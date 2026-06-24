import "dotenv/config";
import { io, Socket } from "socket.io-client";
import axios from "axios";
import nacl from "tweetnacl";
import { loadOffering, listOfferings, listResources, LoadedOffering } from "./offerings";
import { acceptOrRejectJob, createMemo, signMemoById, getJobStatus, claimBudget, claimFee, setBudgetOnChain, getOnChainJob, getOnChainJobFull } from "./sellerApi";
import { AcpJobPhase, SocketEvent } from "./types";
import { getKeypair } from "../../lib/program";
import { getTokenDecimals, KNOWN_MINTS, resolveTokenMint } from "../../lib/tokens";
import { handleChatMessage } from "./chatHandler";
import type { ValidationResult } from "./offeringTypes";
import { getApiUrl, getChatUrl, getAgentDir, getAgentAddress, getPollInterval, getAnthropicApiKey } from "../../lib/config";

const API_URL = getApiUrl();
const CHAT_URL = getChatUrl();
const AGENT_DIR = getAgentDir();
const AGENT_ADDRESS = getAgentAddress();
const POLL_INTERVAL = getPollInterval();

const api = axios.create({ baseURL: API_URL });

/** Track in-flight operations to avoid duplicate processing.
 *  Entries are timestamped so we can evict stale locks. */
const pending = new Map<string, number>();

/** Track when we first noticed indexer lag per job, so we can stop waiting after a timeout */
const indexerLagFirstSeen = new Map<string, number>();
const INDEXER_LAG_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Returns true if we should skip due to indexer lag, false if timeout expired and we should proceed */
function shouldSkipForIndexerLag(jobAddress: string, dbCount: number, onChainCount: number): boolean {
  if (onChainCount <= dbCount) {
    indexerLagFirstSeen.delete(jobAddress);
    return false;
  }
  const now = Date.now();
  const firstSeen = indexerLagFirstSeen.get(jobAddress);
  if (!firstSeen) {
    indexerLagFirstSeen.set(jobAddress, now);
    return true;
  }
  if (now - firstSeen > INDEXER_LAG_TIMEOUT_MS) {
    console.warn(`[seller] Job ${jobAddress.slice(0, 8)}... — indexer lag persisted for ${Math.round((now - firstSeen) / 1000)}s, proceeding anyway`);
    indexerLagFirstSeen.delete(jobAddress);
    return false;
  }
  return true;
}

function isPending(key: string): boolean {
  const ts = pending.get(key);
  if (!ts) return false;
  // Evict locks older than 5 minutes (stuck/crashed handlers)
  if (Date.now() - ts > 300_000) {
    pending.delete(key);
    return false;
  }
  return true;
}

/** Cache loaded offerings */
const offeringCache = new Map<string, LoadedOffering>();

async function getOffering(name: string): Promise<LoadedOffering | null> {
  if (offeringCache.has(name)) return offeringCache.get(name)!;
  try {
    const offering = await loadOffering(name, AGENT_DIR);
    offeringCache.set(name, offering);
    return offering;
  } catch (e: any) {
    console.warn(`[seller] Failed to load offering "${name}": ${e.message}`);
    return null;
  }
}

/** Try to parse requirements JSON from job's JobRequest memo */
function parseRequirements(job: any): { offeringName: string; request: Record<string, any> } | null {
  const jobRequestMemo = job.memos?.find((m: any) => m.memoType === "jobRequest");
  if (!jobRequestMemo?.content) return null;

  try {
    const parsed = JSON.parse(jobRequestMemo.content);
    const offeringName = parsed.offering || parsed.type || parsed.offeringName;
    if (!offeringName) return null;
    return { offeringName, request: parsed };
  } catch {
    return null;
  }
}

// ─── Job Processing ──────────────────────────────────────────────

/** Map on-chain numeric phase to AcpJobPhase string */
const PHASE_MAP: AcpJobPhase[] = [
  AcpJobPhase.REQUEST,
  AcpJobPhase.NEGOTIATION,
  AcpJobPhase.TRANSACTION,
  AcpJobPhase.EVALUATION,
  AcpJobPhase.COMPLETED,
  AcpJobPhase.REJECTED,
];

async function processJob(jobAddress: string) {
  const job = await getJobStatus(jobAddress);
  if (!job) return;

  let phase = job.phase as AcpJobPhase;

  // Reconcile with on-chain state — indexer may lag behind (missed WS events)
  try {
    const onChain = await getOnChainJob(jobAddress);
    const onChainPhase = PHASE_MAP[onChain.phase];
    if (onChainPhase && onChainPhase !== phase) {
      console.log(`[seller] Job ${jobAddress.slice(0, 8)}... — DB phase="${phase}" != on-chain="${onChainPhase}", using on-chain`);
      phase = onChainPhase;
      job.phase = phase;
    }
    // Store on-chain memo count so handlers can detect stale DB memos
    job._onChainMemoCount = onChain.memoCount;
  } catch (e: any) {
    console.warn(`[seller] Job ${jobAddress.slice(0, 8)}... — failed to check on-chain state: ${e.message}`);
  }

  const key = `${jobAddress}:${phase}`;
  if (isPending(key)) return;
  // Lock immediately to prevent concurrent processing (TOCTOU fix)
  pending.set(key, Date.now());

  try {
    switch (phase) {
      case AcpJobPhase.REQUEST:
        await handleRequest(job, key);
        break;
      case AcpJobPhase.NEGOTIATION:
        await handleNegotiation(job, key);
        break;
      case AcpJobPhase.TRANSACTION:
        await handleTransaction(job, key);
        break;
      case AcpJobPhase.EVALUATION:
        await handleEvaluation(job, key);
        break;
      case AcpJobPhase.COMPLETED:
        await handleCompleted(job, key);
        break;
    }
  } catch (err: any) {
    console.error(`[seller] Job ${jobAddress.slice(0, 8)}... phase=${phase} error: ${err.message}`);
  } finally {
    // Always release lock — if phase advanced, key won't match next poll anyway.
    // If phase didn't change, we want to retry on next poll cycle.
    pending.delete(key);
  }
}

/** Resolve offering: try exact name, then fallback to "delegate" if available */
async function resolveOffering(offeringName: string): Promise<{ offering: LoadedOffering; delegated: boolean } | null> {
  const exact = await getOffering(offeringName);
  if (exact) return { offering: exact, delegated: false };

  // Fallback: if we have a "delegate" offering, route unknown offerings through it
  const delegate = await getOffering("delegate");
  if (delegate) {
    console.log(`[seller] Offering "${offeringName}" not found locally, routing through delegate`);
    return { offering: delegate, delegated: true };
  }

  return null;
}

async function handleRequest(job: any, key: string) {
  const parsed = parseRequirements(job);
  if (!parsed) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — no parseable requirements, skipping`);
    return;
  }

  const { offeringName, request } = parsed;
  const resolved = await resolveOffering(offeringName);
  if (!resolved) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — unknown offering "${offeringName}", rejecting`);
    await acceptOrRejectJob(job.address, { accept: false, reason: `Unknown offering: ${offeringName}` });
    return;
  }

  const { offering, delegated } = resolved;

  // For delegated offerings, inject the original offering name as the task
  const validateRequest = delegated
    ? { ...request, task: request.task || `Execute ${offeringName} service`, offering: offeringName, _offeringConfig: offering.config }
    : { ...request, _offeringConfig: offering.config };

  if (offering.handlers.validateRequirements) {
    const result: ValidationResult = offering.handlers.validateRequirements(validateRequest);
    const isValid = result === true || (typeof result === "object" && result.valid);

    if (!isValid) {
      const reason = typeof result === "object" ? result.reason : "Validation failed";
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — validation failed: ${reason}`);
      await acceptOrRejectJob(job.address, { accept: false, reason });
      return;
    }
  }

  const label = delegated ? `delegate(${offeringName})` : offeringName;
  console.log(`[seller] Job ${job.address.slice(0, 8)}... — accepting (offering: ${label})`);
  await acceptOrRejectJob(job.address, { accept: true });
}

async function handleNegotiation(job: any, key: string) {
  // Check if we already created an Agreement memo
  const hasAgreement = job.memos?.some(
    (m: any) => m.memoType === "agreement" || m.memoType === "Agreement"
  );
  if (hasAgreement) return;

  // If on-chain has more memos than DB knows about, DB is stale — skip to avoid duplicates (with timeout)
  const dbMemoCount = job.memos?.length ?? 0;
  const onChainMemoCount = job._onChainMemoCount ?? dbMemoCount;
  if (shouldSkipForIndexerLag(job.address, dbMemoCount, onChainMemoCount)) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — DB has ${dbMemoCount} memos but on-chain has ${onChainMemoCount}, skipping negotiation (indexer lag)`);
    return;
  }

  // Resolve fee and budget from offering + request
  const parsed = parseRequirements(job);
  const offeringName = parsed?.offeringName;
  let feeRate = 0;
  let feeType = "fixed";
  let supportedMints: string[] = [];
  let budgetHuman = 0;

  if (offeringName) {
    const resolved = await resolveOffering(offeringName);
    if (resolved) {
      const config = resolved.offering.config;
      feeRate = config?.feeValue ?? config?.fee ?? 0;
      feeType = config?.feeType ?? "fixed";
      supportedMints = config?.supportedMints ?? [];
    }
  }

  // Budget = requested amount from job request (human-readable units)
  if (parsed?.request) {
    budgetHuman = parsed.request.amount ?? 0;
  }

  // Platform fee
  let feeHuman = feeRate;
  if (feeType === "percentage" && budgetHuman > 0) {
    feeHuman = budgetHuman * feeRate;
  }

  // Get payment mint decimals from on-chain job to convert correctly
  const jobAccount = await getOnChainJobFull(job.address);
  const paymentMint: string = jobAccount.paymentMint.toBase58();
  const decimals = await getTokenDecimals(paymentMint);
  const factor = 10 ** decimals;

  const budgetLamports = Math.round(budgetHuman * factor);
  const feeLamports = Math.round(feeHuman * factor);

  // Reverse lookup: mint address → symbol (e.g. "SOL", "USDC")
  const mintToSymbol = Object.entries(KNOWN_MINTS).find(([, addr]) => addr === paymentMint);
  const paymentSymbol = mintToSymbol ? mintToSymbol[0] : paymentMint.slice(0, 8) + "…";

  // Resolve output mint from job request for the agreement
  const toToken = parsed?.request?.toSymbol || parsed?.request?.toContractAddress;
  const outputMintAddress = toToken ? resolveTokenMint(toToken) : undefined;
  const outputSymbolEntry = outputMintAddress ? Object.entries(KNOWN_MINTS).find(([, addr]) => addr === outputMintAddress) : undefined;
  const outputSymbol = outputSymbolEntry ? outputSymbolEntry[0] : undefined;

  const agreementContent = JSON.stringify({
    message: "Accepting the job. Terms agreed.",
    offering: offeringName || "unknown",
    budget: budgetHuman,
    fee: feeHuman,
    feeType,
    paymentMint,
    paymentSymbol,
    paymentDecimals: decimals,
    ...(outputMintAddress && { outputMint: outputMintAddress }),
    ...(outputSymbol && { outputSymbol }),
    ...(supportedMints.length > 0 && { supportedMints }),
  });

  console.log(`[seller] Job ${job.address.slice(0, 8)}... — setting budget=${budgetLamports} fee=${feeLamports} (decimals=${decimals}) + creating Agreement memo`);

  try {
    // Set budget on-chain (budget = funds for the job, fee = protocol/provider commission)
    await setBudgetOnChain(job.address, budgetLamports, feeLamports);
    // Then create Agreement memo
    await createMemo(job.address, "agreement", agreementContent);
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — negotiation failed: ${e.message}`);
  }
}

async function handleTransaction(job: any, key: string) {
  // Check if Transaction memo exists
  const txMemo = job.memos?.find(
    (m: any) => m.memoType === "transaction" || m.memoType === "Transaction"
  );

  if (!txMemo) {
    // If on-chain has more memos than DB, skip — DB is stale (with timeout)
    const dbMemoCount = job.memos?.length ?? 0;
    const onChainMemoCount = job._onChainMemoCount ?? dbMemoCount;
    if (shouldSkipForIndexerLag(job.address, dbMemoCount, onChainMemoCount)) {
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — DB has ${dbMemoCount} memos but on-chain has ${onChainMemoCount}, skipping transaction (indexer lag)`);
      return;
    }

    console.log(`[seller] Job ${job.address.slice(0, 8)}... — creating Transaction memo`);

    try {
      await createMemo(job.address, "transaction", "Transaction confirmed. Work in progress.");
    } catch (e: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — tx memo failed: ${e.message}`);
    }
    return;
  }

  // Transaction memo exists — sign it if we haven't
  const keypair = getKeypair();

  // Can't sign our own memo (contract enforces OnlyCounterParty)
  if (txMemo.sender === keypair.publicKey.toBase58()) return;

  const alreadySigned = txMemo.signatures?.some(
    (sig: any) => sig.signer === keypair.publicKey.toBase58()
  );
  if (alreadySigned) return;

  // Wait for budget to be set (escrow funded by client)
  if (!job.budget || Number(job.budget) === 0) return;

  console.log(`[seller] Job ${job.address.slice(0, 8)}... — signing Transaction memo`);

  try {
    await signMemoById(job.address, Number(txMemo.memoId), true);
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — sign tx failed: ${e.message}`);
  }
}

async function handleEvaluation(job: any, key: string) {
  const hasDeliverable = job.memos?.some((m: any) => m.memoType === "deliverable");
  if (hasDeliverable) return;

  // If on-chain has more memos than DB knows about, DB is stale — skip to avoid duplicates (with timeout)
  const dbMemoCount = job.memos?.length ?? 0;
  const onChainMemoCount = job._onChainMemoCount ?? dbMemoCount;
  if (shouldSkipForIndexerLag(job.address, dbMemoCount, onChainMemoCount)) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — DB has ${dbMemoCount} memos but on-chain has ${onChainMemoCount}, skipping (indexer lag)`);
    return;
  }

  const parsed = parseRequirements(job);
  if (!parsed) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — no requirements for execution`);
    return;
  }

  const { offeringName, request } = parsed;
  const resolved = await resolveOffering(offeringName);
  if (!resolved) return;

  const { offering, delegated } = resolved;

  // Inject jobAddress and offering config so handlers can interact with ACP escrow
  const baseRequest = {
    ...request,
    jobAddress: job.address,
    _offeringConfig: offering.config,
  };

  // For delegated offerings, pass original request with task context
  const execRequest = delegated
    ? { ...baseRequest, task: request.task || `Execute ${offeringName} service`, offering: offeringName }
    : baseRequest;

  const label = delegated ? `delegate(${offeringName})` : offeringName;
  console.log(`[seller] Job ${job.address.slice(0, 8)}... — executing "${label}"`);

  try {
    const result = await offering.handlers.executeJob(execRequest);
    const deliverable = typeof result.deliverable === "string"
      ? result.deliverable
      : JSON.stringify(result.deliverable);

    console.log(`[seller] Job ${job.address.slice(0, 8)}... — execution complete, creating Deliverable`);
    await createMemo(job.address, "deliverable", deliverable);
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — execution failed: ${e.message}`);
    await createMemo(job.address, "general", JSON.stringify({ error: e.message }));
  }
}

async function handleCompleted(job: any, key: string) {
  const budget = Number(job.budget || 0);
  const claimed = Number(job.amountClaimed || 0);

  if (budget > 0 && claimed < budget) {
    console.log(`[seller] Job ${job.address.slice(0, 8)}... — claiming budget`);
    try {
      const result = await claimBudget(job.address);
      if (result.skipped) console.log(`[seller] Job ${job.address.slice(0, 8)}... — budget already claimed`);
    } catch (e: any) {
      console.error(`[seller] Job ${job.address.slice(0, 8)}... — budget claim failed: ${e.message}`);
    }
  }

  try {
    const result = await claimFee(job.address);
    if (!result.skipped) {
      console.log(`[seller] Job ${job.address.slice(0, 8)}... — fee claimed: tx=${result.tx}`);
    }
  } catch (e: any) {
    console.error(`[seller] Job ${job.address.slice(0, 8)}... — fee claim failed: ${e.message}`);
  }
}

// ─── Polling ─────────────────────────────────────────────────────

let polling = false;

async function pollActiveJobs() {
  if (polling) return;
  polling = true;

  try {
    const keypair = getKeypair();
    const wallet = keypair.publicKey.toBase58();
    const { data } = await api.get("/acp/jobs/active", {
      params: { wallet, role: "provider" },
    });

    const jobs = data.data || [];
    for (const job of jobs) {
      try {
        await processJob(job.address);
      } catch (e: any) {
        console.error(`[seller] Error processing job ${job.address.slice(0, 8)}...: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[seller] Poll error: ${e.message}`);
  } finally {
    polling = false;
  }
}

// ─── Chat ────────────────────────────────────────────────────────

function connectChat(agentAddress: string) {
  if (!getAnthropicApiKey()) {
    console.warn("[seller] Anthropic API key not set — chat disabled");
    return;
  }

  if (!agentAddress) {
    console.warn("[seller] AGENT_ADDRESS not set — chat disabled");
    return;
  }

  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();

  // Load offering configs to send to ChatServer
  const offeringNames = listOfferings(AGENT_DIR);
  const offerings = offeringNames.map((name) => {
    const cached = offeringCache.get(name);
    return cached ? cached.config : { name };
  });
  const chatResources = listResources();

  const chatSocket: Socket = io(CHAT_URL, {
    reconnection: true,
    reconnectionDelay: 3000,
    path: "/chat",
    auth: {
      role: "provider",
      agentMint: agentAddress, // chat server uses agentMint as agent identifier
      wallet,
      offerings,
      resources: chatResources,
    },
  });

  chatSocket.on("connect", () => console.log("[seller:chat] Connected to chat server, awaiting challenge..."));
  chatSocket.on("disconnect", (r) => console.log(`[seller:chat] Disconnected: ${r}`));
  chatSocket.on("connect_error", (e) => console.warn(`[seller:chat] Error: ${e.message}`));

  // Challenge-sign authentication
  chatSocket.on("auth:challenge", (data: { nonce: string }) => {
    console.log("[seller:chat] Received auth challenge, signing...");
    const message = Buffer.from(data.nonce);
    const signature = nacl.sign.detached(message, keypair.secretKey);
    chatSocket.emit("auth:solve", { signature: Buffer.from(signature).toString("base64") });
  });

  chatSocket.on("auth:success", (data: { agentMint: string }) => {
    console.log(`[seller:chat] Authenticated as provider for ${data.agentMint.slice(0, 8)}...`);
  });

  chatSocket.on("auth:error", (data: { message: string }) => {
    console.error(`[seller:chat] Auth failed: ${data.message}`);
  });

  // Chat message handler (server only sends after auth:success)
  chatSocket.on("chat:message", async (data: {
    conversationId: string;
    agentMint: string;
    userId: string;
    wallet: string | null;
    content: string;
    history: { role: string; content: string }[];
  }) => {
    console.log(`[seller:chat] Message from ${data.userId.slice(0, 12)}... in conv ${data.conversationId.slice(0, 8)}...`);

    try {
      const reply = await handleChatMessage(
        data.conversationId,
        data.agentMint,
        data.content,
        data.history.map((m) => ({
          role: m.role as "user" | "agent",
          content: m.content,
        })),
        data.wallet
      );

      chatSocket.emit("chat:response", {
        conversationId: data.conversationId,
        content: reply,
      });
    } catch (e: any) {
      console.error(`[seller:chat] Error generating response: ${e.message}`);
      chatSocket.emit("chat:response", {
        conversationId: data.conversationId,
        content: "Sorry, something went wrong. Please try again.",
      });
    }
  });

  return chatSocket;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();

  console.log("[seller] Starting seller runtime...");
  console.log(`[seller] Wallet: ${wallet}`);
  console.log(`[seller] API: ${API_URL}`);
  console.log(`[seller] Chat: ${CHAT_URL}`);
  console.log(`[seller] Agent dir: ${AGENT_DIR}`);
  console.log(`[seller] Agent address: ${AGENT_ADDRESS || "(not set)"}`);

  // List available offerings
  const offeringNames = listOfferings(AGENT_DIR);
  console.log(`[seller] Available offerings: ${offeringNames.join(", ") || "(none)"}`);

  if (offeringNames.length === 0) {
    console.warn("[seller] No offerings found! Seller will reject all jobs.");
  }

  // Pre-load all offerings
  for (const name of offeringNames) {
    await getOffering(name);
  }

  // Load resources from disk
  const resourcesPayload = listResources();
  if (resourcesPayload.length > 0) {
    console.log(`[seller] Available resources: ${resourcesPayload.map((r) => r.name).join(", ")}`);
  }

  // Register offerings and resources with indexer so they appear in search/marketplace
  try {
    const offeringsPayload = offeringNames
      .map((name) => offeringCache.get(name))
      .filter(Boolean)
      .map((o) => ({
        name: o!.config.name || o!.config.offering,
        description: o!.config.description || "",
        fee: o!.config.feeValue ?? o!.config.fee ?? 0,
        feeType: o!.config.feeType || "fixed",
        slaMinutes: o!.config.slaMinutes ?? 30,
        requiredFunds: o!.config.requiredFunds ?? false,
        requirement: o!.config.requirement ?? {},
        deliverable: o!.config.deliverable ?? {},
      }));
    // Sign nonce for auth
    const nonce = `acp-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sigBytes = nacl.sign.detached(Buffer.from(nonce), keypair.secretKey);
    const signature = Buffer.from(sigBytes).toString("base64");
    await api.put(`/acp/agent/${AGENT_ADDRESS}`, {
      offerings: offeringsPayload,
      resources: resourcesPayload,
      wallet,
      signature,
      nonce,
    });
    console.log(`[seller] Registered ${offeringsPayload.length} offerings and ${resourcesPayload.length} resources with indexer`);
  } catch (e: any) {
    console.warn(`[seller] Failed to register offerings/resources: ${e.message}`);
  }

  // Connect to indexer WebSocket for ACP job events
  const sellerSocket: Socket = io(API_URL, {
    path: "/seller-events",
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 3000,
    auth: { wallet, agentAddress: AGENT_ADDRESS },
  });

  sellerSocket.on("connect", () => console.log("[seller:ws] Connected to seller events"));
  sellerSocket.on("disconnect", (r) => console.log(`[seller:ws] Disconnected: ${r}`));
  sellerSocket.on("connect_error", (e) => console.warn(`[seller:ws] Error: ${e.message}`));

  sellerSocket.on(SocketEvent.JOB_CREATED, (data) => {
    console.log(`[seller:ws] New job: ${data.jobAddress}`);
    processJob(data.jobAddress).catch((e) =>
      console.error(`[seller] Error handling new job: ${e.message}`)
    );
  });

  sellerSocket.on(SocketEvent.JOB_PHASE, (data) => {
    console.log(`[seller:ws] Phase update: ${data.jobAddress} → ${data.phase}`);
    const addr = data.jobAddress;
    for (const key of pending.keys()) {
      if (key.startsWith(addr + ":") && !key.endsWith(`:${data.phase}`)) {
        pending.delete(key);
      }
    }
    processJob(data.jobAddress).catch((e) =>
      console.error(`[seller] Error handling phase update: ${e.message}`)
    );
  });

  sellerSocket.on(SocketEvent.MEMO_CREATED, (data) => {
    console.log(`[seller:ws] Memo created: ${data.jobAddress} (${data.memoType})`);
  });

  sellerSocket.on(SocketEvent.JOB_BUDGET, (data) => {
    console.log(`[seller:ws] Budget set: ${data.jobAddress} = ${data.budget}`);
  });

  // Connect to chat server
  const chatSocket = connectChat(AGENT_ADDRESS);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[seller] Shutting down...");
    sellerSocket.disconnect();
    chatSocket?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Initial poll + periodic polling as fallback
  await pollActiveJobs();
  setInterval(pollActiveJobs, POLL_INTERVAL);

  console.log(`[seller] Running. Polling every ${POLL_INTERVAL}ms`);
}

main().catch((e) => {
  console.error("[seller] Fatal:", e);
  process.exit(1);
});

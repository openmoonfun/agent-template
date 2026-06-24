import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { getClient } from "../lib/client";
import { output, field, heading, log, success, error } from "../lib/output";
import {
  getProgram,
  getKeypair,
  AnchorMemoType,
  hashContent,
  hashToHex,
} from "../lib/program";
import {
  getAcpStatePda,
  getAgentFeeAuthorityPda,
  getJobPda,
  getMemoPda,
  getMemoSigPda,
  getPdaAgent,
  getEscrowVaultPda,
  getEscrowAuthorityPda,
  zeroHash,
} from "../lib/pda";

/**
 * Parse a base58 Solana address from user input, exiting with a clear error
 * instead of throwing a cryptic TypeError from PublicKey's constructor.
 */
function parsePubkeyArg(label: string, value: string | undefined): PublicKey {
  if (!value) {
    error(`${label} is required`);
    process.exit(1);
  }
  try {
    return new PublicKey(value);
  } catch {
    error(`Invalid ${label}: not a valid base58 public key (${value})`);
    process.exit(1);
  }
}

// ─── Write operations (direct on-chain) ─────────────────────────

export async function create(
  agentMint: string,
  provider: string,
  options: {
    evaluator?: string;
    expiredAt?: number;
    requirements?: string;
    isAutomated?: boolean;
  } = {}
) {
  const program = getProgram();
  const keypair = getKeypair();

  // agentMint is now the agent PDA address directly
  const agentPda = parsePubkeyArg("agent address", agentMint);
  const providerKey = parsePubkeyArg("provider", provider);
  const evaluatorKey = options.evaluator
    ? parsePubkeyArg("evaluator", options.evaluator)
    : PublicKey.default;

  const agentAccount = await (program.account as any).agent.fetch(agentPda);
  const nextJobId = Number(agentAccount.jobCounter) + 1;
  const jobPda = getJobPda(agentPda, nextJobId);
  const acpStatePda = getAcpStatePda();

  const expiry = options.expiredAt || Math.floor(Date.now() / 1000) + 3600;

  const tx = await (program.methods as any)
    .createJob(new anchor.BN(expiry))
    .accounts({
      client: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      provider: providerKey,
      evaluator: evaluatorKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  // Create JobRequest memo with requirements
  if (options.requirements) {
    const contentHash = hashContent(options.requirements);
    const hexHash = hashToHex(contentHash);

    // Save content to indexer
    try {
      await getClient().post("/memo-content", { hash: hexHash, text: options.requirements });
    } catch (e) { console.debug("[job] memo-content POST (requirements):", e); }

    const memoPda = getMemoPda(jobPda, 1);
    await (program.methods as any)
      .createMemo(contentHash, AnchorMemoType.jobRequest, false)
      .accounts({
        sender: keypair.publicKey,
        agent: agentPda,
        job: jobPda,
        memo: memoPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
  }

  output({ jobId: nextJobId, jobAddress: jobPda.toBase58(), tx, isAutomated: !!options.isAutomated }, (d) => {
    success("Job created");
    field("Job ID", d.jobId);
    field("Address", d.jobAddress);
    field("TX", d.tx);
    if (d.isAutomated) log("  Auto-pay enabled — will poll and pay automatically");
  });

  // Auto-pay: poll until NEGOTIATION phase, then pay automatically
  if (options.isAutomated) {
    log("\n  Waiting for provider to accept and request payment...");
    const maxAttempts = 60; // 10min with 10s interval
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      try {
        const { data: jobData } = await getClient().get(`/acp/jobs/${nextJobId}`);
        const phase = jobData.phase?.toLowerCase();

        if (phase === "negotiation" || phase === "transaction") {
          log("  Provider accepted — processing payment...");
          await pay(String(nextJobId), true);
          log("  Auto-pay complete. Poll `acp job status` for deliverable.");
          return;
        }
        if (phase === "completed" || phase === "rejected") {
          log(`  Job ended with phase: ${jobData.phase}`);
          return;
        }
      } catch (e: any) {
        // Log but continue polling — transient errors are expected
        if (i % 6 === 5) log(`  Still waiting... (${Math.round((i + 1) * 10 / 60)}min elapsed)`);
      }
    }
    log("  Auto-pay timeout (10min) — check job status manually with `acp job status`.");
  }
}

export async function accept(jobId: string, doAccept: boolean, reason?: string) {
  const program = getProgram();
  const keypair = getKeypair();

  // Fetch job from indexer to get agent PDA
  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  // Find JobRequest memo
  const jobRequestMemo = job.memos?.find((m: any) => m.memoType === "jobRequest");
  if (!jobRequestMemo) throw new Error("No JobRequest memo to sign");

  const memoSigPda = getMemoSigPda(jobPda, BigInt(jobRequestMemo.memoId), keypair.publicKey);
  const reasonHash = reason ? hashContent(reason) : zeroHash();

  if (reason) {
    const hexHash = hashToHex(reasonHash);
    try {
      await getClient().post("/memo-content", { hash: hexHash, text: reason });
    } catch (e) { console.debug("[job] memo-content POST (accept/reject reason):", e); }
  }

  const tx = await (program.methods as any)
    .signMemo(doAccept, reasonHash)
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: getMemoPda(jobPda, Number(jobRequestMemo.memoId)),
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success(`Job ${doAccept ? "accepted" : "rejected"}`);
    field("TX", d.tx);
  });
}

export async function memo(jobId: string, memoType: string, content: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const nextMemoId = Number(jobAccount.memoCount) + 1;
  const memoPda = getMemoPda(jobPda, nextMemoId);

  const anchorType = AnchorMemoType[memoType];
  if (!anchorType) throw new Error(`Invalid memoType: ${memoType}`);

  const contentHash = hashContent(content);
  const hexHash = hashToHex(contentHash);

  try {
    await getClient().post("/memo-content", { hash: hexHash, text: content });
  } catch (e) { console.debug("[job] memo-content POST (memo):", e); }

  const tx = await (program.methods as any)
    .createMemo(contentHash, anchorType, false)
    .accounts({
      sender: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      memo: memoPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ memoId: nextMemoId, tx }, (d) => {
    success("Memo created");
    field("Memo ID", d.memoId);
    field("TX", d.tx);
  });
}

export async function sign(jobId: string, memoId: string, approve: boolean, reason?: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const jid = Number(job.jobId);
  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, jid);
  const mid = Number(memoId);
  const memoPda = getMemoPda(jobPda, mid);
  const memoSigPda = getMemoSigPda(jobPda, mid, keypair.publicKey);

  const reasonHash = reason ? hashContent(reason) : zeroHash();
  if (reason) {
    const hexHash = hashToHex(reasonHash);
    try {
      await getClient().post("/memo-content", { hash: hexHash, text: reason });
    } catch (e) { console.debug("[job] memo-content POST (sign reason):", e); }
  }

  const tx = await (program.methods as any)
    .signMemo(approve, reasonHash)
    .accounts({
      signer: keypair.publicKey,
      acpState: getAcpStatePda(),
      agent: agentPda,
      job: jobPda,
      memo: memoPda,
      memoSignature: memoSigPda,
      escrowVault: getEscrowVaultPda(jobPda),
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success(`Memo ${approve ? "approved" : "rejected"}`);
    field("TX", d.tx);
  });
}

export async function setBudget(jobId: string, budget: number, fee: number) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));

  const tx = await (program.methods as any)
    .setBudget(new anchor.BN(budget), new anchor.BN(fee))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Budget set");
    field("TX", d.tx);
  });
}

export async function deposit(jobId: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const acpStatePda = getAcpStatePda();

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const clientAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const tx = await (program.methods as any)
    .depositToEscrow()
    .accounts({
      client: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      paymentMint,
      clientTokenAccount: clientAta,
      escrowVault,
      escrowAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Deposited to escrow");
    field("TX", d.tx);
  });
}

export async function claim(jobId: string, amount?: number) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;

  const claimable = amount || Number(jobAccount.budget) - Number(jobAccount.amountClaimed);
  const providerAta = getAssociatedTokenAddressSync(paymentMint, new PublicKey(job.provider));

  const createProviderAta = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,
    providerAta,
    new PublicKey(job.provider),
    paymentMint
  );

  const tx = await (program.methods as any)
    .claimBudget(new anchor.BN(claimable))
    .accounts({
      provider: keypair.publicKey,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      providerTokenAccount: providerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([createProviderAta])
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Budget claimed");
    field("TX", d.tx);
  });
}

export async function claimFee(jobId: string) {
  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const acpStatePda = getAcpStatePda();
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const acpState = await (program.account as any).acpState.fetch(acpStatePda);
  // state.platformTreasury is the ATA itself — do NOT derive another ATA
  // from it (yields #3012 AccountNotInitialized).
  const platformTreasuryAta: PublicKey = acpState.platformTreasury;

  const clientAta = getAssociatedTokenAddressSync(paymentMint, new PublicKey(job.client));
  const agentFeeAuthority = getAgentFeeAuthorityPda(agentPda);
  const agentFeeVault = getAssociatedTokenAddressSync(paymentMint, agentFeeAuthority, true);

  const tx = await (program.methods as any)
    .claimFee()
    .accounts({
      claimer: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      escrowVault,
      escrowAuthority,
      clientTokenAccount: clientAta,
      platformTreasuryTokenAccount: platformTreasuryAta,
      paymentMint,
      agentFeeAuthority,
      agentFeeVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ tx }, (d) => {
    success("Fee claimed");
    field("TX", d.tx);
  });
}

export async function pay(jobId: string, doAccept: boolean, content?: string) {
  if (!doAccept) {
    output({ jobId, accepted: false, content }, (d) => {
      success("Payment rejected");
      field("Job ID", d.jobId);
      if (d.content) field("Reason", d.content);
    });
    return;
  }

  const program = getProgram();
  const keypair = getKeypair();

  const { data: job } = await getClient().get(`/acp/jobs/${jobId}`);

  const agentPda = new PublicKey(job.agent);
  const jobPda = getJobPda(agentPda, Number(job.jobId));
  const acpStatePda = getAcpStatePda();

  // Find the agreement memo with payment amount
  const agreementMemo = job.memos?.find((m: any) => m.memoType === "agreement");
  let amount: number | undefined;
  if (agreementMemo?.content) {
    try {
      const parsed = JSON.parse(agreementMemo.content);
      amount = parsed.amount ?? parsed.fee ?? parsed.budget ?? parsed.price;
    } catch {
      // Try as plain number
      const num = Number(agreementMemo.content);
      if (!isNaN(num)) amount = num;
    }
  }

  // Fallback: use job.budget if already set
  if (!amount && job.budget) {
    amount = Number(job.budget);
  }

  if (!amount || amount <= 0) {
    error("Cannot determine payment amount from agreement memo or job budget");
    return;
  }

  // Step 1: Deposit to escrow (budget + fee already set by provider)
  log("  Depositing to escrow...");
  const jobAccount = await (program.account as any).job.fetch(jobPda);
  const paymentMint: PublicKey = jobAccount.paymentMint;
  const clientAta = getAssociatedTokenAddressSync(paymentMint, keypair.publicKey);
  const escrowVault = getEscrowVaultPda(jobPda);
  const escrowAuthority = getEscrowAuthorityPda(jobPda);

  const tx = await (program.methods as any)
    .depositToEscrow()
    .accounts({
      client: keypair.publicKey,
      acpState: acpStatePda,
      agent: agentPda,
      job: jobPda,
      paymentMint,
      clientTokenAccount: clientAta,
      escrowVault,
      escrowAuthority,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  output({ jobId, amount, tx }, (d) => {
    success("Payment approved and deposited");
    field("Job ID", d.jobId);
    field("Amount", d.amount);
    field("TX", d.tx);
  });
}

// ─── Read operations (via indexer API) ───────────────────────────

export async function status(jobId: string) {
  const { data } = await getClient().get(`/acp/jobs/${jobId}`);

  output(data, (d) => {
    heading(`Job #${d.jobId}`);
    field("Address", d.address);
    field("Phase", d.phase);
    field("Client", d.client);
    field("Provider", d.provider);
    field("Evaluator", d.evaluator);
    field("Budget", d.budget);
    field("Claimed", d.amountClaimed);
    field("Memos", d.memoCount);

    if (d.memos?.length > 0) {
      heading("Memos");
      for (const m of d.memos) {
        log(`  [${m.memoId}] ${m.memoType} (${m.sender.slice(0, 8)}...)`);
        if (m.content) log(`      ${m.content.slice(0, 100)}`);
      }
    }
  });
}

export async function active(options: { page?: number; role?: string } = {}) {
  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();
  const { data } = await getClient().get("/acp/jobs/active", {
    params: { page: options.page || 1, role: options.role || "all", wallet },
  });

  output(data, (d) => {
    heading("Active Jobs");
    if (d.data.length === 0) {
      log("  No active jobs");
      return;
    }
    for (const j of d.data) {
      log(`  #${j.jobId} [${j.phase}] client=${j.client.slice(0, 8)}... provider=${j.provider.slice(0, 8)}... budget=${j.budget}`);
    }
    log(`  Page ${d.pagination.page}, total: ${d.pagination.total}`);
  });
}

export async function completed(options: { page?: number; role?: string } = {}) {
  const keypair = getKeypair();
  const wallet = keypair.publicKey.toBase58();
  const { data } = await getClient().get("/acp/jobs/completed", {
    params: { page: options.page || 1, role: options.role || "all", wallet },
  });

  output(data, (d) => {
    heading("Completed Jobs");
    if (d.data.length === 0) {
      log("  No completed jobs");
      return;
    }
    for (const j of d.data) {
      log(`  #${j.jobId} [${j.phase}] client=${j.client.slice(0, 8)}... budget=${j.budget} claimed=${j.amountClaimed}`);
    }
    log(`  Page ${d.pagination.page}, total: ${d.pagination.total}`);
  });
}

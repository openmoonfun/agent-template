import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { listOfferings, listResources, ResourceConfig } from "./offerings";
import { getRpcUrl, getAgentDir, getAnthropicModel, getAnthropicApiKey } from "../../lib/config";

const RPC_URL = getRpcUrl();
const AGENT_DIR = getAgentDir();
const MODEL = getAnthropicModel();

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      throw new Error("Anthropic API key not set. Add anthropicApiKey to config.json or set ANTHROPIC_API_KEY env var.");
    }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

function loadSystemPrompt(): string {
  const promptPath = path.join(__dirname, "..", "offerings", AGENT_DIR, "system_prompt.txt");
  try {
    return fs.readFileSync(promptPath, "utf-8").trim();
  } catch {
    // Fallback to default if agent-specific prompt not found
    const defaultPath = path.join(__dirname, "..", "offerings", "default", "system_prompt.txt");
    return fs.readFileSync(defaultPath, "utf-8").trim();
  }
}

/** Build tools dynamically from local offering.json files and resources */
function buildToolsFromOfferings(): {
  tools: Anthropic.Tool[];
  resourceMap: Map<string, ResourceConfig>;
  offeringConfigs: Map<string, any>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "check_balance",
      description: "Check the user's wallet balances (SOL and USDC) on Solana.",
      input_schema: { type: "object" as const, properties: {}, required: [] },
    },
  ];

  // Cache offering.json contents so executeTool can stamp pricing into the
  // pending envelope without re-reading disk on every call.
  const offeringConfigs = new Map<string, any>();

  const offeringNames = listOfferings(AGENT_DIR);
  for (const name of offeringNames) {
    try {
      const offeringPath = path.join(__dirname, "..", "offerings", AGENT_DIR, name, "offering.json");
      const config = JSON.parse(fs.readFileSync(offeringPath, "utf-8"));
      const toolName = config.name || name;
      offeringConfigs.set(toolName, config);

      const feeNum = config.feeValue ?? config.fee ?? 0;
      const feeStr = config.feeType === "percentage"
        ? `${(feeNum * 100).toFixed(1)}%`
        : `$${feeNum} USDC`;

      tools.push({
        name: toolName,
        description: `${config.description || name}. Fee: ${feeStr}`,
        input_schema: config.requirement || {
          type: "object" as const,
          properties: {},
          required: [],
        },
      });
    } catch (e: any) {
      console.warn(`[chat] Failed to load offering "${name}" for tools: ${e.message}`);
    }
  }

  // Add resources as free, instantly-executed tools
  const resourceMap = new Map<string, ResourceConfig>();
  const resources = listResources();
  for (const r of resources) {
    const toolName = `resource_${r.name}`;
    resourceMap.set(toolName, r);
    tools.push({
      name: toolName,
      description: `[Free Resource] ${r.description}. Returns data instantly, no payment required.`,
      input_schema: {
        type: "object" as const,
        properties: {
          params: {
            type: "object" as const,
            description: "Optional query parameters to pass to the resource endpoint",
          },
        },
        required: [],
      },
    });
  }

  return { tools, resourceMap, offeringConfigs };
}

const { tools: TOOLS, resourceMap: RESOURCE_MAP, offeringConfigs: OFFERING_CONFIGS } = buildToolsFromOfferings();

interface ChatMessage {
  role: "user" | "agent";
  content: string;
}

/** USDC mint on Solana (devnet and mainnet share the same address) */
const USDC_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet
];

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Reject with a clear error if the inner promise hasn't settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function fetchWalletBalances(walletAddress: string): Promise<Record<string, any>> {
  const connection = new Connection(RPC_URL, "confirmed");
  const pubkey = new PublicKey(walletAddress);

  // SOL balance — web3.js has no built-in per-call timeout, so guard manually
  // to prevent a slow RPC from wedging the chat handler.
  const solBalance = await withTimeout(connection.getBalance(pubkey), 10_000, "getBalance");
  const solAmount = solBalance / LAMPORTS_PER_SOL;

  // Token accounts
  const tokenAccounts = await withTimeout(
    connection.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID }),
    15_000,
    "getParsedTokenAccountsByOwner"
  );

  const tokens: { symbol: string; mint: string; balance: number; decimals: number }[] = [];

  for (const { account } of tokenAccounts.value) {
    const parsed = account.data.parsed?.info;
    if (!parsed) continue;
    const mint = parsed.mint as string;
    const balance = parsed.tokenAmount?.uiAmount ?? 0;
    const decimals = parsed.tokenAmount?.decimals ?? 0;

    if (balance === 0) continue;

    const isUsdc = USDC_MINTS.includes(mint);
    tokens.push({
      symbol: isUsdc ? "USDC" : mint.slice(0, 8) + "...",
      mint,
      balance,
      decimals,
    });
  }

  return {
    wallet: walletAddress,
    network: "solana",
    sol: { balance: solAmount, symbol: "SOL" },
    tokens,
  };
}

/** Execute a tool call — returns structured result for Claude */
async function executeTool(
  name: string,
  input: Record<string, any>,
  userWallet: string | null
): Promise<Record<string, any>> {
  console.log(`[chat] Tool call: ${name}`, JSON.stringify(input));

  // Built-in: check_balance
  if (name === "check_balance") {
    if (!userWallet) {
      return { error: "User wallet address not available. Ask the user to connect their wallet." };
    }
    try {
      return await fetchWalletBalances(userWallet);
    } catch (e: any) {
      console.error("[chat] Balance check failed:", e.message);
      return { error: `Failed to fetch balance: ${e.message}` };
    }
  }

  // Resource tools — execute immediately via HTTP GET
  const resource = RESOURCE_MAP.get(name);
  if (resource) {
    try {
      const { default: axios } = await import("axios");
      const params = input.params && typeof input.params === "object" ? input.params : undefined;
      const resp = await axios.get(resource.url, { params, timeout: 15_000 });
      return { status: "resource_result", resource: resource.name, data: resp.data };
    } catch (e: any) {
      console.error(`[chat] Resource query failed for ${resource.name}:`, e.message);
      return { error: `Resource query failed: ${e.message}` };
    }
  }

  // All other tools map to offerings — return as pending job for the frontend
  return {
    status: "pending",
    offering: name,
    ...input,
    message: `Executing ${name}`,
  };
}

/**
 * Handle an incoming chat message from a user (forwarded by indexer ChatServer).
 * Returns the agent's text response.
 */
export async function handleChatMessage(
  conversationId: string,
  agentMint: string,
  userMessage: string,
  history: ChatMessage[],
  userWallet?: string | null
): Promise<string> {
  const client = getClient();

  // Convert history to Claude format
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role === "user" ? "user" as const : "assistant" as const,
    content: m.content,
  }));

  // Build agent context
  const offerings = listOfferings(AGENT_DIR);
  const resources = listResources();
  let agentContext = `\n\nAvailable offerings: ${offerings.join(", ") || "none"}. Agent address: ${agentMint}`;
  if (resources.length > 0) {
    agentContext += `\nFree resources (use resource_<name> tools): ${resources.map((r) => r.name).join(", ")}`;
  }
  if (userWallet) {
    agentContext += `\nUser wallet: ${userWallet}`;
  }

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: loadSystemPrompt() + agentContext,
      tools: TOOLS,
      messages,
    });

    // Process response — tool-use loop (handles parallel and multi-level tool calls)
    const blocks: { type: string; [key: string]: any }[] = [];
    const MAX_TOOL_LOOPS = 5;
    let currentMessages = [...messages];
    let currentResponse = response;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      // Collect text and tool_use blocks
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let hasJobTool = false;

      for (const block of currentResponse.content) {
        if (block.type === "text") {
          blocks.push({ type: "text", content: block.text });
        } else if (block.type === "tool_use") {
          const toolResult = await executeTool(block.name, block.input as Record<string, any>, userWallet || null);
          blocks.push({ type: "tool_call", name: block.name, input: block.input, result: toolResult });

          if (toolResult.offering) hasJobTool = true;

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(toolResult),
          });
        }
      }

      // If no tool use, stop. If ALL tools are ACP job tools (frontend handles them), stop.
      if (currentResponse.stop_reason !== "tool_use" || toolResults.length === 0) break;
      // If any tool is an ACP job tool, we still need to send results back but don't continue the loop
      if (hasJobTool) break;

      // Send ALL tool results back in one message (fixes parallel tool calls)
      try {
        currentMessages = [
          ...currentMessages,
          { role: "assistant" as const, content: currentResponse.content },
          { role: "user" as const, content: toolResults },
        ];

        currentResponse = await client.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system: loadSystemPrompt() + agentContext,
          tools: TOOLS,
          messages: currentMessages,
        });
      } catch (err: any) {
        console.error("[chat] Follow-up error:", err.message);
        break;
      }
    }

    if (blocks.length === 0) {
      return "I'm not sure how to help with that. Could you rephrase?";
    }

    // Return as JSON for structured rendering
    return JSON.stringify(blocks);
  } catch (err: any) {
    console.error("[chat] Claude API error:", err.message);
    return "Sorry, I'm having trouble right now. Please try again.";
  }
}

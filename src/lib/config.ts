import fs from "fs";
import path from "path";
export const ROOT = process.cwd();
export const CONFIG_JSON_PATH = path.resolve(ROOT, "config.json");
export const LOGS_DIR = path.resolve(ROOT, "logs");

// ─── Types ──────────────────────────────────────────────────────

export interface AgentEntry {
  // Local signing keypair for this agent. By convention this is the agent's
  // CREATOR keypair (the one that paid for `createAgent` on-chain). The CLI
  // signs all on-chain calls and API auth requests with this key. Stored as a
  // JSON array of secret key bytes or a path to a keypair file.
  // The agent's PROVIDER is a separate keypair set on-chain and supplied to
  // deployed runtimes through their environment — it is not stored here.
  wallet: string;
  address: string;      // Agent PDA address on-chain (always set after create)
  mint: string;         // Agent token mint (empty until token launch)
  dir: string;          // Offerings directory name
}

export interface ConfigJson {
  // Global settings
  rpc?: string;
  apiUrl?: string;
  chatUrl?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  pollInterval?: number;

  // Runtime state
  sellerPid?: number;

  // Agent management
  activeAgent?: string;                    // name of active agent
  agents?: Record<string, AgentEntry>;     // name → agent config
}

// ─── Read / Write ───────────────────────────────────────────────

export function readConfig(): ConfigJson {
  if (!fs.existsSync(CONFIG_JSON_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function writeConfig(cfg: ConfigJson): void {
  fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

// ─── Active agent helpers ───────────────────────────────────────

/** Get the active agent entry, or null */
export function getActiveAgent(): { name: string } & AgentEntry | null {
  const cfg = readConfig();
  const name = cfg.activeAgent;
  if (!name || !cfg.agents?.[name]) return null;
  return { name, ...cfg.agents[name] };
}

/**
 * Returns the local signing keypair for the active agent.
 *
 * Priority:
 *   1. WALLET_KEY env var      — agent CREATOR key (CLI default)
 *   2. PROVIDER_WALLET env var — agent PROVIDER key (multi-agent serve override)
 *   3. config.json → agents[active].wallet (creator key by convention)
  *
  * Note: WALLET_KEY may differ from the runtime keypair used by a deployment
  * provider.
  */
export function getWalletKey(): string | undefined {
  if (process.env.WALLET_KEY) return process.env.WALLET_KEY;
  if (process.env.PROVIDER_WALLET) return process.env.PROVIDER_WALLET;
  const agent = getActiveAgent();
  return agent?.wallet;
}

/** Get agent PDA address from config. */
export function getAgentAddress(): string {
  const agent = getActiveAgent();
  return agent?.address || "";
}

/** Get agent token mint. Empty until token is launched. */
export function getAgentMint(): string {
  const agent = getActiveAgent();
  return agent?.mint || "";
}

/** Get agent offerings directory name. Env overrides config. */
export function getAgentDir(): string {
  if (process.env.AGENT_DIR) return process.env.AGENT_DIR;
  const agent = getActiveAgent();
  return agent?.dir || "default";
}

// ─── Global settings helpers ────────────────────────────────────

export function getRpcUrl(): string {
  const cfg = readConfig();
  return process.env.RPC_URL || process.env.RPC || cfg.rpc || "http://127.0.0.1:8899";
}

export function getApiUrl(): string {
  const cfg = readConfig();
  return process.env.ACP_API_URL || cfg.apiUrl || "http://localhost:3001";
}

export function getChatUrl(): string {
  const cfg = readConfig();
  return process.env.CHAT_URL || cfg.chatUrl || "http://localhost:3001";
}

export function getAnthropicApiKey(): string {
  const cfg = readConfig();
  return process.env.ANTHROPIC_API_KEY || cfg.anthropicApiKey || "";
}

export function getAnthropicModel(): string {
  const cfg = readConfig();
  return process.env.ANTHROPIC_MODEL || cfg.anthropicModel || "claude-sonnet-4-6";
}

export function getPollInterval(): number {
  const cfg = readConfig();
  return Number(process.env.POLL_INTERVAL) || cfg.pollInterval || 5000;
}

// ─── Seller PID ─────────────────────────────────────────────────

export function findSellerPid(agentName?: string): number | null {
  const cfg = readConfig();
  const name = agentName || cfg.activeAgent;

  // Check per-agent PID first
  if (name && cfg.agents?.[name]) {
    const pid = (cfg.agents[name] as any).sellerPid;
    if (pid) {
      try { process.kill(pid, 0); return pid; } catch { return null; }
    }
  }

  // Fallback to global PID (legacy)
  if (!cfg.sellerPid) return null;
  try { process.kill(cfg.sellerPid, 0); return cfg.sellerPid; } catch { return null; }
}

export function writePidToConfig(pid: number, agentName?: string): void {
  const cfg = readConfig();
  const name = agentName || cfg.activeAgent;
  if (name && cfg.agents?.[name]) {
    (cfg.agents[name] as any).sellerPid = pid;
  } else {
    cfg.sellerPid = pid;
  }
  writeConfig(cfg);
}

export function removePidFromConfig(agentName?: string): void {
  const cfg = readConfig();
  const name = agentName || cfg.activeAgent;
  if (name && cfg.agents?.[name]) {
    delete (cfg.agents[name] as any).sellerPid;
  }
  delete cfg.sellerPid;
  writeConfig(cfg);
}

/** Get all agent names from config */
export function listAgentNames(): string[] {
  const cfg = readConfig();
  return Object.keys(cfg.agents || {});
}

// ─── Misc ───────────────────────────────────────────────────────

export function formatPrice(price: number, feeType?: string): string {
  if (feeType === "percentage") return `${(price * 100).toFixed(1)}%`;
  return `${price} USDC`;
}

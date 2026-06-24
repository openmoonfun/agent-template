// =============================================================================
// acp serve deploy railway [setup|status|logs|teardown]
// acp serve deploy railway env [set|delete]
// =============================================================================

import { execSync, execFileSync, spawnSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as output from "../lib/output";
import { ROOT, readConfig, getActiveAgent } from "../lib/config";

function checkRailwayCli(): boolean {
  try {
    execSync("railway --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function runRailway(args: string[], inherit = false): string {
  try {
    // Use execFileSync with array args to prevent command injection
    if (inherit) {
      execFileSync("railway", args, { cwd: ROOT, stdio: "inherit" });
      return "";
    }
    return execFileSync("railway", args, { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch (e: any) {
    throw new Error(e.message || "Railway command failed");
  }
}

function hasLinkedService(): boolean {
  try {
    // `railway variables` fails if no service is linked
    execSync("railway variables", { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function ensureService(): void {
  if (hasLinkedService()) return;

  output.log("  No service linked. Select or create a service:");
  try {
    // Interactive prompt — lets user pick/create a service
    execSync("railway service", { cwd: ROOT, stdio: "inherit" });
  } catch {
    output.fatal(
      "No service linked. Run `railway service` manually to link or create a service."
    );
  }

  // Verify it worked
  if (!hasLinkedService()) {
    output.fatal("Service still not linked. Run `railway service` and try again.");
  }
}

function generateDockerfile(): string {
  return `FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
COPY idl/ idl/
CMD ["npx", "tsx", "src/seller/runtime/seller.ts"]
`;
}

/** Push active agent's config as Railway env vars so seller runtime works without config.json */
function syncEnvVars(): void {
  const cfg = readConfig();
  const agent = getActiveAgent();

  const vars: Record<string, string> = {};

  if (cfg.rpc) vars.RPC_URL = cfg.rpc;
  if (cfg.apiUrl) vars.ACP_API_URL = cfg.apiUrl;
  if (cfg.chatUrl) vars.CHAT_URL = cfg.chatUrl;
  if (cfg.anthropicApiKey) vars.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (cfg.anthropicModel) vars.ANTHROPIC_MODEL = cfg.anthropicModel;
  if (cfg.pollInterval) vars.POLL_INTERVAL = String(cfg.pollInterval);

  if (agent) {
    vars.WALLET_KEY = agent.wallet;
    vars.AGENT_ADDRESS = agent.address;
    vars.AGENT_DIR = agent.dir;
  }

  const entries = Object.entries(vars).filter(([, v]) => v);
  if (entries.length === 0) {
    output.warn("No config values to sync.");
    return;
  }

  output.log(`  Syncing ${entries.length} env vars to Railway...`);
  // Set all variables in a single command to avoid triggering multiple deploys
  const args = ["variables", "set", ...entries.map(([k, v]) => `${k}=${v}`)];
  const result = spawnSync("railway", args, { cwd: ROOT, stdio: "pipe" });
  if (result.status !== 0) {
    const err = result.stderr?.toString().trim() || "unknown error";
    output.fatal(`Failed to set env vars: ${err}`);
  }
  output.success("Environment variables synced.");
}

export async function setup(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal(
      "Railway CLI not found. Install: npm i -g @railway/cli\n  Then: railway login"
    );
  }

  output.heading("Railway Setup");

  output.log("  Logging in to Railway...");
  try {
    runRailway(["login"], true);
  } catch {
    output.fatal("Railway login failed.");
  }

  output.log("  Creating Railway project...");
  try {
    runRailway(["init"], true);
    output.success("Railway project created.");
  } catch {
    output.warn("Project may already exist. Continuing...");
  }

  output.log("  Linking service...");
  ensureService();

  output.success("Railway setup complete. Run `acp serve deploy railway` to deploy.\n");
}

export async function deploy(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found. Run `acp serve deploy railway setup` first.");
  }

  output.heading("Deploying to Railway");

  // Generate Dockerfile if not present
  const dockerfilePath = path.join(ROOT, "Dockerfile");
  if (!fs.existsSync(dockerfilePath)) {
    output.log("  Generating Dockerfile...");
    fs.writeFileSync(dockerfilePath, generateDockerfile());
    output.success("Dockerfile created.");
  }

  // Generate .dockerignore if not present
  const dockerignorePath = path.join(ROOT, ".dockerignore");
  if (!fs.existsSync(dockerignorePath)) {
    fs.writeFileSync(
      dockerignorePath,
      "node_modules\n.env\nconfig.json\nlogs\n.git\n"
    );
  }

  // Ensure a service is linked (Railway requires it for variables + deploy)
  ensureService();

  // Sync config → Railway env vars (since config.json is excluded from Docker image)
  syncEnvVars();

  output.log("  Deploying...");
  try {
    runRailway(["up", "--detach"], true);
    output.success("Deployment started. Check status with `acp serve deploy railway status`.\n");
  } catch (e: any) {
    output.fatal(`Deploy failed: ${e.message}`);
  }
}

export async function status(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  try {
    const result = runRailway(["status"]);
    output.heading("Railway Deployment Status");
    output.log(result || "  No active deployment found.");
    output.log("");
  } catch (e: any) {
    output.fatal(`Failed to get status: ${e.message}`);
  }
}

export async function logs(follow = false): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  const args = ["logs"];
  if (follow) args.push("--follow");

  try {
    const child = spawn("railway", args, { cwd: ROOT, stdio: "inherit" });
    child.on("close", () => {});
  } catch (e: any) {
    output.fatal(`Failed to get logs: ${e.message}`);
  }
}

export async function teardown(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  output.log("  Removing Railway deployment...");
  try {
    runRailway(["down"], true);
    output.success("Deployment removed.\n");
  } catch (e: any) {
    output.fatal(`Teardown failed: ${e.message}`);
  }
}

export async function env(): Promise<void> {
  if (!checkRailwayCli()) {
    output.fatal("Railway CLI not found.");
  }

  ensureService();

  try {
    const result = runRailway(["variables"]);
    output.heading("Railway Environment Variables");
    output.log(result || "  No variables set.");
    output.log("");
  } catch (e: any) {
    output.fatal(`Failed to list env vars: ${e.message}`);
  }
}

export async function envSet(keyValue: string): Promise<void> {
  if (!keyValue || !keyValue.includes("=")) {
    output.fatal("Usage: acp serve deploy railway env set KEY=value");
  }

  ensureService();

  try {
    runRailway(["variables", "set", keyValue]);
    output.success(`Variable set: ${keyValue.split("=")[0]}. Redeploy to apply.`);
  } catch (e: any) {
    output.fatal(`Failed to set variable: ${e.message}`);
  }
}

export async function envDelete(key: string): Promise<void> {
  if (!key) {
    output.fatal("Usage: acp serve deploy railway env delete KEY");
  }

  ensureService();

  try {
    runRailway(["variables", "delete", key]);
    output.success(`Variable deleted: ${key}. Redeploy to apply.`);
  } catch (e: any) {
    output.fatal(`Failed to delete variable: ${e.message}`);
  }
}

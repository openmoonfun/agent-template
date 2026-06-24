// =============================================================================
// acp profile show    — Show agent profile
// acp profile update  — Update agent info
// =============================================================================

import * as output from "../lib/output";
import { readConfig, writeConfig, getActiveAgent, getAgentAddress } from "../lib/config";
import { getKeypair } from "../lib/program";
import { getClient } from "../lib/client";

export async function show(): Promise<void> {
  const agent = getActiveAgent();

  let wallet = "(not configured)";
  try {
    wallet = getKeypair().publicKey.toBase58();
  } catch (e) { console.debug("[profile] getKeypair:", e); }

  // Try to enrich from indexer API
  let agentData: any = null;
  try {
    const address = getAgentAddress();
    const { data } = await getClient().get(`/acp/agent/${address || wallet}`);
    agentData = data;
  } catch (e) { console.debug("[profile] agent lookup:", e); }

  const info = {
    name: agent?.name || "(not set)",
    wallet,
    address: agent?.address || getAgentAddress() || "(not set)",
    mint: agent?.mint || "(not set)",
    dir: agent?.dir || "default",
    description: agentData?.description || "(none)",
    offerings: agentData?.offerings || [],
  };

  output.output(info, (data) => {
    output.heading("Agent Profile");
    output.field("Name", data.name);
    output.field("Wallet", data.wallet);
    output.field("Address", data.address);
    output.field("Mint", data.mint);
    output.field("Dir", data.dir);
    output.field("Description", data.description);
    if (data.offerings?.length > 0) {
      output.log("\n  Offerings:");
      for (const o of data.offerings) {
        output.log(`    - ${o.name}  fee: ${o.fee} (${o.feeType})`);
      }
    }
    output.log("");
  });
}

export async function update(key: string, value: string): Promise<void> {
  const localKeys = ["name", "mint", "dir", "wallet"];
  const apiKeys = ["description"];
  const supportedKeys = [...localKeys, ...apiKeys];

  if (!key?.trim() || !value?.trim()) {
    output.fatal(
      `Usage: acp profile update <key> <value>\n  Supported keys: ${supportedKeys.join(", ")}`
    );
  }

  if (!supportedKeys.includes(key)) {
    output.fatal(`Invalid key: ${key}. Supported keys: ${supportedKeys.join(", ")}`);
  }

  // API-side fields (stored in indexer DB)
  if (apiKeys.includes(key)) {
    let wallet: string;
    try {
      wallet = getKeypair().publicKey.toBase58();
    } catch {
      return output.fatal("Wallet not configured. Run `acp setup` first.");
    }

    try {
      const address = getAgentAddress();
      await getClient().put(`/acp/agent/${address || wallet}`, { [key]: value });
    } catch (e: any) {
      return output.fatal(`Failed to update ${key}: ${e.message || e}`);
    }

    output.output({ updated: key, value }, () => {
      output.heading("Profile Updated");
      output.log(`  ${key} set to: "${value}"\n`);
    });
    return;
  }

  // Local config fields
  const config = readConfig();
  const agentName = config.activeAgent;

  if (!agentName || !config.agents?.[agentName]) {
    output.fatal("No active agent. Run `acp setup` or `acp agent create` first.");
  }

  if (key === "name") {
    const agent = config.agents![agentName];
    delete config.agents![agentName];
    config.agents![value] = agent;
    config.activeAgent = value;
  } else {
    (config.agents![agentName] as any)[key] = value;
  }

  writeConfig(config);

  output.output({ updated: key, value }, () => {
    output.heading("Profile Updated");
    output.log(`  ${key} set to: "${value}"\n`);
  });
}

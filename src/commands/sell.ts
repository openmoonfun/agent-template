// =============================================================================
// acp sell init <name>     — Scaffold a new offering
// acp sell create <name>   — Validate offering locally
// acp sell delete <name>   — Remove offering
// acp sell list            — Show all offerings with status
// acp sell inspect <name>  — Detailed view of single offering
//
// acp sell resource init <name>     — Scaffold a new resource
// acp sell resource create <name>   — Validate + register resource
// acp sell resource delete <name>   — Delete resource
// acp sell resource list            — Show all resources
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as output from "../lib/output";
import { ROOT, getAgentDir as configGetAgentDir, getAgentAddress } from "../lib/config";
import { getKeypair } from "../lib/program";
import { getClient } from "../lib/client";

/** Offerings base: src/seller/offerings/ */
const OFFERINGS_BASE = path.resolve(ROOT, "src", "seller", "offerings");

/** Offerings root for the current agent */
function getOfferingsRoot(): string {
  return path.resolve(OFFERINGS_BASE, configGetAgentDir());
}

/** Resources live at src/seller/resources/ */
const RESOURCES_ROOT = path.resolve(ROOT, "src", "seller", "resources");

interface OfferingJson {
  name: string;
  description: string;
  fee: number;
  feeType: "fixed" | "percentage";
  slaMinutes?: number;
  requiredFunds: boolean;
  requirement?: Record<string, any>;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function resolveOfferingDir(offeringName: string): string {
  return path.resolve(getOfferingsRoot(), offeringName);
}

function validateOfferingJson(filePath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`offering.json not found at ${filePath}`);
    return result;
  }

  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    result.valid = false;
    result.errors.push(`Invalid JSON in offering.json: ${err}`);
    return result;
  }

  if (!json.name || typeof json.name !== "string" || json.name.trim() === "") {
    result.valid = false;
    result.errors.push(
      'offering.json: "name" is required — set to a non-empty string matching the directory name'
    );
  }
  if (!json.description || typeof json.description !== "string" || json.description.trim() === "") {
    result.valid = false;
    result.errors.push(
      'offering.json: "description" is required — describe what this service does for buyers'
    );
  }
  if (json.fee === undefined || json.fee === null) {
    result.valid = false;
    result.errors.push('offering.json: "fee" is required — set to a number');
  } else if (typeof json.fee !== "number") {
    result.valid = false;
    result.errors.push('offering.json: "fee" must be a number');
  }

  if (json.feeType === undefined || json.feeType === null) {
    result.valid = false;
    result.errors.push('offering.json: "feeType" is required ("fixed" or "percentage")');
  } else if (json.feeType !== "fixed" && json.feeType !== "percentage") {
    result.valid = false;
    result.errors.push('offering.json: "feeType" must be either "fixed" or "percentage"');
  }

  if (typeof json.fee === "number" && json.feeType) {
    if (json.feeType === "fixed" && json.fee < 0) {
      result.valid = false;
      result.errors.push('offering.json: "fee" must be non-negative for fixed fee type');
    }
    if (json.feeType === "percentage" && (json.fee < 0.001 || json.fee > 0.99)) {
      result.valid = false;
      result.errors.push(
        'offering.json: "fee" must be >= 0.001 and <= 0.99 for percentage fee type (e.g. 0.5 = 50%)'
      );
    }
  }

  if (json.requiredFunds === undefined || json.requiredFunds === null) {
    result.valid = false;
    result.errors.push('offering.json: "requiredFunds" is required (true or false)');
  } else if (typeof json.requiredFunds !== "boolean") {
    result.valid = false;
    result.errors.push('offering.json: "requiredFunds" must be true or false');
  }

  return result;
}

function validateHandlers(filePath: string, requiredFunds?: boolean): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`handlers.ts not found at ${filePath}`);
    return result;
  }

  const content = fs.readFileSync(filePath, "utf-8");

  const executeJobPatterns = [
    /export\s+(async\s+)?function\s+executeJob\s*\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?function/,
    /export\s*\{\s*[^}]*executeJob[^}]*\}/,
  ];

  if (!executeJobPatterns.some((p) => p.test(content))) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: must export an "executeJob" function — this is the required handler'
    );
  }

  const hasValidate = [
    /export\s+(async\s+)?function\s+validateRequirements\s*\(/,
    /export\s+const\s+validateRequirements\s*=/,
  ].some((p) => p.test(content));

  if (!hasValidate) {
    result.warnings.push(
      'handlers.ts: optional "validateRequirements" handler not found — requests will be accepted without validation'
    );
  }

  return result;
}

// -- Sync offerings to indexer --

export async function syncDescription(): Promise<void> {
  const offerings = listLocalOfferings();
  if (offerings.length === 0) return;

  let wallet: string;
  try {
    wallet = getKeypair().publicKey.toBase58();
  } catch {
    return;
  }

  const lines = offerings.map((o) => {
    const fee =
      o.feeType === "percentage"
        ? `${(o.fee * 100).toFixed(1)}%`
        : `$${o.fee} USDC`;
    return `• ${o.name} (${fee}) — ${o.description}`;
  });

  try {
    const address = getAgentAddress();
    await getClient().put(`/acp/agent/${address || wallet}`, {
      description: lines.join("\n"),
      offerings: offerings.map((o) => ({
        name: o.name,
        description: o.description,
        fee: o.fee,
        feeType: o.feeType,
        slaMinutes: o.slaMinutes,
        requiredFunds: o.requiredFunds,
        requirement: o.requirement,
        deliverable: o.deliverable,
      })),
    });
  } catch {
    // indexer may be offline, silently skip
  }
}

// -- Init: scaffold a new offering --

export async function init(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell init <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (fs.existsSync(dir)) {
    output.fatal(`Offering directory already exists: ${dir}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const offeringJson: Record<string, unknown> = {
    name: offeringName,
    description: "",
    fee: null,
    feeType: null,
    requiredFunds: false,
    requirement: {},
  };

  fs.writeFileSync(path.join(dir, "offering.json"), JSON.stringify(offeringJson, null, 2) + "\n");

  const handlersTemplate = `import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes";

// Required: implement your service logic here
export async function executeJob(request: any): Promise<ExecuteJobResult> {
  // TODO: Implement your service
  return { deliverable: "TODO: Return your result" };
}

// Optional: validate incoming requests
export function validateRequirements(request: any): ValidationResult {
  return { valid: true };
}

// Optional: provide custom payment request message
export function requestPayment(request: any): string {
  return "Request accepted";
}
`;

  fs.writeFileSync(path.join(dir, "handlers.ts"), handlersTemplate);

  const agentDir = configGetAgentDir();
  output.output({ created: dir }, () => {
    output.heading("Offering Scaffolded");
    output.log(`  Created: src/seller/offerings/${agentDir}/${offeringName}/`);
    output.log(`    - offering.json  (edit name, description, fee, feeType, requirements)`);
    output.log(`    - handlers.ts    (implement executeJob)`);
    output.log(`\n  Next: edit the files, then run: acp sell create ${offeringName}\n`);
  });
}

// -- Create: validate offering --

export async function create(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell create <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    output.fatal(
      `Offering directory not found: ${dir}\n  Create it with: acp sell init ${offeringName}`
    );
  }

  output.log(`\nValidating offering: "${offeringName}"\n`);

  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  output.log("  Checking offering.json...");
  const jsonPath = path.join(dir, "offering.json");
  const jsonResult = validateOfferingJson(jsonPath);
  allErrors.push(...jsonResult.errors);
  allWarnings.push(...jsonResult.warnings);

  let parsedOffering: OfferingJson | null = null;
  if (jsonResult.valid) {
    parsedOffering = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    output.log(`    Valid — Name: "${parsedOffering!.name}"`);
    output.log(`             Fee: ${parsedOffering!.fee} (${parsedOffering!.feeType})`);
    output.log(`             Funds required: ${parsedOffering!.requiredFunds}`);
  } else {
    output.log("    Invalid");
  }

  output.log("\n  Checking handlers.ts...");
  const handlersPath = path.join(dir, "handlers.ts");
  const handlersResult = validateHandlers(handlersPath, parsedOffering?.requiredFunds);
  allErrors.push(...handlersResult.errors);
  allWarnings.push(...handlersResult.warnings);

  if (handlersResult.valid) {
    output.log("    Valid — executeJob handler found");
  } else {
    output.log("    Invalid");
  }

  output.log("\n" + "-".repeat(50));

  if (allWarnings.length > 0) {
    output.log("\n  Warnings:");
    allWarnings.forEach((w) => output.log(`    - ${w}`));
  }

  if (allErrors.length > 0) {
    output.log("\n  Errors:");
    allErrors.forEach((e) => output.log(`    - ${e}`));
    output.fatal("\n  Validation failed. Fix the errors above.");
  }

  output.log("\n  Validation passed!");

  // Auto-sync agent description from all offerings
  await syncDescription();

  output.log("  Offering is ready. Run `acp serve start` to begin accepting jobs.\n");
}

// -- Delete: remove offering --

export async function del(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell delete <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (!fs.existsSync(dir)) {
    output.fatal(`Offering not found: ${offeringName}`);
  }

  fs.rmSync(dir, { recursive: true });
  output.success(`Offering "${offeringName}" removed.`);
}

// -- List: show all offerings --

interface LocalOffering {
  dirName: string;
  name: string;
  description: string;
  fee: number;
  feeType: string;
  slaMinutes: number;
  requiredFunds: boolean;
  requirement: Record<string, any>;
  deliverable: Record<string, any>;
}

function listLocalOfferings(): LocalOffering[] {
  const offeringsRoot = getOfferingsRoot();
  if (!fs.existsSync(offeringsRoot)) return [];

  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const configPath = path.join(offeringsRoot, d.name, "offering.json");
      if (!fs.existsSync(configPath)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return {
          dirName: d.name,
          name: json.name ?? d.name,
          description: json.description ?? "",
          fee: json.fee ?? 0,
          feeType: json.feeType ?? "fixed",
          slaMinutes: json.slaMinutes ?? 30,
          requiredFunds: json.requiredFunds ?? false,
          requirement: json.requirement ?? {},
          deliverable: json.deliverable ?? {},
        };
      } catch {
        return null;
      }
    })
    .filter((o): o is LocalOffering => o !== null);
}

export async function list(): Promise<void> {
  const offerings = listLocalOfferings();

  output.output(offerings, (data) => {
    output.heading("Job Offerings");

    if (data.length === 0) {
      output.log("  No offerings found. Run `acp sell init <name>` to create one.\n");
      return;
    }

    for (const o of data) {
      output.log(`\n  ${o.name}`);
      output.field("    Description", o.description);
      output.field("    Fee", `${o.fee} (${o.feeType})`);
      output.field("    Funds required", String(o.requiredFunds));
    }
    output.log("");
  });
}

// -- Inspect: detailed view --

function detectHandlers(offeringDir: string): string[] {
  const handlersPath = path.join(getOfferingsRoot(), offeringDir, "handlers.ts");
  if (!fs.existsSync(handlersPath)) return [];

  const content = fs.readFileSync(handlersPath, "utf-8");
  const found: string[] = [];

  if (/export\s+(async\s+)?function\s+executeJob\s*\(/.test(content)) found.push("executeJob");
  if (/export\s+(async\s+)?function\s+validateRequirements\s*\(/.test(content))
    found.push("validateRequirements");
  if (/export\s+(async\s+)?function\s+requestPayment\s*\(/.test(content))
    found.push("requestPayment");

  return found;
}

export async function inspect(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell inspect <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  const configPath = path.join(dir, "offering.json");

  if (!fs.existsSync(configPath)) {
    output.fatal(`Offering not found: ${offeringName}`);
  }

  const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const handlers = detectHandlers(offeringName);

  const data = { ...json, handlers };

  output.output(data, (d) => {
    output.heading(`Offering: ${d.name}`);
    output.field("Description", d.description);
    output.field("Fee", `${d.fee} (${d.feeType})`);
    output.field("Funds required", String(d.requiredFunds));
    output.field("Handlers", d.handlers.join(", ") || "(none)");
    if (d.requirement && Object.keys(d.requirement).length > 0) {
      output.log("\n  Requirement Schema:");
      output.log(
        JSON.stringify(d.requirement, null, 4)
          .split("\n")
          .map((line: string) => `    ${line}`)
          .join("\n")
      );
    }
    output.log("");
  });
}

// =============================================================================
// Resource Management
// =============================================================================

function resolveResourceDir(resourceName: string): string {
  return path.resolve(RESOURCES_ROOT, resourceName);
}

export async function resourceInit(resourceName: string): Promise<void> {
  if (!resourceName) {
    output.fatal("Usage: acp sell resource init <resource_name>");
  }

  const dir = resolveResourceDir(resourceName);
  if (fs.existsSync(dir)) {
    output.fatal(`Resource directory already exists: ${dir}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const resourceJson = {
    name: resourceName,
    description: "TODO: Describe what this resource provides",
    url: "https://api.example.com/endpoint",
  };

  fs.writeFileSync(path.join(dir, "resources.json"), JSON.stringify(resourceJson, null, 2) + "\n");

  output.output({ created: dir }, () => {
    output.heading("Resource Scaffolded");
    output.log(`  Created: src/seller/resources/${resourceName}/`);
    output.log(`    - resources.json  (edit name, description, url)`);
    output.log(`\n  Next: edit the file, then run: acp sell resource create ${resourceName}\n`);
  });
}

function validateResourceJson(filePath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`resources.json not found at ${filePath}`);
    return result;
  }

  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    result.valid = false;
    result.errors.push(`Invalid JSON: ${err}`);
    return result;
  }

  if (!json.name || typeof json.name !== "string") {
    result.valid = false;
    result.errors.push('"name" is required');
  }
  if (!json.description || typeof json.description !== "string") {
    result.valid = false;
    result.errors.push('"description" is required');
  }
  if (!json.url || typeof json.url !== "string") {
    result.valid = false;
    result.errors.push('"url" is required');
  }

  return result;
}

export async function resourceCreate(resourceName: string): Promise<void> {
  if (!resourceName) {
    output.fatal("Usage: acp sell resource create <resource_name>");
  }

  const dir = resolveResourceDir(resourceName);
  if (!fs.existsSync(dir)) {
    output.fatal(
      `Resource not found: ${dir}\n  Create it with: acp sell resource init ${resourceName}`
    );
  }

  const jsonPath = path.join(dir, "resources.json");
  const validation = validateResourceJson(jsonPath);

  if (!validation.valid) {
    validation.errors.forEach((e) => output.log(`    - ${e}`));
    output.fatal("Validation failed.");
  }

  output.success(`Resource "${resourceName}" validated and ready.`);
}

export async function resourceDelete(resourceName: string): Promise<void> {
  if (!resourceName) {
    output.fatal("Usage: acp sell resource delete <resource_name>");
  }

  const dir = resolveResourceDir(resourceName);
  if (!fs.existsSync(dir)) {
    output.fatal(`Resource not found: ${resourceName}`);
  }

  fs.rmSync(dir, { recursive: true });
  output.success(`Resource "${resourceName}" removed.`);
}

export async function resourceList(): Promise<void> {
  if (!fs.existsSync(RESOURCES_ROOT)) {
    output.log("  No resources found.\n");
    return;
  }

  const resources = fs
    .readdirSync(RESOURCES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const jsonPath = path.join(RESOURCES_ROOT, d.name, "resources.json");
      if (!fs.existsSync(jsonPath)) return null;
      try {
        return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  output.output(resources, (data) => {
    output.heading("Resources");
    if (data.length === 0) {
      output.log("  No resources found.\n");
      return;
    }
    for (const r of data) {
      output.log(`\n  ${r.name}`);
      output.field("    Description", r.description);
      output.field("    URL", r.url);
    }
    output.log("");
  });
}

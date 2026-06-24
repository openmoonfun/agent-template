#!/usr/bin/env npx tsx
import "dotenv/config";
import { setJsonMode, error, log } from "../src/lib/output";
import * as walletCmd from "../src/commands/wallet";
import * as job from "../src/commands/job";
import * as searchCmd from "../src/commands/search";
import * as serve from "../src/commands/serve";
import * as sell from "../src/commands/sell";
import * as resource from "../src/commands/resource";
import * as profile from "../src/commands/profile";
import * as setup from "../src/commands/setup";
import * as agentCmd from "../src/commands/agent";
import * as deploy from "../src/commands/deploy";
import * as reviewCmd from "../src/commands/review";

const args = process.argv.slice(2);

// Global flags
if (args.includes("--json") || process.env.ACP_JSON === "1") {
  setJsonMode(true);
  const idx = args.indexOf("--json");
  if (idx !== -1) args.splice(idx, 1);
}

if (args.includes("--version") || args.includes("-v")) {
  log("acp v0.2.0");
  process.exit(0);
}

const command = args[0];
const sub = args[1];

function flag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

async function main() {
  switch (command) {
    // ─── Setup ──────────────────────────────────────────────
    case "setup":
      await setup.setup();
      break;

    case "whoami":
      await setup.whoami();
      break;

    // ─── Agent Management ───────────────────────────────────
    case "agent": {
      switch (sub) {
        case "list":
          await agentCmd.list();
          break;
        case "switch": {
          const name = args[2];
          if (!name) { error("Usage: acp agent switch <name>"); process.exit(1); }
          await agentCmd.switchAgent(name);
          break;
        }
        case "create": {
          const name = args[2];
          if (!name) { error("Usage: acp agent create <name>"); process.exit(1); }
          await agentCmd.create(name);
          break;
        }
        case "import": {
          const name = args[2];
          const mint = flag("--mint");
          if (!name || !mint) { error("Usage: acp agent import <name> --mint <address>"); process.exit(1); }
          await agentCmd.importAgent(name, mint);
          break;
        }
        default:
          error(`Unknown agent command: ${sub}`);
          log("Commands: list, switch, create, import");
          process.exit(1);
      }
      break;
    }

    // ─── Wallet ─────────────────────────────────────────────
    case "wallet": {
      switch (sub) {
        case "balance":
          await walletCmd.balance();
          break;
        case "airdrop":
          await walletCmd.airdrop(args[2] ? Number(args[2]) : undefined);
          break;
        default:
          await walletCmd.address();
          break;
      }
      break;
    }

    // ─── Jobs ───────────────────────────────────────────────
    case "job": {
      switch (sub) {
        case "create": {
          const agentAddress = args[2];
          const provider = args[3];
          if (!agentAddress || !provider) {
            error("Usage: acp job create <agentAddress> <provider> [--requirements '<json>'] [--evaluator <addr>] [--expiry <timestamp>] [--isAutomated <true|false>]");
            process.exit(1);
          }
          await job.create(agentAddress, provider, {
            requirements: flag("--requirements"),
            evaluator: flag("--evaluator"),
            expiredAt: flag("--expiry") ? Number(flag("--expiry")) : undefined,
            isAutomated: flag("--isAutomated") === "true",
          });
          break;
        }
        case "status": {
          const id = args[2];
          if (!id) { error("Usage: acp job status <jobId>"); process.exit(1); }
          await job.status(id);
          break;
        }
        case "accept": {
          const id = args[2];
          if (!id) { error("Usage: acp job accept <jobId> [--reject] [--reason 'text']"); process.exit(1); }
          await job.accept(id, !hasFlag("--reject"), flag("--reason"));
          break;
        }
        case "memo": {
          const id = args[2];
          const type = args[3];
          const content = args[4];
          if (!id || !type || !content) {
            error("Usage: acp job memo <jobId> <memoType> '<content>'");
            process.exit(1);
          }
          await job.memo(id, type, content);
          break;
        }
        case "sign": {
          const id = args[2];
          const memoId = args[3];
          if (!id || !memoId) {
            error("Usage: acp job sign <jobId> <memoId> [--reject] [--reason 'text']");
            process.exit(1);
          }
          await job.sign(id, memoId, !hasFlag("--reject"), flag("--reason"));
          break;
        }
        case "budget": {
          const id = args[2];
          const amount = args[3];
          const fee = args[4] || "0";
          if (!id || !amount) { error("Usage: acp job budget <jobId> <amount> [fee]"); process.exit(1); }
          await job.setBudget(id, Number(amount), Number(fee));
          break;
        }
        case "deposit": {
          const id = args[2];
          if (!id) { error("Usage: acp job deposit <jobId>"); process.exit(1); }
          await job.deposit(id);
          break;
        }
        case "claim": {
          const id = args[2];
          if (!id) { error("Usage: acp job claim <jobId>"); process.exit(1); }
          await job.claim(id);
          break;
        }
        case "claim-fee": {
          const id = args[2];
          if (!id) { error("Usage: acp job claim-fee <jobId>"); process.exit(1); }
          await job.claimFee(id);
          break;
        }
        case "pay": {
          const id = args[2];
          if (!id) { error("Usage: acp job pay <jobId> --accept <true|false> [--content 'text']"); process.exit(1); }
          const accept = flag("--accept") !== "false";
          await job.pay(id, accept, flag("--content"));
          break;
        }
        case "active":
          await job.active({ page: Number(flag("--page") || 1), role: flag("--role") });
          break;
        case "completed":
          await job.completed({ page: Number(flag("--page") || 1), role: flag("--role") });
          break;
        default:
          error(`Unknown job command: ${sub}`);
          log("Commands: create, status, accept, memo, sign, budget, deposit, claim, active, completed");
          process.exit(1);
      }
      break;
    }

    // ─── Search ─────────────────────────────────────────────
    case "browse":
    case "search": {
      const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      await searchCmd.search(query, {
        page: flag("--page") ? Number(flag("--page")) : undefined,
        pageSize: flag("--page-size") ? Number(flag("--page-size")) : undefined,
      });
      break;
    }

    // ─── Profile ────────────────────────────────────────────
    case "profile": {
      switch (sub) {
        case "update": {
          const key = args[2];
          const value = args.slice(3).filter((a) => !a.startsWith("--")).join(" ");
          await profile.update(key, value);
          break;
        }
        default:
          await profile.show();
          break;
      }
      break;
    }

    // ─── Sell (Offerings & Resources) ───────────────────────
    case "sell": {
      if (sub === "resource") {
        const resourceSub = args[2];
        const resourceName = args[3];
        switch (resourceSub) {
          case "init":
            await sell.resourceInit(resourceName);
            break;
          case "create":
            await sell.resourceCreate(resourceName);
            break;
          case "delete":
            await sell.resourceDelete(resourceName);
            break;
          case "list":
            await sell.resourceList();
            break;
          default:
            error(`Unknown resource command: ${resourceSub}`);
            log("Commands: init, create, delete, list");
            process.exit(1);
        }
        break;
      }

      const offeringName = args[2];
      switch (sub) {
        case "init":
          await sell.init(offeringName);
          break;
        case "create":
          await sell.create(offeringName);
          break;
        case "delete":
          await sell.del(offeringName);
          break;
        case "list":
          await sell.list();
          break;
        case "inspect":
          await sell.inspect(offeringName);
          break;
        default:
          error(`Unknown sell command: ${sub}`);
          log("Commands: init, create, delete, list, inspect, resource");
          process.exit(1);
      }
      break;
    }

    // ─── Resource Query ─────────────────────────────────────
    case "resource": {
      if (sub === "query") {
        const url = args[2];
        const paramsRaw = flag("--params");
        let params: Record<string, any> | undefined = undefined;
        if (paramsRaw) {
          try {
            const parsed = JSON.parse(paramsRaw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              error("--params must be a JSON object");
              process.exit(1);
            }
            params = parsed;
          } catch (e: any) {
            error(`Invalid JSON in --params: ${e.message}`);
            process.exit(1);
          }
        }
        await resource.query(url, params);
      } else {
        error("Usage: acp resource query <url> [--params '<json>']");
        process.exit(1);
      }
      break;
    }

    // ─── Serve ──────────────────────────────────────────────
    case "serve": {
      if (sub === "deploy") {
        const deploySub = args[2];

        // ── Railway (self-hosted) deploy ──
        if (deploySub !== "railway") {
          error("Usage: acp serve deploy railway [subcommand]");
          process.exit(1);
        }
        const railwaySub = args[3];
        switch (railwaySub) {
          case "setup":
            await deploy.setup();
            break;
          case "status":
            await deploy.status();
            break;
          case "logs":
            await deploy.logs(hasFlag("-f") || hasFlag("--follow"));
            break;
          case "teardown":
            await deploy.teardown();
            break;
          case "env": {
            const envSub = args[4];
            if (envSub === "set") {
              await deploy.envSet(args[5]);
            } else if (envSub === "delete") {
              await deploy.envDelete(args[5]);
            } else {
              await deploy.env();
            }
            break;
          }
          case undefined:
            await deploy.deploy();
            break;
          default:
            error(`Unknown deploy command: ${railwaySub}`);
            log("Commands: setup, status, logs, teardown, env");
            process.exit(1);
        }
        break;
      }

      switch (sub) {
        case "start": await serve.start(hasFlag("--all")); break;
        case "stop": serve.stop(hasFlag("--all")); break;
        case "status": serve.status(hasFlag("--all")); break;
        case "logs": serve.logs(hasFlag("-f") || hasFlag("--follow"), flag("--filter"), flag("--agent") || undefined); break;
        default:
          error(`Unknown serve command: ${sub}`);
          log("Commands: start, stop, status, logs, deploy");
          process.exit(1);
      }
      break;
    }

    // ─── Review ────────────────────────────────────────────
    case "review": {
      switch (sub) {
        case "show":
          await reviewCmd.show(args[2]);
          break;
        case "job":
          await reviewCmd.job(args[2]);
          break;
        default:
          error("Usage: acp review [show <agentAddress> | job <jobAddress>]");
          process.exit(1);
      }
      break;
    }

    // ─── Help ───────────────────────────────────────────────
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;

    default:
      error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  log(`
acp — Agent Commerce Protocol CLI

Usage: acp <command> [subcommand] [args] [flags]

Commands:
  setup                                Interactive setup
  whoami                               Show current agent profile

  agent list                           Show all agents
  agent create <name>                  Create a new agent
  agent switch <name>                  Switch active agent

  wallet [address|balance]             Wallet info
  wallet airdrop [amount]              Request SOL airdrop (devnet)

  browse <query>                       Search agents
    --page <n>                         Page number (default: 1)
    --page-size <n>                    Results per page (default: 10)
  profile [show]                       Show agent profile
  profile update <key> <value>         Update profile

  job create <mint> <provider>         Create a job
    --isAutomated true                 Auto-pay when provider accepts
  job status <id>                      Get job details
  job accept <id> [--reject]           Accept/reject a job
  job memo <id> <type> '<content>'     Create a memo
  job sign <id> <memoId> [--reject]    Sign a memo
  job budget <id> <amount>             Set job budget
  job pay <id> --accept true|false      Approve/reject payment (budget+deposit)
  job deposit <id>                     Deposit to escrow
  job claim <id>                       Claim budget
  job claim-fee <id>                   Claim fee (protocol + client refund)
  job active [--role client|provider]  List active jobs
  job completed                        List completed jobs

  review show <agentAddress>           Show reviews for an agent
  review job <jobAddress>              Show review for a job

  sell init <name>                     Scaffold a new offering
  sell create <name>                   Validate offering
  sell delete <name>                   Remove offering
  sell list                            List all offerings
  sell inspect <name>                  Detailed offering view
  sell resource init <name>            Scaffold a resource
  sell resource create <name>          Validate resource
  sell resource delete <name>          Remove resource
  sell resource list                   List resources

  resource query <url>                 Query a resource URL
    --params '<json>'                  Optional query params

  serve start [--all]                   Start seller (or all agents)
  serve stop [--all]                    Stop seller (or all agents)
  serve status [--all]                  Show status (or all agents)
  serve logs [-f] [--agent <name>]      Show logs
  serve deploy railway                 Deploy to Railway (self-hosted)
  serve deploy railway setup           Setup Railway project
  serve deploy railway status          Show deployment status
  serve deploy railway logs [-f]       Show deployment logs
  serve deploy railway teardown        Remove deployment
  serve deploy railway env             List env vars
  serve deploy railway env set K=V     Set env var
  serve deploy railway env delete K    Delete env var

Flags:
  --json          JSON output mode
  --help, -h      Show help
  --version, -v   Show version

Environment:
  ACP_API_URL     API base URL (default: http://localhost:3001)
  WALLET_KEY      Wallet keypair (JSON array or file path)
  RPC_URL         Solana RPC URL (default: http://127.0.0.1:8899)
  AGENT_DIR       Agent offerings directory (default: "default")
`);
}

// Global crash handlers — surface unhandled async errors with a consistent
// message instead of the default Node dump, and exit non-zero so CI/scripts
// can detect failure.
process.on("unhandledRejection", (reason: any) => {
  error(`Unhandled promise rejection: ${reason?.message || reason}`);
  process.exit(1);
});
process.on("uncaughtException", (err: any) => {
  error(`Uncaught exception: ${err?.message || err}`);
  process.exit(1);
});

main().catch((e) => {
  error(e.message || String(e));
  process.exit(1);
});

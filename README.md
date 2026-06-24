# ACP Agent Template

Template for creating autonomous AI agents on Solana via ACP (Agent Commerce Protocol). Sell services, earn revenue, deploy to Railway.

## Setup

```bash
npm install
npm link          # puts `acp` on your PATH (or use `npx tsx bin/acp.ts`)
```

Create `.env` from the example:

```bash
cp .env.example .env
```

Set `WALLET_KEY` in `.env` — this is the **creator wallet** that pays for on-chain transactions. JSON array of secret key bytes or path to a keypair file. Must have SOL for fees.

```env
WALLET_KEY=<json-array-or-keypair-path>
RPC_URL=https://api.devnet.solana.com
ACP_API_URL=https://your-indexer.example.com
```

## Create an Agent

### Option 1: New agent from CLI

Creates the agent on-chain, generates a provider keypair, saves everything to `config.json`.

```bash
acp agent create mybot
```

This will:
1. Generate a provider keypair (auto-saved)
2. Call `createAgent` on the ACP program
3. Activate the agent in `config.json`

### Option 2: Import agent created on frontend

If you already created an agent on the web app and have the mint address:

```bash
acp agent import mybot --mint 22JMKtCtH6hz1jJwgDCJsxwVBd9Z4hduBFscUBP9wDX4
```

This will:
1. Generate a provider keypair (auto-saved)
2. Print the provider address
3. **You must update the agent's provider on the frontend** to the printed address

## Add Offerings (Services)

```bash
acp sell init my-service          # scaffold offering template
# edit src/seller/offerings/mybot/my-service/offering.json
# edit src/seller/offerings/mybot/my-service/handlers.ts
acp sell create my-service        # validate
```

Each offering has:
- `offering.json` — name, description, fee, requirements schema
- `handlers.ts` — `executeJob()` function with your logic

## Add Resources (Free Endpoints)

Resources are like offerings but free — no on-chain payment.

```bash
acp sell resource init sol-price
# edit src/seller/resources/mybot/sol-price/resources.json
# edit src/seller/resources/mybot/sol-price/handler.ts
acp sell resource create sol-price
```

Each resource has:
- `resources.json` — name, description
- `handler.ts` — `query()` function that returns data

## Run Locally

```bash
acp serve start
```

The seller runtime:
- Connects to the indexer WebSocket
- Accepts incoming jobs automatically
- Executes your offering handlers
- Delivers results and claims payment

## Deploy to Railway

Set up Railway once, then deploy the seller runtime so it runs 24/7:

```bash
acp serve deploy railway setup
acp serve deploy railway
```

The deploy command syncs your active agent config into Railway environment variables and starts the seller runtime.

```bash
acp serve deploy railway status
acp serve deploy railway logs -f
acp serve deploy railway teardown
```

## Enable Chat

Add `ANTHROPIC_API_KEY` to `.env` to enable AI chat. The agent will respond to user messages using Claude with your offerings as tools.

```env
ANTHROPIC_API_KEY=<anthropic-api-key>
```

Agents with chat enabled are marked `hasChat: true` on the marketplace.

## Commands Reference

```
Agent Management:
  acp agent create <name>              Create agent on-chain + generate provider
  acp agent import <name> --mint <addr> Import existing agent from frontend
  acp agent list                        Show all agents
  acp agent switch <name>               Switch active agent

Wallet:
  acp wallet address                    Show wallet address
  acp wallet balance                    Show SOL + token balances
  acp wallet airdrop [amount]           Request SOL airdrop (devnet)

Marketplace:
  acp browse <query>                    Search agents
  acp job create <mint> <provider>      Create a job
  acp job status <id>                   Check job status
  acp job pay <id> --accept true        Approve payment

Offerings:
  acp sell init <name>                  Scaffold offering
  acp sell create <name>                Validate offering
  acp sell delete <name>                Remove offering
  acp sell list                         List all offerings
  acp sell resource init <name>         Scaffold resource
  acp sell resource create <name>       Validate resource

Runtime:
  acp serve start                       Start seller locally
  acp serve stop                        Stop seller
  acp serve status                      Check if running
  acp serve logs [-f]                   Show logs

Deploy:
  acp serve deploy railway setup        Setup Railway project
  acp serve deploy railway              Deploy to Railway
  acp serve deploy railway status       Show deployment status
  acp serve deploy railway logs [-f]    Show deployment logs
  acp serve deploy railway teardown     Remove deployment
```

## Configuration

`config.json` (auto-generated, git-ignored):

```json
{
  "rpc": "https://api.devnet.solana.com",
  "apiUrl": "https://your-indexer.example.com",
  "activeAgent": "mybot",
  "agents": {
    "mybot": {
      "wallet": "<json-array-or-keypair-path>",
      "mint": "22JMK...",
      "dir": "mybot"
    }
  }
}
```

`.env` variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `WALLET_KEY` | Creator wallet keypair (JSON array or file path) | Yes |
| `RPC_URL` | Solana RPC URL | Yes |
| `ACP_API_URL` | Indexer API URL | Yes |
| `ANTHROPIC_API_KEY` | Claude API key (enables chat) | No |
| `POLL_INTERVAL` | Job poll interval in ms | No (default: 10000) |

## Project Structure

```
acp-template/
├── bin/
│   └── acp.ts                    # CLI entry point
├── src/
│   ├── commands/                 # Command handlers
│   │   ├── agent.ts              #   agent create/import/list/switch
│   │   ├── deploy.ts             #   Railway deployment
│   │   ├── job.ts                #   job create/status/accept/claim/pay/...
│   │   ├── profile.ts            #   profile show/update
│   │   ├── resource.ts           #   resource query
│   │   ├── review.ts             #   review show/job
│   │   ├── search.ts             #   browse/search agents
│   │   ├── sell.ts               #   sell init/create/delete/list/inspect + resources
│   │   ├── serve.ts              #   serve start/stop/status/logs
│   │   ├── setup.ts              #   interactive setup
│   │   └── wallet.ts             #   wallet address/balance/airdrop
│   ├── lib/                      # Shared utilities
│   │   ├── client.ts             #   Axios HTTP client for indexer
│   │   ├── config.ts             #   Config & env loading
│   │   ├── output.ts             #   CLI output formatting
│   │   ├── pda.ts                #   Solana PDA derivation
│   │   └── program.ts            #   Anchor program + keypair
│   └── seller/
│       ├── runtime/
│       │   ├── seller.ts         #   Main seller loop (WebSocket + polling)
│       │   ├── sellerApi.ts      #   On-chain tx: accept, memo, sign, claim, transfer
│       │   ├── chatHandler.ts    #   AI chat agent (Claude with tool use)
│       │   ├── offerings.ts      #   Offering + resource loader
│       │   ├── offeringTypes.ts  #   Type definitions
│       │   └── types.ts          #   Job phases, socket events
│       ├── offerings/<agent>/    #   Your offerings (per agent directory)
│       │   └── <offering>/
│       │       ├── offering.json #     Name, description, fee, requirements
│       │       └── handlers.ts   #     executeJob() + validateRequirements()
│       └── resources/<agent>/    #   Your resources (per agent directory)
│           └── <resource>/
│               ├── resources.json #    Name, description
│               └── handler.ts    #     query() function
├── idl/
│   └── virtuals_acp.json        # Solana program IDL (Anchor)
├── references/
│   ├── acp-job.md                # Job lifecycle & commands
│   ├── seller.md                 # Creating & selling offerings
│   ├── agent-wallet.md           # Wallet management
│   ├── agent-token.md            # Token launch & monetization
│   └── deploy.md                 # Railway deployment
├── SKILL.md                      # Agent skill instructions (for AI agents)
├── Dockerfile                    # Container (node:20-slim)
├── .env.example                  # Environment template
├── config.json                   # Agent config (git-ignored)
└── package.json
```

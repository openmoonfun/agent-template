# Railway Deployment Reference

## Overview

Deploy the seller runtime to Railway for 24/7 operation. Each agent gets its own isolated deployment — switch agents and deploy separately, both keep running independently.

## Prerequisites

- Railway account — Hobby plan ($5/month) at [railway.com](https://railway.com)
- Offerings validated with `acp sell create <name>`

## Quick Start

```bash
acp serve deploy railway setup     # First-time: create project + authenticate
acp sell create my_offering        # Validate offering
acp serve deploy railway           # Deploy
acp serve deploy railway status    # Verify
```

## Commands

| Command | Description |
|---------|-------------|
| `acp serve deploy railway setup` | Create Railway project (first-time) |
| `acp serve deploy railway` | Deploy or redeploy |
| `acp serve deploy railway status` | Show deployment status |
| `acp serve deploy railway logs [-f]` | View logs (tail with `-f`) |
| `acp serve deploy railway teardown` | Remove deployment |
| `acp serve deploy railway env` | List environment variables |
| `acp serve deploy railway env set K=V` | Set env var (requires redeploy) |
| `acp serve deploy railway env delete K` | Remove env var (requires redeploy) |

## Environment Variables

Set secrets via `env set`, not in code:

```bash
acp serve deploy railway env set ANTHROPIC_API_KEY=<anthropic-api-key>
acp serve deploy railway env set RPC_URL=https://api.mainnet-beta.solana.com
acp serve deploy railway           # Redeploy to pick up changes
```

Required variables for deployment:
- `RPC_URL` — Solana RPC endpoint
- `ACP_API_URL` — Indexer API URL
- `WALLET_KEY` — Serialized wallet keypair

## Per-Agent Isolation

- Each agent gets its own Railway project
- Project IDs stored in `config.json`
- Switching agents locally doesn't affect running deployments
- All agents run independently on Railway

## Adding New Offerings

After adding a new offering locally:

```bash
acp sell create new_offering       # Validate
acp serve deploy railway           # Redeploy — rebuilds Docker image with full codebase
```

## Local vs. Railway

| Aspect | Local (`serve start`) | Railway (`deploy railway`) |
|--------|----------------------|--------------------------|
| Availability | When machine is on | 24/7 |
| Config source | `config.json` | Environment variables |
| Startup | Instant | ~1 min build |
| Cost | Free | $5/month |

Both can run simultaneously. The runtime is identical — same code, same offerings.

## Docker

The included `Dockerfile` runs the seller runtime:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["npx", "tsx", "src/seller/runtime/seller.ts"]
```

For custom deployments on other platforms, use this Dockerfile directly.

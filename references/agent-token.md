# Agent Token Reference

## Overview

Each agent can launch **one unique token** for capital formation and revenue accrual. Tokens are launched on Meteora Dynamic Bonding Curve (DBC) on Solana mainnet.

## Commands

### Launch Token

```bash
acp token launch <symbol> <description> --json
acp token launch <symbol> <description> --image <url> --json
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<symbol>` | Yes | Token ticker (e.g., `MYAGENT`) |
| `<description>` | Yes | Token description |
| `--image` | No | Token image URL |

One token per agent. Attempting to launch a second will fail.

### Token Info

```bash
acp token info --json
```

Returns token address, symbol, name, and link to the token page.

## What Tokens Enable

- **Capital formation** — raise funds for development and compute costs
- **Revenue** — earn from trading fees on token volume
- **Value accrual** — token gains value as agent capabilities and usage grow

## Token Lifecycle

1. Agent launches token via CLI
2. Token created on Meteora DBC (bonding curve pricing)
3. Trading fees flow to agent wallet automatically
4. Token value reflects agent's utility and adoption

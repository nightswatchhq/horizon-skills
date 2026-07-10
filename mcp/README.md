# horizon-ds-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **operating
Graph Horizon data services** — the companion to the [horizon-skills](../README.md) generator.
Point an MCP client (Claude Desktop/Code, Cursor) at it and inspect or run a deployed
DataService in natural language.

Read-only by default. The on-chain lifecycle tools are registered only when you
explicitly opt in (see Writes).

## Tools

**Read (always available):**
- `service_info` — a DataService's economics (min provision, burn/data-service cuts, stake ratio, thawing period).
- `provider_status` — a provider's registration, active tier count, payments destination, and tier registrations.
- `escrow_balance` — a consumer's PaymentsEscrow balance for `(payer, collector, receiver)`, incl. thawing.
- `tokens_collected` — `GraphTallyCollector.tokensCollected[...]`, the monotonic on-chain settlement floor.
- `gateway_health` — probe a horizon-core gateway's `/health` and `/ready`.

**Write (opt-in — broadcast on-chain transactions):**
- `register_provider`, `start_service`, `stop_service`, `set_payments_destination`.

## Run

```bash
npx horizon-ds-mcp
```

Or from a clone: `npm install && node server.mjs`.

### Claude Code / Desktop config

```json
{
  "mcpServers": {
    "horizon-ds": {
      "command": "npx",
      "args": ["horizon-ds-mcp"],
      "env": {
        "DS_NETWORK": "arbitrum_one",
        "DS_DATA_SERVICE": "0x8ed612666ad1853adb050f4c4c54082deca605b8"
      }
    }
  }
}
```

## Environment

| Var | Meaning | Default |
|---|---|---|
| `DS_NETWORK` | `arbitrum_sepolia` \| `arbitrum_one` | `arbitrum_sepolia` |
| `DS_RPC_URL` | override the network's RPC | network default |
| `DS_DATA_SERVICE` | default DataService address (per-tool overridable) | — |
| `DS_COLLECTOR` | override GraphTallyCollector address | network default |
| `DS_ESCROW` | override PaymentsEscrow address | network default |
| `DS_ALLOW_WRITES` | `"true"` to register the lifecycle write tools | unset (read-only) |
| `DS_OPERATOR_KEY` | `0x`-prefixed operator private key (required for writes) | — |

## Writes — safety

The lifecycle tools broadcast real transactions and are **disabled unless** both
`DS_ALLOW_WRITES=true` and `DS_OPERATOR_KEY` are set. Keep the operator key in your
environment, never in the client config you share. Transactions are signed by the
operator address and sent to the configured network — review before enabling for an
autonomous agent. `collect()` is intentionally not exposed (it needs a signed RAV; the
gateway's collector task handles settlement).

Apache-2.0. Experimental community tooling; not affiliated with The Graph Foundation.

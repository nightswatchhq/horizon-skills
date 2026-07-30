# horizon-skills

> Claude Code skills for building on The Graph's Horizon framework.

A Claude Code plugin providing skills for **The Graph's Horizon** framework. Today it ships
one skill — `create-data-service`, which **forges a complete Horizon data service** from a
short spec — plus a companion MCP server for operating what you deploy. More Horizon skills
will land here over time.

## Skills

### `create-data-service`

Every Horizon data service is the same two layers — an on-chain `DataService` contract
(reusing the shared `GraphTallyCollector`) and an off-chain Rust gateway that validates TAP
receipts, serves/proxies data, and collects fees. This skill distils that pattern, learned
from ~10 hand-built services, into a one-interview generator.

**What it generates**

- **Contract** — `<Name>DataService.sol` + interface (UUPS upgradeable, parameterised
  tiers/economics), a deploy script, and a Foundry test that deploys against a mock
  Horizon stack and exercises the provider lifecycle.
- **Gateway** — built on [`horizon-core`](https://github.com/nightswatchhq/horizon-core);
  optionally with per-endpoint compute-unit pricing.
- **Everything around it** — `gateway.toml`, `docker-compose.yml`, `Dockerfile`,
  `foundry.toml`, a contract-deps setup script, `.env.example`, `yatr.toml`, and a
  per-service README with the full deploy/run runbook.

## What's a data service (and who builds one)?

A Graph Horizon **data service** lets you sell access to data — an RPC endpoint, a REST
API, files, a custom index — and get paid in GRT, trustlessly. Consumers deposit GRT into
an escrow and send a signed micro-receipt (a **TAP** receipt) with each request; your
gateway verifies it, serves the request, periodically rolls receipts into a voucher (a
**RAV**), and redeems it on-chain via the shared `GraphTallyCollector`. To earn, a provider
stakes a GRT **provision** and `register`s on your service's contract. You build one if you
have data worth selling and want to be a paid provider on The Graph's network.

## Prerequisites

To generate and run a service you'll need:

- **[Claude Code](https://claude.com/claude-code)** — to run the skill.
- **Python 3** — the generator (`scaffold.py`).
- **[Foundry](https://book.getfoundry.sh/)** (`forge`) — build/test/deploy the contract.
- **Rust** (`cargo`, stable) — build the gateway (and, for the pipeline archetype, the indexer).
- **Docker** — the generated `docker-compose.yml` runs Postgres + the gateway.

To go *live* (beyond local build/test) you'll also need, on Arbitrum (Sepolia first):
- an **operator wallet** with a little ETH for gas,
- **GRT** to stake as a provision on your deployed service,
- an **RPC URL** and (optional) an Arbiscan key for contract verification.

The skill never invents keys — deploy scripts and the gateway read them from env.

## Two archetypes

- **`proxy`** — front an existing upstream HTTP data plane (RPC, REST, files, graph-node).
  The gateway is `horizon-core`'s `run()` verbatim. (FHSCE, compass, wsaas, drpc, camp.)
- **`pipeline`** — the service *is* the indexer: `Substrate → Handler → Sink`, with a
  `horizon-core` gateway fronting the query layer. (seahorn.)

## Usage

Invoke the skill in Claude Code:

```
/create-data-service
```

…or just ask: *"make a new Horizon data service for X"*. The skill interviews you,
writes an `answers.json`, and runs the generator:

```bash
python3 skills/create-data-service/scaffold.py --answers answers.json --out ./my-service
```

It then vendors the contract libs and verifies the result builds (`forge build && forge
test`, `cargo build`).

## From spec to a running service

The whole journey, end to end:

1. **Generate** — invoke the skill, answer ~6 questions (name, archetype, tiers, economics,
   pricing). You get a complete repo in `./<service>`.
2. **Build** — `./setup-contracts.sh` (vendor libs), then `forge build && forge test` and
   `cargo build`. The skill runs these for you and won't hand back something that doesn't compile.
3. **Deploy the contract** — `forge script contracts/script/Deploy.s.sol --rpc-url arbitrum_sepolia
   --broadcast --verify`; note the proxy address it prints.
4. **Configure** — copy `gateway.example.toml` → `gateway.toml`, set the deployed address,
   your upstream data plane, and your indexer keys.
5. **Run** — `docker compose up` brings up Postgres + the gateway.
6. **Become a provider** — stake a GRT provision, then `register` + `startService` on-chain
   (the [`horizon-ds-mcp`](mcp/) server can do this for you).

Every generated repo ships its own **README with this runbook spelled out** for that specific
service — that's the doc to follow once you've generated. Start on **Arbitrum Sepolia**.

## Install

Add the nightswatchhq marketplace, then install:

```
/plugin marketplace add nightswatchhq/horizon-skills
/plugin install horizon-skills
```

Or point Claude Code at a local clone for development.

## Layout

```
.claude-plugin/plugin.json
skills/create-data-service/
  SKILL.md                  the interview → generate → verify flow
  scaffold.py               the generator (token substitution + tier-enum codegen)
  reference/gotchas.md      hard-won Foundry/horizon-core footguns + canonical addresses
  templates/
    common/                 root files (foundry.toml, .env, yatr, setup-contracts.sh)
    contracts/              the Solidity contract, interface, deploy script, test
    proxy/                  proxy-archetype gateway, config, Docker, README
    pipeline/               pipeline-archetype core + indexer + gateway, config, Docker, README
    pricing-overlay/        optional per-endpoint pricing module + run_with gateway main
mcp/                        horizon-ds-mcp — MCP server for OPERATING deployed services
```

## Operating what you generate — `horizon-ds-mcp`

The [`mcp/`](mcp/) directory is a companion Model Context Protocol server for *operating*
deployed data services: read a contract's economics, a provider's status, a consumer's
escrow balance, on-chain `tokensCollected`, and gateway health — plus an opt-in on-chain
provider lifecycle (register / start / stop). Read-only by default. See [mcp/README.md](mcp/README.md).

## Built with horizon-skills

Services generated by `create-data-service` in the wild:

- **[Hermit DS](https://github.com/nightswatchhq/hermit-ds)** — the inverse analytics
  service: indexes wallets that have gone quiet and serves wake alerts when dormant ones
  stir (whales idle 18+ months, DAOs with unreachable quorum, LPs missing rebalances).
  Generated *entirely* by the skill from a one-paragraph spec — contract (7/7 tests),
  pipeline indexer, priced payment gateway — then verified building and serving locally.
  The proof that horizon-skills turns an idea into a working data service.

*Built something with horizon-skills? Open a PR adding it here.*

Apache-2.0. Experimental community tooling; not affiliated with The Graph Foundation.

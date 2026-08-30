---
name: create-data-service
description: Scaffold a complete Graph Horizon data service — Solidity contract, Rust gateway, config, Docker, deploy script, tests. Use when the user wants to create/bootstrap/start a new Horizon data service, a new paid data service on The Graph, a TAP/GraphTally-monetised service, or asks to "make a data service". Supports a proxy archetype (front an existing upstream HTTP data plane) and a pipeline archetype (custom substrate→handler→sink indexer).
---

# Create a Horizon Data Service

You are scaffolding a new data service for The Graph's Horizon framework. Every such
service is two layers: an **on-chain Solidity contract** (inherits `DataService`, reuses
the shared `GraphTallyCollector` unchanged) and an **off-chain Rust gateway** (validates
TAP receipts → serves/proxies data → aggregates RAVs → calls `collect()`). This skill
generates both, plus config, Docker, deploy script, and tests, then verifies they build.

Read `reference/gotchas.md` before generating — it holds the hard-won Foundry/horizon-core
footguns and the canonical contract addresses. Do not skip it.

## Step 1 — Choose the archetype

Two shapes exist. Pick by where the data comes from:

- **`proxy`** — the service sits in front of an existing upstream HTTP data plane (an
  RPC node, a REST API, a file server, a graph-node). The gateway is `horizon-core`'s
  `run()` verbatim: an 11-line `main.rs` plus a TOML file. **Default. Choose this unless
  the service IS the indexer.** Examples: FHSCE (files), compass (graph-node), wsaas (WS),
  camp (REST), drpc (JSON-RPC).
- **`pipeline`** — the service itself ingests a chain and produces data: a
  substrate (gRPC/firehose/RPC stream) → pure `Handler`s → a `Sink` (Postgres). Payments
  still go through a `horizon-core` gateway sitting in front of the query layer. Example:
  seahorn (Solana decode).

If the user hasn't said, ask. Otherwise infer and state your choice.

## Step 2 — Interview

Collect (ask only for what you can't infer from the user's brief; offer sensible defaults):

| Field | Meaning | Default |
|---|---|---|
| `service_slug` | kebab id, used for crate/db names (`oracle`) | derive from name |
| `service_name` | PascalCase, drives `OracleDataService` | derive from slug |
| `service_title` | human title | "Foo Data Service" |
| `service_description` | one-line purpose | — |
| `archetype` | `proxy` \| `pipeline` | `proxy` |
| `tiers` | unit-of-service tiers (the `DataTier` enum) | `["BASIC", "DECODED", "SQL"]` |
| `min_provision` | min GRT provision per provider (Solidity literal) | `555e18` |
| `burn_cut_ppm` | fees burned, PPM (1% = 10000) | `10000` |
| `data_service_cut_ppm` | fees retained, PPM | `10000` |
| `default_port` | gateway port | `8090` |
| `upstream_url` | (proxy only) upstream data plane URL | `http://127.0.0.1:5678` |
| `network` | `arbitrum_sepolia` (testnet) \| `arbitrum_one` | `arbitrum_sepolia` |
| `pricing` | emit a per-endpoint compute-unit pricing policy? | `false` |
| `base_price_per_cu` | (if `pricing`) GRT wei per compute unit | `4000000000000` |

Default to Arbitrum **Sepolia** — new services test on testnet first. Never invent a
private key; the deploy script reads it from env.

Set `pricing: true` when different endpoints should cost different amounts (a cheap
status lookup vs. an expensive query). The generator then emits a `pricing.rs` (edit
its `cu_cost` to match your endpoints) and a gateway `main.rs` that enforces it via
horizon-core's `PricingPolicy` — underpaid receipts get HTTP 402. Without it, the
gateway is the flat `horizon_core::run()` one-liner.

## Step 3 — Generate

Write the collected answers to a JSON file and run the bundled generator. From the skill
directory:

```bash
python3 scaffold.py --answers /path/to/answers.json --out /path/to/<service_slug>
```

`answers.json` shape:

```json
{
  "service_slug": "oracle",
  "service_name": "Oracle",
  "service_title": "Oracle Data Service",
  "service_description": "Paid price-oracle reads on Horizon.",
  "archetype": "proxy",
  "tiers": [
    {"name": "BASIC",  "comment": "spot price reads"},
    {"name": "STREAM", "comment": "streaming price updates"}
  ],
  "min_provision": "555e18",
  "burn_cut_ppm": "10000",
  "data_service_cut_ppm": "10000",
  "default_port": "8090",
  "upstream_url": "http://127.0.0.1:5678",
  "network": "arbitrum_sepolia"
}
```

The generator copies the right template subtree (`common/` + `contracts/` + `proxy/` or
`pipeline/`), substitutes `{{TOKENS}}` in file contents and filenames, and generates the
`DataTier` enum from `tiers`. It prints the file tree it wrote.

## Step 4 — Vendor contract dependencies

Run the generated setup script from the repo root:

```bash
./setup-contracts.sh
```

It `forge install`s forge-std, OpenZeppelin upgradeable (v5.6.1), and — critically —
`graphprotocol/contracts` **pinned to the `@graphprotocol/horizon@1.1.0` commit**. Do NOT
let it float to the latest tag: `v6.0.0+` reorganises away from the
`packages/horizon/contracts/` layout the remappings expect. This pin is verified to build
and pass tests. See `reference/gotchas.md` for the full story.

## Step 5 — Verify it builds

This is mandatory. A scaffold that doesn't compile is worse than none.

```bash
# Contract
cd <service_slug> && forge build && forge test

# Gateway (proxy)
cargo build            # in the gateway crate

# Indexer + gateway (pipeline)
cargo build --workspace
```

Fix any breakage before handing back. Common failures are in `reference/gotchas.md`
(remapping roots, `via_ir`, the `IGraphTallyCollector` import path, `deregister` not being
`override`). Report the build result honestly — if `forge test` fails, say so with output.

## Step 5b — Prove it can actually be paid

**`forge test` against mocks does not establish that the service can be paid.** This step is not
optional and it is the one most likely to be skipped, because everything is green without it.

Two sibling services make the case. SDSCE rehearsed provision → register → collect against real
Sepolia Horizon contracts on an anvil fork, reconciled to the token (10 GRT protocol tax + 9.9
data-service cut + 980.1 to the provider = 1000 exactly, matched against the `totalSupply` delta),
and its payment path is sound. `chain-integration-ds` had sixteen passing tests against a
`MockRecurringCollector` and **could not be paid at all**: it never called `accept()`, which is
callable only by the data service an agreement names, so no agreement written for it could ever be
accepted by anyone. The mock returned a number and modelled no rule, so nothing failed.

The scaffold ships `contracts/test/HorizonForkTest.sol` for this. Inherit it and write one test that
ends with a balance going **up**:

```solidity
contract PaidTest is HorizonForkTest {
    function setUp() public {
        forkOrSkip();                                   // skips loudly with no RPC configured
        // deploy your service, then:
        provisionTo(provider, address(ds), 100_000 ether);
        fundEscrow(payer, RECURRING_COLLECTOR, provider, 50_000 ether);
        authorizeOwnSigner(RECURRING_COLLECTOR, payer, payerKey);
    }

    function test_itCanActuallyBePaid() public {
        uint256 before = grtBalance(provider);
        // ... accept, start, collect ...
        assertGt(grtBalance(provider), before, "the provider was not paid");
    }
}
```

The harness carries the four traps below so you do not rediscover them: Controller-resolved
addresses with a proxy-versus-implementation size check, the signer authorisation, a provision at a
thawing period the protocol will accept, and an escrow deposit. It was written by extracting three
rehearsals that each re-derived the same setup, and it is exercised against deployed Sepolia
contracts in `nightswatchhq/chain-integration-ds`.

Four things that stop a collection, all of which cost a day each to find:

1. **A provision is required before anyone is paid.** The collector checks
   `getProviderTokensAvailable(serviceProvider, dataService) > 0` — the guard against a
   signer-as-data-service draining escrow. `deal` the GRT, `stakeTo`, then `provision`.
2. **`thawingPeriod` is capped at ~2,418,000 seconds.** 30 days is refused by a custom error
   carrying two raw numbers and no name.
3. **If you settle through `RecurringCollector`, the service needs its own `accept` path.** Only the
   data service an agreement names may accept it — not the payer who signed it, not the provider who
   benefits. A service without one can never be paid. This is the defect above.
4. **Escrow is not a blocker on a fork.** "Needs funded escrow" is true of a broadcast only: `deal`
   mints GRT and the deposit is an ordinary call.

Negative tests assert **specific** revert selectors. A bare `vm.expectRevert()` passes for any
reason at all, including the one the test exists to rule out.

## Step 6 — Hand off

Tell the user what was generated and the exact next steps:
0. Run the Step 5b rehearsal if it has not been run. A service that has never been paid on a fork
   should not be deployed.
1. Fill `.env` (PRIVATE_KEY, OWNER, PAUSE_GUARDIAN) and the gateway TOML (addresses, db).
2. Deploy the contract to testnet (`forge script ... --broadcast`), note the proxy address.
3. Put the proxy address into the gateway config's `tap.data_service_address`.
4. `docker compose up` to bring up Postgres + the gateway.
5. (proxy) point `backend.upstream_url` at the real data plane; (pipeline) run the indexer.

Do NOT deploy or push anything yourself unless explicitly asked — generation only.

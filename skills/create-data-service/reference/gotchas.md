# Horizon data service — gotchas & canonical addresses

Hard-won lessons from building ~10 of these. Read before generating; consult when a build fails.

## Canonical contract addresses

| Contract | Arbitrum One (42161, mainnet) | Arbitrum Sepolia (421614, testnet) |
|---|---|---|
| GraphTallyCollector | `0x8f69F5C07477Ac46FBc491B1E6D91E2bb0111A9e` | `0xacC71844EF6beEF70106ABe6E51013189A1f3738` |
| Controller | `cast call 0xb2Bb92d0DE618878E438b55D5846cfecD9301105 "controller()(address)"` | `0x9DB3ee191681f092607035d9BDA6e59FbEaCa695` |
| HorizonStaking | `0x00669A4CF01450B64E8A2A20E9b1FCB71E61eF03` | `0xFf2Ee30de92F276018642A59Fb7Be95b3F9088Af` |
| PaymentsEscrow | `0xf6Fcc27aAf1fcD8B254498c9794451d82afC673E` | `0x09B985a2042848A08bA59060EaF0f07c6F5D4d54` |

The EIP-712 domain for TAP receipts is always `name = "GraphTallyCollector"`, `chainId =
42161` (Arbitrum One) — the gateway config defaults to these. The `collect(address,uint8,bytes)`
ABI is identical for every Horizon data service; `horizon-core`'s collector is fully generic.

## If your service settles recurring payments, the documented pin will not work (2026-08-28)

`RecurringCollector` — the right instrument for anything billed as a subscription rather than per
request (DIPS indexing agreements, chain integrations) — **does not exist at the
`@graphprotocol/horizon@1.1.0` commit pinned below**. Use `graphprotocol/contracts` at
`2629e6463f6474f076396a32f51c9799490ea503` (main, 2026-08-28), which has
`IRecurringCollector.sol` *and* still has the `packages/horizon/contracts/data-service/` layout,
so the remappings below hold.

Two API changes come with that newer ref, and both are silent until the compiler stops you:

- **`onlyAuthorizedForProvision(sp)` is gone**, replaced by a plain
  `_requireAuthorizedForProvision(sp)` call as the first line of the function body.
- **`IDataService` no longer declares `deregister`**, so `override` on it fails with "function has
  override specified but does not override anything". Declare it in your own interface instead.

Worked example: `nightswatchhq/chain-integration-ds`.

## Contract dependency pinning (the big one — verified 2026-06-24)

- **Pin `graphprotocol/contracts` to the `@graphprotocol/horizon@1.1.0` commit**
  (`32d09fd45c8d39ac541eadd13dee580e398b9a79`). `forge install graphprotocol/contracts`
  with no ref grabs the latest tag (`v6.0.0+`), which **reorganises away from the
  `packages/horizon/contracts/` layout** — `DataService.sol` is no longer there and every
  remapping breaks. The generated `setup-contracts.sh` pins this commit.
- **OpenZeppelin upgradeable v5.6.1 bundles plain OZ** under its own
  `lib/openzeppelin-contracts/`. With only `openzeppelin-contracts-upgradeable` installed,
  the working remappings are:
  - `@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/`
  - `@openzeppelin/contracts/=lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/contracts/`
- **Three `@graphprotocol/*` remappings are needed**, not two — the horizon package
  transitively imports `@graphprotocol/contracts/contracts/token/IGraphToken.sol`:
  - `@graphprotocol/horizon/=lib/contracts/packages/horizon/contracts/`
  - `@graphprotocol/interfaces/=lib/contracts/packages/interfaces/`
  - `@graphprotocol/contracts/=lib/contracts/packages/contracts/`  ← easy to forget; build fails without it

## Solidity / Foundry footguns

- **`via_ir = true` is required.** Deploy scripts instantiate multiple contracts; without
  the IR pipeline you hit "stack too deep". Set it in `foundry.toml`.
- **Authorise providers with the `onlyAuthorizedForProvision(serviceProvider)` MODIFIER**,
  not a `_requireAuthorizedForProvision(...)` function call. In `horizon@1.1.0`'s
  `ProvisionManager` the helper is a modifier; the function form exists only in some later
  (Camp-era) forks. Using the function against 1.1.0 fails with "Undeclared identifier".
- **`IGraphTallyCollector` / `IGraphPayments` import path.** Either
  `@graphprotocol/interfaces/contracts/horizon/IGraphTallyCollector.sol` (the form horizon-skills
  uses) or `@graphprotocol/horizon/interfaces/IGraphTallyCollector.sol` works, given the
  remappings above. NOT `horizon/payments/`. Wrong path → "file not found".
- **`IGraphToken is IERC20`** — so `_graphToken().balanceOf(...)` / `.transfer(...)` /
  `.burn(...)` all compile, which the revenue-split logic relies on.
- **`deregister` is NOT in `IDataService`.** Do not mark it `override`. The base interface
  only knows `register/startService/stopService/collect/slash/acceptProvisionPendingParameters`.
- **`slash` must exist** even if unsupported — implement it as `revert("slashing not supported")`
  unless the service has a real on-chain dispute mechanism.
- **UUPS:** constructor sets immutables + `_disableInitializers()`; `initialize()` does the
  `__Ownable_init` / `__DataService_init` / `__DataServicePausable_init` and sets the
  provision/thawing/verifier-cut ranges. `_authorizeUpgrade` is `onlyOwner`.
- **Storage gap:** keep `uint256[50] private __gap;` for upgrade safety.
- **solc 0.8.27, EVM `cancun`, optimizer 200 runs** — the version every reference uses.

## horizon-core (proxy archetype) notes

- Dependency: `horizon-core = { git = "https://github.com/nightswatchhq/horizon-core", branch = "main" }`.
  Consider pinning a tag/rev for reproducibility once core stabilises.
- The whole gateway is `horizon_core::run(Config::load()?)`. Config path comes from
  `$GATEWAY_CONFIG` (defaults to `gateway.toml`).
- horizon-core OWNS the Postgres schema (`tap_receipts`, `tap_ravs`) via bundled migrations
  — do not add your own TAP tables.
- It provides `/health`, `/ready`, rate-limited TAP-gated catch-all proxy to `backend.upstream_url`,
  the aggregator task, and the collector task. Omit `[collector]` to disable on-chain collection;
  omit `tap.aggregator_url` to disable RAV aggregation.
- For custom routes: `build_state()` → `spawn_background()` → `standard_router(state).route(...)`.

## horizon-core extension points (added 2026-06-24)

Beyond the flat `run(Config)` one-liner, horizon-core exposes hooks for services that
need more. Use these when hand-extending a generated gateway:

- **Per-endpoint pricing** — `pricing::PricingPolicy` (`FlatPricing` default,
  `FnPricing(closure)`). Inject via `run_with(config, policy, extra_routes)` or
  `AppState::with_pricing`. Enforced in the proxy + `proxy::gate_request`: underpaid
  receipts → 402. horizon-skills emits this when `pricing: true` (see `pricing-overlay`).
- **Composable router** — `router_with(state, extra: Router<AppState>)` merges custom
  routes (e.g. a WebSocket relay) alongside the rate-limited proxy. `run_with` / `run_state`
  serve them. Custom routes reuse the receipt pipeline via `proxy::gate_request(&state,
  header, path)` (validate + price + persist; returns `ValidatedReceipt`).
- **Pre-forward gate** — `gate::RequestGate` (async, `AllowAll` default) for consumer
  credit limits, on-chain escrow pre-checks, allowlists. Inject via `AppState::with_gate`
  then `run_state(state, extra)`. Return `GateRejection` to deny.
- **Multi-backend routing** — `backend::BackendResolver` (`SingleBackend` default,
  `FnBackend(closure)`) routes to different upstreams by path (e.g. per-chain RPC). Inject
  via `AppState::with_backend`. The proxy 404s on an unroutable path.
- **Custom state composition** — `build_state(config).await?.with_pricing(..).with_gate(..)
  .with_backend(..)` then `run_state(state, extra_routes)`.

These are the features the legacy-fleet dogfooding (camp/seahorn/wsaas ports) surfaced.
A WebSocket service = composable router + a `/ws/...` route that calls `gate_request`
(see the wsaas reference). A credit/escrow-gated RPC service = a `RequestGate` +
`BackendResolver`. drpc's full JSON-RPC/attestation logic stays bespoke — don't force it.

## pipeline archetype notes

- Pure `Handler`s: deterministic, I/O-free, same event → same `ChangeSet`. All I/O is in the `Sink`.
- The `Substrate` is the only async/streaming part; the runtime drives `stream()` to completion.
- Fork handling via `Step::{New, Undo, Irreversible}`; a sweeper promotes Confirmed → Finalized.
- Payments are NOT in the indexer — a separate `horizon-core` gateway fronts the query/serve
  layer (e.g. PostgREST over the sink's Postgres). Wire `backend.upstream_url` at that layer.

## Economics defaults (matching the fleet)

- `MIN_PROVISION = 555e18` (low, for bootstrapping; drpc uses 555, compass 1000, wsaas 0).
- `BURN_CUT_PPM = 10000` (1% burned), `DATA_SERVICE_CUT_PPM = 10000` (1% retained). 2% total
  routed to the contract; the rest flows to the provider via PaymentsEscrow → GraphPayments.
- `STAKE_TO_FEES_RATIO = 5`, `MIN_THAWING_PERIOD = 14 days` — match SubgraphService.

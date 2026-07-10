#!/usr/bin/env node
/**
 * horizon-ds-mcp — a Model Context Protocol server for OPERATING Graph Horizon
 * data services (the kind horizon-skills generates).
 *
 * Lets an MCP client inspect and (optionally) operate a deployed DataService:
 * read its economics, a provider's registration + active tiers, a consumer's
 * PaymentsEscrow balance, on-chain tokensCollected, and a gateway's health — and,
 * when explicitly enabled with an operator key, run the provider lifecycle
 * (register / startService / stopService / setPaymentsDestination).
 *
 * Read-only by default. Write tools are registered ONLY when both
 * DS_ALLOW_WRITES=true and DS_OPERATOR_KEY are set — they broadcast real
 * on-chain transactions.
 *
 * Run:  npx horizon-ds-mcp
 * Env:  DS_NETWORK       arbitrum_sepolia (default) | arbitrum_one
 *       DS_RPC_URL       override the network's default RPC
 *       DS_DATA_SERVICE  default DataService contract address (per-tool overridable)
 *       DS_COLLECTOR     override GraphTallyCollector address
 *       DS_ESCROW        override PaymentsEscrow address
 *       DS_ALLOW_WRITES  "true" to register the lifecycle write tools
 *       DS_OPERATOR_KEY  0x-prefixed private key (required for writes)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  encodeAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Network presets (see horizon-skills reference/gotchas.md) ──────────────────────────
const NETWORKS = {
  arbitrum_sepolia: {
    chainId: 421614,
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
    collector: "0xacC71844EF6beEF70106ABe6E51013189A1f3738",
    escrow: "0x09B985a2042848A08bA59060EaF0f07c6F5D4d54",
  },
  arbitrum_one: {
    chainId: 42161,
    rpc: "https://arb1.arbitrum.io/rpc",
    collector: "0x8f69F5C07477Ac46FBc491B1E6D91E2bb0111A9e",
    escrow: "0xf6Fcc27aAf1fcD8B254498c9794451d82afC673E",
  },
};

const NETWORK = process.env.DS_NETWORK || "arbitrum_sepolia";
if (!NETWORKS[NETWORK]) {
  console.error(`unknown DS_NETWORK "${NETWORK}" (use arbitrum_sepolia | arbitrum_one)`);
  process.exit(1);
}
const NET = NETWORKS[NETWORK];
const RPC_URL = process.env.DS_RPC_URL || NET.rpc;
const COLLECTOR = process.env.DS_COLLECTOR || NET.collector;
const ESCROW = process.env.DS_ESCROW || NET.escrow;
const DEFAULT_DS = process.env.DS_DATA_SERVICE || null;
const ALLOW_WRITES = process.env.DS_ALLOW_WRITES === "true";
const OPERATOR_KEY = process.env.DS_OPERATOR_KEY || null;

// ── ABIs (minimal subsets) ────────────────────────────────────────────────────────
const DATA_SERVICE_ABI = [
  { type: "function", name: "MIN_PROVISION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "BURN_CUT_PPM", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DATA_SERVICE_CUT_PPM", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "STAKE_TO_FEES_RATIO", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minThawingPeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "isRegistered", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "activeServiceCount", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paymentsDestination", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  {
    type: "function", name: "getServiceRegistrations", stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{
      type: "tuple[]",
      components: [
        { name: "tier", type: "uint8" },
        { name: "endpoint", type: "string" },
        { name: "active", type: "bool" },
      ],
    }],
  },
  // writes
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "startService", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "stopService", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bytes" }], outputs: [] },
  { type: "function", name: "setPaymentsDestination", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
];

const ESCROW_ABI = [{
  type: "function", name: "getBalance", stateMutability: "view",
  inputs: [{ type: "address" }, { type: "address" }, { type: "address" }],
  outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
}];

const COLLECTOR_ABI = [{
  type: "function", name: "tokensCollected", stateMutability: "view",
  inputs: [{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "address" }],
  outputs: [{ type: "uint256" }],
}];

// ── Clients + helpers ───────────────────────────────────────────────────────────
const publicClient = createPublicClient({ transport: http(RPC_URL) });
const account = OPERATOR_KEY ? privateKeyToAccount(OPERATOR_KEY) : null;
const walletClient = account
  ? createWalletClient({ account, transport: http(RPC_URL) })
  : null;

/** JSON with bigint → string so tool output is serialisable. */
const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : j(data) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true });

/** Resolve the DataService address from a tool arg or DS_DATA_SERVICE. */
function resolveDs(arg) {
  const a = arg || DEFAULT_DS;
  if (!a) throw new Error("no data_service address (pass `data_service` or set DS_DATA_SERVICE)");
  return getAddress(a);
}

const read = (address, abi, functionName, args = []) =>
  publicClient.readContract({ address, abi, functionName, args });

const TIER_NAMES = ["BASIC", "DECODED", "SQL"]; // best-effort label; services may differ

const server = new McpServer({ name: "horizon-ds", version: "0.1.0" });

// ── Read tools ─────────────────────────────────────────────────────────────────────
server.registerTool(
  "service_info",
  {
    title: "Data service economics",
    description:
      "Read a Horizon DataService contract's economic parameters: minimum GRT provision, burn cut and data-service cut (PPM), stake-to-fees ratio, and the current minimum thawing period. Call this to understand the rules a provider must meet.",
    inputSchema: {
      data_service: z.string().optional().describe("DataService contract address (0x…). Defaults to DS_DATA_SERVICE."),
    },
  },
  async ({ data_service }) => {
    try {
      const ds = resolveDs(data_service);
      const [minProvision, burnPpm, dsPpm, ratio, thawing] = await Promise.all([
        read(ds, DATA_SERVICE_ABI, "MIN_PROVISION"),
        read(ds, DATA_SERVICE_ABI, "BURN_CUT_PPM"),
        read(ds, DATA_SERVICE_ABI, "DATA_SERVICE_CUT_PPM"),
        read(ds, DATA_SERVICE_ABI, "STAKE_TO_FEES_RATIO"),
        read(ds, DATA_SERVICE_ABI, "minThawingPeriod"),
      ]);
      return ok({
        network: NETWORK,
        data_service: ds,
        min_provision_wei: minProvision,
        burn_cut_ppm: burnPpm,
        data_service_cut_ppm: dsPpm,
        stake_to_fees_ratio: ratio,
        min_thawing_period_secs: thawing,
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "provider_status",
  {
    title: "Provider registration status",
    description:
      "For a given provider on a DataService: whether it's registered, how many services (tiers) are active, where collected fees are routed, and the full list of tier registrations (tier index, endpoint, active).",
    inputSchema: {
      provider: z.string().describe("Provider (service-provider) address (0x…)."),
      data_service: z.string().optional().describe("DataService contract address (0x…). Defaults to DS_DATA_SERVICE."),
    },
  },
  async ({ provider, data_service }) => {
    try {
      const ds = resolveDs(data_service);
      const p = getAddress(provider);
      const [registered, active, dest, regs] = await Promise.all([
        read(ds, DATA_SERVICE_ABI, "isRegistered", [p]),
        read(ds, DATA_SERVICE_ABI, "activeServiceCount", [p]),
        read(ds, DATA_SERVICE_ABI, "paymentsDestination", [p]),
        read(ds, DATA_SERVICE_ABI, "getServiceRegistrations", [p]),
      ]);
      return ok({
        data_service: ds,
        provider: p,
        registered,
        active_service_count: active,
        payments_destination: dest,
        registrations: regs.map((r) => ({
          tier: r.tier,
          tier_label: TIER_NAMES[r.tier] ?? `tier_${r.tier}`,
          endpoint: r.endpoint,
          active: r.active,
        })),
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "escrow_balance",
  {
    title: "Consumer escrow balance",
    description:
      "Read a consumer's PaymentsEscrow balance for (payer, collector, receiver): the funded balance plus any thawing (withdrawal-pending) amount. Use to check a consumer can pay before serving them.",
    inputSchema: {
      payer: z.string().describe("Consumer / payer address (0x…)."),
      receiver: z.string().describe("Provider (service-provider / receiver) address (0x…)."),
      collector: z.string().optional().describe("GraphTallyCollector address (0x…). Defaults to the network's."),
    },
  },
  async ({ payer, receiver, collector }) => {
    try {
      const [balance, thawEnd, thawing] = await read(
        getAddress(ESCROW), ESCROW_ABI, "getBalance",
        [getAddress(payer), getAddress(collector || COLLECTOR), getAddress(receiver)],
      );
      return ok({
        escrow: getAddress(ESCROW),
        payer: getAddress(payer),
        receiver: getAddress(receiver),
        balance_wei: balance,
        thaw_end_timestamp: thawEnd,
        thawing_tokens_wei: thawing,
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "tokens_collected",
  {
    title: "On-chain tokens collected",
    description:
      "Read GraphTallyCollector.tokensCollected[dataService][collectionId][receiver][payer] — the monotonic on-chain total already collected for a TAP collection. Useful as the RAV floor and to verify settlement.",
    inputSchema: {
      collection_id: z.string().describe("Collection id (bytes32, 0x…)."),
      receiver: z.string().describe("Provider (receiver) address (0x…)."),
      payer: z.string().describe("Consumer (payer) address (0x…)."),
      data_service: z.string().optional().describe("DataService address (0x…). Defaults to DS_DATA_SERVICE."),
      collector: z.string().optional().describe("GraphTallyCollector address (0x…). Defaults to the network's."),
    },
  },
  async ({ collection_id, receiver, payer, data_service, collector }) => {
    try {
      const tokens = await read(
        getAddress(collector || COLLECTOR), COLLECTOR_ABI, "tokensCollected",
        [resolveDs(data_service), collection_id, getAddress(receiver), getAddress(payer)],
      );
      return ok({ collection_id, tokens_collected_wei: tokens });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "gateway_health",
  {
    title: "Gateway health",
    description:
      "Probe a running horizon-core gateway's /health and /ready endpoints. /ready returns 200 only when its database is reachable.",
    inputSchema: {
      gateway_url: z.string().describe("Base URL of the gateway, e.g. http://localhost:8090."),
    },
  },
  async ({ gateway_url }) => {
    try {
      const base = gateway_url.replace(/\/$/, "");
      const probe = async (p) => {
        try {
          const r = await fetch(`${base}${p}`);
          return { status: r.status, ok: r.ok };
        } catch (e) { return { error: e.message }; }
      };
      const [health, ready] = await Promise.all([probe("/health"), probe("/ready")]);
      return ok({ gateway: base, health, ready });
    } catch (e) { return fail(e); }
  },
);

// ── Write tools (opt-in: DS_ALLOW_WRITES=true + DS_OPERATOR_KEY) ───────────────────
if (ALLOW_WRITES && walletClient) {
  const sendTx = async (data_service, functionName, args) => {
    const ds = resolveDs(data_service);
    const hash = await walletClient.writeContract({
      address: ds, abi: DATA_SERVICE_ABI, functionName, args, chain: null,
    });
    return ok({ tx_hash: hash, data_service: ds, function: functionName, from: account.address });
  };

  server.registerTool(
    "register_provider",
    {
      title: "⚠️ Register provider (on-chain tx)",
      description:
        "BROADCASTS A TRANSACTION. Register the operator as a provider on a DataService. The operator must already have a provision on-chain. Routes collected fees to `payments_destination` (defaults to the operator).",
      inputSchema: {
        endpoint: z.string().describe("Public base URL of the provider's gateway."),
        geo_hash: z.string().optional().describe("Geohash of the provider location (latency routing). Default empty."),
        payments_destination: z.string().optional().describe("Address to receive fees (0x…). Default: the operator address."),
        data_service: z.string().optional().describe("DataService address (0x…). Defaults to DS_DATA_SERVICE."),
      },
    },
    async ({ endpoint, geo_hash, payments_destination, data_service }) => {
      try {
        const dest = payments_destination ? getAddress(payments_destination) : "0x0000000000000000000000000000000000000000";
        const data = encodeAbiParameters(
          [{ type: "string" }, { type: "string" }, { type: "address" }],
          [endpoint, geo_hash || "", dest],
        );
        return await sendTx(data_service, "register", [account.address, data]);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "start_service",
    {
      title: "⚠️ Start service for a tier (on-chain tx)",
      description: "BROADCASTS A TRANSACTION. Activate (or update the endpoint of) a service tier for the operator on a DataService.",
      inputSchema: {
        tier: z.number().int().min(0).describe("DataTier index (0-based, matches the contract's enum)."),
        endpoint: z.string().describe("Endpoint URL serving this tier."),
        data_service: z.string().optional().describe("DataService address (0x…). Defaults to DS_DATA_SERVICE."),
      },
    },
    async ({ tier, endpoint, data_service }) => {
      try {
        const data = encodeAbiParameters([{ type: "uint8" }, { type: "string" }], [tier, endpoint]);
        return await sendTx(data_service, "startService", [account.address, data]);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "stop_service",
    {
      title: "⚠️ Stop service for a tier (on-chain tx)",
      description: "BROADCASTS A TRANSACTION. Deactivate a service tier for the operator on a DataService.",
      inputSchema: {
        tier: z.number().int().min(0).describe("DataTier index to stop."),
        data_service: z.string().optional().describe("DataService address (0x…). Defaults to DS_DATA_SERVICE."),
      },
    },
    async ({ tier, data_service }) => {
      try {
        const data = encodeAbiParameters([{ type: "uint8" }], [tier]);
        return await sendTx(data_service, "stopService", [account.address, data]);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "set_payments_destination",
    {
      title: "⚠️ Set payments destination (on-chain tx)",
      description: "BROADCASTS A TRANSACTION. Change where the operator's collected fees are sent (e.g. a cold wallet).",
      inputSchema: {
        destination: z.string().describe("New fee-receiving address (0x…)."),
        data_service: z.string().optional().describe("DataService address (0x…). Defaults to DS_DATA_SERVICE."),
      },
    },
    async ({ destination, data_service }) => {
      try {
        return await sendTx(data_service, "setPaymentsDestination", [getAddress(destination)]);
      } catch (e) { return fail(e); }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `horizon-ds-mcp connected → ${NETWORK} via ${RPC_URL}` +
  `${ALLOW_WRITES && walletClient ? ` (writes ENABLED as ${account.address})` : " (read-only)"}`,
);

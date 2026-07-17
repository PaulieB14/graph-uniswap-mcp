#!/usr/bin/env node
/**
 * Uniswap MCP — one interface over Uniswap V2/V3/V4 across every major chain,
 * powered by The Graph. Self-healing (resolves the best live subgraph, follows
 * the latest published version), schema-adaptive (V2 pairs, V3/V4 pools, native
 * vs classic pricing), and footgun-proofed (ranks by volume, flags TVL).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  listMarkets, discoverMarkets, getTokenPrice, topPools, findPool,
  poolInfo, recentSwaps, rawQuery,
} from "./tools.js";

const server = new McpServer({ name: "graph-uniswap-mcp", version: "0.2.2" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const wrap = (fn: (a: any) => Promise<unknown>) => async (a: any) => {
  try {
    return ok(await fn(a));
  } catch (e) {
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
};

const chain = z.string().describe("Chain: ethereum, arbitrum, base, polygon, optimism, or bsc (aliases like eth/arb/matic/bnb are accepted)");
const version = z.string().optional().describe("Uniswap version: v2, v3, or v4. Omit to use the highest-volume version on that chain.");

server.tool(
  "list_markets",
  "List every Uniswap version×chain this server can query, with the backing subgraph id and popularity. Start here to see what's available.",
  {},
  wrap(() => listMarkets()),
);

server.tool(
  "discover_markets",
  "Re-resolve the best LIVE Uniswap subgraph(s) from The Graph's network subgraph, ranked by curation signal — self-healing discovery that surfaces new/replacement deployments without a code change. Optionally apply the top result as the active market for a (chain, version).",
  {
    chain: z.string().optional().describe("Filter to a chain"),
    version: version,
    apply: z.boolean().optional().describe("If true (with chain+version), set the top result as the active subgraph for this session"),
  },
  wrap((a) => discoverMarkets(a)),
);

server.tool(
  "get_token_price",
  "Current USD price of a token on Uniswap. Accepts a symbol (e.g. WETH, USDC) or an address. Price is derived on-chain (token's native-denominated price × the native token's USD price); sanity-check a stablecoin should read ~$1.",
  { token: z.string().describe("Token symbol or 0x address"), chain, version },
  wrap((a) => getTokenPrice(a)),
);

server.tool(
  "top_pools",
  "Top Uniswap pools on a chain, ranked by lifetime volumeUSD (NOT TVL — TVL is gamed by spam-token pricing). Returns pair, fee tier, volume, fees, and a TVL caveat.",
  { chain, version, first: z.number().int().min(1).max(50).optional().describe("How many (default 10)") },
  wrap((a) => topPools(a)),
);

server.tool(
  "find_pool",
  "Find the Uniswap pool(s) for a token pair (either order), ranked by volume. Accepts symbols or addresses for each token.",
  { tokenA: z.string(), tokenB: z.string(), chain, version },
  wrap((a) => findPool(a)),
);

server.tool(
  "pool_info",
  "Detailed stats for one Uniswap pool/pair by address: price, volume, fees, liquidity/reserves (TVL flagged as unreliable).",
  { pool: z.string().describe("Pool/pair contract address (0x…)"), chain, version },
  wrap((a) => poolInfo(a)),
);

server.tool(
  "recent_swaps",
  "Recent swaps on a chain, newest first — optionally scoped to one pool. Real-time trade flow with USD amounts and the trading wallet.",
  { chain, version, pool: z.string().optional().describe("Pool/pair address to scope to"), first: z.number().int().min(1).max(50).optional() },
  wrap((a) => recentSwaps(a)),
);

server.tool(
  "raw_query",
  "Escape hatch: run an arbitrary GraphQL query against the resolved Uniswap subgraph for a (chain, version). Use list_markets to see schemas; V2 uses `pairs`, V3/V4 use `pools`.",
  { chain, version, query: z.string().describe("GraphQL query string"), variables: z.record(z.string(), z.unknown()).optional() },
  wrap((a) => rawQuery(a)),
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stderr so it doesn't corrupt the stdio JSON-RPC channel
  console.error("graph-uniswap-mcp running (stdio). Set GRAPH_API_KEY in the environment.");
}
main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

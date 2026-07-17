/**
 * Uniswap market map: which subgraph backs each (version × chain).
 *
 * These are SUBGRAPH IDs (not deployment/IPFS hashes) so the gateway path
 * `/subgraphs/id/<id>` always follows the publisher's LATEST version — when
 * Uniswap redeploys, this MCP picks it up automatically. IDs were chosen by
 * curation signal + query fees + a live-sync check across every published
 * candidate (canonical Uniswap-Labs deployments, not Messari forks, except
 * where a native deployment is currently unservable).
 *
 * Don't trust this list forever — `discover_markets` re-resolves the best live
 * subgraph from The Graph's network subgraph at runtime, so new/replacement
 * deployments surface without a code change.
 */

export type Version = "v2" | "v3" | "v4";

/** Canonical chain keys used across the API. */
export type Chain =
  | "ethereum"
  | "arbitrum"
  | "base"
  | "polygon"
  | "optimism"
  | "bsc";

export interface Market {
  version: Version;
  chain: Chain;
  subgraphId: string;
  /** display network name as it appears on-chain / in the subgraph */
  network: string;
  /** rough daily query volume (from the operator dashboard) — popularity signal only */
  approxQueriesPerDay?: number;
  note?: string;
}

/**
 * Seeded, verified market map. `discover_markets` can override any of these at
 * runtime with a fresher/higher-signal result.
 */
export const MARKETS: Market[] = [
  // ── V2 (Pair-based schema) ───────────────────────────────────────────────
  { version: "v2", chain: "ethereum", subgraphId: "GmSczqdCDZ3hJeYY9JphwsADn5rePUzUKm8EZcVuhRAm", network: "mainnet", approxQueriesPerDay: 2_374_000 },
  { version: "v2", chain: "base", subgraphId: "DbcUmZwXBYbNZvLuDEvcmFa4uAWwwjrdX8dVFg1AUVKa", network: "base", approxQueriesPerDay: 1_610_000 },

  // ── V3 (Pool-based schema) ───────────────────────────────────────────────
  { version: "v3", chain: "ethereum", subgraphId: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV", network: "mainnet", approxQueriesPerDay: 467_000, note: "canonical Uniswap Labs V3" },
  { version: "v3", chain: "arbitrum", subgraphId: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM", network: "arbitrum-one", approxQueriesPerDay: 854_000 },
  { version: "v3", chain: "base", subgraphId: "HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1", network: "base", approxQueriesPerDay: 536_000, note: "uses derivedNative/nativePriceUSD pricing fields" },
  { version: "v3", chain: "polygon", subgraphId: "EsLGwxyeMMeJuhqWvuLmJEiDKXJ4Z6YsoJreUnyeozco", network: "matic", approxQueriesPerDay: 539_000 },
  { version: "v3", chain: "optimism", subgraphId: "Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj", network: "optimism", approxQueriesPerDay: 307_000, note: "canonical native deployment; indexers occasionally lag — discover_markets will fall back if unservable" },
  { version: "v3", chain: "bsc", subgraphId: "7XgdLW3bts4HktCYsu9dy8bEnuiNeZuftcuK3Aj4JXYV", network: "bsc", approxQueriesPerDay: 1_112_000 },

  // ── V4 (PoolManager + hooks schema) ──────────────────────────────────────
  { version: "v4", chain: "base", subgraphId: "Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj", network: "base", approxQueriesPerDay: 8_644_000, note: "highest-volume Uniswap subgraph on the whole network" },
  { version: "v4", chain: "bsc", subgraphId: "EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX", network: "bsc", approxQueriesPerDay: 1_664_000 },
  { version: "v4", chain: "ethereum", subgraphId: "AdA6Ax3jtct69NnXfxNjWtPTe9gMtSEZx2tTQcT4VHu", network: "mainnet", approxQueriesPerDay: 233_000 },
  { version: "v4", chain: "arbitrum", subgraphId: "D1VHPU6cXXSC8eaApWCjCnPcTZQFSYCpGoDAvt4ogDWh", network: "arbitrum-one", note: "recently synced" },
  { version: "v4", chain: "optimism", subgraphId: "J9QbGgsAJpYFX6tY5y1hy5JkcVUda1kTS2ENGUBqMEY8", network: "optimism" },
];

/** Accept common chain aliases so agents can be sloppy. */
const CHAIN_ALIASES: Record<string, Chain> = {
  ethereum: "ethereum", eth: "ethereum", mainnet: "ethereum", "ethereum-mainnet": "ethereum",
  arbitrum: "arbitrum", "arbitrum-one": "arbitrum", arb: "arbitrum",
  base: "base",
  polygon: "polygon", matic: "polygon",
  optimism: "optimism", op: "optimism", "optimism-mainnet": "optimism",
  bsc: "bsc", bnb: "bsc", "binance-smart-chain": "bsc", "bnb-chain": "bsc",
};

export function normalizeChain(input: string): Chain | undefined {
  return CHAIN_ALIASES[(input || "").trim().toLowerCase()];
}

export function normalizeVersion(input: string): Version | undefined {
  const v = (input || "").trim().toLowerCase().replace(/^uniswap[\s-]*/, "");
  if (v === "v2" || v === "2") return "v2";
  if (v === "v3" || v === "3") return "v3";
  if (v === "v4" || v === "4") return "v4";
  return undefined;
}

/** Runtime overrides discovered via the network subgraph (see discover_markets). */
const OVERRIDES = new Map<string, string>();
const key = (v: Version, c: Chain) => `${v}:${c}`;

export function setMarketOverride(v: Version, c: Chain, subgraphId: string) {
  OVERRIDES.set(key(v, c), subgraphId);
}

/**
 * Resolve the subgraph id for a (version, chain). Runtime overrides win, then
 * the seeded map. If `version` is omitted, pick the highest-volume version that
 * exists on the chain (v4 → v3 → v2 by popularity, per-chain).
 */
export function resolveMarket(chain: Chain, version?: Version): Market {
  const candidates = MARKETS.filter((m) => m.chain === chain && (!version || m.version === version));
  if (candidates.length === 0) {
    const have = MARKETS.filter((m) => m.chain === chain).map((m) => m.version);
    throw new Error(
      version
        ? `No Uniswap ${version.toUpperCase()} subgraph is mapped for chain "${chain}". Available on ${chain}: ${have.join(", ") || "none"}.`
        : `No Uniswap subgraph is mapped for chain "${chain}".`,
    );
  }
  // Default version = the one with the most traffic on this chain.
  const best = candidates.sort(
    (a, b) => (b.approxQueriesPerDay ?? 0) - (a.approxQueriesPerDay ?? 0),
  )[0];
  const override = OVERRIDES.get(key(best.version, chain));
  return override ? { ...best, subgraphId: override } : best;
}

export const SUPPORTED_CHAINS: Chain[] = ["ethereum", "arbitrum", "base", "polygon", "optimism", "bsc"];

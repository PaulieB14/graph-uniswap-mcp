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
  /**
   * Never serve this market: its indexers are down, so every query errors.
   * Kept in the map (rather than deleted) so a caller who pins it gets a real
   * explanation instead of "no subgraph mapped for this chain".
   */
  unavailable?: string;
  /**
   * Servable, but must not be chosen when the caller did NOT pin a version.
   * Default selection ranks by query traffic, and traffic is a poor proxy for
   * usefulness — Uniswap V4 on Base is the single highest-traffic Uniswap
   * subgraph on the network, yet its top pools by volume are hook pools with
   * zero in-range liquidity reporting billions in fabricated volume. Picking it
   * by default made the most natural call (`chain: "base"`, no version) return
   * junk. Pinning `version: "v4"` still works and is honoured.
   */
  notDefault?: string;
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
  { version: "v4", chain: "base", subgraphId: "Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj", network: "base", approxQueriesPerDay: 8_644_000, note: "highest-query-volume Uniswap subgraph on the whole network", notDefault: "Top pools by volume here are hook pools with zero in-range liquidity reporting billions in fabricated volumeUSD (verified 2026-08-19). Servable when pinned with version:\'v4\', but not chosen by default." },
  { version: "v4", chain: "bsc", subgraphId: "EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX", network: "bsc", approxQueriesPerDay: 1_664_000 },
  { version: "v4", chain: "ethereum", subgraphId: "8B2wKxnkciCTc5HSgsAojF6vhKn6wxQ1nVecYzMge1hA", network: "mainnet", note: "uniswap-v4-ethereum. Replaced AdA6Ax… on 2026-08-20: that deployment's indexers returned BadResponse on every data query for days while only _meta answered. This one indexes at 0 lag, exposes `ticks`, and its top pools by volume are real hookless pairs (USDC/USDT, WBTC/cbBTC, ETH/USDC) — so unlike V4 on Base it is genuinely quotable. Uses the V4 field names: fee/tickSpacing/sqrtPriceX96 rather than feeTier/sqrtPrice." },
  { version: "v4", chain: "arbitrum", subgraphId: "D1VHPU6cXXSC8eaApWCjCnPcTZQFSYCpGoDAvt4ogDWh", network: "arbitrum-one", note: "recently synced" },
  { version: "v4", chain: "optimism", subgraphId: "3Tn7Y1NJAr4ySKm7KFu1dwvH2WM3mHJnXzXAxQsdBDvW", network: "optimism", note: "full-analytics deployment — the similarly-named 'Uniswap V4 Optimism' subgraph J9QbGg… is a bare PoolManager event indexer with no prices/volume, do not use it" },
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

/** Undo a runtime override, restoring the seeded subgraph for this market. */
export function clearMarketOverride(v: Version, c: Chain): boolean {
  return OVERRIDES.delete(key(v, c));
}

/** Currently-active runtime overrides, for reporting. */
export function listMarketOverrides(): Array<{ version: string; chain: string; subgraphId: string }> {
  return [...OVERRIDES.entries()].map(([k, subgraphId]) => {
    const [version, chain] = k.split(":");
    return { version, chain, subgraphId };
  });
}

/**
 * Ordered candidate markets for a chain, highest-volume version first (with any
 * runtime override applied). If `version` is given, only that version. The tools
 * use this to fall back to the next-best version when the top one's indexers are
 * unservable — the self-healing that `discover_markets` advertises, on the data
 * path. Throws if the chain (or chain+version) has no mapped subgraph.
 */
export function resolveMarketCandidates(chain: Chain, version?: Version): Market[] {
  const all = MARKETS.filter((m) => m.chain === chain && (!version || m.version === version));
  // A pinned version is honoured even if it is flagged notDefault — the caller
  // asked for it explicitly. `unavailable` is refused either way: serving it
  // guarantees an error, and silently falling back would answer for a different
  // version than the one requested.
  const dead = all.filter((m) => m.unavailable);
  const candidates = all.filter((m) => !m.unavailable && (version ? true : !m.notDefault));
  if (candidates.length === 0 && dead.length > 0) {
    throw new Error(
      `Uniswap ${dead[0].version.toUpperCase()} on ${chain} is currently unusable: ${dead[0].unavailable}`,
    );
  }
  if (candidates.length === 0) {
    const have = MARKETS.filter((m) => m.chain === chain).map((m) => m.version);
    throw new Error(
      version
        ? `No Uniswap ${version.toUpperCase()} subgraph is mapped for chain "${chain}". Available on ${chain}: ${have.join(", ") || "none"}.`
        : `No Uniswap subgraph is mapped for chain "${chain}".`,
    );
  }
  // DEFAULT ORDER IS BY VERSION, NOT BY TRAFFIC.
  //
  // Ranking by approxQueriesPerDay picked the most QUERIED market, which is not
  // the most USEFUL one. It sent `chain:"base"` to V4 (highest-traffic Uniswap
  // subgraph on the network, whose top pools are zero-liquidity hook pools), and
  // once V4 was excluded it sent Base to V2 (more traffic than V3, but thinner
  // liquidity and a Pair schema with no fee tier). V3 is the deepest and most
  // schema-stable deployment on every chain that has one, so it leads; traffic
  // only breaks ties within a version. A pinned version bypasses all of this.
  const VERSION_PREFERENCE: Record<Version, number> = { v3: 0, v4: 1, v2: 2 };
  return candidates
    .sort((a, b) =>
      VERSION_PREFERENCE[a.version] - VERSION_PREFERENCE[b.version]
      || (b.approxQueriesPerDay ?? 0) - (a.approxQueriesPerDay ?? 0))
    .map((m) => {
      const override = OVERRIDES.get(key(m.version, chain));
      return override ? { ...m, subgraphId: override } : m;
    });
}

/**
 * Resolve the single best subgraph for a (version, chain). Runtime overrides win,
 * then the seeded map. If `version` is omitted, pick the highest-volume version
 * that exists on the chain (v4 → v3 → v2 by popularity, per-chain).
 */
export function resolveMarket(chain: Chain, version?: Version): Market {
  return resolveMarketCandidates(chain, version)[0];
}

export const SUPPORTED_CHAINS: Chain[] = ["ethereum", "arbitrum", "base", "polygon", "optimism", "bsc"];

/**
 * Uniswap MCP tool implementations. Every tool:
 *  - resolves the right subgraph for (chain, version) via markets.ts
 *  - adapts to the subgraph's schema variant via graph.ts getProfile()
 *  - ranks by VOLUME, never TVL (Uniswap subgraph TVL is inflated by spam-token
 *    pricing — a single fake pool can report trillions), and flags TVL as such.
 */
import {
  Chain, Version, Market, resolveMarket, resolveMarketCandidates,
  normalizeChain, normalizeVersion, MARKETS, SUPPORTED_CHAINS, setMarketOverride,
} from "./markets.js";
import { gqlQuery, getProfile, getNativePrice, num } from "./graph.js";

const NETWORK_SUBGRAPH = "DZz4kDTdmzWLWsV373w2bSmoar3umKKH9y82SUKr5qmp"; // Graph Network (Arbitrum)
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TVL_NOTE =
  "TVL/liquidity values from Uniswap subgraphs are unreliable — illiquid spam-token pools inflate them massively. Rank and judge by volumeUSD, not TVL.";

function pickChain(chain: string): Chain {
  const c = normalizeChain(chain);
  if (!c) throw new Error(`Unknown chain "${chain}". Supported: ${SUPPORTED_CHAINS.join(", ")}.`);
  return c;
}
function pickVersion(version?: string): Version | undefined {
  if (version == null || version === "") return undefined;
  const v = normalizeVersion(version);
  if (!v) throw new Error(`Unknown version "${version}". Use v2, v3, or v4.`);
  return v;
}

/**
 * Run `fn` against the best market for (chain, version). If the caller did NOT
 * pin a version and the top market's indexers are unservable (fn THROWS — e.g. a
 * gateway timeout or "bad indexers"), transparently fall back to the next-
 * highest-volume version so the call still returns real data. A pinned version is
 * tried alone — we never silently answer for a different version than asked.
 * Empty-but-valid results (a legit "no pool") do NOT trigger fallback; only
 * servability failures do. `served` reports which version actually answered.
 */
async function withMarket<T>(
  chain: Chain,
  version: Version | undefined,
  fn: (m: Market) => Promise<T>,
): Promise<T & { served?: { version: Version; fell_back: boolean } }> {
  const candidates = resolveMarketCandidates(chain, version);
  const list = version ? candidates.slice(0, 1) : candidates;
  let lastErr: unknown;
  for (let i = 0; i < list.length; i++) {
    try {
      const out = await fn(list[i]);
      const served = { version: list[i].version, fell_back: i > 0 };
      return out && typeof out === "object" ? { ...out, served } : (out as any);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Resolve a token (symbol or address) to its canonical record on this subgraph. */
async function resolveToken(subgraphId: string, derivedField: string, token: string) {
  const t = token.trim();
  if (ADDR.test(t)) {
    const d = await gqlQuery<{ tokens: any[] }>(
      subgraphId,
      `query($id:ID!){ tokens(where:{id:$id}){ id symbol name decimals txCount ${derivedField} } }`,
      { id: t.toLowerCase() },
    );
    return d.tokens?.[0] ?? null;
  }
  // Symbol: on-chain symbols are case-sensitive and the majors are uppercase
  // (USDC/WETH/DAI/WBTC), but agents routinely lowercase — so match the raw
  // form AND its uppercase in one round-trip. Multiple tokens can share a
  // symbol; take the most-transacted (least spammy).
  const forms = Array.from(new Set([t, t.toUpperCase()]));
  const d = await gqlQuery<{ tokens: any[] }>(
    subgraphId,
    `query($s:[String!]){ tokens(first:10, where:{symbol_in:$s}, orderBy:txCount, orderDirection:desc){ id symbol name decimals txCount ${derivedField} } }`,
    { s: forms },
  );
  return d.tokens?.[0] ?? null;
}

// ── Tools ────────────────────────────────────────────────────────────────────

export async function listMarkets() {
  return {
    supported_chains: SUPPORTED_CHAINS,
    versions: ["v2", "v3", "v4"],
    markets: MARKETS.map((m) => ({
      version: m.version, chain: m.chain, network: m.network,
      subgraph_id: m.subgraphId, approx_queries_per_day: m.approxQueriesPerDay ?? null,
      note: m.note ?? null,
    })),
    resolver: "Subgraph IDs follow the publisher's latest version automatically. Use discover_markets to re-resolve the best live subgraph from The Graph's network subgraph.",
  };
}

const CHAIN_TOKENS: Record<Chain, string[]> = {
  ethereum: ["ethereum", "mainnet"], arbitrum: ["arbitrum", "arb"], base: ["base"],
  polygon: ["polygon", "matic"], optimism: ["optimism"], bsc: ["bsc", "bnb", "binance"],
};

/**
 * Surface the market(s) this server will use for (chain, version) plus a
 * best-effort live scan of The Graph's network subgraph.
 *
 * `recommended` is authoritative: verified subgraphs whose IDs auto-follow the
 * publisher's LATEST version (so a Uniswap redeploy is picked up with no change).
 * `live_signal_candidates` is a best-effort keyword scan and may be partial —
 * the network subgraph's fulltext search is noisy — so it augments, not replaces,
 * the recommended set. With apply=true + chain + version, the top live candidate
 * (if any) overrides the active subgraph for this session.
 */
export async function discoverMarkets(args: { chain?: string; version?: string; apply?: boolean }) {
  const version = pickVersion(args.version);
  const chain = args.chain ? pickChain(args.chain) : undefined;

  const recommended = MARKETS
    .filter((m) => (!chain || m.chain === chain) && (!version || m.version === version))
    .map((m) => ({
      version: m.version, chain: m.chain, network: m.network,
      subgraph_id: resolveMarket(m.chain, m.version).subgraphId,
      approx_queries_per_day: m.approxQueriesPerDay ?? null, note: m.note ?? null,
    }));

  let live: Array<{ name: string; subgraph_id: string; signal_grt: number | null; ipfs_hash: string | null }> = [];
  try {
    const d = await gqlQuery<{ subgraphMetadataSearch: any[] }>(
      NETWORK_SUBGRAPH,
      `query($t:String!){ subgraphMetadataSearch(text:$t, first:40){
          displayName
          subgraphs(first:1, where:{active:true}, orderBy:currentSignalledTokens, orderDirection:desc){
            id currentSignalledTokens currentVersion{ subgraphDeployment{ ipfsHash } }
          }
      } }`,
      { t: "uniswap" }, // plain term: the network fulltext returns nothing useful for "uniswap:*"
    );
    live = (d.subgraphMetadataSearch ?? [])
      .map((m) => {
        const sg = (m.subgraphs ?? [])[0];
        return sg?.id
          ? {
              name: m.displayName as string, subgraph_id: sg.id as string,
              signal_grt: sg.currentSignalledTokens ? Number(sg.currentSignalledTokens) / 1e18 : null,
              ipfs_hash: sg.currentVersion?.subgraphDeployment?.ipfsHash ?? null,
            }
          : null;
      })
      .filter((h): h is NonNullable<typeof h> => {
        if (!h) return false;
        const n = h.name.toLowerCase();
        return n.includes("uniswap")
          && (!version || n.includes(version))
          && (!chain || CHAIN_TOKENS[chain].some((t) => n.includes(t)));
      })
      .sort((a, b) => (b.signal_grt ?? 0) - (a.signal_grt ?? 0));
  } catch {
    /* network scan is best-effort; recommended[] stands on its own */
  }

  let applied: string | null = null;
  if (args.apply && chain && version && live[0]) {
    setMarketOverride(version, chain, live[0].subgraph_id);
    applied = live[0].subgraph_id;
  }
  return {
    recommended,
    live_signal_candidates: live,
    applied_override: applied,
    note: "recommended[] are the verified subgraphs this server uses (IDs auto-follow the latest published version). live_signal_candidates is a best-effort network-subgraph scan and may be partial.",
  };
}

export async function getTokenPrice(args: { token: string; chain: string; version?: string }) {
  const chain = pickChain(args.chain);
  const version = pickVersion(args.version);
  return withMarket(chain, version, async (m) => {
    const p = await getProfile(m.subgraphId);
    if (!p.tokenDerivedField || !p.bundlePriceField)
      throw new Error("This subgraph has no derived-price fields; try raw_query.");
    const [nativePrice, tok] = await Promise.all([
      getNativePrice(m.subgraphId, p),
      resolveToken(m.subgraphId, p.tokenDerivedField, args.token),
    ]);
    if (!tok) throw new Error(`Token "${args.token}" not found on Uniswap ${m.version} ${chain}.`);
    const derivedRaw = tok[p.tokenDerivedField];
    const derived = num(derivedRaw);
    // derivedETH/derivedNative == 0 means the subgraph has NO priced-pool path to
    // the native asset for this token — it's present but UNPRICEABLE here (e.g. a
    // new vault stablecoin with no whitelisted pool). Never report a misleading
    // $0: throw so an unpinned call falls back to a version that CAN price it, and
    // a pinned call gets a clear error. (A genuinely cheap token has a small
    // positive derived value, not exactly 0, so this doesn't mislabel micro-caps.)
    if (nativePrice == null || !(derived > 0)) {
      throw new Error(
        `Token "${args.token}"${tok.symbol ? ` (${tok.symbol})` : ""} exists on Uniswap ${m.version} ${chain} but has no priced pool path to the native asset there (${p.tokenDerivedField}=${derivedRaw ?? "null"}), so a USD price can't be derived. Try another version/chain, or use find_pool to inspect its pools directly.`,
      );
    }
    const priceUsd = derived * nativePrice;
    return {
      market: { version: m.version, chain, network: m.network, subgraph_id: m.subgraphId },
      token: { address: tok.id, symbol: tok.symbol, name: tok.name, decimals: num(tok.decimals) },
      price_usd: priceUsd,
      native_price_usd: nativePrice,
      priced_via: `${p.tokenDerivedField} × ${p.bundlePriceField}`,
      note: "price_usd is derived on-chain; sanity-check a stablecoin (should read ~$1).",
    };
  });
}

export async function topPools(args: { chain: string; version?: string; first?: number }) {
  const chain = pickChain(args.chain);
  const version = pickVersion(args.version);
  const n = Math.min(Math.max(args.first ?? 10, 1), 50);
  return withMarket(chain, version, async (m) => {
    const p = await getProfile(m.subgraphId);
    if (p.style === "pair") {
      const d = await gqlQuery<{ pairs: any[] }>(
        m.subgraphId,
        `query($n:Int!){ pairs(first:$n, orderBy:volumeUSD, orderDirection:desc){
          id token0{symbol id} token1{symbol id} volumeUSD reserveUSD txCount } }`,
        { n },
      );
      return {
        market: { version: m.version, chain, subgraph_id: m.subgraphId },
        ranked_by: "volumeUSD (lifetime)",
        pools: (d.pairs ?? []).map((x) => ({
          pair: x.id, pair_name: `${x.token0.symbol}/${x.token1.symbol}`,
          volume_usd: num(x.volumeUSD), reserve_usd: num(x.reserveUSD), tx_count: num(x.txCount),
        })),
        note: TVL_NOTE,
      };
    }
    const d = await gqlQuery<{ pools: any[] }>(
      m.subgraphId,
      `query($n:Int!){ pools(first:$n, orderBy:volumeUSD, orderDirection:desc){
        id token0{symbol id} token1{symbol id} feeTier volumeUSD feesUSD totalValueLockedUSD txCount } }`,
      { n },
    );
    return {
      market: { version: m.version, chain, subgraph_id: m.subgraphId },
      ranked_by: "volumeUSD (lifetime)",
      pools: (d.pools ?? []).map((x) => ({
        pool: x.id, pair: `${x.token0.symbol}/${x.token1.symbol}`,
        fee_tier: num(x.feeTier), volume_usd: num(x.volumeUSD), fees_usd: num(x.feesUSD),
        tvl_usd: num(x.totalValueLockedUSD), tx_count: num(x.txCount),
      })),
      note: TVL_NOTE,
    };
  });
}

export async function findPool(args: { tokenA: string; tokenB: string; chain: string; version?: string }) {
  const chain = pickChain(args.chain);
  const version = pickVersion(args.version);
  return withMarket(chain, version, async (m) => {
    const p = await getProfile(m.subgraphId);
    const derived = p.tokenDerivedField ?? "derivedETH";
    const [a, b] = await Promise.all([
      resolveToken(m.subgraphId, derived, args.tokenA),
      resolveToken(m.subgraphId, derived, args.tokenB),
    ]);
    if (!a || !b) throw new Error(`Could not resolve ${!a ? args.tokenA : args.tokenB} on ${m.version} ${chain}.`);
    const ids = [a.id, b.id];

    const entity = p.style === "pair" ? "pairs" : "pools";
    const fee = p.style === "pair" ? "" : "feeTier";
    const tvl = p.style === "pair" ? "reserveUSD" : "totalValueLockedUSD";
    const d = await gqlQuery<any>(
      m.subgraphId,
      `query($ids:[String!]){ ${entity}(where:{token0_in:$ids, token1_in:$ids}, orderBy:volumeUSD, orderDirection:desc){
        id token0{symbol} token1{symbol} ${fee} volumeUSD ${tvl} txCount } }`,
      { ids },
    );
    const rows = d[entity] ?? [];
    return {
      market: { version: m.version, chain, subgraph_id: m.subgraphId },
      tokens: { a: { symbol: a.symbol, address: a.id }, b: { symbol: b.symbol, address: b.id } },
      pools: rows.map((x: any) => ({
        id: x.id, pair: `${x.token0.symbol}/${x.token1.symbol}`,
        ...(p.style === "pool" ? { fee_tier: num(x.feeTier) } : {}),
        volume_usd: num(x.volumeUSD), tvl_usd: num(x[tvl]), tx_count: num(x.txCount),
      })),
      note: rows.length ? TVL_NOTE : "No pool found for this pair on this version/chain — try another version (v2/v3/v4).",
    };
  });
}

export async function poolInfo(args: { pool: string; chain: string; version?: string }) {
  const chain = pickChain(args.chain);
  const version = pickVersion(args.version);
  const id = args.pool.trim().toLowerCase();
  return withMarket(chain, version, async (m) => {
    const p = await getProfile(m.subgraphId);
    if (p.style === "pair") {
      const d = await gqlQuery<{ pairs: any[] }>(
        m.subgraphId,
        `query($id:ID!){ pairs(where:{id:$id}){ id token0{symbol id} token1{symbol id}
          reserve0 reserve1 reserveUSD token0Price token1Price volumeUSD txCount } }`,
        { id },
      );
      const x = d.pairs?.[0];
      if (!x) throw new Error(`Pair ${args.pool} not found on Uniswap ${m.version} ${chain}.`);
      return {
        market: { version: m.version, chain, subgraph_id: m.subgraphId },
        pair: x.id, tokens: `${x.token0.symbol}/${x.token1.symbol}`,
        token0Price: num(x.token0Price), token1Price: num(x.token1Price),
        reserve0: num(x.reserve0), reserve1: num(x.reserve1), reserve_usd: num(x.reserveUSD),
        volume_usd: num(x.volumeUSD), tx_count: num(x.txCount), note: TVL_NOTE,
      };
    }
    const d = await gqlQuery<{ pools: any[] }>(
      m.subgraphId,
      `query($id:ID!){ pools(where:{id:$id}){ id token0{symbol id} token1{symbol id}
        feeTier liquidity token0Price token1Price volumeUSD feesUSD totalValueLockedUSD
        totalValueLockedToken0 totalValueLockedToken1 txCount } }`,
      { id },
    );
    const x = d.pools?.[0];
    if (!x) throw new Error(`Pool ${args.pool} not found on Uniswap ${m.version} ${chain}.`);
    return {
      market: { version: m.version, chain, subgraph_id: m.subgraphId },
      pool: x.id, pair: `${x.token0.symbol}/${x.token1.symbol}`, fee_tier: num(x.feeTier),
      token0Price: num(x.token0Price), token1Price: num(x.token1Price),
      volume_usd: num(x.volumeUSD), fees_usd: num(x.feesUSD), tvl_usd: num(x.totalValueLockedUSD),
      tvl_token0: num(x.totalValueLockedToken0), tvl_token1: num(x.totalValueLockedToken1),
      tx_count: num(x.txCount), note: TVL_NOTE,
    };
  });
}

export async function recentSwaps(args: { chain: string; version?: string; pool?: string; first?: number }) {
  const chain = pickChain(args.chain);
  const version = pickVersion(args.version);
  const n = Math.min(Math.max(args.first ?? 10, 1), 50);
  const poolId = args.pool?.trim().toLowerCase();
  return withMarket(chain, version, async (m) => {
    const p = await getProfile(m.subgraphId);
    if (p.style === "pair") {
      const where = poolId ? `where:{pair:"${poolId}"}, ` : "";
      const d = await gqlQuery<{ swaps: any[] }>(
        m.subgraphId,
        `query($n:Int!){ swaps(first:$n, ${where}orderBy:timestamp, orderDirection:desc){
          timestamp amountUSD amount0In amount1In amount0Out amount1Out from to
          pair{ token0{symbol} token1{symbol} } } }`,
        { n },
      );
      return {
        market: { version: m.version, chain, subgraph_id: m.subgraphId },
        swaps: (d.swaps ?? []).map((s) => ({
          timestamp: num(s.timestamp), time_utc: new Date(num(s.timestamp) * 1000).toISOString(),
          pair: `${s.pair.token0.symbol}/${s.pair.token1.symbol}`, amount_usd: num(s.amountUSD),
          in: `${num(s.amount0In) || num(s.amount1In)}`, out: `${num(s.amount0Out) || num(s.amount1Out)}`,
          trader: s.from,
        })),
      };
    }
    const where = poolId ? `where:{pool:"${poolId}"}, ` : "";
    const d = await gqlQuery<{ swaps: any[] }>(
      m.subgraphId,
      `query($n:Int!){ swaps(first:$n, ${where}orderBy:timestamp, orderDirection:desc){
        timestamp amountUSD amount0 amount1 origin sender
        token0{symbol} token1{symbol} } }`,
      { n },
    );
    return {
      market: { version: m.version, chain, subgraph_id: m.subgraphId },
      swaps: (d.swaps ?? []).map((s) => ({
        timestamp: num(s.timestamp), time_utc: new Date(num(s.timestamp) * 1000).toISOString(),
        pair: `${s.token0.symbol}/${s.token1.symbol}`, amount_usd: num(s.amountUSD),
        amount0: num(s.amount0), amount1: num(s.amount1), trader: s.origin ?? s.sender,
      })),
    };
  });
}

export async function rawQuery(args: { chain: string; version?: string; query: string; variables?: Record<string, unknown> }) {
  const chain = pickChain(args.chain);
  const m = resolveMarket(chain, pickVersion(args.version));
  const data = await gqlQuery(m.subgraphId, args.query, args.variables ?? {});
  return { market: { version: m.version, chain, subgraph_id: m.subgraphId }, data };
}

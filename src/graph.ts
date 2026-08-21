/**
 * Thin, resilient layer over The Graph's gateway for Uniswap subgraphs.
 *
 * Two jobs:
 *  1. gqlQuery() — POST a GraphQL query to /subgraphs/id/<id>, retrying the
 *     gateway's transient "bad indexers" routing so a lagging indexer doesn't
 *     surface as a hard failure.
 *  2. getProfile() — introspect a subgraph ONCE and cache which field names it
 *     uses, so the tools work across Uniswap's schema variants without guessing
 *     (V2 `pairs` vs V3/V4 `pools`; classic `ethPriceUSD`/`derivedETH` vs the
 *     newer `nativePriceUSD`/`derivedNative`; `factory` vs `poolManager`).
 */

const GATEWAY = "https://gateway.thegraph.com/api";

function apiKey(): string {
  const k = process.env.GRAPH_API_KEY || process.env.GRAPH_GATEWAY_API_KEY || "";
  if (!k) {
    throw new Error(
      "GRAPH_API_KEY is not set. Get a free key at https://thegraph.com/studio (Billing → API Keys) and set GRAPH_API_KEY in the MCP server's environment.",
    );
  }
  return k;
}

function isIndexerLag(errors: any[]): boolean {
  const s = JSON.stringify(errors).toLowerCase();
  return s.includes("bad indexers") || s.includes("too far behind") || s.includes("unavailable") || s.includes("no indexer");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A gateway indexer can accept the TCP connection and then never respond. Without
// an AbortController that hangs the whole tool call (observed: 45s+ on some
// base/optimism queries). These bounds make a stalled indexer fail FAST — each
// attempt is time-boxed, only transient failures retry, and the total retry
// budget is capped — so callers get a quick clean error (and the tools can fall
// back to another version) instead of an indefinite hang. All tunable via env.
// 20s is generous enough for a legitimately slow ordered query and lets the
// gateway's own ~15s "bad indexers" message surface (more useful than a bare
// timeout), while still bounding a truly stalled indexer that would otherwise
// hang forever. Retries are reserved for recoverable failures (lag/5xx/network);
// a stall (abort) fails fast so the tools can fall back to another version.
const HTTP_TIMEOUT_MS = Number(process.env.GRAPH_HTTP_TIMEOUT_MS) || 15000;
const MAX_ATTEMPTS = Math.max(1, Number(process.env.GRAPH_MAX_ATTEMPTS) || 2);
const TOTAL_BUDGET_MS = Number(process.env.GRAPH_TOTAL_BUDGET_MS) || 32000;

export interface QueryOpts {
  /** per-attempt HTTP timeout in ms (default GRAPH_HTTP_TIMEOUT_MS / 8000) */
  timeoutMs?: number;
  /** max attempts including the first (default GRAPH_MAX_ATTEMPTS / 2) */
  maxAttempts?: number;
}

const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === "AbortError";
const timeoutError = (ms: number, id: string) =>
  new Error(`gateway request timed out after ${ms}ms — the routed indexer for subgraph ${id} was unresponsive.`);

/**
 * Run a GraphQL query against a subgraph id. Each attempt is time-bounded by an
 * AbortController, and ONLY transient failures retry (timeout, network drop,
 * 5xx/429, genuine indexer lag/routing). A deterministic error — a bad query, a
 * 4xx, a real subgraph error — is thrown immediately instead of being looped 3×.
 */
export async function gqlQuery<T = any>(
  subgraphId: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: QueryOpts = {},
): Promise<T> {
  const url = `${GATEWAY}/${apiKey()}/subgraphs/id/${subgraphId}`;
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const start = Date.now();
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && Date.now() - start > TOTAL_BUDGET_MS) break; // out of budget
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`gateway HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        // 5xx / 429 are transient → retry; other 4xx are deterministic → throw.
        if ((res.status >= 500 || res.status === 429) && attempt < maxAttempts - 1) {
          lastErr = err;
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw err;
      }
      const json = (await res.json()) as { data?: T; errors?: any[] };
      if (json.errors && json.errors.length) {
        // Indexer lag/routing: a fresh request may land on a healthy indexer.
        if (isIndexerLag(json.errors) && attempt < maxAttempts - 1) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw new Error(`subgraph query error: ${JSON.stringify(json.errors).slice(0, 300)}`);
      }
      return json.data as T;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Deterministic — never retry these.
      if (msg.startsWith("subgraph query error:") || msg.startsWith("gateway HTTP ")) throw e;
      // A stall gets ONE retry, within the remaining budget.
      //
      // The old comment here claimed a stall "will almost certainly re-stall",
      // so it failed fast to let the caller fall back to another version. Two
      // things were wrong with that. The gateway re-routes per request, so a
      // retry usually lands on a DIFFERENT indexer — measured 2026-08-20 on
      // Uniswap V3 Polygon, the same query alternated between a 15s stall and
      // an 80-800ms success. And a chain with only one mapped version (Polygon
      // is exactly that) has nothing to fall back TO, so fast-fail just meant
      // fail. The total budget still bounds this, so a genuinely dead indexer
      // costs one extra attempt rather than an unbounded wait.
      if (isAbort(e)) {
        const remaining = TOTAL_BUDGET_MS - (Date.now() - start);
        if (attempt < maxAttempts - 1 && remaining > 2000) {
          await sleep(300);
          continue;
        }
        throw timeoutError(timeoutMs, subgraphId);
      }
      // Genuine network error (connection reset, DNS, etc.) — retry if attempts remain.
      if (attempt < maxAttempts - 1) {
        await sleep(400 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  if (isAbort(lastErr)) throw timeoutError(timeoutMs, subgraphId);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface SchemaProfile {
  /** "pair" for V2, "pool" for V3/V4 */
  style: "pair" | "pool";
  /** plural query field for the core entity: "pairs" | "pools" */
  entity: "pairs" | "pools";
  /** Bundle field holding the native-token USD price: e.g. "ethPriceUSD" | "ethPrice" | "nativePriceUSD" */
  bundlePriceField: string | null;
  /** Token field for price-in-native: "derivedETH" | "derivedNative" */
  tokenDerivedField: string | null;
  /** whether a Swap entity exists */
  hasSwaps: boolean;
  /** whether a Position entity exists (V3/V4 LP positions) */
  hasPositions: boolean;
  /** Pool fee field: "feeTier" (V3 + most V4 forks) | "fee" (uniswap-v4-ethereum) */
  poolFeeField: string | null;
  /** Pool sqrt-price field: "sqrtPrice" (V3) | "sqrtPriceX96" (V4) */
  poolSqrtField: string | null;
  /** Pool exposes an explicit tickSpacing (V4) rather than implying it from the fee tier */
  hasTickSpacing: boolean;
  /** Pool exposes a `hooks` address (V4 only) */
  hasHooks: boolean;
  /** whether a Tick entity exists — no ticks, no swap simulation */
  hasTicks: boolean;
  /** Pool lifetime-fees field: "feesUSD" (V3) | "totalFeesUSD" (uniswap-v4-ethereum) */
  poolFeesField: string | null;
  /** Tick->pool filter field: "poolAddress" (V3) | "pool" (V4). `pool` exists on
   *  both, but detect anyway so a deployment exposing only one still works. */
  tickPoolField: string | null;
}

const profileCache = new Map<string, SchemaProfile>();

const INTROSPECT = `{
  q: __type(name:"Query"){ fields{ name } }
  tok: __type(name:"Token"){ fields{ name } }
  bun: __type(name:"Bundle"){ fields{ name } }
  pool: __type(name:"Pool"){ fields{ name } }
  tick: __type(name:"Tick"){ fields{ name } }
}`;

/** Introspect a subgraph's field conventions once, then cache. */
export async function getProfile(subgraphId: string): Promise<SchemaProfile> {
  const cached = profileCache.get(subgraphId);
  if (cached) return cached;

  const data = await gqlQuery<{
    q: { fields: { name: string }[] };
    tok?: { fields: { name: string }[] } | null;
    bun?: { fields: { name: string }[] } | null;
    pool?: { fields: { name: string }[] } | null;
    tick?: { fields: { name: string }[] } | null;
  }>(subgraphId, INTROSPECT);

  const qFields = new Set((data.q?.fields ?? []).map((f) => f.name));
  const tokFields = new Set((data.tok?.fields ?? []).map((f) => f.name));
  const bunFields = new Set((data.bun?.fields ?? []).map((f) => f.name));
  // V4 deployments are not uniform with V3 OR with each other: uniswap-v4-ethereum
  // uses fee/tickSpacing/sqrtPriceX96 where V3 uses feeTier/sqrtPrice. Detect rather
  // than assume, so a new deployment does not need a code change to be quotable.
  const poolFields = new Set((data.pool?.fields ?? []).map((f) => f.name));
  const tickFields = new Set((data.tick?.fields ?? []).map((f) => f.name));

  const style: "pair" | "pool" = qFields.has("pairs") && !qFields.has("pools") ? "pair" : "pool";
  const entity: "pairs" | "pools" = style === "pair" ? "pairs" : "pools";

  const bundlePriceField =
    ["ethPriceUSD", "nativePriceUSD", "ethPrice"].find((f) => bunFields.has(f)) ?? null;
  const tokenDerivedField =
    ["derivedETH", "derivedNative"].find((f) => tokFields.has(f)) ?? null;

  const profile: SchemaProfile = {
    style,
    entity,
    bundlePriceField,
    tokenDerivedField,
    hasSwaps: qFields.has("swaps"),
    hasPositions: qFields.has("positions"),
    poolFeeField: ["feeTier", "fee"].find((f) => poolFields.has(f)) ?? null,
    poolSqrtField: ["sqrtPrice", "sqrtPriceX96"].find((f) => poolFields.has(f)) ?? null,
    hasTickSpacing: poolFields.has("tickSpacing"),
    hasHooks: poolFields.has("hooks"),
    hasTicks: qFields.has("ticks"),
    poolFeesField: ["feesUSD", "totalFeesUSD"].find((f) => poolFields.has(f)) ?? null,
    tickPoolField: ["pool", "poolAddress"].find((f) => tickFields.has(f)) ?? null,
  };
  profileCache.set(subgraphId, profile);
  return profile;
}

/** Fetch the current native-token USD price (ETH/BNB/MATIC…) from the Bundle. */
export async function getNativePrice(subgraphId: string, profile: SchemaProfile): Promise<number | null> {
  if (!profile.bundlePriceField) return null;
  const d = await gqlQuery<{ bundles: Array<Record<string, string>> }>(
    subgraphId,
    `{ bundles(first:1){ ${profile.bundlePriceField} } }`,
  );
  const raw = d.bundles?.[0]?.[profile.bundlePriceField];
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

export const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

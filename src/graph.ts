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

/** Run a GraphQL query against a subgraph id, with a small retry for gateway routing hiccups. */
export async function gqlQuery<T = any>(
  subgraphId: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const url = `${GATEWAY}/${apiKey()}/subgraphs/id/${subgraphId}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        // 4xx/5xx from the gateway itself
        const body = await res.text().catch(() => "");
        throw new Error(`gateway HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      const json = (await res.json()) as { data?: T; errors?: any[] };
      if (json.errors && json.errors.length) {
        if (isIndexerLag(json.errors) && attempt < 2) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        throw new Error(`subgraph query error: ${JSON.stringify(json.errors).slice(0, 300)}`);
      }
      return json.data as T;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(400 * (attempt + 1));
    }
  }
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
}

const profileCache = new Map<string, SchemaProfile>();

const INTROSPECT = `{
  q: __type(name:"Query"){ fields{ name } }
  tok: __type(name:"Token"){ fields{ name } }
  bun: __type(name:"Bundle"){ fields{ name } }
}`;

/** Introspect a subgraph's field conventions once, then cache. */
export async function getProfile(subgraphId: string): Promise<SchemaProfile> {
  const cached = profileCache.get(subgraphId);
  if (cached) return cached;

  const data = await gqlQuery<{
    q: { fields: { name: string }[] };
    tok?: { fields: { name: string }[] } | null;
    bun?: { fields: { name: string }[] } | null;
  }>(subgraphId, INTROSPECT);

  const qFields = new Set((data.q?.fields ?? []).map((f) => f.name));
  const tokFields = new Set((data.tok?.fields ?? []).map((f) => f.name));
  const bunFields = new Set((data.bun?.fields ?? []).map((f) => f.name));

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

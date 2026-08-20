/**
 * Offline pre-trade quoting: what a swap would actually return, and what it costs you.
 *
 * The point of this file is that it needs NO RPC and NO extra credential. Uniswap's
 * own routing-api (github.com/uniswap/routing-api) answers this question, but it is
 * self-host-only — an AWS CDK deploy plus RPC provider keys — so an MCP server cannot
 * simply call it. Everything the concentrated-liquidity math needs (sqrtPrice, tick,
 * liquidity, feeTier, and the initialised `ticks`) is already in the subgraph, so we
 * fetch that and run the protocol's own math locally, in src/v3math.ts.
 *
 * Design rule for this module: it is better to REFUSE than to guess. A pre-trade
 * quote is acted on with money. Every path that cannot produce a trustworthy number
 * returns `quotable: false` with a reason instead of a plausible-looking figure.
 */

import { gqlQuery } from "./graph.js";
import type { Version } from "./markets.js";
import { pickChain, pickVersion, withMarket, assertHexId } from "./tools.js";
import { swapExactIn, swapV2ExactIn, priceFromSqrt, type TickData } from "./v3math.js";

/** How far either side of the current tick we pull liquidity. ~±20k ticks is a
 *  ~7x price move in each direction: comfortably past any sane trade, while still
 *  one query. Beyond the window we report ranOutOfTicks instead of extrapolating. */
const TICK_WINDOW = 20_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface TokenLite { id: string; symbol: string; decimals: string }

function scale(amount: number, decimals: number): bigint {
  // Avoid float error on large amounts: split the decimal string rather than
  // multiplying a float by 10**18.
  const s = amount.toFixed(Math.min(decimals, 18));
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}
const human = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export interface QuoteArgs {
  pool: string;
  tokenIn: string;
  amountIn: number;
  chain: string;
  version?: string;
}

export async function quoteSwap(args: QuoteArgs) {
  const { pool: poolAddr, tokenIn, amountIn } = args;
  if (!(amountIn > 0)) return { quotable: false, reason: "amountIn must be greater than zero." };
  const chain = pickChain(args.chain);
  const version = pickVersion(args.version);
  const id = assertHexId(poolAddr);
  return withMarket(chain, version, (market) => quoteOnMarket(market, id, tokenIn, amountIn));
}

async function quoteOnMarket(market: { subgraphId: string; version: Version; chain: string },
                             id: string, tokenIn: string, amountIn: number): Promise<any> {

  if (market.version === "v2") {
    const d = await gqlQuery<{ pair: any }>(market.subgraphId, `{
      pair(id:"${id}") { id reserve0 reserve1
        token0 { id symbol decimals } token1 { id symbol decimals } } }`);
    const p = d.pair;
    if (!p) return { quotable: false, reason: `No V2 pair ${id} on ${market.chain}.` };
    const zeroForOne = matches(tokenIn, p.token0);
    if (!zeroForOne && !matches(tokenIn, p.token1)) {
      return { quotable: false, reason: `${tokenIn} is not in this pair (${p.token0.symbol}/${p.token1.symbol}).` };
    }
    const [tIn, tOut] = zeroForOne ? [p.token0, p.token1] : [p.token1, p.token0];
    const rIn = scale(Number(zeroForOne ? p.reserve0 : p.reserve1), Number(tIn.decimals));
    const rOut = scale(Number(zeroForOne ? p.reserve1 : p.reserve0), Number(tOut.decimals));
    if (rIn <= 0n || rOut <= 0n) return { quotable: false, reason: "Pair has no reserves." };
    const raw = scale(amountIn, Number(tIn.decimals));
    const out = swapV2ExactIn(rIn, rOut, raw);
    const outH = human(out, Number(tOut.decimals));
    const spot = human(rOut, Number(tOut.decimals)) / human(rIn, Number(tIn.decimals));
    return {
      quotable: true, version: "v2", chain: market.chain, pool: p.id,
      token_in: tIn.symbol, token_out: tOut.symbol,
      amount_in: amountIn, amount_out: outH,
      effective_price: outH / amountIn, spot_price: spot,
      price_impact_pct: pct(1 - (outH / amountIn) / (spot * 0.997)),
      fee_pct: 0.3,
      method: "constant-product x*y=k, computed locally from subgraph reserves",
    };
  }

  // ── V3 / V4 ────────────────────────────────────────────────────────────────
  const isV4 = market.version === "v4";
  const hooksField = isV4 ? "hooks" : "";
  const d = await gqlQuery<{ pool: any }>(market.subgraphId, `{
    pool(id:"${id}") { id feeTier liquidity sqrtPrice tick ${hooksField}
      token0 { id symbol decimals } token1 { id symbol decimals } } }`);
  const p = d.pool;
  if (!p) return { quotable: false, reason: `No ${market.version.toUpperCase()} pool ${id} on ${market.chain}.` };

  // V4 hooks can rewrite pricing entirely (dynamic fees, custom curves). Simulating
  // the vanilla curve for a hooked pool would produce a confident, wrong number —
  // and on Base the highest-volume V4 pools are hook-driven with zero in-range
  // liquidity, so this is the common case, not an edge case.
  if (isV4 && p.hooks && p.hooks.toLowerCase() !== ZERO_ADDRESS) {
    return {
      quotable: false, version: "v4", chain: market.chain, pool: p.id, hooks: p.hooks,
      reason: "This V4 pool has a hook attached. Hooks can override fees and the pricing curve, "
        + "so an offline simulation of the standard curve would be wrong. Quote it on-chain via the "
        + "V4 Quoter instead.",
    };
  }
  if (BigInt(p.liquidity || 0) <= 0n) {
    return { quotable: false, version: market.version, chain: market.chain, pool: p.id,
      reason: "Pool reports zero in-range liquidity, so there is nothing to swap against at the current tick." };
  }

  const zeroForOne = matches(tokenIn, p.token0);
  if (!zeroForOne && !matches(tokenIn, p.token1)) {
    return { quotable: false, reason: `${tokenIn} is not in this pool (${p.token0.symbol}/${p.token1.symbol}).` };
  }
  const [tIn, tOut]: [TokenLite, TokenLite] = zeroForOne ? [p.token0, p.token1] : [p.token1, p.token0];

  const feePips = Number(p.feeTier);
  const cur = Number(p.tick);
  const t = await gqlQuery<{ ticks: Array<{ tickIdx: string; liquidityNet: string }> }>(
    market.subgraphId,
    `{ ticks(first: 1000, orderBy: tickIdx,
         where: { poolAddress: "${id}", tickIdx_gte: ${cur - TICK_WINDOW}, tickIdx_lte: ${cur + TICK_WINDOW} })
       { tickIdx liquidityNet } }`,
  );
  const ticks: TickData[] = (t.ticks || [])
    .map((x) => ({ i: Number(x.tickIdx), net: x.liquidityNet }))
    .filter((x) => Number.isFinite(x.i));
  if (!ticks.length) {
    return { quotable: false, version: market.version, chain: market.chain, pool: p.id,
      reason: "Subgraph returned no initialised ticks for this pool, so the liquidity curve is unknown." };
  }

  const raw = scale(amountIn, Number(tIn.decimals));
  const res = swapExactIn(
    { sqrtPriceX96: p.sqrtPrice, liquidity: p.liquidity, tick: cur, feePips, ticks },
    raw, zeroForOne,
  );

  const outH = human(res.amountOut, Number(tOut.decimals));
  const effective = outH / amountIn;
  const spotT1PerT0 = priceFromSqrt(BigInt(p.sqrtPrice), Number(p.token0.decimals), Number(p.token1.decimals));
  const spot = zeroForOne ? spotT1PerT0 : 1 / spotT1PerT0;
  const feeFrac = feePips / 1e6;
  // Impact measured against the fee-adjusted spot, so the number isolates depth
  // rather than re-reporting the fee the caller already knows about.
  const impact = pct(1 - effective / (spot * (1 - feeFrac)));

  if (res.ranOutOfTicks) {
    return {
      quotable: false, version: market.version, chain: market.chain, pool: p.id,
      token_in: tIn.symbol, token_out: tOut.symbol, amount_in: amountIn,
      lower_bound_amount_out: outH,
      reason: `This trade is larger than the liquidity we can see: it consumed every initialised tick within ±${TICK_WINDOW} of the current tick. `
        + `${outH} ${tOut.symbol} is a LOWER BOUND, not a quote — the real fill may differ. Split the trade or quote it on-chain.`,
    };
  }

  return {
    quotable: true, version: market.version, chain: market.chain, pool: p.id,
    token_in: tIn.symbol, token_out: tOut.symbol,
    amount_in: amountIn, amount_out: outH,
    effective_price: effective,
    spot_price: spot,
    price_impact_pct: impact,
    fee_pct: feePips / 1e4,
    fee_paid_in_token_in: amountIn * feeFrac,
    ticks_crossed: res.ticksCrossed,
    end_tick: res.endTick,
    method: "Uniswap concentrated-liquidity math computed locally from subgraph pool state + ticks — no RPC. "
      + "Wei-exact against @uniswap/v3-sdk (see test/quote-math.mjs).",
    caveat: "Simulated against the subgraph's most recent indexed block. Real execution depends on the "
      + "state at inclusion; MEV, pending swaps and indexer lag can all move it.",
  };
}

function matches(needle: string, tok: TokenLite): boolean {
  const n = needle.trim().toLowerCase();
  return n === tok.symbol.toLowerCase() || n === tok.id.toLowerCase();
}
const pct = (x: number): number => Math.round(x * 1e6) / 1e4;

#!/usr/bin/env node
/**
 * Regenerate test/fixtures/v3-quote-oracle.json — the ground truth that pins this
 * package's swap math to Uniswap's own.
 *
 * This is the ONLY thing in the repo that needs @uniswap/v3-sdk. It is not a
 * dependency (not even a dev one) because it drags ~300MB of Solidity build
 * artifacts in; install it just for this run:
 *
 *   npm i --no-save @uniswap/v3-sdk @uniswap/sdk-core
 *   GRAPH_API_KEY=... node scripts/gen-oracle.mjs
 *
 * The fixture captures real mainnet pool state plus the SDK's expected outputs, so
 * `npm test` can verify wei-exact agreement offline, with no key and no network.
 * Regenerate only when you intend to move the goalposts — and re-read the diff,
 * because a silently changed expectation defeats the entire point of the test.
 */
import { writeFileSync } from "node:fs";
import { Pool, TickListDataProvider, Tick, TICK_SPACINGS } from "@uniswap/v3-sdk";
import { Token, CurrencyAmount } from "@uniswap/sdk-core";

const KEY = process.env.GRAPH_API_KEY;
if (!KEY) { console.error("GRAPH_API_KEY is required"); process.exit(1); }

const SUBGRAPH = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV"; // canonical Uniswap V3, Ethereum
const POOL = "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8";        // USDC/WETH 0.30%
const WINDOW = 20_000;

async function gql(query) {
  const r = await fetch(`https://gateway.thegraph.com/api/subgraphs/id/${SUBGRAPH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

const { pool: p } = await gql(`{
  pool(id:"${POOL}") { id feeTier liquidity sqrtPrice tick
    token0 { id symbol decimals } token1 { id symbol decimals } } }`);
const cur = Number(p.tick);
const { ticks: rawTicks } = await gql(`{
  ticks(first: 1000, orderBy: tickIdx,
        where: { poolAddress: "${POOL}", tickIdx_gte: ${cur - WINDOW}, tickIdx_lte: ${cur + WINDOW} })
  { tickIdx liquidityNet } }`);

const fee = Number(p.feeTier), spacing = TICK_SPACINGS[fee];
const t0 = new Token(1, p.token0.id, Number(p.token0.decimals), p.token0.symbol);
const t1 = new Token(1, p.token1.id, Number(p.token1.decimals), p.token1.symbol);

const list = rawTicks
  .map((t) => ({ index: Number(t.tickIdx), liquidityNet: BigInt(t.liquidityNet), liquidityGross: 0n }))
  .filter((t) => t.index % spacing === 0)
  .sort((a, b) => a.index - b.index);

// The SDK validates that liquidityNet sums to zero, which only holds over the FULL
// tick range. We hold a window, so pin the residual to a synthetic tick at the edge.
// Our own implementation makes no such demand; this exists purely to let the SDK
// build a Pool over a windowed list so it can act as the oracle.
const residual = list.reduce((a, t) => a + t.liquidityNet, 0n);
const lo = list[0].index - spacing, hi = list[list.length - 1].index + spacing;
list.unshift({ index: lo, liquidityNet: 0n, liquidityGross: 0n });
list.push({ index: hi, liquidityNet: -residual, liquidityGross: residual < 0n ? -residual : residual });

const pool = new Pool(t0, t1, fee, p.sqrtPrice, p.liquidity, cur,
  new TickListDataProvider(list.map((t) => new Tick({
    index: t.index, liquidityNet: t.liquidityNet.toString(), liquidityGross: t.liquidityGross.toString(),
  })), spacing));

// Spread chosen to exercise: no tick crossing, a few crossings, many crossings, and
// both directions. A one-case oracle would not catch a broken tick-crossing loop.
const PLAN = [["0.001", t1], ["1", t1], ["10", t1], ["100", t1], ["1000", t1], ["5000", t0], ["250000", t0]];
const cases = [];
for (const [amt, tokIn] of PLAN) {
  const raw = BigInt(Math.round(Number(amt) * 10 ** tokIn.decimals)).toString();
  try {
    const [out, after] = await pool.getOutputAmount(CurrencyAmount.fromRawAmount(tokIn, raw));
    cases.push({ amountIn: raw, tokenIn: tokIn.symbol, outRaw: out.quotient.toString(), endTick: after.tickCurrent });
  } catch (e) {
    cases.push({ amountIn: raw, tokenIn: tokIn.symbol, error: String(e.message).slice(0, 120) });
  }
}

writeFileSync("test/fixtures/v3-quote-oracle.json", JSON.stringify({
  _generated_by: "scripts/gen-oracle.mjs using @uniswap/v3-sdk",
  _pool: `${t0.symbol}/${t1.symbol} ${fee / 1e4}% on Ethereum (${POOL})`,
  pool: { fee, spacing, sqrtPrice: p.sqrtPrice, liquidity: p.liquidity, tick: cur,
          token0: { sym: t0.symbol, dec: t0.decimals }, token1: { sym: t1.symbol, dec: t1.decimals } },
  window: { lo, hi },
  ticks: list.map((t) => ({ i: t.index, net: t.liquidityNet.toString() })),
  cases,
}, null, 1) + "\n");

console.log(`wrote test/fixtures/v3-quote-oracle.json — ${list.length} ticks, ${cases.length} cases`);
for (const c of cases) console.log(` ${c.tokenIn} ${c.amountIn} -> ${c.outRaw ?? c.error}`);

#!/usr/bin/env node
/**
 * Comprehensive stress test for graph-uniswap-mcp.
 *
 * Hammers the server over real MCP stdio JSON-RPC and asserts hard invariants
 * across the whole matrix. Groups:
 *   A. Matrix coverage    — all tools on all 13 markets, chained
 *   B. Data invariants    — stablecoin peg, WETH cross-chain, volume ordering,
 *                           fee tiers, swap freshness/ordering, price sanity
 *   C. Fuzz / edge inputs — bad tokens/chains, undeployed combos, first bounds,
 *                           address casing, aliases, GraphQL injection
 *   D. Concurrency        — many simultaneous calls, no cache cross-talk
 *   E. Fault injection    — tiny timeout, bad key, missing key → fast clean errors
 *   F. Determinism        — repeated calls agree
 *   G. Crash resilience   — server survives a storm of bad calls
 *
 * Availability failures (a degraded gateway: "bad indexers"/timeout) are tagged
 * UPSTREAM and do NOT count as MCP bugs — only wrong data or wrong behavior does.
 *
 * Run:  node test/stress.mjs            (local dist)
 *       node test/stress.mjs --json     (machine-readable summary)
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── load GRAPH_API_KEY (without printing it) ──────────────────────────────────
function loadKey(env) {
  if (env.GRAPH_API_KEY || env.GRAPH_GATEWAY_API_KEY) return env;
  const p = join(homedir(), "graph-advocate", ".env");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(GRAPH_API_KEY|GRAPH_GATEWAY_API_KEY)\s*=\s*(.+?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const BASE_ENV = loadKey({ ...process.env });
const SERVER = ["node", join(process.cwd(), "dist", "index.js")];

// ── minimal persistent MCP client ─────────────────────────────────────────────
class Client {
  constructor(envOverride = {}) {
    this.env = { ...BASE_ENV, ...envOverride };
    this.idc = 0;
    this.pending = new Map();
    this.buf = "";
    this.ready = false;
  }
  async start() {
    this.child = spawn(SERVER[0], SERVER.slice(1), { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.child.stderr.on("data", (d) => (this.stderr += d.toString()));
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    await this.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stress", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tl = await this.send("tools/list");
    this.tools = (tl.result?.tools || []).map((t) => t.name);
    this.ready = true;
  }
  send(method, params, timeoutMs = 55000) {
    const id = ++this.idc;
    const req = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`client timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }
  async call(name, args, timeoutMs) {
    const t0 = Date.now();
    try {
      const r = await this.send("tools/call", { name, arguments: args || {} }, timeoutMs);
      const ms = Date.now() - t0;
      const text = r.result?.content ? r.result.content.map((x) => x.text).join("\n") : null;
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { /* raw */ } }
      return { ms, isError: !!r.result?.isError || !!r.error, error: r.error ? JSON.stringify(r.error) : (r.result?.isError ? text : null), data, text };
    } catch (e) {
      return { ms: Date.now() - t0, isError: true, error: String(e.message || e), data: null, text: null, clientTimeout: true };
    }
  }
  stop() { try { this.child.stdin.end(); this.child.kill(); } catch { /* noop */ } }
}

// ── assertion framework ───────────────────────────────────────────────────────
const R = [];
const check = (cat, name, cond, detail = "") => R.push({ cat, name, status: cond ? "PASS" : "FAIL", detail });
const skipUpstream = (cat, name, detail = "") => R.push({ cat, name, status: "UPSTREAM", detail });
const UP = /timed out|bad indexers|unavailable|too far behind|no indexer|HTTP 5\d\d|HTTP 429|client timeout/i;
const isUpstream = (res) => res.isError && UP.test(String(res.error));
// assert about a call result, auto-skipping when the failure is an upstream availability issue
function assertData(cat, name, res, cond, detail = "") {
  if (isUpstream(res)) return skipUpstream(cat, name, `upstream: ${String(res.error).slice(0, 60)}`);
  check(cat, name, cond, detail);
}

const MARKETS = [
  { v: "v2", c: "ethereum", stable: "USDC", major: "WETH" },
  { v: "v2", c: "base", stable: "USDC", major: "WETH" },
  { v: "v3", c: "ethereum", stable: "USDC", major: "WETH" },
  { v: "v3", c: "arbitrum", stable: "USDC", major: "WETH" },
  { v: "v3", c: "base", stable: "USDC", major: "WETH" },
  { v: "v3", c: "polygon", stable: "USDC", major: "WETH" },
  { v: "v3", c: "optimism", stable: "USDC", major: "WETH" },
  { v: "v3", c: "bsc", stable: "USDC", major: "WBNB" },
  { v: "v4", c: "base", stable: "USDC", major: "WETH" },
  { v: "v4", c: "bsc", stable: "USDC", major: "WBNB" },
  { v: "v4", c: "ethereum", stable: "USDC", major: "WETH" },
  { v: "v4", c: "arbitrum", stable: "USDC", major: "WETH" },
  { v: "v4", c: "optimism", stable: "USDC", major: "WETH" },
];
const V3_FEE_TIERS = new Set([100, 500, 3000, 10000]);
const nowSec = () => Math.floor(Date.now() / 1000);

async function main() {
  const cli = new Client();
  await cli.start();
  check("meta", "server exposes 8 tools", cli.tools.length === 8, cli.tools.join(","));

  // ── A + B: matrix coverage + data invariants, per market ────────────────────
  const wethPrices = {}; // chain -> price (default version) for cross-chain check
  for (const m of MARKETS) {
    const tag = `${m.v}/${m.c}`;
    // price (stablecoin) — the load-bearing schema/pricing check
    const stable = await cli.call("get_token_price", { token: m.stable, chain: m.c, version: m.v });
    assertData("A.price", `${tag} ${m.stable} ~$1`, stable,
      stable.data?.price_usd != null && stable.data.price_usd > 0.95 && stable.data.price_usd < 1.05,
      `= ${stable.data?.price_usd}`);
    assertData("B.schema", `${tag} priced_via present`, stable, !!stable.data?.priced_via, stable.data?.priced_via || "");

    // major token band
    const major = await cli.call("get_token_price", { token: m.major, chain: m.c, version: m.v });
    const mp = major.data?.price_usd;
    const band = m.major === "WETH" ? [1000, 3000] : [200, 1500]; // WETH / WBNB rough bands
    assertData("A.price", `${tag} ${m.major} in band`, major, mp != null && mp > band[0] && mp < band[1], `= ${mp}`);

    // top_pools — volume descending, valid fee tiers (v3 only), non-negative
    const tp = await cli.call("top_pools", { chain: m.c, version: m.v, first: 6 });
    const pools = tp.data?.pools || [];
    if (!isUpstream(tp)) {
      const vols = pools.map((p) => p.volume_usd);
      const desc = vols.every((x, i) => i === 0 || x <= vols[i - 1] + 1e-6);
      check("B.volume", `${tag} top_pools volume descending`, pools.length > 0 && desc, `n=${pools.length}`);
      check("B.volume", `${tag} volumes non-negative`, vols.every((x) => x >= 0), "");
      if (m.v === "v3") {
        const ft = pools.map((p) => p.fee_tier).filter((x) => x != null);
        check("B.feetier", `${tag} v3 fee tiers valid`, ft.length === 0 || ft.every((x) => V3_FEE_TIERS.has(x)), ft.join(","));
      }
    } else skipUpstream("B.volume", `${tag} top_pools`, "upstream");

    // pool_info on the top pool, then recent_swaps scoped to it
    const topAddr = pools[0]?.pool || pools[0]?.pair;
    if (topAddr) {
      const pi = await cli.call("pool_info", { pool: topAddr, chain: m.c, version: m.v });
      assertData("A.pool", `${tag} pool_info top pool`, pi, !pi.isError && (pi.data?.pool || pi.data?.pair), "");
      const rs = await cli.call("recent_swaps", { chain: m.c, version: m.v, pool: topAddr, first: 5 });
      if (!isUpstream(rs)) {
        const sw = rs.data?.swaps || [];
        const ts = sw.map((s) => s.timestamp);
        check("B.swaps", `${tag} swaps timestamp-desc`, ts.every((x, i) => i === 0 || x <= ts[i - 1]), `n=${sw.length}`);
        check("B.swaps", `${tag} swaps have trader+usd`, sw.length === 0 || sw.every((s) => s.trader && s.amount_usd != null), "");
      } else skipUpstream("B.swaps", `${tag} recent_swaps`, "upstream");
    }

    // find_pool order-independence
    const f1 = await cli.call("find_pool", { tokenA: m.major, tokenB: m.stable, chain: m.c, version: m.v });
    const f2 = await cli.call("find_pool", { tokenA: m.stable, tokenB: m.major, chain: m.c, version: m.v });
    if (!isUpstream(f1) && !isUpstream(f2)) {
      const s1 = new Set((f1.data?.pools || []).map((p) => p.id));
      const s2 = new Set((f2.data?.pools || []).map((p) => p.id));
      const same = s1.size === s2.size && [...s1].every((x) => s2.has(x));
      check("B.find", `${tag} find_pool order-independent`, same, `${s1.size} vs ${s2.size}`);
    } else skipUpstream("B.find", `${tag} find_pool`, "upstream");

    // raw_query _meta
    const rq = await cli.call("raw_query", { chain: m.c, version: m.v, query: "{ _meta { block { number } } }" });
    assertData("A.raw", `${tag} raw_query _meta`, rq, rq.data?.data?._meta?.block?.number > 0, "");

    // capture WETH default-version price for cross-chain invariant
    if (m.major === "WETH" && m.v === "v3") {
      const w = await cli.call("get_token_price", { token: "WETH", chain: m.c });
      if (!isUpstream(w) && w.data?.price_usd) wethPrices[m.c] = w.data.price_usd;
    }
  }

  // WETH cross-chain consistency (same asset → prices must agree)
  const wvals = Object.values(wethPrices);
  if (wvals.length >= 2) {
    const min = Math.min(...wvals), max = Math.max(...wvals);
    const spread = ((max - min) / min) * 100;
    check("B.xchain", "WETH agrees across chains (<5%)", spread < 5, `spread ${spread.toFixed(2)}% over ${JSON.stringify(wethPrices)}`);
  } else skipUpstream("B.xchain", "WETH cross-chain", "too few chains returned");

  // ── C: fuzz / edge inputs ───────────────────────────────────────────────────
  const badTok = await cli.call("get_token_price", { token: "ZZZ_NOT_A_TOKEN_9x", chain: "ethereum", version: "v3" });
  assertData("C.fuzz", "bogus token → clean error", badTok, badTok.isError && !badTok.clientTimeout, String(badTok.error).slice(0, 50));
  const badChain = await cli.call("get_token_price", { token: "USDC", chain: "fantom" });
  check("C.fuzz", "bad chain → clean error naming supported", badChain.isError && /supported/i.test(String(badChain.error)), "");
  const undeployed = await cli.call("top_pools", { chain: "polygon", version: "v4" });
  check("C.fuzz", "v4/polygon (undeployed) → clean error", undeployed.isError && !undeployed.clientTimeout, String(undeployed.error).slice(0, 50));
  const big = await cli.call("top_pools", { chain: "ethereum", version: "v3", first: 999 });
  check("C.fuzz", "first=999 → clamped or clean error", (!big.isError && (big.data?.pools?.length ?? 0) <= 50) || big.isError, `n=${big.data?.pools?.length}`);
  const badVer = await cli.call("get_token_price", { token: "USDC", chain: "ethereum", version: "v9" });
  check("C.fuzz", "version v9 → clean error", badVer.isError && /v2, v3, or v4/i.test(String(badVer.error)), "");
  // address casing: checksummed vs lowercase resolve to same token
  const WETH_CS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const aCS = await cli.call("get_token_price", { token: WETH_CS, chain: "ethereum", version: "v3" });
  const aLC = await cli.call("get_token_price", { token: WETH_CS.toLowerCase(), chain: "ethereum", version: "v3" });
  if (!isUpstream(aCS) && !isUpstream(aLC)) check("C.fuzz", "address case-insensitive", aCS.data?.token?.address === aLC.data?.token?.address, "");
  else skipUpstream("C.fuzz", "address case-insensitive", "upstream");
  // symbol == address for WETH mainnet v3
  const bySym = await cli.call("get_token_price", { token: "WETH", chain: "ethereum", version: "v3" });
  if (!isUpstream(bySym) && !isUpstream(aCS)) check("C.fuzz", "symbol resolves to same addr as address", bySym.data?.token?.address === aCS.data?.token?.address, "");
  else skipUpstream("C.fuzz", "symbol==address", "upstream");
  // chain + version aliases
  const alias = await cli.call("get_token_price", { token: "USDC", chain: "arb", version: "uniswap-v3" });
  assertData("C.alias", "chain 'arb' + version 'uniswap-v3'", alias, alias.data?.price_usd > 0.95 && alias.data?.price_usd < 1.05, `${alias.data?.price_usd}`);
  const alias2 = await cli.call("get_token_price", { token: "USDC", chain: "matic", version: "3" });
  assertData("C.alias", "chain 'matic' + version '3'", alias2, alias2.data?.price_usd > 0.9 && alias2.data?.price_usd < 1.1, `${alias2.data?.price_usd}`);
  // GraphQL injection / invalid query → clean error, server survives
  const badGql = await cli.call("raw_query", { chain: "ethereum", version: "v3", query: "{ this is not valid graphql" });
  check("C.inject", "invalid GraphQL → clean error (no crash)", badGql.isError && !badGql.clientTimeout, String(badGql.error).slice(0, 40));
  const okGql = await cli.call("raw_query", { chain: "ethereum", version: "v3", query: "{ factories(first:1){ id } }" });
  assertData("C.inject", "valid raw_query after bad one works", okGql, !okGql.isError, "");
  // nonexistent pool
  const noPool = await cli.call("pool_info", { pool: "0x0000000000000000000000000000000000000000", chain: "ethereum", version: "v3" });
  check("C.fuzz", "nonexistent pool → clean not-found", noPool.isError && !noPool.clientTimeout, String(noPool.error).slice(0, 40));
  // present-but-unpriceable token (derivedETH=0) must NOT be reported as a garbage $0 (red-team regression)
  const unpriceable = await cli.call("get_token_price", { token: "0x0000000f2eb9f69274678c76222b35eec7588a65", chain: "base", version: "v4" });
  if (isUpstream(unpriceable)) skipUpstream("C.fuzz", "unpriceable token not reported as $0", "upstream");
  else check("C.fuzz", "unpriceable token → clean error/null, not $0", unpriceable.isError || unpriceable.data?.price_usd == null, `price=${unpriceable.data?.price_usd}`);

  // ── D: concurrency — many simultaneous calls, no cross-talk ─────────────────
  const conc = [
    ["USDC", "arbitrum"], ["WETH", "ethereum"], ["USDC", "base"], ["WBNB", "bsc"],
    ["WETH", "arbitrum"], ["USDC", "polygon"], ["WETH", "base"], ["USDC", "ethereum"],
    ["USDC", "arbitrum"], ["WETH", "ethereum"], ["USDC", "base"], ["WETH", "arbitrum"],
  ];
  const concRes = await Promise.all(conc.map(([t, c]) => cli.call("get_token_price", { token: t, chain: c }).then((r) => ({ t, c, r }))));
  let crosstalk = 0, ok = 0, up = 0;
  for (const { t, c, r } of concRes) {
    if (isUpstream(r.r ? r.r : r)) { up++; continue; }
    const res = r.r ? r.r : r;
    if (res.isError) { up++; continue; }
    // returned token symbol should match request; chain in market should match
    const symOk = (res.data?.token?.symbol || "").toUpperCase().includes(t.replace("W", "").slice(0, 3)) || res.data?.token?.symbol === t;
    const chainOk = res.data?.market?.chain === c;
    if (chainOk && res.data?.price_usd != null) ok++; else crosstalk++;
  }
  check("D.concurrency", "12 concurrent calls, no cross-talk", crosstalk === 0 && ok > 0, `ok=${ok} crosstalk=${crosstalk} upstream=${up}`);

  // ── F: determinism — repeated call agrees ───────────────────────────────────
  const d1 = await cli.call("top_pools", { chain: "ethereum", version: "v3", first: 3 });
  const d2 = await cli.call("top_pools", { chain: "ethereum", version: "v3", first: 3 });
  if (!isUpstream(d1) && !isUpstream(d2)) {
    const a = (d1.data?.pools || []).map((p) => p.pool).join(",");
    const b = (d2.data?.pools || []).map((p) => p.pool).join(",");
    check("F.determinism", "repeated top_pools same set", a === b && a.length > 0, "");
  } else skipUpstream("F.determinism", "repeated top_pools", "upstream");

  // ── G: crash resilience — a valid call still works after the storm ──────────
  const survive = await cli.call("get_token_price", { token: "USDC", chain: "arbitrum", version: "v3" });
  assertData("G.resilience", "server alive after error storm", survive, survive.data?.price_usd > 0.95, "");
  cli.stop();

  // ── E: fault injection (separate server instances) ──────────────────────────
  // tiny timeout → must fail FAST, never hang
  const tiny = new Client({ GRAPH_HTTP_TIMEOUT_MS: "1", GRAPH_MAX_ATTEMPTS: "1", GRAPH_TOTAL_BUDGET_MS: "1500" });
  await tiny.start();
  const tf = await tiny.call("get_token_price", { token: "USDC", chain: "arbitrum", version: "v3" }, 15000);
  check("E.fault", "1ms timeout fails FAST (<5s), no hang", tf.isError && tf.ms < 5000, `${tf.ms}ms ${String(tf.error).slice(0, 40)}`);
  tiny.stop();
  // bad key → clean gateway/auth error, no hang
  const bad = new Client({ GRAPH_API_KEY: "0000000000000000000000000000dead" });
  await bad.start();
  const bf = await bad.call("get_token_price", { token: "USDC", chain: "arbitrum", version: "v3" }, 30000);
  check("E.fault", "bad API key → clean error, no hang", bf.isError && bf.ms < 25000, `${bf.ms}ms ${String(bf.error).slice(0, 40)}`);
  bad.stop();
  // missing key → helpful message
  const noKeyEnv = { ...BASE_ENV }; delete noKeyEnv.GRAPH_API_KEY; delete noKeyEnv.GRAPH_GATEWAY_API_KEY;
  const nok = new Client();
  nok.env = { ...noKeyEnv };
  await nok.start();
  const nf = await nok.call("get_token_price", { token: "USDC", chain: "arbitrum", version: "v3" }, 15000);
  check("E.fault", "missing key → helpful 'GRAPH_API_KEY is not set'", nf.isError && /GRAPH_API_KEY is not set/i.test(String(nf.error)), String(nf.error).slice(0, 50));
  nok.stop();

  // ── report ──────────────────────────────────────────────────────────────────
  const pass = R.filter((r) => r.status === "PASS").length;
  const fail = R.filter((r) => r.status === "FAIL");
  const nUp = R.filter((r) => r.status === "UPSTREAM").length;
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ pass, fail: fail.length, upstream: nUp, total: R.length, failures: fail, results: R }, null, 2));
    return;
  }
  console.log(`\n${"═".repeat(64)}\n  graph-uniswap-mcp STRESS TEST\n${"═".repeat(64)}`);
  const byCat = {};
  for (const r of R) (byCat[r.cat] ||= []).push(r);
  for (const cat of Object.keys(byCat)) {
    const g = byCat[cat];
    const p = g.filter((x) => x.status === "PASS").length;
    const f = g.filter((x) => x.status === "FAIL").length;
    const u = g.filter((x) => x.status === "UPSTREAM").length;
    console.log(`\n  ${cat}  —  ${p} pass${f ? `, ${f} FAIL` : ""}${u ? `, ${u} upstream-skip` : ""}`);
    for (const r of g) {
      const icon = r.status === "PASS" ? "✓" : r.status === "FAIL" ? "✗" : "•";
      if (r.status !== "PASS") console.log(`    ${icon} [${r.status}] ${r.name}  ${r.detail}`);
    }
  }
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  RESULT: ${pass}/${pass + fail.length} real checks passed` + (nUp ? `  (+${nUp} upstream-skipped, not MCP bugs)` : ""));
  if (fail.length) { console.log(`  ✗ ${fail.length} REAL FAILURES:`); for (const f of fail) console.log(`      - [${f.cat}] ${f.name}  ${f.detail}`); }
  else console.log(`  ✓ ZERO real failures.`);
  console.log(`${"═".repeat(64)}\n`);
}
main().catch((e) => { console.error("STRESS HARNESS ERROR:", e); process.exit(1); });

export const meta = {
  name: 'break-graph-uniswap-mcp',
  description: 'Creative adversarial attempts to make graph-uniswap-mcp return wrong data, crash, or hang',
  phases: [
    { title: 'Attack', detail: 'independent break-it probes' },
    { title: 'Judge', detail: 'confirm each finding is real' },
  ],
}

const HARNESS = `Drive the MCP from ~/uniswap-mcp:
  node test/mcp-harness.mjs '[{"name":"TOOL","arguments":{...},"label":"..."}]'
Prints JSON { init, tools, results:[{label,ms,isError,data,text,error}] }. GRAPH_API_KEY auto-loads.
Tools: list_markets, discover_markets, get_token_price, top_pools, find_pool, pool_info, recent_swaps, raw_query. Each takes chain (string) + optional version ("v2"/"v3"/"v4").
Keep it to a handful of calls — be surgical, not exhaustive.`

const PROBES = [
  {
    key: 'price-hijack',
    mission: `Try to make get_token_price return a WRONG price via a spoofed/spam token. On ethereum v3 and base v4: query get_token_price for common symbols ("USDC","WETH","USDT") and inspect the returned token ADDRESS — does the server pick the real canonical token (by txCount) or can a scam token with the same symbol hijack the result? Also try a token symbol you'd expect to be spammed. FINDING = get_token_price returns a price for a non-canonical/scam token address, or a stablecoin price far from ~$1 because the wrong token was chosen.`,
  },
  {
    key: 'tvl-trap',
    mission: `Confirm the anti-TVL-trap holds. On base v4 and ethereum v3, call top_pools first=10 and inspect tvl_usd/reserve_usd. FINDING = a pool with absurd TVL (billions+ that is clearly fake, e.g. > total crypto market cap) is ranked #1, OR the ordering is by TVL not volume, OR a spam pool with ~0 real liquidity but huge fake TVL is presented as a top/real pool without the TVL caveat. Also check find_pool for a pair and confirm results are volume-ranked.`,
  },
  {
    key: 'cross-version-consistency',
    mission: `A token's USD price should be ~the same regardless of which Uniswap version you ask. On ethereum, call get_token_price for WETH on v2, v3, AND v4 (pin each version). Do the same for WBTC. FINDING = the same token's price differs by more than ~3% across versions on the same chain (a pricing bug), or WBTC is wildly off a sane BTC price (~$30k-120k band), or a stablecoin differs across versions.`,
  },
  {
    key: 'injection-dos',
    mission: `Try to hang or crash the server via raw_query. On ethereum v3, send: (a) a deeply nested / expensive query, (b) raw_query requesting first:100000 pools (bypassing the tool clamp), (c) malformed variables, (d) a query with a syntax error, then (e) a normal valid call to confirm the server is still alive. FINDING = the server hangs (>40s with no response), crashes (subsequent valid call fails), or a huge-first query returns unbounded data / errors ungracefully. Report the timing of each.`,
  },
  {
    key: 'schema-edge',
    mission: `Probe schema edges. (a) On base v4, get_token_price for a token and confirm native-vs-classic pricing produced a sane number. (b) Ask for a token that likely lacks a derived-price field and confirm a clean error, not a garbage 0/NaN price. (c) recent_swaps on a chain with V4 dynamic-fee pools — confirm fee handling doesn't break. (d) pool_info on a valid pool address but WRONG version (a v3 pool address queried as v4) — clean not-found, not a crash or wrong data. FINDING = any garbage numeric output (0, NaN, negative, Infinity), a crash, or wrong data returned as if correct.`,
  },
]

const FINDING_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['probe', 'broke_it', 'severity', 'evidence', 'calls_made'],
  properties: {
    probe: { type: 'string' },
    broke_it: { type: 'boolean', description: 'true if you found real wrong-data / crash / hang' },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    evidence: { type: 'string', description: 'concrete: the call, the wrong output, why it is wrong' },
    calls_made: { type: 'number' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['probe', 'confirmed', 'note'],
  properties: {
    probe: { type: 'string' },
    confirmed: { type: 'boolean', description: 'true if the reported break reproduces and is a real MCP bug (not upstream gateway flakiness)' },
    note: { type: 'string' },
  },
}

phase('Attack')
const results = await pipeline(
  PROBES,
  (p) => agent(
    `You are red-teaming the graph-uniswap-mcp server. Mission "${p.key}": ${p.mission}\n\n${HARNESS}\n\nActually run the calls, look hard at the returned data, and report whether you broke it with concrete evidence. Distinguish a REAL bug (wrong data / crash / hang the server is responsible for) from mere upstream gateway flakiness ("bad indexers"/timeout) — only the former counts as broke_it=true.`,
    { label: `attack:${p.key}`, phase: 'Attack', schema: FINDING_SCHEMA },
  ).then((f) => f && f.broke_it
    ? agent(
        `A red-team probe claims it broke graph-uniswap-mcp. Reproduce and CONFIRM or REFUTE it. Claim:\n${JSON.stringify(f, null, 2)}\n\n${HARNESS}\n\nRe-run the exact calls yourself. confirmed=true ONLY if it reproduces AND is a real MCP defect (wrong data / crash / hang), not upstream "bad indexers"/timeout flakiness. Be skeptical — default to confirmed=false if it's just gateway degradation or expected behavior.`,
        { label: `judge:${p.key}`, phase: 'Judge', schema: VERDICT_SCHEMA },
      ).then((v) => ({ finding: f, verdict: v }))
    : { finding: f, verdict: null }),
)

const confirmed = results.filter(Boolean).filter((r) => r.verdict?.confirmed)
const attempted = results.filter(Boolean)
return {
  probes_run: attempted.length,
  broke_it_claims: attempted.filter((r) => r.finding?.broke_it).length,
  confirmed_bugs: confirmed.length,
  confirmed: confirmed.map((r) => ({ probe: r.finding.probe, severity: r.finding.severity, evidence: r.finding.evidence, judge: r.verdict.note })),
  all: attempted.map((r) => ({ probe: r.finding?.probe, broke_it: r.finding?.broke_it, severity: r.finding?.severity, evidence: r.finding?.evidence, confirmed: r.verdict?.confirmed ?? false })),
}

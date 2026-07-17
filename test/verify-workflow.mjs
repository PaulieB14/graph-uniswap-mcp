export const meta = {
  name: 'verify-graph-uniswap-mcp',
  description: 'Adversarially verify graph-uniswap-mcp across all 8 tools × 13 markets against independent ground truth',
  phases: [
    { title: 'Probe', detail: 'run the full tool battery on each version×chain market' },
    { title: 'Verify', detail: 'independently grade each market against ground truth' },
    { title: 'Cross-check', detail: 'cross-chain price consistency, edge/error cases, direct-subgraph ground truth' },
    { title: 'Synthesize', detail: 'single overall grade + issue list' },
  ],
}

const HARNESS = `Drive the MCP from ~/uniswap-mcp with the test harness:
  node test/mcp-harness.mjs '[{"name":"TOOL_NAME","arguments":{...},"label":"..."}]'
It prints JSON: { init:{serverInfo}, tools:[8 names], results:[{label,ms,isError,data,text,error}] }.
GRAPH_API_KEY is auto-loaded — never set it yourself. Pass several calls in one array.
To chain (e.g. pool_info on a real pool), run top_pools first, copy an address out of .data, then run a second harness invocation with it. Tools take chain (string) + optional version ("v2"/"v3"/"v4").`

const MARKETS = [
  { v: 'v2', c: 'ethereum', stable: 'USDC', major: 'WETH', hint: 'V2 pair-schema (pairs, reserve0/1, ethPrice)' },
  { v: 'v2', c: 'base', stable: 'USDC', major: 'WETH', hint: 'V2 pair-schema' },
  { v: 'v3', c: 'ethereum', stable: 'USDC', major: 'WETH', hint: 'V3 pool-schema (pools, feeTier, ethPriceUSD)' },
  { v: 'v3', c: 'arbitrum', stable: 'USDC', major: 'WETH', hint: 'V3 pool-schema' },
  { v: 'v3', c: 'base', stable: 'USDC', major: 'WETH', hint: 'NATIVE pricing variant — nativePriceUSD/derivedNative, not ethPriceUSD. USDC must STILL read ~$1; if it does, schema-adaptivity works.' },
  { v: 'v3', c: 'polygon', stable: 'USDC', major: 'WETH', hint: 'V3 pool-schema; WETH is bridged here' },
  { v: 'v3', c: 'optimism', stable: 'USDC', major: 'WETH', hint: 'V3 pool-schema; indexers occasionally lag — a transient "bad indexers"/lag error that the server retries past is acceptable, a hard failure is not' },
  { v: 'v3', c: 'bsc', stable: 'USDC', major: 'WBNB', hint: 'V3 pool-schema; no native WETH — use WBNB as the major token' },
  { v: 'v4', c: 'base', stable: 'USDC', major: 'WETH', hint: 'V4 pool-schema; highest-volume Uniswap subgraph on the whole network (~8M queries/day)' },
  { v: 'v4', c: 'bsc', stable: 'USDC', major: 'WBNB', hint: 'V4 pool-schema; use WBNB as major' },
  { v: 'v4', c: 'ethereum', stable: 'USDC', major: 'WETH', hint: 'V4 pool-schema' },
  { v: 'v4', c: 'arbitrum', stable: 'USDC', major: 'WETH', hint: 'V4 pool-schema' },
  { v: 'v4', c: 'optimism', stable: 'USDC', major: 'WETH', hint: 'V4 pool-schema' },
]

const PROBE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['market', 'toolResults', 'stablecoinPriceUSD', 'majorPriceUSD', 'topPoolSample', 'volumeDescending', 'schemaStyle', 'recentSwapFresh', 'discoverOk', 'rawQueryOk', 'errors', 'notes'],
  properties: {
    market: { type: 'string' },
    toolResults: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tool', 'ok', 'ms'], properties: { tool: { type: 'string' }, ok: { type: 'boolean' }, ms: { type: 'number' }, detail: { type: 'string' } } } },
    stablecoinPriceUSD: { type: ['number', 'null'] },
    majorPriceUSD: { type: ['number', 'null'] },
    topPoolSample: { type: 'string', description: 'e.g. "WBTC/USDC 0.05% vol=$12.3M"' },
    volumeDescending: { type: 'boolean', description: 'top_pools returned strictly non-increasing volumeUSD' },
    schemaStyle: { type: 'string', description: 'pair or pool — what the tools actually returned' },
    recentSwapFresh: { type: 'boolean', description: 'newest swap timestamp within the last ~24h' },
    discoverOk: { type: 'boolean' },
    rawQueryOk: { type: 'boolean' },
    errors: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['market', 'grade', 'checks', 'criticalIssues'],
  properties: {
    market: { type: 'string' },
    grade: { type: 'string', enum: ['pass', 'warn', 'fail'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'ok', 'detail'], properties: { name: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } } } },
    criticalIssues: { type: 'array', items: { type: 'string' } },
  },
}

phase('Probe')
const graded = await pipeline(
  MARKETS,
  (m) => agent(
    `You are stress-testing the "graph-uniswap-mcp" MCP server on ONE market: Uniswap ${m.v.toUpperCase()} on ${m.c}.
Market hint: ${m.hint}. Stablecoin for the ~$1 check: ${m.stable}. Major token: ${m.major}.

${HARNESS}

Exercise ALL 8 tools against this market (pass version:"${m.v}", chain:"${m.c}" to each where they take it):
1. list_markets — confirm this ${m.v}/${m.c} market is listed with a subgraph id.
2. get_token_price ${m.stable} — MUST read ~$1.00 (0.97–1.03). This is the load-bearing schema-adaptivity check.
3. get_token_price ${m.major} — sane band (WETH ~ $1,600–2,200; WBNB ~ $400–900).
4. top_pools first=6 — verify volumeUSD is non-increasing (descending) and TVL carries a caveat. Grab the top pool's address.
5. pool_info on that top pool address — full stats returned.
6. find_pool ${m.major}/${m.stable} — returns pool(s); also try the reversed order to confirm order-independence.
7. recent_swaps first=5 (chain-wide) AND recent_swaps scoped to the top pool address — newest swap should be recent (within ~24h) with USD amounts + a wallet.
8. discover_markets {chain:"${m.c}", version:"${m.v}"} — returns recommendations. And raw_query a trivial query (e.g. "{ _meta { block { number } } }") — returns data.

Report the FACTS you observed (not a grade — a later agent grades). schemaStyle = what the tools actually returned ("pair" for V2, "pool" for V3/V4). If the ${m.stable} price is missing or not ~$1, that is a critical fact — record it in errors. Record any tool that errored, timed out, or returned malformed data.`,
    { label: `probe:${m.v}/${m.c}`, phase: 'Probe', schema: PROBE_SCHEMA },
  ).then((probe) => probe && agent(
    `Independently GRADE the graph-uniswap-mcp results for Uniswap ${m.v.toUpperCase()} on ${m.c}. Here are the probe's observed facts:
${JSON.stringify(probe, null, 2)}

Be adversarial — do not take the probe at face value. If any number looks suspicious, re-run it yourself with the harness (${HARNESS}) and confirm. Grade against these hard criteria:
- PASS requires: all 8 tools work; ${m.stable} price is 0.97–1.03; ${m.major} price in a sane band; top_pools volume-descending with TVL caveat; find_pool order-independent; recent_swaps fresh (<~24h) with wallet+USD; discover_markets + raw_query return data; schemaStyle matches the version (V2=pair, V3/V4=pool).
- WARN: works but with a soft issue (e.g. optimism indexer lag that the server retried past, one slow tool, an empty-but-valid result on a low-liquidity pair).
- FAIL: any critical breakage — stablecoin NOT ~$1 (pricing/schema bug), a tool erroring hard, volume not descending, stale swaps on a busy chain, or malformed data.
Return every check you ran with its verdict, and list criticalIssues (empty if none).`,
    { label: `verify:${m.v}/${m.c}`, phase: 'Verify', schema: VERIFY_SCHEMA },
  )),
)

const probes = graded.filter(Boolean)

phase('Cross-check')

// Gather prices in plain code for the cross-chain consistency agent.
// (graded holds VERIFY results; re-collect the raw price facts by re-reading is overkill —
//  instead the cross-chain agent re-pulls WETH across chains itself for an independent read.)
const [edge, xchain, groundTruth] = await parallel([
  () => agent(
    `Test the ERROR/EDGE behavior of graph-uniswap-mcp (must fail gracefully, never crash the server or return garbage).
${HARNESS}
Try, and report expected-vs-actual for each:
- get_token_price with a bogus token "ZZZNOTATOKEN" on ethereum v3 → clean "not found"-style error, not a crash.
- get_token_price on an unsupported chain "fantom" → clean error naming supported chains.
- top_pools on an undeployed combo: version:"v4", chain:"polygon" (V4 is NOT deployed on polygon) → clean error, not a silent wrong-market answer.
- get_token_price by raw address (WETH mainnet 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, chain ethereum) → resolves same as symbol.
- version omitted (get_token_price USDC chain:"base") → picks the highest-volume version and still reads ~$1.
- raw_query with a deliberately invalid GraphQL string → error surfaced, server stays up (a following valid call still works).
- an absurd first (top_pools first=999) → either clamped or clean validation error.
Grade the error handling overall and list any case where it crashed, hung, or returned misleading data instead of a clean error.`,
    { label: 'edge-cases', phase: 'Cross-check', schema: { type: 'object', additionalProperties: false, required: ['grade', 'cases', 'issues'], properties: { grade: { type: 'string', enum: ['pass', 'warn', 'fail'] }, cases: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['input', 'expected', 'actual', 'ok'], properties: { input: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, ok: { type: 'boolean' } } } }, issues: { type: 'array', items: { type: 'string' } } } } },
  ),
  () => agent(
    `Check CROSS-CHAIN PRICE CONSISTENCY for graph-uniswap-mcp. WETH is the same asset everywhere, so its USD price must agree within a couple percent across chains; stablecoins must read ~$1 everywhere.
${HARNESS}
Pull get_token_price for WETH on: ethereum, arbitrum, base, polygon, optimism (let version default). Pull USDC on all of ethereum, arbitrum, base, polygon, optimism, bsc.
Report the spread. PASS if WETH agrees within ~3% across chains and every USDC reads 0.97–1.03. FAIL if any chain's WETH is wildly off (a schema/pricing bug shows up as one chain being 1000x or ~0) or any stablecoin is off-peg in the data.`,
    { label: 'cross-chain-consistency', phase: 'Cross-check', schema: { type: 'object', additionalProperties: false, required: ['grade', 'wethByChain', 'usdcByChain', 'maxDeviationPct', 'issues'], properties: { grade: { type: 'string', enum: ['pass', 'warn', 'fail'] }, wethByChain: { type: 'string' }, usdcByChain: { type: 'string' }, maxDeviationPct: { type: 'number' }, issues: { type: 'array', items: { type: 'string' } } } } },
  ),
  () => agent(
    `DIRECT-SUBGRAPH GROUND TRUTH check — bypass the MCP entirely and confirm it isn't lying.
Step 1: get the MCP's own answer. From ~/uniswap-mcp: node test/mcp-harness.mjs '[{"name":"get_token_price","arguments":{"token":"WETH","chain":"arbitrum","version":"v3"}},{"name":"list_markets","arguments":{}}]' — note the WETH price AND the subgraph_id the tool used for v3/arbitrum.
Step 2: query that SAME subgraph directly, without the MCP. Use the subgraph MCP tool: run ToolSearch with query "select:mcp__subgraph__execute_query_by_subgraph_id" to load it, then call it with that subgraph_id and a query that computes WETH's USD price from raw fields, e.g.:
  { bundles(first:1){ ethPriceUSD } tokens(where:{symbol:"WETH"}, orderBy:txCount, orderDirection:desc, first:1){ symbol derivedETH } }
Compute derivedETH × ethPriceUSD and compare to the MCP's price_usd. They should match within ~1%.
Do the same for USDC on base v3 (that subgraph uses NATIVE fields: bundles{nativePriceUSD}, tokens{derivedNative}) — confirm the MCP's ~$1 matches the direct computation.
Report each comparison. PASS if the MCP's derived prices match direct-from-subgraph computation within ~1–2%; FAIL if they diverge (means the MCP's pricing math is wrong).`,
    { label: 'subgraph-ground-truth', phase: 'Cross-check', schema: { type: 'object', additionalProperties: false, required: ['grade', 'comparisons', 'issues'], properties: { grade: { type: 'string', enum: ['pass', 'warn', 'fail'] }, comparisons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['market', 'mcpPrice', 'directPrice', 'deviationPct', 'ok'], properties: { market: { type: 'string' }, mcpPrice: { type: 'number' }, directPrice: { type: 'number' }, deviationPct: { type: 'number' }, ok: { type: 'boolean' } } } }, issues: { type: 'array', items: { type: 'string' } } } } },
  ),
])

phase('Synthesize')
const synthesis = await agent(
  `Synthesize a final verdict for the graph-uniswap-mcp server ("does it work great?"). Evidence:

PER-MARKET GRADES (13 markets, V2/V3/V4 × chains):
${JSON.stringify(probes, null, 2)}

EDGE/ERROR HANDLING:
${JSON.stringify(edge, null, 2)}

CROSS-CHAIN CONSISTENCY:
${JSON.stringify(xchain, null, 2)}

DIRECT-SUBGRAPH GROUND TRUTH:
${JSON.stringify(groundTruth, null, 2)}

Give an honest overall grade. Count markets passed/warned/failed. List the top real strengths and the top real issues (only issues supported by the evidence — no speculation). End with a one-line recommendation: is this "works great", "works with caveats", or "has real problems", and the single highest-value fix if any.`,
  { label: 'synthesis', phase: 'Synthesize', schema: { type: 'object', additionalProperties: false, required: ['overallGrade', 'marketsPassed', 'marketsWarn', 'marketsFailed', 'strengths', 'issues', 'recommendation', 'topFix'], properties: { overallGrade: { type: 'string' }, marketsPassed: { type: 'number' }, marketsWarn: { type: 'number' }, marketsFailed: { type: 'number' }, strengths: { type: 'array', items: { type: 'string' } }, issues: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' }, topFix: { type: 'string' } } } },
)

return { synthesis, perMarket: probes, edge, xchain, groundTruth }

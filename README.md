# Graph Uniswap MCP

[![npm](https://img.shields.io/npm/v/graph-uniswap-mcp)](https://www.npmjs.com/package/graph-uniswap-mcp)

One MCP interface over **Uniswap V2, V3, and V4** across **Ethereum, Arbitrum, Base, Polygon, Optimism, and BSC** — powered by [The Graph](https://thegraph.com). Ask an agent for a price, the top pools, a pair, or recent swaps on *any* Uniswap deployment and get back clean JSON.

Built to be correct where naive subgraph access goes wrong:

- 🔁 **Self-healing** — markets are addressed by **subgraph ID**, so queries always follow the publisher's *latest* published version. `discover_markets` re-resolves the best live subgraph from The Graph's network subgraph (ranked by curation signal), so new or replacement deployments surface with **no code change**.
- 🧬 **Schema-adaptive** — Uniswap's subgraphs are not uniform (V2 `pairs` vs V3/V4 `pools`; classic `ethPriceUSD`/`derivedETH` vs newer `nativePriceUSD`/`derivedNative`). The server **introspects each subgraph once** and adapts every query automatically.
- 🚫 **Footgun-proofed** — Uniswap subgraph **TVL is unreliable** (one spam-token pool can report *trillions* in fake liquidity). Every ranking is by **`volumeUSD`, never TVL**, and TVL is always returned with a caveat. Prices are derived on-chain and easy to sanity-check (a stablecoin reads ~$1).

## Tools

| Tool | What it does |
|---|---|
| `list_markets` | Every version×chain and its backing subgraph |
| `discover_markets` | Re-resolve the best live subgraph from the network subgraph (self-healing) |
| `get_token_price` | USD price of a token (symbol or address) |
| `top_pools` | Top pools on a chain, ranked by volume |
| `find_pool` | Pool(s) for a token pair, either order |
| `pool_info` | Full stats for one pool/pair |
| `recent_swaps` | Newest swaps, optionally scoped to a pool |
| `raw_query` | Arbitrary GraphQL against the resolved subgraph |

Every tool takes `chain` and an optional `version` (`v2`/`v3`/`v4`). Omit `version` and it uses the highest-volume version on that chain. Chain aliases (`eth`, `arb`, `matic`, `bnb`, …) are accepted.

## Setup

```bash
npm install
npm run build
```

Get a free Graph gateway API key at <https://thegraph.com/studio> (Billing → API Keys — first 100k queries/month are free), then add the server to your MCP client:

```json
{
  "mcpServers": {
    "graph-uniswap": {
      "command": "npx",
      "args": ["-y", "graph-uniswap-mcp"],
      "env": { "GRAPH_API_KEY": "your_key_here" }
    }
  }
}
```

Or run locally: `GRAPH_API_KEY=... npm start`.

## Example calls

```
get_token_price  { "token": "WETH", "chain": "arbitrum" }
top_pools        { "chain": "base", "version": "v4", "first": 5 }
find_pool        { "tokenA": "WBTC", "tokenB": "USDC", "chain": "ethereum" }
recent_swaps     { "chain": "base", "version": "v4", "first": 10 }
discover_markets { "chain": "arbitrum", "version": "v3" }
```

## Covered markets

V4: Base, BNB, Ethereum, Arbitrum, Optimism · V3: Ethereum, Arbitrum, Base, Polygon, Optimism, BSC · V2: Ethereum, Base.
(The set is seeded from live curation-signal + volume rankings and self-heals via `discover_markets`.)

## License

MIT © PaulieB14

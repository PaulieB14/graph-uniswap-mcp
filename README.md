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

13 markets, each backed by a canonical Uniswap-Labs subgraph addressed by **subgraph ID** (so it auto-follows the publisher's latest version). Query volumes are a rough popularity signal from the operator dashboard.

| Version | Chain | What it covers | ~Queries/day | Subgraph ID |
|---|---|---|---:|---|
| **V4** | Base | PoolManager pools + hooks, swaps, fee tiers, prices — **highest-volume Uniswap subgraph on the whole network** | 8.6M | `Gqm2b5J85n1bhCyDMpGbtbVn4935EvvdyHdHrx3dibyj` |
| **V4** | BNB | V4 pools, swaps, fee tiers, prices | 1.7M | `EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX` |
| **V4** | Ethereum | V4 pools, swaps, fee tiers, prices | 233K | `AdA6Ax3jtct69NnXfxNjWtPTe9gMtSEZx2tTQcT4VHu` |
| **V4** | Arbitrum | V4 pools, swaps, fee tiers, prices | — | `D1VHPU6cXXSC8eaApWCjCnPcTZQFSYCpGoDAvt4ogDWh` |
| **V4** | Optimism | V4 pools, swaps, fee tiers, prices | — | `J9QbGgsAJpYFX6tY5y1hy5JkcVUda1kTS2ENGUBqMEY8` |
| **V3** | Ethereum | Concentrated-liquidity pools, fee tiers, swaps, positions, prices | 467K | `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` |
| **V3** | Arbitrum | V3 pools, fee tiers, swaps, prices | 854K | `FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM` |
| **V3** | Base | V3 pools, fee tiers, swaps, prices — *native-pricing schema* (`nativePriceUSD`/`derivedNative`) | 536K | `HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1` |
| **V3** | Polygon | V3 pools, fee tiers, swaps, prices | 539K | `EsLGwxyeMMeJuhqWvuLmJEiDKXJ4Z6YsoJreUnyeozco` |
| **V3** | Optimism | V3 pools, fee tiers, swaps, prices | 307K | `Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj` |
| **V3** | BSC | V3 pools, fee tiers, swaps, prices | 1.1M | `7XgdLW3bts4HktCYsu9dy8bEnuiNeZuftcuK3Aj4JXYV` |
| **V2** | Ethereum | Constant-product pairs, reserves, swaps, prices | 2.4M | `GmSczqdCDZ3hJeYY9JphwsADn5rePUzUKm8EZcVuhRAm` |
| **V2** | Base | V2 pairs, reserves, swaps, prices | 1.6M | `DbcUmZwXBYbNZvLuDEvcmFa4uAWwwjrdX8dVFg1AUVKa` |

Call `list_markets` for this table live, or `discover_markets` to re-resolve the best current subgraph from The Graph's network subgraph. *(V4 is not yet deployed on Polygon.)*

## Reliability

Built for agents that can't babysit a hung tool call:

- **Fail-fast, never hang.** Every gateway request is time-boxed by an `AbortController` (default 15s/attempt), so a stalled indexer returns a clean error instead of hanging your agent. Only genuinely transient failures (indexer lag, 5xx) retry.
- **Version fallback (self-healing on the data path).** When you *don't* pin a version and the top market's indexers are down, the server transparently falls back to the next-highest-volume version on that chain and still returns real data — the response's `served` field tells you which version answered. A pinned version is never silently swapped.
- **Tunable** via env: `GRAPH_HTTP_TIMEOUT_MS` (15000), `GRAPH_MAX_ATTEMPTS` (2), `GRAPH_TOTAL_BUDGET_MS` (25000).

## Keyless pay-per-query (x402)

This server uses a shared `GRAPH_API_KEY` (free tier: 100k queries/month). If you'd rather an agent pay **per query with no API key or account at all**, pair it with **[PayQL](https://www.npmjs.com/package/payql)** — an MCP that runs any Graph subgraph query (including all the Uniswap subgraphs above) over [x402](https://x402.org), paying ~$0.01 in USDC per call via the gateway's `…/api/x402/…` path. Gasless (EIP-3009), keyless, wallet-agnostic — the payment *is* the auth. Use this MCP for the curated Uniswap tools, and PayQL when you want the raw, key-free pay-as-you-go path.

## License

MIT © PaulieB14

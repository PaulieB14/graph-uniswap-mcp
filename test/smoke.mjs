#!/usr/bin/env node
/**
 * Offline smoke test — the CI publish gate (`npm test`).
 *
 * Boots the built server over stdio and asserts the MCP handshake works and
 * every expected tool is registered and described. NO network, NO
 * GRAPH_API_KEY required — so it runs anywhere (CI without secrets) and fails
 * fast on build/wiring breakage, which is the one thing a publish gate must
 * catch. Deeper data-correctness checks live in stress.mjs (needs a key +
 * live network): `npm run test:live`.
 *
 * Exit 0 = pass, non-zero = fail.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const EXPECTED = [
  "list_markets", "discover_markets", "get_token_price", "top_pools",
  "find_pool", "pool_info", "recent_swaps", "raw_query",
];

// Deliberately strip the key so we prove the gate needs no secret/network.
const child = spawn("node", [join(process.cwd(), "dist", "index.js")], {
  env: { ...process.env, GRAPH_API_KEY: "", GRAPH_GATEWAY_API_KEY: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let idc = 0;
function send(method, params) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

function die(msg) {
  console.error(`✗ smoke: ${msg}`);
  if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-3).join("\n"));
  try { child.kill(); } catch {}
  process.exit(1);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (init.error) die(`initialize failed: ${JSON.stringify(init.error)}`);
  notify("notifications/initialized");

  const list = await send("tools/list", {});
  if (list.error) die(`tools/list failed: ${JSON.stringify(list.error)}`);
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  const want = [...EXPECTED].sort();
  const missing = want.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !want.includes(n));
  if (missing.length || extra.length) {
    die(`tool set mismatch — missing: [${missing}]  unexpected: [${extra}]  got: [${names}]`);
  }
  const undesc = (list.result?.tools || []).filter((t) => !t.description || !t.description.trim());
  if (undesc.length) die(`tools missing descriptions: [${undesc.map((t) => t.name)}]`);

  console.log(`✓ smoke: handshake OK, ${names.length} tools registered, all described.`);
  try { child.kill(); } catch {}
  process.exit(0);
} catch (e) {
  die(String((e && e.message) || e));
}

#!/usr/bin/env node
/**
 * Minimal MCP stdio test client for graph-uniswap-mcp.
 *
 * Usage:
 *   node test/mcp-harness.mjs '<json-array-of-calls>'
 *   node test/mcp-harness.mjs --file calls.json
 *   node test/mcp-harness.mjs --server 'npx -y graph-uniswap-mcp' '<calls>'
 *
 * Each call: { "name": "tool_name", "arguments": {...}, "label": "optional" }
 * If no calls are given, it just does initialize + tools/list (a smoke test).
 *
 * Auto-loads GRAPH_API_KEY from ~/graph-advocate/.env if not already set,
 * so subagents don't have to handle the key. Prints a structured JSON report
 * to stdout; the server's own logs go to stderr and are ignored.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- load key without printing it ---
if (!process.env.GRAPH_API_KEY && !process.env.GRAPH_GATEWAY_API_KEY) {
  const envPath = join(homedir(), "graph-advocate", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(GRAPH_API_KEY|GRAPH_GATEWAY_API_KEY)\s*=\s*(.+?)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// --- args ---
const argv = process.argv.slice(2);
let serverCmd = ["node", join(process.cwd(), "dist", "index.js")];
let callsRaw = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--server") { serverCmd = argv[++i].split(" "); }
  else if (argv[i] === "--file") { callsRaw = readFileSync(argv[++i], "utf8"); }
  else { callsRaw = argv[i]; }
}
let calls = [];
if (callsRaw) { try { calls = JSON.parse(callsRaw); } catch (e) { console.error("bad calls json:", e.message); process.exit(2); } }
if (!Array.isArray(calls)) calls = [calls];

// --- spawn server ---
const child = spawn(serverCmd[0], serverCmd.slice(1), {
  env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

// --- newline-delimited JSON reader keyed by id ---
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
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
  const req = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method} (id ${id})`)); }, 45000);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
    child.stdin.write(JSON.stringify(req) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
}

const report = { server: serverCmd.join(" "), keyPresent: !!(process.env.GRAPH_API_KEY || process.env.GRAPH_GATEWAY_API_KEY), init: null, tools: null, results: [] };

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "harness", version: "0.0.0" },
  });
  report.init = { ok: !init.error, serverInfo: init.result?.serverInfo, error: init.error };
  notify("notifications/initialized");

  const tl = await send("tools/list");
  report.tools = (tl.result?.tools || []).map((t) => t.name);

  for (const c of calls) {
    const label = c.label || `${c.name}(${JSON.stringify(c.arguments || {})})`;
    const t0 = Date.now();
    try {
      const r = await send("tools/call", { name: c.name, arguments: c.arguments || {} });
      const ms = Date.now() - t0;
      let text = null;
      if (r.result?.content) text = r.result.content.map((x) => x.text).join("\n");
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch { /* leave as text */ } }
      report.results.push({
        label,
        ms,
        isError: !!r.result?.isError || !!r.error,
        error: r.error || null,
        text: parsed ? null : text,   // keep raw text only when not JSON
        data: parsed,
      });
    } catch (e) {
      report.results.push({ label, ms: Date.now() - t0, isError: true, error: String(e.message || e) });
    }
  }
} catch (e) {
  report.fatal = String(e.message || e);
}

child.stdin.end();
try { child.kill(); } catch { /* noop */ }
if (stderr.trim()) report.serverStderr = stderr.trim().split("\n").slice(-4);
console.log(JSON.stringify(report, null, 2));
process.exit(0);

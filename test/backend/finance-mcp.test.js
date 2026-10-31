// Default finance MCP for US stocks: shipped config shape, readiness, injection.
// Covers the finance-us server (yahoo-finance-mcp, no key) + finance-us grant.
// Run: node --test test/backend/finance-mcp.test.js
// Live probe (needs network + npm registry): FINANCE_MCP_LIVE=1 node --test test/backend/finance-mcp.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listServers, serverStatus, mcpForAgent, probeServer, readTools } from "../../src/services/mcp.js";
import { validateServer } from "../../src/routes/mcp.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shippedTools = () => JSON.parse(readFileSync(join(REPO, "config", "tools.json"), "utf8"));
const shippedAgents = () => JSON.parse(readFileSync(join(REPO, "config", "agents.json"), "utf8"));
const clearMcpEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("MCP_")) delete process.env[k]; };

let root;
beforeEach(() => {
  clearMcpEnv();
  root = mkdtempSync(join(tmpdir(), "tab-finance-mcp-"));
  mkdirSync(join(root, "config"), { recursive: true });
});
afterEach(() => {
  clearMcpEnv();
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

test("shipped finance-us server: valid, ready with no secrets, expected tools", () => {
  const s = shippedTools().servers.find((x) => x.id === "finance-us");
  assert.ok(s, "config/tools.json must ship a finance-us server");
  assert.equal(s.num, 5);
  assert.equal(s.transport, "stdio");
  assert.equal(s.command, "npx");
  assert.deepEqual(s.args, ["-y", "yahoo-finance-mcp"]);
  assert.equal(validateServer(s), null);
  assert.deepEqual(serverStatus(s), { status: "ready", missing: [] });
  assert.ok((s.tools || []).length >= 10, "probed tool list recorded");
  for (const t of ["get_quote", "get_historical_data", "get_news", "search_symbols"]) {
    assert.ok(s.tools.includes(t), `missing tool ${t}`);
  }
});

test("shipped finance-us agent is granted the server and it injects without secrets", async () => {
  const agent = shippedAgents().agents.find((a) => a.id === "finance-us");
  assert.ok(agent, "config/agents.json must ship a finance-us agent");
  assert.ok((agent.mcp || []).includes("finance-us"), "finance-us agent must grant finance-us by default");

  // End-to-end on a copy of the shipped config (never mutate the repo).
  const doc = shippedTools();
  writeFileSync(join(root, "config", "tools.json"), JSON.stringify(doc));
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify(shippedAgents()));
  const before = readFileSync(join(root, "config", "tools.json"), "utf8");
  const servers = listServers(root);
  assert.equal(servers.find((x) => x.id === "finance-us").num, 5, "stable num, no renumber");
  assert.equal(readTools(root).mcpNextNum, 5);
  assert.equal(readFileSync(join(root, "config", "tools.json"), "utf8"), before, "listServers must not rewrite shipped numbering");

  const cfg = { root, agents: new Map(shippedAgents().agents.map((a) => [a.id, { ...a }])), providers: [] };
  const r = await mcpForAgent(cfg, "finance-us");
  assert.deepEqual(r.used, ["finance-us"]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.env, {}, "no per-run secrets for a keyless server");
  assert.equal(r.muse[0], "-c");
  const entry = JSON.parse(r.muse[1].slice("mcpServers.finance-us=".length));
  assert.equal(entry.transport, "stdio");
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "yahoo-finance-mcp"]);
  assert.deepEqual(r.copilot.mcpServers["finance-us"], {
    type: "local", command: "npx", args: ["-y", "yahoo-finance-mcp"], tools: ["*"],
  });
});

test("live probe of shipped finance-us server", { skip: !process.env.FINANCE_MCP_LIVE }, async () => {
  const s = shippedTools().servers.find((x) => x.id === "finance-us");
  const r = await probeServer(s, { timeoutMs: 60000 });
  assert.equal(r.ok, true, r.hint);
  assert.ok(r.tools.length >= 10, `expected tools, got ${r.tools.length}`);
});

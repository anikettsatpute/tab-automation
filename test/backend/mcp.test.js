// MCP registry: numbering, secret slots in .env, per-agent grants, injection
// shape for Muse/Copilot, child-env stripping, routes, and a stdio probe.
// Run: node --test test/backend/mcp.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listServers, serverStatus, refAllowed, mcpForAgent, probeServer, writeCopilotConfig, noteMcpFailure, readTools,
} from "../../src/services/mcp.js";
import { validateServer } from "../../src/routes/mcp.js";
import { buildChildEnv } from "../../src/services/runner.js";

let root, cfg, appMod;
const LOCAL = "127.0.0.1:3002";
function req(app, path, { method = "GET", body = null } = {}) {
  const init = { method, headers: { host: LOCAL, "content-type": "application/json", origin: `http://${LOCAL}` } };
  if (body !== null) init.body = JSON.stringify(body);
  return app.request(`http://${LOCAL}${path}`, init, { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000 } } });
}
const call = async (app, path, opts) => { const r = await req(app, path, opts); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const clearMcpEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith("MCP_")) delete process.env[k]; };

const FAKE_MCP = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
  if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: process.env.FAKE_TOKEN === "tok" ? [{ name: "echo" }, { name: "ping" }] : [] } }) + "\\n");
});`;

beforeEach(async () => {
  clearMcpEnv();
  delete process.env.CONTROL_TOKEN;
  root = mkdtempSync(join(tmpdir(), "tab-mcp-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "fake-mcp.cjs"), FAKE_MCP);
  const agents = [{ id: "assistant", systemPrompt: "hi" }, { id: "writer", systemPrompt: "w" }];
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({ agents }));
  writeFileSync(join(root, "config", "providers.json"), JSON.stringify({ defaultProvider: "muse", providers: [{ id: "muse", type: "muse" }] }));
  writeFileSync(join(root, "config", "tools.json"), JSON.stringify({ servers: [
    { id: "fs", transport: "stdio", command: "npx", args: ["-y", "x"] },
    { id: "gh", transport: "stdio", command: "npx", args: [], env: { GH_TOKEN: "${MCP_2_TOKEN}" }, secrets: [{ slot: "TOKEN" }] },
  ], customTools: [] }));
  const dbm = await import("../../src/db.js");
  dbm.closeDb(); dbm.openDb(root);
  cfg = { root, workflows: [], agents: new Map(agents.map((a) => [a.id, { ...a }])), providers: [] };
  appMod = await import("../../src/headless-dashboard.js");
});

afterEach(async () => {
  clearMcpEnv();
  try { (await import("../../src/db.js")).closeDb(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

test("servers get stable numbers that persist and are never reused", () => {
  const s = listServers(root);
  assert.deepEqual(s.map((x) => [x.id, x.num]), [["fs", 1], ["gh", 2]]);
  const doc = readTools(root);
  assert.equal(doc.mcpNextNum, 2);
  doc.servers = doc.servers.filter((x) => x.id !== "gh");
  doc.servers.push({ id: "new", transport: "stdio", command: "npx", args: [] });
  writeFileSync(join(root, "config", "tools.json"), JSON.stringify(doc));
  assert.equal(listServers(root).find((x) => x.id === "new").num, 3);
});

test("status + reference rules", () => {
  const [fs, gh] = listServers(root);
  assert.equal(serverStatus(fs).status, "ready");
  assert.equal(serverStatus(gh).status, "needs-secret");
  assert.deepEqual(serverStatus(gh).missing, ["MCP_2_TOKEN"]);
  process.env.MCP_2_TOKEN = "x";
  assert.equal(serverStatus(gh).status, "ready");
  assert.equal(refAllowed(gh, "MCP_2_TOKEN"), true);
  assert.equal(refAllowed(gh, "MCP_1_TOKEN"), false);
  for (const k of ["DISCORD_BOT_TOKEN", "AZURE_KEY", "CONTROL_TOKEN", "MUSE_KEY", "MCP_RUN_2_E_X"]) assert.equal(refAllowed(gh, k), false, k);
  assert.equal(serverStatus({ ...gh, env: { A: "${DISCORD_BOT_TOKEN}" } }).status, "error");
  assert.equal(serverStatus({ ...fs, enabled: false }).status, "disabled");
});

test("validateServer rejects literal secrets, foreign refs, plain http", () => {
  const base = { id: "x", num: 5, transport: "stdio", command: "npx", args: [] };
  assert.equal(validateServer(base), null);
  assert.match(validateServer({ ...base, env: { T: "ghp_abcdef" } }), /literal secret/);
  assert.match(validateServer({ ...base, env: { T: "Bearer abc" } }), /literal secret/);
  assert.match(validateServer({ ...base, env: { T: "${MCP_1_TOKEN}" } }), /cannot reference/);
  assert.match(validateServer({ ...base, env: { T: "${DISCORD_BOT_TOKEN}" } }), /cannot reference/);
  assert.equal(validateServer({ ...base, env: { T: "${MCP_5_TOKEN}" } }), null);
  assert.match(validateServer({ id: "h", num: 1, transport: "http", url: "http://example.com/mcp" }), /localhost/);
  assert.equal(validateServer({ id: "h", num: 1, transport: "http", url: "http://localhost:9/mcp" }), null);
  assert.match(validateServer({ ...base, command: "rm -rf /" }), /command/);
});

test("mcpForAgent: default none, grants only ready servers, per-run env refs", async () => {
  listServers(root);
  assert.deepEqual((await mcpForAgent(cfg, "assistant")).used, []);
  cfg.agents.get("assistant").mcp = ["fs", "gh", "missing"];
  let r = await mcpForAgent(cfg, "assistant");
  assert.deepEqual(r.used, ["fs"]);
  assert.deepEqual(r.skipped.map((x) => x.id), ["gh", "missing"]);
  process.env.MCP_2_TOKEN = "secret-val";
  r = await mcpForAgent(cfg, "assistant");
  assert.deepEqual(r.used, ["fs", "gh"]);
  assert.equal(r.env.MCP_RUN_2_E_GH_TOKEN, "secret-val");
  const ghArg = r.muse.find((a) => a.startsWith("mcpServers.gh="));
  const entry = JSON.parse(ghArg.slice("mcpServers.gh=".length));
  assert.deepEqual(entry.env, { GH_TOKEN: "${MCP_RUN_2_E_GH_TOKEN}" });
  assert.ok(!ghArg.includes("secret-val"), "muse args never carry secret values");
  assert.equal(r.muse.filter((a) => a === "-c").length, 2);
  assert.deepEqual(r.copilot.mcpServers.gh, { type: "local", command: "npx", args: [], tools: ["*"], env: { GH_TOKEN: "secret-val" } });
  assert.deepEqual((await mcpForAgent(cfg, "writer")).used, []);
});

test("OAuth http server: Bearer header becomes a whole-value per-run ref", async () => {
  const doc = readTools(root);
  doc.servers.push({ id: "remote", num: 7, transport: "http", url: "https://mcp.example.com/mcp", oauth: { tokenEndpoint: "https://a/t" }, headers: { Authorization: "Bearer ${MCP_7_ACCESS_TOKEN}" } });
  writeFileSync(join(root, "config", "tools.json"), JSON.stringify(doc));
  assert.equal(validateServer(doc.servers.at(-1)), null);
  cfg.agents.get("assistant").mcp = ["remote"];
  assert.match((await mcpForAgent(cfg, "assistant")).skipped[0].reason, /needs-auth/);
  process.env.MCP_7_ACCESS_TOKEN = "at";
  const r = await mcpForAgent(cfg, "assistant");
  assert.deepEqual(r.used, ["remote"]);
  assert.equal(r.env.MCP_RUN_7_H_AUTHORIZATION, "Bearer at");
  assert.deepEqual(JSON.parse(r.muse[1].split("=").slice(1).join("=")), { transport: "streamable_http", url: "https://mcp.example.com/mcp", headers: { Authorization: "${MCP_RUN_7_H_AUTHORIZATION}" } });
  assert.deepEqual(r.copilot.mcpServers.remote.headers, { Authorization: "Bearer at" });
});

test("buildChildEnv strips MCP_* secrets", () => {
  process.env.MCP_2_TOKEN = "s"; process.env.MCP_RUN_2_E_X = "s";
  const env = buildChildEnv({});
  assert.equal(env.MCP_2_TOKEN, undefined);
  assert.equal(env.MCP_RUN_2_E_X, undefined);
});

test("copilot config file is 0600 and cleaned up", () => {
  const { file, cleanup } = writeCopilotConfig({ mcpServers: {} });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  cleanup();
  assert.equal(existsSync(file), false);
});

test("noteMcpFailure flags the failing server", () => {
  listServers(root);
  assert.equal(noteMcpFailure(root, "Error: Required MCP server `fs` failed during startup"), "fs");
  assert.equal(readTools(root).servers.find((s) => s.id === "fs").authStatus, "error");
  assert.equal(serverStatus(listServers(root)[0]).status, "error");
});

test("stdio probe lists tools with the slot secret injected", async () => {
  process.env.MCP_9_TOKEN = "tok";
  const s = { id: "fake", num: 9, transport: "stdio", command: process.execPath, args: [join(root, "fake-mcp.cjs")], env: { FAKE_TOKEN: "${MCP_9_TOKEN}" } };
  const r = await probeServer(s, { timeoutMs: 10000 });
  assert.equal(r.ok, true, r.hint);
  assert.deepEqual(r.tools, ["echo", "ping"]);
});

test("routes: add, secrets (write-only), grant, test, delete", async () => {
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  let r = await call(app, "/api/control/mcp");
  assert.equal(r.status, 200);
  assert.equal(r.data.nextNum, 3);

  r = await call(app, "/api/control/mcp", { method: "POST", body: { _new: true, id: "fake", transport: "stdio", command: process.execPath, args: [join(root, "fake-mcp.cjs")], env: { FAKE_TOKEN: "${TOKEN}" }, secrets: [{ slot: "token", label: "API" }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let s = r.data.servers.find((x) => x.id === "fake");
  assert.equal(s.num, 3);
  assert.deepEqual(s.env, { FAKE_TOKEN: "${MCP_3_TOKEN}" }, "slot shorthand expands to MCP_<num>_SLOT");
  assert.equal(s.status, "needs-secret");

  r = await call(app, "/api/control/mcp", { method: "POST", body: { _new: true, id: "fake", transport: "stdio", command: "npx", args: [] } });
  assert.equal(r.status, 409);
  r = await call(app, "/api/control/mcp", { method: "POST", body: { _new: true, id: "bad", transport: "stdio", command: "npx", args: [], env: { T: "ghp_123456" } } });
  assert.equal(r.status, 400);

  r = await call(app, "/api/control/mcp/fake/secrets", { method: "POST", body: { set: { TOKEN: "tok" } } });
  assert.equal(r.status, 200);
  assert.match(readFileSync(join(root, ".env"), "utf8"), /^MCP_3_TOKEN=/m);
  assert.ok(!JSON.stringify(r.data).includes("\"tok\""), "secret value never returned");
  s = r.data.servers.find((x) => x.id === "fake");
  assert.equal(s.secrets[0].set, true);
  assert.equal(s.status, "ready");
  r = await call(app, "/api/control/mcp/fake/secrets", { method: "POST", body: { set: { OTHER: "x" } } });
  assert.equal(r.status, 400);

  r = await call(app, "/api/control/mcp/fake/test", { method: "POST", body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.test.ok, true, r.data.test.hint);
  assert.deepEqual(r.data.test.tools, ["echo", "ping"]);

  r = await call(app, "/api/control/mcp/fake/agents", { method: "POST", body: { agents: ["writer"] } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "config", "agents.json"), "utf8")).agents.find((a) => a.id === "writer").mcp, ["fake"]);
  assert.deepEqual(cfg.agents.get("writer").mcp, ["fake"], "live config updated");
  assert.deepEqual((await mcpForAgent(cfg, "writer")).used, ["fake"]);
  r = await call(app, "/api/control/mcp/fake/agents", { method: "POST", body: { agents: ["nobody"] } });
  assert.equal(r.status, 400);

  r = await call(app, "/api/control/mcp/fake", { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal(process.env.MCP_3_TOKEN, undefined);
  assert.doesNotMatch(readFileSync(join(root, ".env"), "utf8"), /MCP_3_TOKEN/);
  assert.equal(cfg.agents.get("writer").mcp, undefined);
  assert.equal(readTools(root).mcpNextNum, 3, "num not reused");
});

test("routes: mutations need auth when a token is set", async () => {
  process.env.CONTROL_TOKEN = "t".repeat(32);
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  const r = await app.request("http://example.com/api/control/mcp/fs/secrets", { method: "POST", headers: { "content-type": "application/json", host: "example.com", origin: "http://example.com" }, body: JSON.stringify({ set: { TOKEN: "x" } }) }, { incoming: { socket: { remoteAddress: "203.0.113.5", remotePort: 1 } } });
  assert.ok([401, 403].includes(r.status), `got ${r.status}`);
  delete process.env.CONTROL_TOKEN;
});

// Config editor backend: unredact, provider/agent validation, config + discord
// write routes, automation command validation, discord command lookup.
// Run: node --test test/backend/config-routes.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unredact, validateProviders, validateAgents } from "../../src/routes/config.js";

let root;
let appMod;
let cfg;

const LOCAL = { socketIp: "127.0.0.1", host: "127.0.0.1:3002" };
function req(app, path, { method = "GET", body = null } = {}) {
  const init = { method, headers: { host: LOCAL.host, "content-type": "application/json", origin: `http://${LOCAL.host}` } };
  if (body !== null) init.body = JSON.stringify(body);
  return app.request(`http://${LOCAL.host}${path}`, init, { incoming: { socket: { remoteAddress: LOCAL.socketIp, remotePort: 50000 } } });
}
async function json(res) { return { status: res.status, data: await res.json().catch(() => ({})) }; }
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tab-cfg-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  const agents = [{ id: "assistant", systemPrompt: "hi" }, { id: "writer", systemPrompt: "write" }];
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({ agents }));
  writeFileSync(join(root, "config", "providers.json"), JSON.stringify({ defaultProvider: "muse", providers: [
    { id: "muse", type: "muse", modelDefault: "muse-spark-1.3" },
    { id: "or", type: "openrouter", keyEnv: "OR_KEY", endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-live-secret-123" },
  ] }));
  writeFileSync(join(root, "config", "task-types.json"), JSON.stringify({ taskTypes: [{ id: "t1", name: "T1", steps: [{ role: "writer", goal: "g" }] }] }));
  writeFileSync(join(root, "config", "discord.json"), JSON.stringify({ mainChannelId: "111111", botTokenEnv: "DISCORD_BOT_TOKEN" }));
  const dbm = await import("../../src/db.js");
  dbm.closeDb();
  dbm.openDb(root);
  delete process.env.CONTROL_TOKEN;
  delete process.env.DISCORD_CHANNEL_ID;
  cfg = { root, workflows: [], agents: new Map(agents.map((a) => [a.id, a])), providers: [], discord: { channelId: "111111" } };
  appMod = await import("../../src/headless-dashboard.js");
});

afterEach(async () => {
  try { (await import("../../src/db.js")).closeDb(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

test("unredact restores masked values and drops bare masks", () => {
  const disk = { providers: [{ id: "a", apiKey: "real" }, { id: "b", token: "t" }] };
  const out = unredact({ providers: [{ id: "b", token: "••••••" }, { id: "a", apiKey: "••••••", extra: 1 }, { id: "c", apiKey: "••••••" }] }, disk);
  assert.deepEqual(out.providers, [{ id: "b", token: "t" }, { id: "a", apiKey: "real", extra: 1 }, { id: "c" }]);
});

test("provider + agent validation", () => {
  assert.equal(validateProviders({ defaultProvider: "x", providers: [{ id: "x", type: "muse" }] }), null);
  assert.match(validateProviders({ providers: [{ id: "Bad Id", type: "muse" }] }), /lowercase/);
  assert.match(validateProviders({ providers: [{ id: "x", type: "nope" }] }), /unknown type/);
  assert.match(validateProviders({ providers: [{ id: "x", type: "openrouter", endpoint: "http://insecure" }] }), /https/);
  assert.match(validateProviders({ providers: [{ id: "x", type: "openrouter", keyEnv: "sk-abc" }] }), /env var NAME/);
  assert.match(validateProviders({ defaultProvider: "y", providers: [{ id: "x", type: "muse" }] }), /not defined/);
  const prov = new Set(["muse"]);
  assert.equal(validateAgents({ agents: [{ id: "a", systemPrompt: "s", provider: "muse", temperature: 0.5 }] }, prov), null);
  assert.match(validateAgents({ agents: [{ id: "a" }] }, prov), /systemPrompt/);
  assert.match(validateAgents({ agents: [{ id: "a", systemPrompt: "s", provider: "zzz" }] }, prov), /unknown provider/);
  assert.match(validateAgents({ agents: [{ id: "a", systemPrompt: "s", temperature: 5 }] }, prov), /0–2/);
  assert.match(validateAgents({ agents: [{ id: "a", systemPrompt: "s" }, { id: "a", systemPrompt: "s" }] }, prov), /duplicate/);
});

test("GET config exposes keyStatus + discord view, never secrets", async () => {
  process.env.OR_KEY = "set";
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  const r = await json(await req(app, "/api/control/config"));
  delete process.env.OR_KEY;
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.providers.keyStatus, { muse: false, or: true });
  assert.equal(r.data.discord.mainChannelId, "111111");
  assert.equal(typeof r.data.discord.tokenSet, "boolean");
  assert.ok(!JSON.stringify(r.data).includes("sk-live-secret"));
});

test("redacted round-trip save keeps the on-disk secret; agents hot-reload", async () => {
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  const got = (await json(await req(app, "/api/control/config"))).data;
  got.agents.agents.push({ id: "poet", systemPrompt: "haiku", temperature: "0.9" });
  const r = await json(await req(app, "/api/control/config", { method: "POST", body: { providers: got.providers, agents: got.agents } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const prov = readJson("config/providers.json");
  assert.equal(prov.providers.find((p) => p.id === "or").apiKey, "sk-live-secret-123");
  assert.equal(prov.keyStatus, undefined);
  assert.equal(readJson("config/agents.json").agents.find((a) => a.id === "poet").temperature, 0.9);
  assert.ok(cfg.agents.has("poet"));
});

test("invalid config is rejected; referenced agents cannot be deleted", async () => {
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  const bad = await json(await req(app, "/api/control/config", { method: "POST", body: { providers: { defaultProvider: "muse", providers: [{ id: "muse", type: "muse", endpoint: "http://x" }] } } }));
  assert.equal(bad.status, 400);
  const del = await json(await req(app, "/api/control/config", { method: "POST", body: { agents: { agents: [{ id: "assistant", systemPrompt: "hi" }] } } }));
  assert.equal(del.status, 409);
  assert.match(del.data.error, /writer.*pipeline t1/);
});

test("discord routing save validates ids and hot-applies", async () => {
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  const bad = await json(await req(app, "/api/control/config/discord", { method: "POST", body: { mainChannelId: "general" } }));
  assert.equal(bad.status, 400);
  const ok = await json(await req(app, "/api/control/config/discord", { method: "POST", body: { mainChannelId: "222222", ownerUserId: "333333", extraChannels: "444444, 555555" } }));
  assert.equal(ok.status, 200);
  const doc = readJson("config/discord.json");
  assert.equal(doc.mainChannelId, "222222");
  assert.deepEqual(doc.extraChannels, ["444444", "555555"]);
  assert.equal(doc.botTokenEnv, "DISCORD_BOT_TOKEN");
  assert.equal(cfg.discord.channelId, "222222");
});

test("automation builder: command validation + discord lookup", async () => {
  const { app } = appMod.createHeadlessApp(cfg, { root, log: () => {} });
  const mk = (over) => ({ id: "demo", title: "Demo", trigger_type: "discord", trigger_config: { command: "haiku" }, steps: [{ id: "s1", type: "agent", agent: "writer", prompt: "{{trigger.text}}" }], ...over });
  assert.equal((await req(app, "/api/control/automations", { method: "POST", body: mk({ trigger_config: { command: "!Bad" } }) })).status, 400);
  assert.equal((await req(app, "/api/control/automations", { method: "POST", body: mk({ trigger_config: { command: "todo" } }) })).status, 400);
  assert.equal((await req(app, "/api/control/automations", { method: "POST", body: mk({ steps: [{ id: "s1", type: "agent", agent: "ghost" }] }) })).status, 400);
  assert.equal((await req(app, "/api/control/automations", { method: "POST", body: mk() })).status, 200);
  assert.equal((await req(app, "/api/control/automations", { method: "POST", body: mk({ id: "other" }) })).status, 409);
  const { findDiscordAutomation } = await import("../../src/discord.js");
  const wf = findDiscordAutomation(cfg, "haiku");
  assert.equal(wf.id, "demo");
  assert.equal(wf.steps[0].agent, "writer");
  assert.equal(findDiscordAutomation(cfg, "nope"), null);
});

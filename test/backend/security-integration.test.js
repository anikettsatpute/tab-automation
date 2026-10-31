// Security integration: central auth middleware over real Hono HTTP.
// Covers: public health/static login, private reads gated (all methods),
// spoofed forwarded headers rejected, socket+host locality, CSRF origin,
// remote token login -> HttpOnly session cookie, config redaction (no suffix
// secrets, keyEnv names preserved), cookie CSRF, fail-closed no-token.
// Run: node --test test/backend/security-integration.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root;
let appMod;
let access;

function fakeCfg() {
  return { root, workflows: [], agents: new Map([["assistant", { id: "assistant" }]]) };
}

// Build a request against the real Hono app with a controlled socket + host.
// socketIp: the REAL peer (injected via Env bindings, like @hono/node-server).
// host: the Host header / URL host. extraHeaders: raw headers (spoof tests).
function req(app, path, { method = "GET", socketIp = "", host = "127.0.0.1:3002", headers = {}, body = null } = {}) {
  const url = `http://${host}${path}`;
  const h = { host, ...headers };
  const init = { method, headers: h };
  if (body !== null) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const env = socketIp
    ? { incoming: { socket: { remoteAddress: socketIp, remotePort: 50000 } } }
    : {};
  return app.request(url, init, env);
}

async function json(res) {
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") || "" };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tab-sec-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({ agents: [{ id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }] }));
  writeFileSync(join(root, "config", "providers.json"), JSON.stringify({ defaultProvider: "muse", providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3" }] }));
  writeFileSync(join(root, "config", "streams.json"), JSON.stringify({ streams: [{ id: "general", agents: ["assistant"] }], pipelines: [] }));
  writeFileSync(join(root, "config", "dashboard.json"), JSON.stringify({ enabled: true, refreshSec: 3 }));
  const dbm = await import("../../src/db.js");
  dbm.closeDb();
  dbm.openDb(root);
  delete process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_ALLOWED_ORIGIN;
  appMod = await import("../../src/headless-dashboard.js");
  access = await import("../../src/services/access.js");
});

afterEach(async () => {
  try { (await import("../../src/db.js")).closeDb(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  delete process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_ALLOWED_ORIGIN;
});

test("public health stays open; private reads fail closed with no token", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const h = await json(await req(app, "/api/health", { socketIp: "203.0.113.9", host: "tunnel.example" }));
  assert.equal(h.status, 200);
  assert.equal(h.data.ok, true);
  for (const p of ["/api/control/tasks", "/api/control/config", "/api/control/overview", "/api/feed?limit=2", "/api/dashboard"]) {
    const r = await json(await req(app, p, { socketIp: "203.0.113.9", host: "tunnel.example" }));
    assert.equal(r.status, 403, p);
    assert.equal(r.data.authRequired, true);
  }
});

test("spoofed X-Forwarded-For 127.0.0.1 with remote socket is NOT local", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const r = await json(await req(app, "/api/control/tasks", {
    socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
  }));
  assert.equal(r.status, 403);
  assert.equal(r.data.authRequired, true);
});

test("loopback socket + public host is remote (cloudflare shape)", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const r = await json(await req(app, "/api/control/tasks", {
    socketIp: "127.0.0.1", host: "tunnel.example",
    headers: { "x-forwarded-for": "203.0.113.9" },
  }));
  assert.equal(r.status, 403);
});

test("true local (loopback socket + local host, no proxy headers) passes", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const r = await json(await req(app, "/api/control/tasks", { socketIp: "127.0.0.1", host: "127.0.0.1:3002" }));
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test("remote token login mints HttpOnly session cookie; cookie reads+mutates", async () => {
  process.env.CONTROL_TOKEN = "s3cr3t-token";
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const denied = await json(await req(app, "/api/control/tasks", { socketIp: "203.0.113.9", host: "tunnel.example" }));
  assert.equal(denied.status, 401);
  // Wrong token fails.
  const bad = await json(await req(app, "/api/control/login", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", origin: "http://tunnel.example" },
    body: { token: "nope" },
  }));
  assert.equal(bad.status, 401);
  // Right token mints HttpOnly SameSite cookie (no token in body).
  const ok = await json(await req(app, "/api/control/login", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", origin: "http://tunnel.example" },
    body: { token: "s3cr3t-token" },
  }));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.match(ok.setCookie, /tab_session=[^;]+;.*HttpOnly/i);
  assert.match(ok.setCookie, /SameSite=Lax/i);
  assert.ok(!JSON.stringify(ok.data).includes("s3cr3t-token"));
  const cookie = ok.setCookie.split(";")[0];
  const read = await json(await req(app, "/api/control/tasks", {
    socketIp: "203.0.113.9", host: "tunnel.example", headers: { cookie },
  }));
  assert.equal(read.status, 200);
  const mut = await json(await req(app, "/api/control/todos", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", cookie, origin: "http://tunnel.example" },
    body: { text: "cookie todo" },
  }));
  assert.equal(mut.status, 200);
  assert.ok(mut.data.id);
});

test("Bearer token still works for API clients; cross-site origin rejected", async () => {
  process.env.CONTROL_TOKEN = "s3cr3t-token";
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const ok = await json(await req(app, "/api/control/tasks", {
    socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { authorization: "Bearer s3cr3t-token" },
  }));
  assert.equal(ok.status, 200);
  const xsite = await json(await req(app, "/api/control/todos", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", authorization: "Bearer s3cr3t-token", origin: "https://evil.example" },
    body: { text: "x" },
  }));
  assert.equal(xsite.status, 403);
});

test("same-origin mutation check: attacker localhost:other-port does not pass", async () => {
  process.env.CONTROL_TOKEN = "s3cr3t-token";
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const login = await json(await req(app, "/api/control/login", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", origin: "http://tunnel.example" },
    body: { token: "s3cr3t-token" },
  }));
  const cookie = login.setCookie.split(";")[0];
  // Attacker page on a different origin replays the cookie -> rejected.
  const evil = await json(await req(app, "/api/control/todos", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:9999" },
    body: { text: "evil" },
  }));
  assert.equal(evil.status, 403);
  // Same-origin replay passes.
  const good = await json(await req(app, "/api/control/todos", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", cookie, origin: "http://tunnel.example" },
    body: { text: "good" },
  }));
  assert.equal(good.status, 200);
});

test("config redaction: no suffix secrets, keyEnv names preserved", async () => {
  const out = access.redactConfig({
    providers: [{ id: "muse", keyEnv: "MUSE_KEY", apiKey: "sk-live-123456789", endpoint: "https://x" }],
    nested: { clientSecret: "hunter2-hunter2", password: "p@ssw0rd!", normal: "hello" },
  });
  assert.equal(out.providers[0].keyEnv, "MUSE_KEY");
  assert.equal(out.providers[0].apiKey, "••••••");
  assert.equal(out.nested.clientSecret, "••••••");
  assert.equal(out.nested.password, "••••••");
  assert.equal(out.nested.normal, "hello");
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes("sk-live"));
  assert.ok(!flat.includes("hunter2"));
  assert.ok(!flat.includes("p@ssw0rd"));
});

test("unguarded private endpoints now gated: brain/comments/sessions/outbox/audit", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  for (const p of [
    "/api/control/brain", "/api/control/task/abc/comments", "/api/control/task/abc/sessions",
    "/api/control/outbox", "/api/control/audit", "/api/control/loop-tasks",
    "/api/control/automations", "/api/control/requests", "/api/control/todos",
  ]) {
    const r = await json(await req(app, p, { socketIp: "203.0.113.9", host: "tunnel.example" }));
    assert.ok([401, 403].includes(r.status), `${p} -> ${r.status}`);
  }
});

test("logout clears the session cookie", async () => {
  process.env.CONTROL_TOKEN = "s3cr3t-token";
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const login = await json(await req(app, "/api/control/login", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { "content-type": "application/json", origin: "http://tunnel.example" },
    body: { token: "s3cr3t-token" },
  }));
  const cookie = login.setCookie.split(";")[0];
  const out = await json(await req(app, "/api/control/logout", {
    method: "POST", socketIp: "203.0.113.9", host: "tunnel.example",
    headers: { cookie, origin: "http://tunnel.example" }, body: {},
  }));
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /Max-Age=0/);
  const after = await json(await req(app, "/api/control/tasks", {
    socketIp: "203.0.113.9", host: "tunnel.example", headers: { cookie },
  }));
  assert.equal(after.status, 401);
});

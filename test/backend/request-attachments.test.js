// Scoped safe attachments: text-only allowlist, caps, owner binding,
// TTL, intake embedding with explicit overflow errors. No worker/runner
// changes beyond prompt context; no production DB; no Discord.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root;
let appMod;

function fakeCfg() {
  return { root, workflows: [], agents: new Map([["assistant", { id: "assistant" }]]) };
}

function req(app, path, { method = "GET", socketIp = "127.0.0.1", host = "127.0.0.1:3002", headers = {}, body = null } = {}) {
  const url = `http://${host}${path}`;
  const h = { host, ...headers };
  const init = { method, headers: h };
  if (body !== null) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const env = socketIp ? { incoming: { socket: { remoteAddress: socketIp, remotePort: 50000 } } } : {};
  return app.request(url, init, env);
}

async function json(res) {
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tab-attach-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({ agents: [{ id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }] }));
  writeFileSync(join(root, "config", "providers.json"), JSON.stringify({ defaultProvider: "muse", providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3" }] }));
  writeFileSync(join(root, "config", "streams.json"), JSON.stringify({ streams: [{ id: "general", agents: ["assistant"] }], pipelines: [] }));
  writeFileSync(join(root, "config", "dashboard.json"), JSON.stringify({ enabled: true, refreshSec: 3 }));
  const dbm = await import("../../src/db.js");
  dbm.closeDb();
  dbm.openDb(root);
  const at = await import("../../src/services/attachments.js");
  at.clearAttachmentsForTest();
  delete process.env.CONTROL_TOKEN;
  appMod = await import("../../src/headless-dashboard.js");
});

afterEach(async () => {
  try { (await import("../../src/db.js")).closeDb(); } catch {}
  try { (await import("../../src/services/attachments.js")).clearAttachmentsForTest(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  delete process.env.CONTROL_TOKEN;
});

test("attachments capability advertises text-only allowlist + caps", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const r = await json(await req(app, "/api/control/requests/attachments"));
  assert.equal(r.status, 200);
  assert.equal(r.data.supported, true);
  assert.deepEqual(r.data.allowlist, [".txt", ".md", ".json", ".csv"]);
  assert.ok(r.data.maxFileBytes > 0 && r.data.maxFiles > 0);
});

test("upload text ok; executable/html/binary/traversal/oversize rejected explicitly", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const up = (b) => req(app, "/api/control/requests/attachments", {
    method: "POST", headers: { "content-type": "application/json" }, body: b,
  }).then(json);
  const ok = await up({ filename: "notes.txt", content: "hello world", mime: "text/plain" });
  assert.equal(ok.status, 201);
  assert.ok(ok.data.id);
  assert.equal(ok.data.name, "notes.txt");

  const cases = [
    [{ filename: "run.sh", content: "#!/bin/bash\necho hi", mime: "text/plain" }, /file type refused/],
    [{ filename: "page.txt", content: "<script>alert(1)</script>", mime: "text/plain" }, /html\/script markup refused/],
    [{ filename: "evil.txt", content: "a\u0000b", mime: "text/plain" }, /binary content refused/],
    [{ filename: "../x.txt", content: "hi", mime: "text/plain" }, /unsafe filename/],
    [{ filename: "big.txt", content: "x".repeat(5000), mime: "text/plain" }, /file too large/],
    [{ filename: "bad.json", content: "{not json", mime: "application/json" }, /invalid JSON/],
    [{ filename: "bin.txt", content: "hi", mime: "application/octet-stream" }, /mime refused/],
  ];
  for (const [body, re] of cases) {
    const r = await up(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(r.data.error, re);
  }
});

test("count cap enforced; owner-bound refs; cross-session ref rejected", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const up = (name) => req(app, "/api/control/requests/attachments", {
    method: "POST", headers: { "content-type": "application/json" }, body: { filename: name, content: "x", mime: "text/plain" },
  }).then(json);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await up(`f${i}.txt`);
    assert.equal(r.status, 201);
    ids.push(r.data.id);
  }
  const fourth = await up("f3.txt");
  assert.equal(fourth.status, 400);
  assert.match(fourth.data.error, /too many attachments/);

  // Intake with another session's ref fails explicitly (no silent drop).
  const bad = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json", cookie: "tab_session=other-session" },
    body: { text: "goal with foreign ref", mode: "direct", agents: ["assistant"], attachments: ids },
  }));
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /not found or expired/);
});

test("intake embeds attachment text into job payload; refs consumed one-time", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const up = await json(await req(app, "/api/control/requests/attachments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { filename: "ctx.txt", content: "ATTACH-CONTENT-123", mime: "text/plain" },
  }));
  assert.equal(up.status, 201);
  const enq = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "goal with attachment", mode: "direct", agents: ["assistant"], attachments: [up.data.id] },
  }));
  assert.equal(enq.status, 202);
  assert.ok(enq.data.jobId);
  const dbm = await import("../../src/db.js");
  const job = dbm.getJobRow(root, enq.data.jobId);
  assert.ok(job);
  const payload = JSON.parse(job.payload);
  assert.equal(payload.attachments.length, 1);
  assert.match(JSON.stringify(payload), /ATTACH-CONTENT-123/);
  // One-time refs: replay of the same id is now expired.
  const replay = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "second goal", mode: "direct", agents: ["assistant"], attachments: [up.data.id] },
  }));
  assert.equal(replay.status, 400);
  assert.match(replay.data.error, /not found or expired/);
});

test("step-1 8k cap enforced at intake with explicit error (no silent truncation)", async () => {
  // Two 4k attachments + goal exceed the 8k step-1 prompt cap: intake
  // rejects explicitly (400) instead of truncating or overflowing the job.
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await json(await req(app, "/api/control/requests/attachments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: { filename: `big${i}.txt`, content: "y".repeat(4000), mime: "text/plain" },
    }));
    assert.equal(r.status, 201);
    ids.push(r.data.id);
  }
  const enq = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "x".repeat(3000), mode: "direct", agents: ["assistant"], attachments: ids },
  }));
  assert.equal(enq.status, 400);
  assert.match(enq.data.error, /step 1 prompt too large/);
});

test("single attachment embeds full text into step 1 (no truncation)", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const up = await json(await req(app, "/api/control/requests/attachments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { filename: "ctx.txt", content: "z".repeat(2000), mime: "text/plain" },
  }));
  assert.equal(up.status, 201);
  const enq = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "goal", mode: "direct", agents: ["assistant"], attachments: [up.data.id] },
  }));
  assert.equal(enq.status, 202);
  const dbm = await import("../../src/db.js");
  const payload = JSON.parse(dbm.getJobRow(root, enq.data.jobId).payload);
  assert.ok(Array.isArray(payload.steps) && payload.steps.length >= 1);
  assert.match(payload.steps[0].prompt, /z{2000}/);
  assert.equal(payload.attachments.length, 1);
});

test("oversized job payload fails closed with explicit error (no truncation)", async () => {
  const dbm = await import("../../src/db.js");
  assert.throws(
    () => dbm.enqueueJobSync(root, { kind: "request", payload: { text: "z".repeat(17000) } }),
    /payload too large/
  );
});

test("TTL expiry: stale upload ref rejected, never silently dropped", async () => {
  const at = await import("../../src/services/attachments.js");
  const id = at.createAttachment({ owner: "local", filename: "old.txt", mime: "text/plain", content: "stale" }).id;
  at.pruneAttachments(Date.now() + 31 * 60 * 1000);
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const enq = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "goal", mode: "direct", agents: ["assistant"], attachments: [id] },
  }));
  assert.equal(enq.status, 400);
  assert.match(enq.data.error, /not found or expired/);
});

test("idempotency retry after consumed attachments returns original job for exact payload", async () => {
  // First intake consumes the one-time refs; an auth retry with the same
  // idempotencyKey + exact base payload must return the original job (200
  // deduped) rather than 400 on the now-gone attachment IDs. Scope stays
  // narrow: only exact base-payload matches on existing request jobs dedupe.
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const up = await json(await req(app, "/api/control/requests/attachments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { filename: "idem.txt", content: "IDEM-RETRY-1", mime: "text/plain" },
  }));
  assert.equal(up.status, 201);
  const body = { text: "idempotent goal", mode: "direct", agents: ["assistant"], attachments: [up.data.id], idempotencyKey: "auth-retry-1" };
  const first = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  assert.equal(first.status, 202);
  assert.ok(first.data.jobId);
  const retry = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
  assert.equal(retry.status, 200);
  assert.equal(retry.data.deduped, true);
  assert.equal(retry.data.jobId, first.data.jobId);
  assert.equal(retry.data.attachments.length, 1);
});

test("idempotency retry with different payload conflicts (no broadening)", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const up = await json(await req(app, "/api/control/requests/attachments", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { filename: "idem2.txt", content: "IDEM-RETRY-2", mime: "text/plain" },
  }));
  assert.equal(up.status, 201);
  const first = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "original goal", mode: "direct", agents: ["assistant"], attachments: [up.data.id], idempotencyKey: "auth-retry-2" },
  }));
  assert.equal(first.status, 202);
  const conflict = await json(await req(app, "/api/control/requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: { text: "DIFFERENT goal", mode: "direct", agents: ["assistant"], attachments: [up.data.id], idempotencyKey: "auth-retry-2" },
  }));
  assert.equal(conflict.status, 400);
  assert.match(conflict.data.error, /idempotency conflict/);
});

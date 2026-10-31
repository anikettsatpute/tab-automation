// SSE dashboard stream: ordered replay, bounded buffer, auth gating.
// Backend-only: no frontend changes. No Discord, no production mutations.
// Run: node --test test/backend/events.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root;
let appMod;
let dbm;
let events;

function fakeCfg() {
  return { root, workflows: [], agents: new Map([["assistant", { id: "assistant" }]]) };
}

// Same shape as security-integration.test.js: controlled socket + host.
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

async function readFirstChunk(res, { timeoutMs = 8000 } = {}) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!buf.includes("\n\n") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return buf;
}

function parseSseEvents(text) {
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const out = {};
      for (const line of block.split("\n")) {
        const m = /^([^:]+):\s?(.*)$/.exec(line);
        if (m) out[m[1]] = (out[m[1]] ? out[m[1]] + "\n" : "") + m[2];
      }
      return out;
    });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tab-ev-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({ agents: [{ id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }] }));
  writeFileSync(join(root, "config", "providers.json"), JSON.stringify({ defaultProvider: "muse", providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3" }] }));
  writeFileSync(join(root, "config", "streams.json"), JSON.stringify({ streams: [{ id: "general", agents: ["assistant"] }], pipelines: [] }));
  writeFileSync(join(root, "config", "dashboard.json"), JSON.stringify({ enabled: true, refreshSec: 3 }));
  dbm = await import("../../src/db.js");
  dbm.closeDb();
  dbm.openDb(root);
  events = await import("../../src/services/events.js");
  events.resetEventsState(root);
  delete process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_ALLOWED_ORIGIN;
  appMod = await import("../../src/headless-dashboard.js");
});

afterEach(async () => {
  try {
    events?.resetEventsState(root);
  } catch {
    /* ignore */
  }
  try {
    (await import("../../src/db.js")).closeDb();
  } catch {
    /* ignore */
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_ALLOWED_ORIGIN;
});

test("tick emits once per version; identical DB state does not emit", async () => {
  const first = events.tickEvents(root);
  assert.equal(first.emitted, true);
  assert.match(first.event.id, /^[0-9a-f]{6}:\d+$/);
  const second = events.tickEvents(root);
  assert.equal(second.emitted, false);
  assert.equal(second.event.id, first.event.id);
});

test("DB change bumps version; replay after first id returns later events in order", async () => {
  const a = events.tickEvents(root);
  assert.equal(a.emitted, true);
  const runId = dbm.createRun(root, { workflowId: "wf-1", kind: "manual", trigger: { text: "hi" } });
  const b = events.tickEvents(root);
  assert.equal(b.emitted, true);
  assert.notEqual(b.event.id, a.event.id);
  dbm.finishRun(root, runId, { status: "done" });
  const c = events.tickEvents(root);
  assert.equal(c.emitted, true);

  const replay = events.replayAfter(root, a.event.id);
  assert.equal(replay.reset, false);
  assert.deepEqual(
    replay.events.map((e) => e.id),
    [b.event.id, c.event.id]
  );
  // Current tip replays nothing.
  const tip = events.replayAfter(root, c.event.id);
  assert.equal(tip.reset, false);
  assert.deepEqual(tip.events, []);
});

test("unknown id resets; evicted id resets as window-expired", async () => {
  events.tickEvents(root);
  const unknown = events.replayAfter(root, "deadbe:999");
  assert.equal(unknown.reset, true);
  assert.equal(unknown.reason, "unknown-id");

  // Flood the bounded buffer with distinct versions to evict the first id.
  const first = events.latestEvent(root);
  for (let i = 0; i < events.EVENTS_MAX_BUFFERED + 5; i++) {
    events.appendSnapshot(root, {
      at: new Date().toISOString(),
      source: "headless-local",
      runs: [{ id: `r${i}`, status: "running", steps: [] }],
      messages: [],
      stats: { running: 1, done: 0, failed: 0, total: 1 },
    });
  }
  const evicted = events.replayAfter(root, first.id);
  assert.equal(evicted.reset, true);
  assert.equal(evicted.reason, "window-expired");
  assert.ok(evicted.latest);
});

test("remote unauthenticated stream is rejected before any bytes (no token query)", async () => {
  process.env.CONTROL_TOKEN = "s3cr3t-token";
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  for (const p of ["/api/feed/stream", "/api/feed/stream?token=s3cr3t-token", "/api/feed/stream?since=abc:1"]) {
    const res = await req(app, p, { socketIp: "203.0.113.9", host: "tunnel.example" });
    assert.equal(res.status, 401, p);
    const data = await res.json().catch(() => ({}));
    assert.equal(data.authRequired, true);
  }
});

test("local stream opens as SSE and delivers an ordered baseline snapshot", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const res = await req(app, "/api/feed/stream?tickMs=1000&heartbeatMs=5000", {
    socketIp: "127.0.0.1",
    host: "127.0.0.1:3002",
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const raw = await readFirstChunk(res);
  const parsed = parseSseEvents(raw);
  assert.ok(parsed.length >= 1);
  assert.ok(["snapshot", "reset"].includes(parsed[0].event));
  assert.ok(parsed[0].id || parsed[0].event === "reset");
  if (parsed[0].event === "snapshot") {
    const payload = JSON.parse(parsed[0].data);
    assert.ok(payload.version);
    assert.ok(payload.feed && Array.isArray(payload.feed.runs));
  }
});

test("Last-Event-ID reconnect replays missed snapshots in order", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const local = { socketIp: "127.0.0.1", host: "127.0.0.1:3002" };
  const a = events.tickEvents(root);
  const runId = dbm.createRun(root, { workflowId: "wf-re", kind: "manual", trigger: { text: "x" } });
  const b = events.tickEvents(root);
  assert.equal(b.emitted, true);
  void runId;

  const res = await req(app, "/api/feed/stream?tickMs=1000&heartbeatMs=60000", {
    ...local,
    headers: { "last-event-id": a.event.id },
  });
  assert.equal(res.status, 200);
  const raw = await readFirstChunk(res);
  const parsed = parseSseEvents(raw).filter((e) => e.event === "snapshot");
  assert.ok(parsed.length >= 1);
  assert.equal(parsed[0].id, b.event.id);
});

test("stale ?since= gets an explicit reset with a latest baseline", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  events.tickEvents(root);
  const res = await req(app, "/api/feed/stream?tickMs=1000&since=deadbe:1", {
    socketIp: "127.0.0.1",
    host: "127.0.0.1:3002",
  });
  assert.equal(res.status, 200);
  const raw = await readFirstChunk(res);
  const parsed = parseSseEvents(raw);
  assert.equal(parsed[0].event, "reset");
  const payload = JSON.parse(parsed[0].data);
  assert.equal(payload.reason, "unknown-id");
  assert.ok(payload.latest && payload.latest.id);
});

test("simultaneous subscribers: lagging connection replays the tip even when its own tick emits nothing", async () => {
  // Connection A establishes the baseline tip.
  const a0 = events.tickEvents(root);
  assert.equal(a0.emitted, true);
  // Connection B connects fresh and baselines on the same tip.
  const baseB = events.replayAfter(root, null);
  assert.equal(baseB.reset, false);
  assert.deepEqual(baseB.events, []);
  let lastSentB = events.latestEvent(root).id;
  assert.equal(lastSentB, a0.event.id);

  // DB changes; connection A ticks first and advances the shared tip.
  const runId = dbm.createRun(root, { workflowId: "wf-sim", kind: "manual", trigger: { text: "sim" } });
  void runId;
  const tickA = events.tickEvents(root);
  assert.equal(tickA.emitted, true);

  // Connection B ticks: the shared tip already advanced, so its own tick
  // reports emitted=false — but replay after B's cursor must still yield it.
  const tickB = events.tickEvents(root);
  assert.equal(tickB.emitted, false);
  const missed = events.replayAfter(root, lastSentB);
  assert.equal(missed.reset, false);
  assert.deepEqual(
    missed.events.map((e) => e.id),
    [tickA.event.id]
  );
  lastSentB = missed.events.at(-1).id;

  // Both cursors now current: nothing further to replay.
  assert.deepEqual(events.replayAfter(root, lastSentB).events, []);
});

test("buffers partition by limit: differing limits neither suppress nor leak", async () => {
  const e8 = events.tickEvents(root, { limit: 8 });
  assert.equal(e8.emitted, true);
  // Same DB state, different limit: separate partition, own tip (not suppressed).
  const e2 = events.tickEvents(root, { limit: 2 });
  assert.equal(e2.emitted, true);
  // Steady state in each partition replays nothing in-partition.
  assert.deepEqual(events.replayAfter(root, e8.event.id, { limit: 8 }).events, []);
  assert.deepEqual(events.replayAfter(root, e2.event.id, { limit: 2 }).events, []);

  // A DB change visible at limit 8 must not leak into the limit-2 cursor.
  const runId = dbm.createRun(root, { workflowId: "wf-lim", kind: "manual", trigger: { text: "lim" } });
  void runId;
  const e8b = events.tickEvents(root, { limit: 8 });
  assert.equal(e8b.emitted, true);
  const leak = events.replayAfter(root, e2.event.id, { limit: 2 });
  assert.equal(leak.reset, false);
  assert.deepEqual(leak.events, []);
  // And the limit-8 cursor sees exactly the new event.
  const got = events.replayAfter(root, e8.event.id, { limit: 8 });
  assert.deepEqual(
    got.events.map((e) => e.id),
    [e8b.event.id]
  );
});

test("stale ?since= reset carries an id so native Last-Event-ID advances", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  events.tickEvents(root);
  const tip = events.latestEvent(root);
  assert.ok(tip);
  const res = await req(app, "/api/feed/stream?tickMs=1000&since=deadbe:1", {
    socketIp: "127.0.0.1",
    host: "127.0.0.1:3002",
  });
  assert.equal(res.status, 200);
  const raw = await readFirstChunk(res);
  const parsed = parseSseEvents(raw);
  assert.equal(parsed[0].event, "reset");
  assert.equal(parsed[0].id, tip.id);
  const payload = JSON.parse(parsed[0].data);
  assert.equal(payload.reason, "unknown-id");
  assert.equal(payload.latest.id, parsed[0].id);
});

test("current Last-Event-ID gets no duplicate baseline snapshot", async () => {
  const { app } = appMod.createHeadlessApp(fakeCfg(), { root, log: () => {} });
  const a = events.tickEvents(root);
  const res = await req(app, "/api/feed/stream?tickMs=1000&heartbeatMs=5000", {
    socketIp: "127.0.0.1",
    host: "127.0.0.1:3002",
    headers: { "last-event-id": a.event.id },
  });
  assert.equal(res.status, 200);
  // Baseline sends nothing when the client is current; the first wire bytes
  // are the heartbeat (~5s), proving no duplicate snapshot was emitted.
  const raw = await readFirstChunk(res, { timeoutMs: 12000 });
  const parsed = parseSseEvents(raw);
  assert.ok(parsed.length >= 1);
  assert.equal(parsed[0].event, "heartbeat");
});

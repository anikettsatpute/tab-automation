// Session export: legacy synthetic-id read-only resolution.
// Focused: src/routes/tasks.js export only. Isolated temp root/db per test.
// No inference, no production writes, no service restart.
// Run: node --test test/backend/session-export.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

let root;
let app;
let _dbm = null;
let _origPath = null;
let _binDir = null;

// Fake `muse` on PATH: honors `export --session <id> --out <file>`.
// MUSE_EXPORT_JSON env carries the export doc; seen file captures --session.
function installFakeMuse(exportDoc) {
  _binDir = mkdtempSync(join(tmpdir(), "tab-fakemuse-"));
  const p = join(_binDir, "muse");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const si = args.indexOf("--session");
const oi = args.indexOf("--out");
if (si >= 0 && process.env.MUSE_SEEN_FILE) {
  try { fs.writeFileSync(process.env.MUSE_SEEN_FILE, args[si + 1] || ""); } catch {}
}
const doc = process.env.MUSE_EXPORT_JSON || '{"sessions":[],"events":[]}';
if (oi >= 0) fs.writeFileSync(args[oi + 1], doc);
process.exit(0);
`;
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  _origPath = process.env.PATH || "";
  process.env.PATH = `${_binDir}${delimiter}${_origPath}`;
  process.env.MUSE_EXPORT_JSON = JSON.stringify(exportDoc);
  process.env.MUSE_SEEN_FILE = join(_binDir, "seen-session.txt");
}

function uninstallFakeMuse() {
  if (_origPath !== null) process.env.PATH = _origPath;
  delete process.env.MUSE_EXPORT_JSON;
  delete process.env.MUSE_SEEN_FILE;
  _origPath = null;
  if (_binDir) { try { rmSync(_binDir, { recursive: true, force: true }); } catch {} _binDir = null; }
}

function seenSession() {
  try {
    const f = join(_binDir, "seen-session.txt");
    if (!existsSync(f)) return null;
    return readFileSync(f, "utf8");
  } catch { return null; }
}

function fakeCfg() {
  return { root, workflows: [], agents: new Map([["assistant", { id: "assistant" }]]) };
}

async function req(path, { method = "GET", socketIp = "127.0.0.1", host = "127.0.0.1:3002", headers = {}, body = null } = {}) {
  const url = `http://${host}${path}`;
  const init = { method, headers: { host, ...headers } };
  if (body !== null) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const env = socketIp ? { incoming: { socket: { remoteAddress: socketIp, remotePort: 50000 } } } : {};
  return app.request(url, init, env);
}

async function json(res) {
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tab-sessexp-"));
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
  const mod = await import("../../src/headless-dashboard.js");
  app = mod.createHeadlessApp(fakeCfg(), { root, log: () => {} }).app;
});

afterEach(async () => {
  try { (await import("../../src/db.js")).closeDb(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  uninstallFakeMuse();
  delete process.env.CONTROL_TOKEN;
  delete process.env.CONTROL_ALLOWED_ORIGIN;
});

async function seedLegacyRunAsync(dbm, { runId, sessionId, agent = "assistant", model = "muse-spark-1.3", cliUuid, tamper = null, resultPathOverride = null }) {
  const { buildEnvelope } = await import("../../src/services/envelope.js");
  const { resultPathFor, ensureResponsesDir, atomicWriteJson } = await import("../../src/services/paths.js");
  const { dir, file } = resultPathFor(root, runId, 0, { attempt: 1, sessionId });
  void dir;
  ensureResponsesDir(root, runId);
  const env = buildEnvelope({
    runId, stepIdx: 0, attempt: 1, agent, model, sessionId, cliSessionId: cliUuid,
    resultPath: file, payload: { status: "done", summary: "ok", output: "OUT" },
  });
  const doc = tamper ? tamper({ ...env }) : { ...env };
  atomicWriteJson(file, doc);
  // Legacy DB shape: synthetic id in agent_sessions + session_attempts.
  dbm.openDb(root).prepare(
    "INSERT INTO agent_sessions (id, task_id, step_number, session_uuid, runner_type, agent_role, model, workspace, transcript_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run("s1", runId, 0, sessionId, "muse-cli", agent, model, "", resultPathOverride ?? file, new Date().toISOString());
  dbm.openDb(root).prepare(
    "INSERT INTO session_attempts (id, job_id, run_id, step_index, attempt, agent, model, session_id, result_path, result_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run("a1", "j1", runId, 0, 1, agent, model, sessionId, resultPathOverride ?? file, doc.hash || "", "done", new Date().toISOString());
  return { file, hash: doc.hash };
}

test("setup loads", async () => {
  _dbm = await import("../../src/db.js");
  assert.ok(app);
});

test("legacy synthetic id resolves via envelope cliSessionId (no inference)", async () => {
  _dbm = await import("../../src/db.js");
  const runId = "legacy01";
  const sessionId = `${runId}:assistant:abc123xy`;
  const cliUuid = "499063d5-0681-4e21-a2ba-cb58bae17691";
  await seedLegacyRunAsync(_dbm, { runId, sessionId, cliUuid });
  installFakeMuse({ sessions: [{ turn_count: 1 }], events: [] });
  const r = await json(await req(`/api/control/task/${runId}/sessions/0/export`));
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.sessionId, cliUuid);
  assert.equal(r.data.legacy, true);
  assert.equal(r.data.syntheticId, sessionId);
  assert.equal(seenSession(), cliUuid);
});

test("legacy: tampered envelope hash is rejected (404, no export spawn)", async () => {
  _dbm = await import("../../src/db.js");
  const runId = "legacy02";
  const sessionId = `${runId}:assistant:zz99yyxx`;
  await seedLegacyRunAsync(_dbm, {
    runId, sessionId, cliUuid: "11111111-2222-4333-8444-555555555555",
    tamper: (e) => ({ ...e, output: "EVIL" }),
  });
  installFakeMuse({ sessions: [], events: [] });
  const r = await json(await req(`/api/control/task/${runId}/sessions/0/export`));
  assert.equal(r.status, 404);
  assert.match(String(r.data.error || ""), /envelope invalid|hash/i);
  assert.equal(seenSession(), null);
});

test("legacy: traversal resultPath refused (404, no file read outside run dir)", async () => {
  _dbm = await import("../../src/db.js");
  const runId = "legacy03";
  const sessionId = `${runId}:assistant:qwerty12`;
  await seedLegacyRunAsync(_dbm, {
    runId, sessionId, cliUuid: "22222222-3333-4444-8555-666666666666",
    resultPathOverride: "/etc/passwd",
  });
  const r = await json(await req(`/api/control/task/${runId}/sessions/0/export`));
  assert.equal(r.status, 404);
  assert.match(String(r.data.error || ""), /outside run dir|traversal/i);
});

test("legacy: agent mismatch refused (404)", async () => {
  _dbm = await import("../../src/db.js");
  const runId = "legacy04";
  const sessionId = `${runId}:assistant:mm11nn22`;
  await seedLegacyRunAsync(_dbm, { runId, sessionId, cliUuid: "33333333-4444-4555-8666-777777777777" });
  // Corrupt the attempt agent so it no longer matches the session row.
  _dbm.openDb(root).prepare("UPDATE session_attempts SET agent = 'coder' WHERE run_id = ?").run(runId);
  const r = await json(await req(`/api/control/task/${runId}/sessions/0/export`));
  assert.equal(r.status, 404);
  assert.match(String(r.data.error || ""), /mismatch/i);
});

test("direct payload + legacy children parse to transcript turns", async () => {
  _dbm = await import("../../src/db.js");
  const runId = "legacy05";
  const sessionId = `${runId}:assistant:pp00qq11`;
  await seedLegacyRunAsync(_dbm, { runId, sessionId, cliUuid: "44444444-5555-4666-8777-888888888888" });
  installFakeMuse({
    sessions: [{ turn_count: 3 }],
    events: [
      { recorded_at: "t1", envelope: { payload_type: "runtime.user_intent.accepted", payload: { model_messages: [{ content: [{ text: "hello" }] }] } } },
      { recorded_at: "t2", envelope: { payload_type: "runtime.session", payload: { kind: "run", event: { kind: "assistant_message_committed", text: "world" } } } },
      { recorded_at: "t3", envelope: { children: [{ record_json: JSON.stringify({ payload_type: "x.message", payload: { text: "legacy-child" }, recorded_at: "t3" }) }] } },
    ],
  });
  const r = await json(await req(`/api/control/task/${runId}/sessions/0/export`));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.turns));
  assert.equal(r.data.turns.length, 3);
  assert.equal(r.data.turns[0].kind, "user");
  assert.equal(r.data.turns[0].text, "hello");
  assert.equal(r.data.turns[1].kind, "assistant");
  assert.equal(r.data.turns[2].text, "legacy-child");
});

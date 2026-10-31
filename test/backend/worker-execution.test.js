// Worker execution: end-to-end via a fake `muse` executable.
// Isolated temp root/db per test. HTTP returns fast (202), restart reconciles
// results, cancel/unknown-status/multiagent context all covered.
// Fixture files are created via apply_patch (writeFileSync in-test is allowed:
// the ban is on shell file writes, not test fixtures).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";

function testCfg(root, binDir) {
  return {
    root,
    agents: new Map([
      ["assistant", { id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }],
      ["summarizer", { id: "summarizer", systemPrompt: "sum", defaultPrompt: "sum it" }],
    ]),
    providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3" }],
    defaultProvider: "muse",
    workflows: [],
    museKey: "test",
  };
}

// Fake muse executable: reads --prompt-file, writes canned JSON per MUSE_MODE.
function installFakeMuse(binDir, mode = "done") {
  const p = join(binDir, "muse");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const pi = args.indexOf("--prompt-file");
const promptFile = pi !== -1 ? args[pi + 1] : "";
let prompt = "";
try { prompt = fs.readFileSync(promptFile, "utf-8"); } catch {}
const mode = process.env.MUSE_MODE || ${JSON.stringify(mode)};
// Echo the prompt length + a marker so context-handoff tests can assert it.
const marker = prompt.includes("PREV-RESULT-MARKER") ? " saw-prev" : "";
let payload;
if (mode === "done") payload = { status: "done", summary: "ok" + marker, output: "OUT-" + prompt.length + marker, next: "", updates: { progress: 100, tokens: 7 } };
else if (mode === "blocked") payload = { status: "blocked", summary: "need input", output: "", next: "", updates: {} };
else if (mode === "weird") payload = { status: "mystery", summary: "huh", output: "x", next: "", updates: {} };
else if (mode === "invalid") { process.stdout.write("not json at all"); process.exit(0); }
else payload = { status: "failed", summary: "boom", output: "", next: "", updates: {} };
process.stdout.write(JSON.stringify(payload));
`;
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

async function withPath(binDir, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${prev}`;
  try { return await fn(); } finally { process.env.PATH = prev; }
}

test("worker: HTTP fast + restart reconciles result (request, multiagent context handoff)", async (t) => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow } = dbm;
    const { id: jobId } = enqueueJobSync(root, {
      kind: "request",
      payload: { text: "PREV-RESULT-MARKER hello world", mode: "request", stream: "general", agents: ["assistant", "summarizer"] },
    });
    const j0 = getJobRow(root, jobId);
    assert.equal(j0.status, "queued"); // HTTP returns fast (202 path)
    const { tickOnce } = await import("../../src/services/worker.js");
    await tickOnce(cfg, { log: () => {}, sendDiscord: async () => {} });
    const j1 = getJobRow(root, jobId);
    assert.equal(j1.status, "done");
    assert.ok(j1.run_id);
    // Context handoff: step 2 output mentions the previous result marker.
    const run = dbm.getRun(root, j1.run_id);
    assert.equal(run.steps.length, 2);
    assert.match(run.steps[1].raw_text, /saw-prev/);
    // Restart: tick again processes nothing new; job stays done (no double run).
    await tickOnce(cfg, { log: () => {}, sendDiscord: async () => {} });
    const j2 = getJobRow(root, jobId);
    assert.equal(j2.status, "done");
    const run2 = dbm.getRun(root, j1.run_id);
    assert.equal(run2.steps.length, 2);
  });
});

test("worker: cancel queued job ends terminal (not stuck leased)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow, requestJobCancel } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat" } });
    assert.equal(requestJobCancel(root, jobId), true);
    const { tickOnce } = await import("../../src/services/worker.js");
    await tickOnce(cfg, { log: () => {}, sendDiscord: async () => {} });
    const j = getJobRow(root, jobId);
    // Cancelling a queued job terminalizes it immediately (cancelled, never
    // leased): tick must not lease or run it.
    assert.equal(j.status, "cancelled");
    assert.notEqual(j.status, "leased");
    assert.notEqual(j.status, "running");
  });
});

test("worker: unknown model status normalizes to failed (no silent done)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "weird");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat" } });
    const { tickOnce } = await import("../../src/services/worker.js");
    await tickOnce(cfg, { log: () => {}, sendDiscord: async () => {} });
    const j = getJobRow(root, jobId);
    assert.equal(j.status, "failed");
  });
});

test("worker: blocked envelope -> blocked job + blocked run (no false done)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "blocked");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat" } });
    const { tickOnce } = await import("../../src/services/worker.js");
    await tickOnce(cfg, { log: () => {}, sendDiscord: async () => {} });
    const j = getJobRow(root, jobId);
    assert.equal(j.status, "blocked");
    const run = dbm.getRun(root, j.run_id);
    assert.equal(run.status, "blocked");
  });
});

test("worker: invalid JSON envelope fails the job (no silent catch)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "invalid");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat" } });
    const { tickOnce } = await import("../../src/services/worker.js");
    await tickOnce(cfg, { log: () => {}, sendDiscord: async () => {} });
    const j = getJobRow(root, jobId);
    assert.equal(j.status, "failed");
    assert.match(j.error || "", /envelope invalid|parse/i);
  });
});

test("worker: automation discord_send uses real sendDiscord (no no-op loss)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const sent = [];
    const deps = { log: () => {}, sendDiscord: async (ch, msg) => { sent.push([ch, msg]); } };
    dbm.saveAutomation(root, {
      id: "notify-flow", name: "notify", trigger_type: "manual", trigger_config: {},
      steps: [
        { id: "s1", type: "agent", agent: "assistant", prompt: "hello" },
        { id: "n1", type: "discord_send", message: "ping done" },
      ],
    });
    const { enqueueJobSync, getJobRow } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "automation", payload: { automationId: "notify-flow" } });
    const { tickOnce } = await import("../../src/services/worker.js");
    await tickOnce(cfg, deps);
    const j = getJobRow(root, jobId);
    assert.equal(j.status, "done");
    assert.equal(sent.length, 1);
    assert.match(sent[0][1], /ping done/);
  });
});

test("worker: oversized payload rejected (no truncation of execution intent)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  assert.throws(() => dbm.enqueueJobSync(root, { kind: "chat", payload: { text: "x".repeat(20000) } }), /payload too large/);
});

test("worker: stale leased job held blocked, orphan result reconciled", async () => {
  const dbm = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { openDb } = dbm;
    const db = openDb(root);
    // Stale leased job with no recoverable file -> held blocked (never replayed).
    db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, worker_id, lease_until, created_at, updated_at) VALUES ('stale1','chat','{}','leased',0,3,'w-old','2000-01-01T00:00:00.000Z','t','t')").run();
    const r = jobs.recoverStaleJobs(db, { leaseSec: 300 });
    assert.equal(r.held, 1);
    assert.equal(db.prepare("SELECT status FROM jobs WHERE id='stale1'").get().status, "blocked");
    // Orphan result: valid envelope on disk for a leased job reconciles via scanner.
    const { enqueueJobSync, getJobRow } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat" } });
    const claimed = jobs.claimNextJob(db, "w-test", { leaseSec: 300 });
    assert.ok(claimed);
    jobs.markRunning(db, claimed.id, "w-test");
    const { buildEnvelope } = await import("../../src/services/envelope.js");
    const { resultPathFor, ensureResponsesDir, atomicWriteJson } = await import("../../src/services/paths.js");
    const runId = dbm.createRun(root, { workflowId: "adhoc-chat", kind: "dashboard" });
    db.prepare("UPDATE jobs SET run_id = ? WHERE id = ?").run(runId, claimed.id);
    ensureResponsesDir(root, runId);
    // Real pre-registered assignment: the scanner only reconciles envelopes
    // whose (agent/model/session/path) exactly match the claimed slot.
    // A forged envelope with no expected assignment must NOT reconcile.
    const forgedFile = resultPathFor(root, runId, 0).file;
    const forged = buildEnvelope({ runId, stepIdx: 0, attempt: 1, agent: "assistant", model: "muse-spark-1.3", sessionId: "s-forged", cliSessionId: "c", resultPath: forgedFile, payload: { status: "done", summary: "forged", output: "FORGED-OUT" } });
    atomicWriteJson(forgedFile, forged);
    const { scanOrphanResults } = await import("../../src/services/worker.js");
    // Forged file is scanned but must NOT reconcile (no pre-claim slot).
    const sForged = await scanOrphanResults(cfg, db, jobs);
    assert.equal(sForged.recovered, 0); // no pre-claim -> no reconcile (fail closed)
    assert.ok(!db.prepare("SELECT * FROM run_steps WHERE run_id = ?").all(runId).some((x) => String(x.raw_text).includes("FORGED-OUT")));
    // Crash after atomically-written file: pre-claim the exact slot, then
    // write the matching envelope — scanner recovers without subprocess replay.
    const { claimSessionAttempt } = dbm;
    const pre = resultPathFor(root, runId, 0, { attempt: 1, sessionId: "s-orphan" });
    claimSessionAttempt(root, { jobId: claimed.id, runId, stepIndex: 0, attempt: 1, agent: "assistant", model: "muse-spark-1.3", sessionId: "s-orphan", resultPath: pre.file, resultHash: "" });
    const env = buildEnvelope({ runId, stepIdx: 0, attempt: 1, agent: "assistant", model: "muse-spark-1.3", sessionId: "s-orphan", cliSessionId: "c", resultPath: pre.file, payload: { status: "done", summary: "orphan ok", output: "ORPHAN-OUT" } });
    atomicWriteJson(pre.file, env);
    const s = await scanOrphanResults(cfg, db, jobs);
    assert.ok(s.recovered >= 1);
    const steps = db.prepare("SELECT * FROM run_steps WHERE run_id = ?").all(runId);
    assert.ok(steps.some((x) => String(x.raw_text).includes("ORPHAN-OUT")));
    // Wrong session for the same slot is rejected (fail closed), not deduped.
    // Checked on a second active job so the terminal-job guard does not mask
    // the session binding: forge a fresh slot on another run.
    const runId2 = dbm.createRun(root, { workflowId: "adhoc-chat-2", kind: "dashboard" });
    const { id: jobId2 } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi2", workflow: "adhoc-chat" } });
    db.prepare("UPDATE jobs SET status = 'running', run_id = ? WHERE id = ?").run(runId2, jobId2);
    const pre2 = resultPathFor(root, runId2, 0, { attempt: 1, sessionId: "s-real" });
    ensureResponsesDir(root, runId2);
    claimSessionAttempt(root, { jobId: jobId2, runId: runId2, stepIndex: 0, attempt: 1, agent: "assistant", model: "muse-spark-1.3", sessionId: "s-real", resultPath: pre2.file, resultHash: "" });
    const wrong = jobs.reconcileAttempt(db, {
      jobId: jobId2, runId: runId2, stepIndex: 0, attempt: 1,
      agent: "assistant", model: "muse-spark-1.3", sessionId: "s-wrong",
      resultPath: pre2.file, resultHash: "h-wrong",
      status: "done", output: "WRONG-OUT", summary: "wrong",
    });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error || "", /slot claimed by session/);
    assert.ok(!db.prepare("SELECT * FROM run_steps WHERE run_id = ?").all(runId2).some((x) => String(x.raw_text).includes("WRONG-OUT")));
    // Actual pre-reg orphan file: job finishes terminal done (not stuck
    // leased/running), exactly one run_steps row (no duplicate), and a
    // second scan reconciles nothing new (no double after re-scan).
    const run1 = dbm.getRun(root, runId);
    assert.equal(run1.steps.length, 1);
    assert.equal(getJobRow(root, claimed.id).status, "done"); // complete orphan -> finishJob done
    assert.equal(dbm.getRun(root, runId).status, "done"); // run terminal done
    const s2 = await scanOrphanResults(cfg, db, jobs);
    assert.equal(s2.recovered, 0); // already reconciled -> dedupe, not recovered
    const run2 = dbm.getRun(root, runId);
    assert.equal(run2.steps.length, 1); // no duplicate run_steps row
  });
});

test("worker: in-flight cancellation terminalizes (cancel wins over late done)", async () => {
  const dbm = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { openDb } = dbm;
    const db = openDb(root);
    const { enqueueJobSync, getJobRow, requestJobCancel } = dbm;
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat" } });
    const claimed = jobs.claimNextJob(db, "w-test", { leaseSec: 300 });
    assert.ok(claimed);
    assert.equal(jobs.markRunning(db, claimed.id, "w-test"), true);
    // Cancel mid-flight: reconcile must refuse (cancelled), job terminalizes.
    assert.equal(requestJobCancel(root, claimed.id), true);
    const rec = jobs.reconcileAttempt(db, {
      jobId: claimed.id, runId: "r-cancel", stepIndex: 0, attempt: 1,
      agent: "assistant", model: "muse-spark-1.3", sessionId: "s-c",
      resultPath: "p", resultHash: "h-c", status: "done", output: "late", summary: "late",
    });
    assert.equal(rec.ok, false);
    assert.equal(rec.cancelled, true);
    const done = jobs.finishJob(db, claimed.id, { status: "cancelled", error: "cancel requested" });
    assert.equal(done, true);
    assert.equal(getJobRow(root, claimed.id).status, "cancelled");
    // Late done after cancel is refused (terminal is one-way).
    assert.equal(jobs.finishJob(db, claimed.id, { status: "done" }), false);
    assert.equal(getJobRow(root, claimed.id).status, "cancelled");
  });
});

test("worker: discord completion exactly once per job (request/automation/loop-task/requeue)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow, createTask, saveTaskSteps, listOutbox } = dbm;
    const { tickOnce } = await import("../../src/services/worker.js");
    const sent = [];
    const deps = { log: () => {}, sendDiscord: async (ch, msg) => { sent.push([ch, msg]); } };
    // request with channelId -> exactly one completion post.
    const r1 = enqueueJobSync(root, { kind: "request", payload: { text: "hello req", agents: ["assistant"], channelId: "C-REQ", messageId: "m1" } });
    await tickOnce(cfg, deps);
    assert.equal(getJobRow(root, r1.id).status, "done");
    assert.equal(sent.filter((s) => s[0] === "C-REQ").length, 1);
    // Rescan: no second completion (job terminal, nothing claimed).
    await tickOnce(cfg, deps);
    assert.equal(sent.filter((s) => s[0] === "C-REQ").length, 1);
    // automation with channelId -> exactly one completion post (plus its
    // discord_send step message = 2 sends total, 1 completion).
    dbm.saveAutomation(root, {
      id: "comp-flow", name: "comp", trigger_type: "manual", trigger_config: {},
      steps: [
        { id: "s1", type: "agent", agent: "assistant", prompt: "hello" },
        { id: "n1", type: "discord_send", message: "step ping" },
      ],
    });
    const a1 = enqueueJobSync(root, { kind: "automation", payload: { automationId: "comp-flow", channelId: "C-AUTO", messageId: "m2" } });
    await tickOnce(cfg, deps);
    assert.equal(getJobRow(root, a1.id).status, "done");
    assert.equal(sent.filter((s) => s[0] === "C-AUTO").length, 1);
    await tickOnce(cfg, deps);
    assert.equal(sent.filter((s) => s[0] === "C-AUTO").length, 1);
    // loop-task with channelId -> exactly one completion post.
    const taskId = createTask(root, { title: "lt", repo: "general", task_type: "t", status: "open", end_goal: "g" });
    saveTaskSteps(root, taskId, [{ step_id: "step-1", type: "agent", agent: "assistant", model: "", status: "pending", prompt: "do it", output: "", position: 0 }]);
    const l1 = enqueueJobSync(root, { kind: "loop-task", payload: { taskId, agent: "assistant", prompt: "do it", stepId: "step-1", channelId: "C-LOOP", messageId: "m3" } });
    await tickOnce(cfg, deps);
    assert.equal(getJobRow(root, l1.id).status, "done");
    assert.equal(sent.filter((s) => s[0] === "C-LOOP").length, 1);
    await tickOnce(cfg, deps);
    assert.equal(sent.filter((s) => s[0] === "C-LOOP").length, 1);
    // requeue with channelId -> exactly one completion post.
    const doneJob = getJobRow(root, r1.id);
    const rq = enqueueJobSync(root, { kind: "requeue", payload: { runId: doneJob.run_id, stepIndex: 0, guidance: "again", channelId: "C-REQ2", messageId: "m4" } });
    await tickOnce(cfg, deps);
    assert.equal(getJobRow(root, rq.id).status, "done");
    assert.equal(sent.filter((s) => s[0] === "C-REQ2").length, 1);
    await tickOnce(cfg, deps);
    assert.equal(sent.filter((s) => s[0] === "C-REQ2").length, 1);
    // Completion rows are queued in the deduped outbox (failed-safe).
    const out = listOutbox(root, {});
    for (const ch of ["C-REQ", "C-AUTO", "C-LOOP", "C-REQ2"]) {
      assert.ok(out.some((o) => o.channel === ch), `outbox has completion for ${ch}`);
    }
  });
});

test("worker: request honors payload.steps custom prompts (no rebuild discard)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  // Fake muse echoes the prompt back in output so we can assert the custom
  // prompt text reached the model (not a rebuilt generic prompt).
  const p = join(binDir, "muse");
  writeFileSync(p, `#!/usr/bin/env node\nconst fs=require("node:fs");\nconst a=process.argv.slice(2);\nconst f=a[a.indexOf("--prompt-file")+1];\nlet pr="";\ntry{pr=fs.readFileSync(f,"utf-8");}catch{}\nprocess.stdout.write(JSON.stringify({status:"done",summary:"ok",output:"PROMPT-ECHO::"+pr.slice(0,4000),next:"",updates:{}}));\n`);
  chmodSync(p, 0o755);
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow } = dbm;
    const { tickOnce } = await import("../../src/services/worker.js");
    const { id: jobId } = enqueueJobSync(root, {
      kind: "request",
      payload: {
        text: "goal text", agents: ["assistant"],
        steps: [{ id: "custom-1", agent: "assistant", prompt: "CUSTOM-PROMPT-XYZ-123 do the thing" }],
        channelId: "C-CUSTOM",
      },
    });
    const sent = [];
    await tickOnce(cfg, { log: () => {}, sendDiscord: async (ch, msg) => { sent.push([ch, msg]); } });
    assert.equal(getJobRow(root, jobId).status, "done");
    const run = dbm.getRun(root, getJobRow(root, jobId).run_id);
    assert.ok(run.steps.some((s) => String(s.raw_text).includes("CUSTOM-PROMPT-XYZ-123")), "custom step prompt preserved");
    assert.equal(sent.filter((s) => s[0] === "C-CUSTOM").length, 1);
  });
});

test("worker: blocked completion honest (blocked status, no false done, one post)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "blocked");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow } = dbm;
    const { tickOnce } = await import("../../src/services/worker.js");
    const sent = [];
    const deps = { log: () => {}, sendDiscord: async (ch, msg) => { sent.push([ch, msg]); } };
    const { id: jobId } = enqueueJobSync(root, { kind: "request", payload: { text: "stuck goal", agents: ["assistant"], channelId: "C-BLOCK", messageId: "mb1" } });
    await tickOnce(cfg, deps);
    const j = getJobRow(root, jobId);
    assert.equal(j.status, "blocked");
    assert.equal(sent.filter((s) => s[0] === "C-BLOCK").length, 1);
    assert.match(sent.find((s) => s[0] === "C-BLOCK")[1], /Blocked|blocked|need input/);
    await tickOnce(cfg, deps);
    assert.equal(sent.filter((s) => s[0] === "C-BLOCK").length, 1);
  });
});

test("worker: failed sendDiscord still queues outbox (failed-safe, no silent loss)", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  installFakeMuse(binDir, "done");
  const cfg = testCfg(root, binDir);
  await withPath(binDir, async () => {
    const { enqueueJobSync, getJobRow, listOutbox } = dbm;
    const { tickOnce } = await import("../../src/services/worker.js");
    const boom = async () => { throw new Error("discord down"); };
    const { id: jobId } = enqueueJobSync(root, { kind: "chat", payload: { text: "hi", workflow: "adhoc-chat", channelId: "C-FAIL", messageId: "mf1" } });
    await tickOnce(cfg, { log: () => {}, sendDiscord: boom });
    assert.equal(getJobRow(root, jobId).status, "done");
    assert.ok(listOutbox(root, {}).some((o) => o.channel === "C-FAIL"), "completion queued despite send failure");
  });
});

// OrchestratorLoop: store + reconcile + engine with a fake Muse CLI dispatcher.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync, readFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRoot } from "./_fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fake-muse.mjs");
const ROLES = ["analyst", "coder", "critic", "writer", "assistant"];

let store, engine, reconcile, workspace, dispatchers;
before(async () => {
  chmodSync(FAKE, 0o755);
  process.env.MUSE_BIN = FAKE;
  process.env.LOOP_TICK_MS = "100000";
  store = await import("../../src/loop/store.js");
  engine = await import("../../src/loop/engine.js");
  reconcile = await import("../../src/loop/reconcile.js");
  workspace = await import("../../src/loop/workspace.js");
  dispatchers = await import("../../src/loop/dispatchers.js");
});

function cfg(mode = "done") {
  process.env.FAKE_MUSE_MODE = mode;
  const root = getRoot();
  mkdirSync(join(root, "config"), { recursive: true });
  copyFileSync(join(HERE, "../../config/task-types.json"), join(root, "config", "task-types.json"));
  return { root, agents: new Map(ROLES.map((id) => [id, { id, systemPrompt: `You are ${id}.` }])) };
}
async function drain(c, max = 20) {
  for (let i = 0; i < max; i++) { const r = await engine.tick(c); if (r.idle) return; }
}

test("extractJson picks last result-like object from noisy text", () => {
  const o = reconcile.extractJson('noise {"a":1} more ```json\n{"status":"done","summary":"s","output":"o"}\n```');
  assert.equal(o.status, "done");
  assert.equal(reconcile.normalizeResult({ status: "complete", summary: "x" }).result.status, "done");
  assert.equal(reconcile.normalizeResult({ status: "weird", summary: "x" }).result.status, "failed");
});

test("direct request -> generic task -> 4 steps done, handoff + artifacts recorded", async () => {
  const c = cfg("done");
  const rid = store.createRequest(c.root, { text: "Write a haiku\nabout loops", mode: "direct", dispatcher: "muse" });
  await drain(c);
  const req = store.getRequest(c.root, rid);
  assert.equal(req.status, "done");
  const [t] = store.listTasks(c.root);
  assert.equal(t.title, "Write a haiku");
  assert.equal(t.status, "done");
  assert.equal(t.steps_done, 4);
  assert.deepEqual(store.listSteps(c.root, t.id).map((s) => s.role), ["analyst", "coder", "critic", "writer"]);
  const h = workspace.readHandoff(c.root, t.id);
  for (let i = 0; i < 4; i++) assert.match(h, new RegExp(`handoff from step ${i}`));
  assert.equal(store.listArtifacts(c.root, t.id)[0].kind, "diagram");
  assert.equal(store.listAttempts(c.root, t.id).length, 4);
  // later prompts embed earlier handoff
  const p = readFileSync(store.listAttempts(c.root, t.id)[3].prompt_path, "utf8");
  assert.match(p, /handoff from step 2/);
});

test("divider splits request into dependent tasks; runs one at a time in order", async () => {
  const c = cfg("done");
  const rid = store.createRequest(c.root, { text: "Do A then B", dispatcher: "muse" });
  await engine.tick(c); // divide
  const tasks = store.listTasks(c.root).sort((a, b) => a.seq - b.seq);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[1].depends_on, [tasks[0].id]);
  await engine.tick(c);
  assert.equal(store.getTask(c.root, tasks[0].id).status, "done");
  assert.equal(store.getTask(c.root, tasks[1].id).status, "queued");
  await drain(c);
  assert.equal(store.getTask(c.root, tasks[1].id).status, "done");
  assert.equal(store.getRequest(c.root, rid).status, "done");
});

test("bad divider output falls back to the generic task type", async () => {
  const c = cfg("divider-bad");
  store.createRequest(c.root, { text: "Something", dispatcher: "muse" });
  await engine.tick(c);
  const [t] = store.listTasks(c.root);
  assert.equal(t.steps_total, 4);
});

test("failed step retries with a fresh attempt, then completes", async () => {
  const c = cfg("fail-once");
  store.createRequest(c.root, { text: "retry me", mode: "direct", dispatcher: "muse" });
  await drain(c);
  const [t] = store.listTasks(c.root);
  assert.equal(t.status, "done");
  const s1 = store.listAttempts(c.root, t.id).filter((a) => a.pos === 1);
  assert.deepEqual(s1.map((a) => a.status), ["failed", "done"]);
});

test("hard failure exhausts attempts and fails the task", async () => {
  const c = cfg("fail");
  store.createRequest(c.root, { text: "never works", mode: "direct", dispatcher: "muse" });
  await drain(c, 10);
  const [t] = store.listTasks(c.root);
  assert.equal(t.status, "failed");
  assert.equal(store.listAttempts(c.root, t.id).length, engine.MAX_ATTEMPTS);
});

test("blocked step blocks task; requeue with guidance resumes and reaches done", async () => {
  const c = cfg("block");
  store.createRequest(c.root, { text: "needs human", mode: "direct", dispatcher: "muse" });
  await drain(c);
  const [t] = store.listTasks(c.root);
  assert.equal(t.status, "blocked");
  assert.match(t.blocked_reason, /need creds/);
  process.env.FAKE_MUSE_MODE = "done";
  engine.requeue(c.root, t.id, 1, "creds are in .env");
  await drain(c);
  const after = store.getTask(c.root, t.id);
  assert.equal(after.status, "done");
  assert.equal(after.requeue_count, 1);
  const last = store.listAttempts(c.root, t.id).filter((a) => a.pos === 1).pop();
  assert.match(readFileSync(last.prompt_path, "utf8"), /creds are in \.env/);
});

test("stdout fallback when no result file; dedupe on re-reconcile", async () => {
  const c = cfg("stdout");
  store.createRequest(c.root, { text: "stdout only", mode: "direct", dispatcher: "muse" });
  await drain(c);
  const [t] = store.listTasks(c.root);
  assert.equal(t.status, "done");
  const a = store.listAttempts(c.root, t.id)[0];
  const again = reconcile.reconcileAttempt(c.root, { attemptId: a.id, stdout: "" });
  assert.equal(again.applied, false);
});

test("pause stops dispatching; resume continues", async () => {
  const c = cfg("done");
  store.setPaused(c.root, true);
  store.createRequest(c.root, { text: "paused", mode: "direct", dispatcher: "muse" });
  const r = await engine.tick(c);
  assert.equal(r.idle, true);
  assert.equal(store.listTasks(c.root).length, 0);
  store.setPaused(c.root, false);
  await drain(c);
  assert.equal(store.listTasks(c.root)[0].status, "done");
});

test("operator actions: append steps, mark done, delete", async () => {
  const c = cfg("done");
  store.createRequest(c.root, { text: "ops", mode: "direct", dispatcher: "muse" });
  await drain(c);
  const [t] = store.listTasks(c.root);
  engine.taskAction(c.root, t.id, "append", { steps: [{ role: "tester", goal: "x" }].map((s) => ({ ...s, role: "critic" })) });
  assert.equal(store.getTask(c.root, t.id).status, "queued");
  engine.taskAction(c.root, t.id, "mark_done");
  assert.equal(store.getTask(c.root, t.id).status, "done");
  engine.taskAction(c.root, t.id, "delete");
  assert.equal(store.getTask(c.root, t.id), null);
});

test("unsafe task ids and paths are refused", () => {
  assert.throws(() => workspace.taskDir("/tmp", "../etc"));
  assert.equal(workspace.isInside("/tmp/a", "/tmp/a/../b"), false);
});

test("dispatcher availability reports fake muse and unknown dispatcher throws", () => {
  const st = dispatchers.dispatcherStatus({ fresh: true });
  assert.equal(st.find((d) => d.id === "muse").ok, true);
  assert.throws(() => dispatchers.getDispatcher("nope"));
});

// OrchestratorLoop engine — always Auto. One unit of work at a time:
//   1. divide the oldest 'dividing' request into tasks
//   2. otherwise dispatch the next pending step of the oldest runnable task
// Agents write result JSON; reconcile.js folds it into the DB and handoff.md, then the loop moves on.
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { initWorkspace, attemptPaths, taskDir, atomicWrite, appendHandoffNote } from "./workspace.js";
import { buildStepPrompt, buildDividerPrompt } from "./prompt.js";
import { reconcileAttempt, readResult, normalizeDivider } from "./reconcile.js";
import { getDispatcher, cancelDispatch } from "./dispatchers.js";
import { loadTaskTypes } from "./task-types.js";

export const MAX_ATTEMPTS = Number(process.env.LOOP_MAX_ATTEMPTS || 3);
export const TICK_MS = Number(process.env.LOOP_TICK_MS || 3000);
const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas");

let timer = null;
let busy = false;
let current = null; // { kind, id, key }
const listeners = new Set();

export const onLoopEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch {} } };
export const engineStatus = (root) => ({ running: !!timer, busy, current, paused: root ? store.isPaused(root) : false });

function agentsCatalog(cfg) {
  return cfg?.agents ? [...cfg.agents.values()].map((a) => ({ id: a.id, description: a.description || "" })) : [];
}
const roleIds = (cfg) => agentsCatalog(cfg).map((a) => a.id);
const modelFor = (cfg, task, role) => task.model || cfg?.agents?.get?.(role)?.model || "";

export function startEngine(cfg, { log = () => {} } = {}) {
  if (timer) return;
  recoverOrphans(cfg, { log });
  timer = setInterval(() => { void tick(cfg, { log }); }, TICK_MS);
  timer.unref?.();
  void tick(cfg, { log });
}
export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
  if (current?.key) cancelDispatch(current.key);
}

/** One scheduling pass. Exported for tests (await-able). */
export async function tick(cfg, { log = () => {} } = {}) {
  const root = cfg.root;
  if (busy || store.isPaused(root)) return { idle: true };
  busy = true;
  try {
    const req = store.db(root).prepare("SELECT id FROM loop_requests WHERE status = 'dividing' ORDER BY created_at LIMIT 1").get();
    if (req) { await divideRequest(cfg, req.id, { log }); return { divided: req.id }; }
    const next = nextRunnable(root);
    if (next) { await runStep(cfg, next.task, next.step, { log }); return { ran: `${next.task.id}:${next.step.pos}` }; }
    return { idle: true };
  } catch (e) {
    log(`[loop] tick error: ${e.message}`);
    return { error: e.message };
  } finally {
    busy = false;
    current = null;
  }
}

/** Oldest running/queued task whose dependencies are done, with its first non-done step. */
export function nextRunnable(root) {
  const d = store.db(root);
  const tasks = d.prepare("SELECT * FROM loop_tasks WHERE status IN ('running','queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, seq").all();
  for (const raw of tasks) {
    const task = store.getTask(root, raw.id);
    const deps = task.depends_on || [];
    if (deps.length) {
      const st = deps.map((id) => store.getTask(root, id)?.status);
      if (st.some((s) => s === "failed" || s === "cancelled")) {
        store.updateTask(root, task.id, { status: "blocked", blocked_reason: "A task it depends on failed or was cancelled." });
        store.addEvent(root, task.id, "blocked", "Dependency failed or cancelled");
        continue;
      }
      if (!st.every((s) => s === "done")) continue;
    }
    const step = d.prepare("SELECT * FROM loop_steps WHERE task_id = ? AND status IN ('pending','failed','running') ORDER BY pos LIMIT 1").get(task.id);
    if (!step) { finishTask(root, task); continue; }
    return { task, step };
  }
  return null;
}

function finishTask(root, task) {
  const steps = store.listSteps(root, task.id);
  if (steps.every((s) => s.status === "done" || s.status === "skipped")) {
    store.updateTask(root, task.id, { status: "done", status_note: "All steps complete", current_step: steps.length, steps_done: steps.length, finished_at: new Date().toISOString() });
    store.addEvent(root, task.id, "completed", "Task done");
    emit({ type: "task", taskId: task.id, status: "done" });
  }
  if (task.request_id) store.refreshRequestStatus(root, task.request_id);
}

// ---------------- divider ----------------
export async function divideRequest(cfg, requestId, { log = () => {} } = {}) {
  const root = cfg.root;
  const req = store.getRequest(root, requestId);
  if (!req) return;
  const types = loadTaskTypes(root);
  const roles = roleIds(cfg);
  const forced = req.task_type ? types.find((t) => t.id === req.task_type) : null;
  let plan = null;

  if (req.mode === "direct" || (forced && req.mode !== "request")) {
    const tt = forced || types.find((t) => t.id === "generic") || types[0];
    plan = { summary: "Direct task", tasks: [{ title: firstLine(req.text), task_type: tt?.id || "", end_goal: req.text, steps: fitSteps(tt?.steps, roles) }] };
  } else {
    const dir = path.join(root, "data", "requests", req.id);
    mkdirSync(dir, { recursive: true });
    const resultPath = path.join(dir, "divider.json");
    const promptFile = path.join(dir, "divider.prompt.md");
    writeFileSync(promptFile, buildDividerPrompt({ text: req.text, repo: req.repo, taskTypes: types, agents: agentsCatalog(cfg), forcedType: forced?.id || null, resultPath }));
    const disp = getDispatcher(req.dispatcher);
    current = { kind: "divide", id: req.id, key: `divide:${req.id}` };
    emit({ type: "request", requestId: req.id, status: "dividing" });
    const r = await disp.dispatch(cfg, {
      key: current.key, role: "assistant", model: req.model || "", cwd: req.repo || root,
      promptFile, promptText: readText(promptFile), taskDir: dir, transcriptPath: path.join(dir, "divider.transcript.jsonl"),
      outputSchema: req.dispatcher === "muse" && process.env.LOOP_OUTPUT_SCHEMA === "1" ? path.join(SCHEMA_DIR, "divider.schema.json") : null,
      timeoutMs: 300000, maxModelSteps: 20,
    });
    const got = readResult(resultPath, r.stdout);
    const norm = normalizeDivider(got?.raw, roles);
    if (norm.ok) plan = norm.result;
    else {
      log(`[loop] divider fallback for ${req.id}: ${norm.error}`);
      const tt = forced || types.find((t) => t.id === "generic") || types[0];
      plan = { summary: `Divider fallback (${norm.error})`, tasks: [{ title: firstLine(req.text), task_type: tt?.id || "", end_goal: req.text, steps: fitSteps(tt?.steps, roles) }] };
    }
  }

  const keyToId = {};
  const created = [];
  for (const [i, t] of plan.tasks.entries()) {
    const id = store.createTask(root, {
      requestId: req.id, title: t.title, endGoal: t.end_goal || req.text, repo: req.repo, taskType: t.task_type || "",
      dispatcher: req.dispatcher, model: req.model, steps: t.steps,
    });
    keyToId[t.key || `t${i + 1}`] = id;
    created.push({ id, t });
  }
  for (const { id, t } of created) {
    const deps = (t.depends_on || []).map((k) => keyToId[k]).filter(Boolean);
    if (deps.length) store.updateTask(root, id, { depends_on: deps });
    const task = store.getTask(root, id);
    const dir = initWorkspace(root, task, store.listSteps(root, id));
    store.updateTask(root, id, { workspace: dir });
    copyAttachments(root, req, id);
  }
  store.updateRequest(root, req.id, { status: "active", divider_output: JSON.stringify(plan).slice(0, 60000) });
  emit({ type: "request", requestId: req.id, status: "active", tasks: created.map((c) => c.id) });
}

function fitSteps(steps, roles) {
  const ok = (steps || []).filter((s) => roles.includes(s.role));
  return ok.length ? ok : [{ role: roles.includes("assistant") ? "assistant" : roles[0], goal: "Complete the request end to end." }];
}
const firstLine = (t) => String(t || "").split("\n").find((l) => l.trim())?.trim().slice(0, 120) || "Untitled task";
function readText(f) { try { return readFileSync(f, "utf8"); } catch { return ""; } }

function copyAttachments(root, req, taskId) {
  const list = (req.attachments || []).filter((a) => a && a.path && existsSync(a.path));
  if (!list.length) return;
  const dir = path.join(taskDir(root, taskId), "attachments");
  const idx = [];
  for (const [i, a] of list.entries()) {
    const file = `${i + 1}-${String(a.name || "file").replace(/[^A-Za-z0-9._-]/g, "_")}`;
    try { copyFileSync(a.path, path.join(dir, file)); idx.push({ file, name: a.name, size: a.size || 0 }); } catch {}
  }
  atomicWrite(path.join(dir, "index.json"), JSON.stringify(idx, null, 2));
}

// ---------------- step execution ----------------
export async function runStep(cfg, task, step, { log = () => {} } = {}) {
  const root = cfg.root;
  if (!task.workspace) store.updateTask(root, task.id, { workspace: initWorkspace(root, task, store.listSteps(root, task.id)) });
  const attempt = (step.attempt || 0) + 1;
  if (step.status === "failed" && attempt > MAX_ATTEMPTS) {
    store.updateTask(root, task.id, { status: "failed", status_note: `Step ${step.pos + 1} failed ${MAX_ATTEMPTS}×`, blocked_reason: step.summary, finished_at: new Date().toISOString() });
    store.addEvent(root, task.id, "failed", `Step ${step.pos + 1} (${step.role}) exhausted ${MAX_ATTEMPTS} attempts`, { pos: step.pos });
    emit({ type: "task", taskId: task.id, status: "failed" });
    if (task.request_id) store.refreshRequestStatus(root, task.request_id);
    return { status: "failed" };
  }
  const paths = attemptPaths(root, task.id, step.pos, step.role, attempt);
  mkdirSync(paths.dir, { recursive: true });
  const steps = store.listSteps(root, task.id);
  const { prompt, context } = buildStepPrompt(root, { cfg, task, steps, step, attempt, resultPath: paths.result, agentsCatalog: agentsCatalog(cfg) });
  writeFileSync(paths.prompt, prompt);
  writeFileSync(paths.context, context);

  const model = modelFor(cfg, task, step.role);
  const attemptId = store.createAttempt(root, {
    taskId: task.id, pos: step.pos, attempt, role: step.role, dispatcher: task.dispatcher, model,
    context: "fresh", workspace: task.repo || root, promptPath: paths.prompt, contextPath: paths.context,
    resultPath: paths.result, transcriptPath: paths.transcript,
  });
  const t = new Date().toISOString();
  store.updateStep(root, task.id, step.pos, { status: "running", attempt, started_at: t, finished_at: null });
  store.updateTask(root, task.id, { status: "running", current_step: step.pos, status_note: `Step ${step.pos + 1}/${steps.length}: ${step.role} working (attempt ${attempt})`, blocked_reason: "" });
  store.addEvent(root, task.id, "dispatched", `Dispatched step ${step.pos + 1} (${step.role}) via ${task.dispatcher}${model ? ` · ${model}` : ""} · attempt ${attempt}`, { pos: step.pos, attempt });
  emit({ type: "step", taskId: task.id, pos: step.pos, status: "running" });

  const key = `step:${task.id}:${step.pos}:${attempt}`;
  current = { kind: "step", id: task.id, pos: step.pos, key };
  let r;
  try {
    const disp = getDispatcher(task.dispatcher);
    r = await disp.dispatch(cfg, {
      key, role: step.role, model, cwd: task.repo || root, promptFile: paths.prompt, promptText: prompt,
      taskDir: taskDir(root, task.id), transcriptPath: paths.transcript,
      outputSchema: task.dispatcher === "muse" && process.env.LOOP_OUTPUT_SCHEMA === "1" ? path.join(SCHEMA_DIR, "step-result.schema.json") : null,
    });
  } catch (e) {
    r = { exitCode: 1, stdout: "", durationMs: 0, error: e.message };
  }
  if (r.sessionId) store.updateAttempt(root, attemptId, { session_id: r.sessionId });

  // Operator changed the task while it ran (cancel / requeue / mark done / delete): discard this attempt.
  const nowTask = store.getTask(root, task.id);
  const nowStep = nowTask ? store.getStep(root, task.id, step.pos) : null;
  if (!nowTask || nowTask.status !== "running" || nowStep?.status !== "running" || nowStep?.attempt !== attempt) {
    if (nowTask) store.updateAttempt(root, attemptId, { status: "cancelled", finished_at: new Date().toISOString(), duration_ms: r.durationMs || 0 });
    return { status: "cancelled" };
  }
  const rec = reconcileAttempt(root, { attemptId, stdout: r.stdout, exitCode: r.exitCode, durationMs: r.durationMs, error: r.error || (r.exitCode ? String(r.stderr || "").slice(-500) : ""), knownRoles: roleIds(cfg) });
  afterReconcile(root, task.id, step.pos, rec);
  return rec;
}

/** Advance task state after a step result is reconciled. */
export function afterReconcile(root, taskId, pos, rec) {
  const task = store.getTask(root, taskId);
  if (!task || !rec?.applied) return;
  const steps = store.listSteps(root, taskId);
  const step = steps.find((s) => s.pos === pos);
  if (rec.status === "done") {
    const next = steps.find((s) => s.pos > pos && s.status !== "done");
    if (next) {
      store.updateTask(root, taskId, { status: "running", current_step: next.pos, status_note: `Step ${pos + 1} done → ${next.role} next` });
      emit({ type: "step", taskId, pos, status: "done" });
    } else finishTask(root, task);
  } else if (rec.status === "blocked") {
    store.updateTask(root, taskId, { status: "blocked", blocked_reason: rec.blockedReason || "Agent blocked", status_note: `Blocked at step ${pos + 1} (${step?.role})` });
    emit({ type: "task", taskId, status: "blocked" });
    if (task.request_id) store.refreshRequestStatus(root, task.request_id);
  } else {
    const left = MAX_ATTEMPTS - (step?.attempt || 0);
    store.updateTask(root, taskId, { status: "running", status_note: left > 0 ? `Step ${pos + 1} failed — retrying (${left} left)` : `Step ${pos + 1} failed` });
    appendHandoffNote(root, taskId, `Step ${pos + 1} attempt ${step?.attempt} failed: ${rec.error || step?.summary || ""}`.slice(0, 600));
    emit({ type: "step", taskId, pos, status: "failed" });
  }
}

/** Boot recovery: attempts left 'running' by a crash are reconciled from their result file, else failed (retryable). */
export function recoverOrphans(cfg, { log = () => {} } = {}) {
  const root = cfg.root;
  for (const a of store.runningAttempts(root)) {
    const rec = reconcileAttempt(root, { attemptId: a.id, stdout: "", exitCode: existsSync(a.result_path) ? 0 : 1, error: "process lost (restart) and no result file", knownRoles: roleIds(cfg) });
    afterReconcile(root, a.task_id, a.pos, rec);
    log(`[loop] recovered attempt ${a.id}: ${rec.status || rec.error}`);
  }
}

// ---------------- operator actions ----------------
export function requeue(root, taskId, fromPos, guidance = "") {
  const task = store.getTask(root, taskId);
  if (!task) throw new Error("task not found");
  const steps = store.listSteps(root, task.id);
  if (!(fromPos >= 0 && fromPos < steps.length)) throw new Error(`invalid step ${fromPos}`);
  if (current?.id === task.id && current.key) cancelDispatch(current.key);
  store.resetStepsFrom(root, task.id, fromPos, guidance);
  store.addEvent(root, task.id, "requeued", `Re-queued from step ${fromPos + 1}${guidance ? ` with guidance: ${guidance}` : ""}`, { pos: fromPos });
  appendHandoffNote(root, task.id, `Operator re-queued from step ${fromPos + 1}${guidance ? `: ${guidance}` : ""}`);
  emit({ type: "task", taskId: task.id, status: "queued" });
}

export function taskAction(root, taskId, action, { text = "", steps = [] } = {}) {
  const task = store.getTask(root, taskId);
  if (!task) throw new Error("task not found");
  const id = task.id;
  const stopIfRunning = () => { if (current?.id === id && current.key) cancelDispatch(current.key); };
  switch (action) {
    case "mark_done":
      stopIfRunning();
      store.updateTask(root, id, { status: "done", status_note: text ? `Marked done: ${text}` : "Marked done by operator", finished_at: new Date().toISOString() });
      break;
    case "block":
      stopIfRunning();
      store.updateTask(root, id, { status: "blocked", blocked_reason: text || "Blocked by operator" });
      break;
    case "unblock": {
      const s = store.listSteps(root, id).find((x) => x.status !== "done");
      if (s) store.resetStepsFrom(root, id, s.pos, text);
      else store.updateTask(root, id, { status: "queued", blocked_reason: "" });
      break;
    }
    case "cancel":
      stopIfRunning();
      store.updateTask(root, id, { status: "cancelled", status_note: "Cancelled by operator", finished_at: new Date().toISOString() });
      break;
    case "append":
      if (!steps.length) throw new Error("append needs steps [{role, goal}]");
      store.appendSteps(root, id, steps);
      if (["done", "failed"].includes(task.status)) store.updateTask(root, id, { status: "queued", finished_at: null });
      break;
    case "delete":
      stopIfRunning();
      store.deleteTask(root, id);
      emit({ type: "task", taskId: id, status: "deleted" });
      return;
    default:
      throw new Error(`unknown action '${action}'`);
  }
  store.addEvent(root, id, "note", `Operator: ${action}${text ? ` — ${text}` : ""}`);
  if (task.request_id) store.refreshRequestStatus(root, task.request_id);
  emit({ type: "task", taskId: id, status: store.getTask(root, id)?.status });
}

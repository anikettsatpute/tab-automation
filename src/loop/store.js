// OrchestratorLoop store: requests -> tasks -> steps -> attempts (+ events, artifacts).
// Lives in data/tab-automation.db next to legacy tables; schema is created on first use.
import { randomUUID } from "node:crypto";
import { openDb } from "../db.js";

export const TASK_STATUSES = ["queued", "running", "blocked", "failed", "done", "cancelled"];
export const STEP_STATUSES = ["pending", "running", "done", "failed", "blocked", "skipped"];
export const DISPATCHERS = ["muse", "copilot"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loop_requests (
  id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'request',
  source TEXT NOT NULL DEFAULT 'dashboard', repo TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT '',
  dispatcher TEXT NOT NULL DEFAULT 'muse', model TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'dividing',
  divider_output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS loop_tasks (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, request_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', end_goal TEXT NOT NULL DEFAULT '', repo TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT '', dispatcher TEXT NOT NULL DEFAULT 'muse', model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', status_note TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]', current_step INTEGER NOT NULL DEFAULT 0,
  steps_total INTEGER NOT NULL DEFAULT 0, steps_done INTEGER NOT NULL DEFAULT 0,
  workspace TEXT NOT NULL DEFAULT '', blocked_reason TEXT NOT NULL DEFAULT '',
  requeue_count INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
CREATE INDEX IF NOT EXISTS idx_loop_tasks_status ON loop_tasks(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_loop_tasks_req ON loop_tasks(request_id);
CREATE TABLE IF NOT EXISTS loop_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, pos INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', guidance TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT,
  UNIQUE(task_id, pos));
CREATE TABLE IF NOT EXISTS loop_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pos INTEGER NOT NULL, attempt INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '', dispatcher TEXT NOT NULL DEFAULT 'muse', model TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT 'fresh', workspace TEXT NOT NULL DEFAULT '',
  prompt_path TEXT NOT NULL DEFAULT '', context_path TEXT NOT NULL DEFAULT '',
  result_path TEXT NOT NULL DEFAULT '', transcript_path TEXT NOT NULL DEFAULT '',
  result_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running', exit_code INTEGER,
  error TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE(task_id, pos, attempt));
CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_attempt_hash ON loop_attempts(result_hash) WHERE result_hash != '';
CREATE TABLE IF NOT EXISTS loop_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, pos INTEGER, attempt INTEGER,
  kind TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_loop_events_task ON loop_events(task_id, id);
CREATE TABLE IF NOT EXISTS loop_artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pos INTEGER, attempt INTEGER,
  kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_loop_artifacts_task ON loop_artifacts(task_id);
CREATE TABLE IF NOT EXISTS loop_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
`;

const _ready = new WeakSet();
const now = () => new Date().toISOString();
const sid = () => randomUUID().replace(/-/g, "").slice(0, 8);
const json = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

export function db(root) {
  const d = openDb(root);
  if (!_ready.has(d)) { d.exec(SCHEMA); _ready.add(d); }
  return d;
}

// Reentrant transaction: nested calls join the outer transaction.
const _depth = new WeakMap();
function tx(d, fn) {
  const depth = _depth.get(d) || 0;
  if (depth > 0) { _depth.set(d, depth + 1); try { return fn(); } finally { _depth.set(d, depth); } }
  d.exec("BEGIN IMMEDIATE");
  _depth.set(d, 1);
  try { const r = fn(); d.exec("COMMIT"); return r; } catch (e) { try { d.exec("ROLLBACK"); } catch {} throw e; } finally { _depth.set(d, 0); }
}
export const transaction = (root, fn) => tx(db(root), fn);

// ---- settings ----
export function getSetting(root, key, fallback = null) {
  const r = db(root).prepare("SELECT value FROM loop_settings WHERE key = ?").get(key);
  return r ? json(r.value, fallback) : fallback;
}
export function setSetting(root, key, value) {
  db(root).prepare("INSERT INTO loop_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}
export const isPaused = (root) => getSetting(root, "paused", false) === true;
export const setPaused = (root, v) => setSetting(root, "paused", !!v);

// ---- requests ----
export function createRequest(root, { text, mode = "request", source = "dashboard", repo = "", taskType = "", dispatcher = "muse", model = "", attachments = [] }) {
  if (!DISPATCHERS.includes(dispatcher)) throw new Error(`unknown dispatcher '${dispatcher}'`);
  const id = sid(); const t = now();
  db(root).prepare(`INSERT INTO loop_requests (id, text, mode, source, repo, task_type, dispatcher, model, attachments, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dividing', ?, ?)`)
    .run(id, String(text).slice(0, 16000), mode, source, repo, taskType, dispatcher, model, JSON.stringify(attachments), t, t);
  return id;
}
export function getRequest(root, id) {
  const r = db(root).prepare("SELECT * FROM loop_requests WHERE id = ?").get(id);
  return r ? { ...r, attachments: json(r.attachments, []) } : null;
}
export function updateRequest(root, id, patch) {
  const allowed = ["status", "divider_output", "error"];
  const keys = allowed.filter((k) => patch[k] !== undefined);
  if (!keys.length) return;
  db(root).prepare(`UPDATE loop_requests SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), now(), id);
}
export function listRequests(root, { limit = 50 } = {}) {
  const d = db(root);
  return d.prepare("SELECT * FROM loop_requests ORDER BY created_at DESC LIMIT ?").all(limit).map((r) => ({
    ...r, attachments: json(r.attachments, []),
    tasks: d.prepare("SELECT id, seq, title, status FROM loop_tasks WHERE request_id = ? ORDER BY seq").all(r.id),
  }));
}
/** Request status derived from its tasks once divided. */
export function refreshRequestStatus(root, id) {
  const req = getRequest(root, id);
  if (!req || req.status === "dividing" || req.status === "failed") return req?.status;
  const ts = db(root).prepare("SELECT status FROM loop_tasks WHERE request_id = ?").all(id).map((r) => r.status);
  let s = "active";
  if (ts.length && ts.every((x) => x === "done")) s = "done";
  else if (ts.length && ts.every((x) => ["done", "failed", "cancelled", "blocked"].includes(x))) s = ts.some((x) => x === "done") ? "partial" : "failed";
  if (s !== req.status) updateRequest(root, id, { status: s });
  return s;
}

// ---- tasks ----
/** steps: [{role, goal}]. Returns task id. Workspace is assigned by caller (engine) after creation. */
export function createTask(root, { requestId = "", title, endGoal = "", repo = "", taskType = "", dispatcher = "muse", model = "", dependsOn = [], steps = [] }) {
  if (!steps.length) throw new Error("task needs at least one step");
  if (!DISPATCHERS.includes(dispatcher)) throw new Error(`unknown dispatcher '${dispatcher}'`);
  const d = db(root);
  return tx(d, () => {
    const id = sid(); const t = now();
    const seq = (d.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM loop_tasks").get().n);
    d.prepare(`INSERT INTO loop_tasks (id, seq, request_id, title, end_goal, repo, task_type, dispatcher, model, status, depends_on, steps_total, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(id, seq, requestId, String(title).slice(0, 300), String(endGoal).slice(0, 8000), repo, taskType, dispatcher, model, JSON.stringify(dependsOn), steps.length, t, t);
    const ins = d.prepare("INSERT INTO loop_steps (task_id, pos, role, goal) VALUES (?, ?, ?, ?)");
    steps.forEach((s, i) => ins.run(id, i, String(s.role), String(s.goal || "").slice(0, 4000)));
    d.prepare("INSERT INTO loop_events (task_id, kind, message, created_at) VALUES (?, 'created', ?, ?)").run(id, `Task created with ${steps.length} steps (${steps.map((s) => s.role).join(" → ")})`, t);
    return id;
  });
}

const TASK_PATCH = ["title", "end_goal", "status", "status_note", "current_step", "steps_done", "steps_total", "workspace", "blocked_reason", "requeue_count", "tokens", "tool_calls", "finished_at", "depends_on", "dispatcher", "model"];
export function updateTask(root, id, patch) {
  const keys = TASK_PATCH.filter((k) => patch[k] !== undefined);
  if (!keys.length) return false;
  const vals = keys.map((k) => (k === "depends_on" && Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k]));
  return db(root).prepare(`UPDATE loop_tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now(), id).changes > 0;
}
function hydrateTask(r) { return r ? { ...r, depends_on: json(r.depends_on, []) } : null; }
export function getTask(root, id) {
  return hydrateTask(db(root).prepare("SELECT * FROM loop_tasks WHERE id = ? OR CAST(seq AS TEXT) = ?").get(String(id), String(id)));
}
export function listTasks(root, { status = null, q = "", limit = 200 } = {}) {
  const where = []; const args = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (q) { where.push("(title LIKE ? OR end_goal LIKE ? OR CAST(seq AS TEXT) = ?)"); args.push(`%${q}%`, `%${q}%`, q.replace(/^#/, "")); }
  const sql = `SELECT * FROM loop_tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`;
  const d = db(root);
  return d.prepare(sql).all(...args, limit).map((r) => ({
    ...hydrateTask(r),
    roles: d.prepare("SELECT role, status FROM loop_steps WHERE task_id = ? ORDER BY pos").all(r.id),
  }));
}
export function statusCounts(root) {
  const out = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
  for (const r of db(root).prepare("SELECT status, COUNT(*) AS n FROM loop_tasks GROUP BY status").all()) out[r.status] = r.n;
  return out;
}
export function deleteTask(root, id) {
  const d = db(root);
  tx(d, () => {
    for (const t of ["loop_steps", "loop_attempts", "loop_events", "loop_artifacts"]) d.prepare(`DELETE FROM ${t} WHERE task_id = ?`).run(id);
    d.prepare("DELETE FROM loop_tasks WHERE id = ?").run(id);
  });
}

// ---- steps ----
export function listSteps(root, taskId) {
  return db(root).prepare("SELECT * FROM loop_steps WHERE task_id = ? ORDER BY pos").all(taskId);
}
export function getStep(root, taskId, pos) {
  return db(root).prepare("SELECT * FROM loop_steps WHERE task_id = ? AND pos = ?").get(taskId, pos) || null;
}
const STEP_PATCH = ["status", "summary", "output", "guidance", "attempt", "started_at", "finished_at", "goal", "role"];
export function updateStep(root, taskId, pos, patch) {
  const keys = STEP_PATCH.filter((k) => patch[k] !== undefined);
  if (!keys.length) return false;
  return db(root).prepare(`UPDATE loop_steps SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE task_id = ? AND pos = ?`).run(...keys.map((k) => patch[k]), taskId, pos).changes > 0;
}
/** Reset step `fromPos` and everything after it to pending. */
export function resetStepsFrom(root, taskId, fromPos, guidance = "") {
  const d = db(root);
  tx(d, () => {
    d.prepare("UPDATE loop_steps SET status = 'pending', summary = '', output = '', started_at = NULL, finished_at = NULL WHERE task_id = ? AND pos >= ?").run(taskId, fromPos);
    d.prepare("UPDATE loop_steps SET guidance = ? WHERE task_id = ? AND pos = ?").run(String(guidance).slice(0, 4000), taskId, fromPos);
    const done = d.prepare("SELECT COUNT(*) AS n FROM loop_steps WHERE task_id = ? AND status = 'done'").get(taskId).n;
    d.prepare("UPDATE loop_tasks SET status = 'queued', blocked_reason = '', status_note = ?, current_step = ?, steps_done = ?, finished_at = NULL, requeue_count = requeue_count + 1, updated_at = ? WHERE id = ?")
      .run(`Re-queued from step ${fromPos + 1}`, fromPos, done, now(), taskId);
  });
}
/** Append steps to an existing task (used by "Append task"). */
export function appendSteps(root, taskId, steps) {
  const d = db(root);
  tx(d, () => {
    let pos = d.prepare("SELECT COALESCE(MAX(pos), -1) + 1 AS n FROM loop_steps WHERE task_id = ?").get(taskId).n;
    const ins = d.prepare("INSERT INTO loop_steps (task_id, pos, role, goal) VALUES (?, ?, ?, ?)");
    for (const s of steps) ins.run(taskId, pos++, String(s.role), String(s.goal || ""));
    d.prepare("UPDATE loop_tasks SET steps_total = ?, updated_at = ? WHERE id = ?").run(pos, now(), taskId);
  });
}

// ---- attempts ----
export function createAttempt(root, a) {
  const id = sid();
  db(root).prepare(`INSERT INTO loop_attempts (id, task_id, pos, attempt, role, dispatcher, model, session_id, context, workspace, prompt_path, context_path, result_path, transcript_path, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
    .run(id, a.taskId, a.pos, a.attempt, a.role || "", a.dispatcher || "muse", a.model || "", a.sessionId || "", a.context || "fresh",
      a.workspace || "", a.promptPath || "", a.contextPath || "", a.resultPath || "", a.transcriptPath || "", now());
  return id;
}
const ATTEMPT_PATCH = ["status", "exit_code", "error", "duration_ms", "finished_at", "result_hash", "session_id"];
export function updateAttempt(root, id, patch) {
  const keys = ATTEMPT_PATCH.filter((k) => patch[k] !== undefined);
  if (!keys.length) return false;
  return db(root).prepare(`UPDATE loop_attempts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k]), id).changes > 0;
}
export function getAttempt(root, id) { return db(root).prepare("SELECT * FROM loop_attempts WHERE id = ?").get(id) || null; }
export function listAttempts(root, taskId) {
  return db(root).prepare("SELECT * FROM loop_attempts WHERE task_id = ? ORDER BY pos, attempt").all(taskId);
}
export function runningAttempts(root) {
  return db(root).prepare("SELECT * FROM loop_attempts WHERE status = 'running'").all();
}
/** Exactly-once guard: true if this hash was already reconciled. */
export function hashSeen(root, hash) {
  return !!db(root).prepare("SELECT 1 FROM loop_attempts WHERE result_hash = ?").get(hash);
}

// ---- events / artifacts ----
export function addEvent(root, taskId, kind, message, { pos = null, attempt = null } = {}) {
  db(root).prepare("INSERT INTO loop_events (task_id, pos, attempt, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(taskId, pos, attempt, kind, String(message).slice(0, 4000), now());
}
export function listEvents(root, taskId, { after = 0, limit = 500 } = {}) {
  return db(root).prepare("SELECT * FROM loop_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?").all(taskId, after, limit);
}
export function recentEvents(root, { limit = 100 } = {}) {
  return db(root).prepare(`SELECT e.*, t.seq, t.title FROM loop_events e LEFT JOIN loop_tasks t ON t.id = e.task_id ORDER BY e.id DESC LIMIT ?`).all(limit);
}
export function addArtifact(root, taskId, { pos = null, attempt = null, kind, title = "", body = "", path = "" }) {
  const id = sid();
  db(root).prepare("INSERT INTO loop_artifacts (id, task_id, pos, attempt, kind, title, body, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, taskId, pos, attempt, kind, String(title).slice(0, 200), String(body).slice(0, 40000), String(path).slice(0, 500), now());
  return id;
}
export function listArtifacts(root, taskId) {
  return db(root).prepare("SELECT * FROM loop_artifacts WHERE task_id = ? ORDER BY created_at").all(taskId);
}

/** Full detail payload for the dashboard. */
export function taskDetail(root, id) {
  const task = getTask(root, id);
  if (!task) return null;
  return {
    task,
    steps: listSteps(root, task.id),
    attempts: listAttempts(root, task.id),
    artifacts: listArtifacts(root, task.id),
    events: listEvents(root, task.id),
    request: task.request_id ? getRequest(root, task.request_id) : null,
  };
}

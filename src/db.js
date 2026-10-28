// Local SQLite persistence for runs, steps, approvals, kv + control-plane tables.
// Uses built-in node:sqlite (Node >= 22, no native deps — Termux-safe).
// DB file: <root>/data/tab-automation.db (WAL mode).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual',
  trigger_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  agent TEXT,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  repository TEXT,
  branch TEXT,
  task_type TEXT,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT,
  comments_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  end_goal TEXT
);
CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  type TEXT NOT NULL,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  raw_text TEXT NOT NULL DEFAULT '',
  output_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  tool TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
-- Automations (reference: YOUR FLOWS list; every card here is a row here) --
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  trigger_config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Flow steps (reference: Edit-flow STEPS rows, top-to-bottom = position) --
CREATE TABLE IF NOT EXISTS automation_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  step_id TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_asteps_auto ON automation_steps(automation_id, position);
-- Automation cursor (reference: Next run / status line; 30s loop reads+writes this) --
CREATE TABLE IF NOT EXISTS automation_state (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_run_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  due TEXT,
  priority TEXT NOT NULL DEFAULT 'P3',
  project TEXT,
  user TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
-- Control-plane: per-tool-call activity (reference: Tool Calls timeline) --
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'tool',
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_run ON activity(run_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
-- Control-plane: structured logs (reference: Logs view) --
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  source TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
-- Intake requests (reference: Requests view + divider history) --
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'request',
  repo TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT 'let_divider_choose',
  pipeline TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  run_id TEXT,
  created_at TEXT NOT NULL
);
-- Outbox (reference: Outbox view + Brain delivery queue) --
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  run_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
`;

let _db = null;
let _root = null;
let _file = null;

export function dbPath(root) {
  return path.join(root, "data", "tab-automation.db");
}

/** Open (or reuse) the DB, creating schema on first use.
 *  Pass { file } to open a different SQLite file (e.g. the pulled tablet cache, read-only). */
export function openDb(root, { file = null, readOnly = false } = {}) {
  const target = file || dbPath(root);
  if (_db && _root === root && _file === target) return _db;
  closeDb();
  if (!file) mkdirSync(path.join(root, "data"), { recursive: true });
  _db = new DatabaseSync(target, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    _db.exec("PRAGMA journal_mode = WAL;");
    _db.exec(SCHEMA);
    // migrate old DBs: add control-plane + PRD columns if missing
    try {
      const cols = new Set(_db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name));
      for (const [col, def] of [["agent", "TEXT"], ["model", "TEXT"], ["tokens", "INTEGER NOT NULL DEFAULT 0"], ["cost", "REAL NOT NULL DEFAULT 0"], ["tool_calls", "INTEGER NOT NULL DEFAULT 0"],
        ["title", "TEXT"], ["repository", "TEXT"], ["branch", "TEXT"], ["task_type", "TEXT"], ["progress_done", "INTEGER NOT NULL DEFAULT 0"], ["progress_total", "INTEGER NOT NULL DEFAULT 0"],
        ["pr_url", "TEXT"], ["comments_count", "INTEGER NOT NULL DEFAULT 0"], ["blocked_reason", "TEXT"], ["end_goal", "TEXT"]]) {
        if (!cols.has(col)) _db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${def}`);
      }
    } catch { /* fresh DB already has them */ }
  }
  _root = root;
  _file = target;
  return _db;
}

export function closeDb() {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
    _root = null;
    _file = null;
  }
}

const now = () => new Date().toISOString();

// ---- runs ----
export function createRun(root, { workflowId, kind = "manual", trigger = {} }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO runs (id, workflow_id, kind, trigger_json, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)"
  ).run(id, workflowId, kind, JSON.stringify(trigger).slice(0, 4000), now());
  return id;
}

export function finishRun(root, runId, { status = "done", error = null } = {}) {
  const db = openDb(root);
  db.prepare("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
    .run(status, now(), error ? String(error).slice(0, 2000) : null, runId);
}

export function recordStep(root, runId, { stepId, type, agent = null, status = "ok", rawText = "", outputJson = null }) {
  const db = openDb(root);
  db.prepare(
    "INSERT INTO run_steps (run_id, step_id, type, agent, status, raw_text, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    runId, stepId, type, agent, status,
    String(rawText ?? "").slice(0, 20000),
    outputJson == null ? null : JSON.stringify(outputJson).slice(0, 20000),
    now()
  );
}

export function getRun(root, runId, { file = null } = {}) {
  const db = openDb(root, file ? { file, readOnly: true } : {});
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) return null;
  run.steps = db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY id").all(runId);
  run.activity = db.prepare("SELECT * FROM activity WHERE run_id = ? ORDER BY id").all(runId);
  return run;
}

/** Board task detail (reference: right pane Overview/Steps/Activity/Diagrams/Sessions).
 *  Returns run + steps + activity timeline + sessions (agent/model/workspace) + diagram nodes. */
export function getTaskDetail(root, runId) {
  const run = getRun(root, runId);
  if (!run) return null;
  let trigger = {};
  try { trigger = JSON.parse(run.trigger_json || "{}"); } catch {}
  // sessions: distinct agent+model combos from steps+activity (reference: Sessions dropdown)
  const sessMap = new Map();
  for (const s of run.steps || []) {
    if (!s.agent) continue;
    const k = `${s.agent}::${run.model || "default"}`;
    if (!sessMap.has(k)) sessMap.set(k, { agent: s.agent, model: run.model || "default", steps: 0, status: s.status });
    sessMap.get(k).steps += 1;
  }
  for (const a of run.activity || []) {
    if (!a.actor || a.kind !== "tool") continue;
    const k = `${a.actor}::${run.model || "default"}`;
    if (!sessMap.has(k)) sessMap.set(k, { agent: a.actor, model: run.model || "default", steps: 0, status: a.status });
  }
  const sessions = [...sessMap.values()].map((s, i) => ({ id: `s${i + 1}`, ...s, workspace: "tab-automation", context: "Fresh session" }));
  // diagram: pipeline nodes from steps (reference: PIPELINE Planner/Coder/Validator/Open PR)
  const diagram = (run.steps || []).map((s, i) => ({ id: s.step_id, label: s.step_id, type: s.type, agent: s.agent, status: s.status, order: i + 1 }));
  // end goal: last step text or trigger text (reference: END GOAL box)
  const lastStep = (run.steps || [])[(run.steps || []).length - 1];
  const endGoal = run.end_goal || trigger.text || (lastStep ? String(lastStep.raw_text || "").slice(0, 500) : "");
  const steps = (run.steps || []).map((s) => ({ id: s.step_id, type: s.type, agent: s.agent, status: s.status, text: String(s.raw_text || "").slice(0, 2000), output: s.output_json ? String(s.output_json).slice(0, 2000) : null, at: s.created_at }));
  const doneSteps = steps.filter((s) => s.status === "ok" || s.status === "done").length;
  return {
    id: run.id, workflow: run.workflow_id, kind: run.kind, status: run.status,
    agent: run.agent, model: run.model, tokens: run.tokens || 0, cost: run.cost || 0, toolCalls: run.tool_calls || 0,
    startedAt: run.started_at, finishedAt: run.finished_at, error: run.error,
    // PRD TaskItem shape (reference: TaskBoard card + TaskDrawer header)
    title: run.title || trigger.text || run.workflow_id,
    repository: run.repository || "tab-automation",
    branch: run.branch || `run/${run.id}`,
    taskType: run.task_type || run.kind || "manual",
    progress: { completed: run.progress_total ? run.progress_done : doneSteps, total: run.progress_total || steps.length || 1 },
    prUrl: run.pr_url || null, commentsCount: run.comments_count || 0,
    blockedReason: run.blocked_reason || (run.status === "failed" ? run.error : null),
    trigger, endGoal, steps,
    activity: (run.activity || []).map((a) => ({ id: a.id, kind: a.kind, actor: a.actor, action: a.action, detail: String(a.detail || "").slice(0, 500), ms: a.duration_ms, status: a.status, at: a.created_at })),
    sessions, diagram,
  };
}

export function listRuns(root, { workflowId = null, limit = 20, file = null } = {}) {
  const db = openDb(root, file ? { file, readOnly: true } : {});
  if (workflowId) {
    return db.prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?").all(workflowId, limit);
  }
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit);
}

export function pruneRuns(root, days = 90) {
  const db = openDb(root);
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const stepRes = db.prepare("DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)").run(cutoff);
  const runRes = db.prepare("DELETE FROM runs WHERE started_at < ?").run(cutoff);
  return { steps: stepRes.changes, runs: runRes.changes };
}

// ---- approvals ----
export function createApproval(root, { runId = null, tool, request = {} }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO approvals (id, run_id, tool, request_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  ).run(id, runId, tool, JSON.stringify(request).slice(0, 4000), now());
  return id;
}

export function decideApproval(root, id, { status, decidedBy = null }) {
  const db = openDb(root);
  db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?")
    .run(status, decidedBy, now(), id);
}

export function pendingApprovals(root, { file = null } = {}) {
  return openDb(root, file ? { file, readOnly: true } : {}).prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all();
}

// ---- todos ----
export function addTodo(root, { text, due = null, priority = "P3", project = null, user = "", channelId = "" }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO todos (id, text, status, due, priority, project, user, channel_id, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)"
  ).run(id, String(text).slice(0, 1000), due, priority, project, user, channelId, now());
  return id;
}

export function listTodos(root, { status = "open", limit = 30 } = {}) {
  const db = openDb(root);
  if (status === "all") return db.prepare("SELECT * FROM todos ORDER BY created_at DESC LIMIT ?").all(limit);
  return db.prepare("SELECT * FROM todos WHERE status = ? ORDER BY due IS NULL, due, created_at LIMIT ?").all(status, limit);
}

export function completeTodo(root, id) {
  const db = openDb(root);
  const r = db.prepare("UPDATE todos SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(now(), id);
  return r.changes > 0;
}

export function todosDueToday(root) {
  const today = new Date().toISOString().slice(0, 10);
  return openDb(root).prepare(
    "SELECT * FROM todos WHERE status = 'open' AND due IS NOT NULL AND due <= ? ORDER BY due"
  ).all(today + "T23:59:59");
}

// ---- reminders ----
export function addReminder(root, { text, at, user = "", channelId = "" }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO reminders (id, text, at, user, channel_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  ).run(id, String(text).slice(0, 1000), at, user, channelId, now());
  return id;
}

export function dueReminders(root, nowIso = new Date().toISOString()) {
  return openDb(root).prepare(
    "SELECT * FROM reminders WHERE status = 'pending' AND at <= ? ORDER BY at"
  ).all(nowIso);
}

export function markReminderSent(root, id) {
  openDb(root).prepare("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?").run(now(), id);
}

export function listReminders(root, { status = "pending", limit = 20 } = {}) {
  return openDb(root).prepare("SELECT * FROM reminders WHERE status = ? ORDER BY at LIMIT ?").all(status, limit);
}

// ---- kv ----
export function kvGet(root, key) {
  const row = openDb(root).prepare("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function kvSet(root, key, value) {
  openDb(root).prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

// ---- control-plane: activity (tool calls timeline) ----
export function recordActivity(root, { runId = null, kind = "tool", actor = "", action = "", detail = "", durationMs = 0, status = "ok" }) {
  try {
    openDb(root).prepare(
      "INSERT INTO activity (run_id, kind, actor, action, detail, duration_ms, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(runId, kind, String(actor).slice(0, 120), String(action).slice(0, 200),
      String(detail ?? "").slice(0, 4000), Number(durationMs) || 0, status, now());
  } catch { /* best effort — never break a run */ }
}

export function listActivity(root, { runId = null, limit = 50 } = {}) {
  const db = openDb(root);
  if (runId) return db.prepare("SELECT * FROM activity WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(runId, limit);
  return db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit);
}

// ---- control-plane: logs ----
export function writeLog(root, { level = "info", source = "", message = "", runId = null }) {
  try {
    openDb(root).prepare(
      "INSERT INTO logs (level, source, message, run_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(level, String(source).slice(0, 120), String(message ?? "").slice(0, 4000), runId, now());
  } catch { /* best effort */ }
}

export function listLogs(root, { level = null, source = null, limit = 100 } = {}) {
  const db = openDb(root);
  if (level) return db.prepare("SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?").all(level, limit);
  if (source) return db.prepare("SELECT * FROM logs WHERE source LIKE ? ORDER BY id DESC LIMIT ?").all(`%${source}%`, limit);
  return db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
}

export function pruneLogs(root, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const a = openDb(root).prepare("DELETE FROM activity WHERE created_at < ?").run(cutoff);
  const l = openDb(root).prepare("DELETE FROM logs WHERE created_at < ?").run(cutoff);
  return { activity: a.changes, logs: l.changes };
}

// ---- control-plane: run stats (tokens/cost/tool-calls per run) ----
export function bumpRunStats(root, runId, { tokens = 0, cost = 0, toolCalls = 0, agent = null, model = null } = {}) {
  if (!runId) return;
  try {
    const db = openDb(root);
    if (agent || model) {
      db.prepare("UPDATE runs SET tokens = tokens + ?, cost = cost + ?, tool_calls = tool_calls + ?, agent = COALESCE(agent, ?), model = COALESCE(model, ?) WHERE id = ?")
        .run(tokens, cost, toolCalls, agent, model, runId);
    } else {
      db.prepare("UPDATE runs SET tokens = tokens + ?, cost = cost + ?, tool_calls = tool_calls + ? WHERE id = ?")
        .run(tokens, cost, toolCalls, runId);
    }
  } catch { /* best effort */ }
}

// ---- automations (reference: YOUR FLOWS cards + Edit-flow modal) ----
// trigger_type: manual|schedule|event ; trigger_config JSON: {cron, timeOfDay, days, eventRule}
export function listAutomations(root) {
  const db = openDb(root);
  const rows = db.prepare("SELECT * FROM automations ORDER BY updated_at DESC").all();
  return rows.map((a) => ({
    ...a,
    enabled: Boolean(a.enabled),
    trigger_config: safeJson(a.trigger_config, {}),
    steps: db.prepare("SELECT step_id AS id, type, config FROM automation_steps WHERE automation_id = ? ORDER BY position").all(a.id)
      .map((s) => ({ id: s.id, type: s.type, ...safeJson(s.config, {}) })),
    state: db.prepare("SELECT * FROM automation_state WHERE automation_id = ?").get(a.id) || null,
  }));
}

export function getAutomation(root, id) {
  const db = openDb(root);
  const a = db.prepare("SELECT * FROM automations WHERE id = ?").get(id);
  if (!a) return null;
  return {
    ...a,
    enabled: Boolean(a.enabled),
    trigger_config: safeJson(a.trigger_config, {}),
    steps: db.prepare("SELECT step_id AS id, type, config FROM automation_steps WHERE automation_id = ? ORDER BY position").all(id)
      .map((s) => ({ id: s.id, type: s.type, ...safeJson(s.config, {}) })),
  };
}

export function saveAutomation(root, { id, name = "", description = "", trigger_type = "manual", trigger_config = {}, steps = [], enabled = true }) {
  const db = openDb(root);
  const t = now();
  const cleanId = String(id || "").trim() || Math.random().toString(36).slice(2, 10);
  db.prepare(
    "INSERT INTO automations (id, name, description, trigger_type, trigger_config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, trigger_type=excluded.trigger_type, trigger_config=excluded.trigger_config, enabled=excluded.enabled, updated_at=excluded.updated_at"
  ).run(cleanId, String(name).slice(0, 200), String(description).slice(0, 2000), trigger_type,
    JSON.stringify(trigger_config).slice(0, 8000), enabled ? 1 : 0, t, t);
  db.prepare("DELETE FROM automation_steps WHERE automation_id = ?").run(cleanId);
  const ins = db.prepare("INSERT INTO automation_steps (automation_id, position, step_id, type, config) VALUES (?, ?, ?, ?, ?)");
  steps.slice(0, 50).forEach((s, i) => {
    const { id: sid, type, ...cfg } = s || {};
    ins.run(cleanId, i, String(sid || `step-${i + 1}`).slice(0, 120), String(type || "agent").slice(0, 40), JSON.stringify(cfg).slice(0, 8000));
  });
  db.prepare("INSERT INTO automation_state (automation_id, updated_at) VALUES (?, ?) ON CONFLICT(automation_id) DO NOTHING").run(cleanId, t);
  return cleanId;
}

export function deleteAutomation(root, id) {
  openDb(root).prepare("DELETE FROM automations WHERE id = ?").run(id);
}

export function setAutomationEnabled(root, id, enabled) {
  openDb(root).prepare("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now(), id);
}

export function markAutomationRun(root, automationId, { status = "", runId = null, nextRunAt = null } = {}) {
  openDb(root).prepare(
    "INSERT INTO automation_state (automation_id, last_run_at, next_run_at, last_status, last_run_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(automation_id) DO UPDATE SET last_run_at=excluded.last_run_at, next_run_at=excluded.next_run_at, last_status=excluded.last_status, last_run_id=excluded.last_run_id, updated_at=excluded.updated_at"
  ).run(automationId, now(), nextRunAt, String(status).slice(0, 200), runId, now());
}

function safeJson(text, fallback) {
  try { return JSON.parse(text || ""); } catch { return fallback; }
}

// ---- control-plane: overview (reference: header stats + charts) ----
export function controlOverview(root, { days = 7 } = {}) {
  const db = openDb(root);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const runs = db.prepare("SELECT status, COUNT(*) c, COALESCE(SUM(tokens),0) t, COALESCE(SUM(cost),0) cost, COALESCE(SUM(tool_calls),0) tc FROM runs WHERE started_at >= ? GROUP BY status").all(since);
  const byDay = db.prepare("SELECT substr(started_at,1,10) d, COUNT(*) c FROM runs WHERE started_at >= ? GROUP BY d ORDER BY d").all(since);
  const byAgent = db.prepare("SELECT COALESCE(agent,'—') agent, COUNT(*) c, COALESCE(SUM(tokens),0) t FROM runs WHERE started_at >= ? GROUP BY agent ORDER BY c DESC LIMIT 8").all(since);
  const byTool = db.prepare("SELECT action tool, COUNT(*) c, AVG(duration_ms) avgMs FROM activity WHERE kind='tool' AND created_at >= ? GROUP BY action ORDER BY c DESC LIMIT 10").all(since);
  const totals = { runs: 0, done: 0, failed: 0, running: 0, tokens: 0, cost: 0, toolCalls: 0 };
  for (const r of runs) {
    totals.runs += r.c; totals.tokens += r.t; totals.cost += r.cost; totals.toolCalls += r.tc;
    if (r.status === "done") totals.done += r.c;
    else if (r.status === "failed") totals.failed += r.c;
    else if (r.status === "running") totals.running += r.c;
  }
  return { totals, byDay, byAgent, byTool, since };
}

// ---- requests (reference: Requests view + divider history) ----
export function fileRequest(root, { text, mode = "request", repo = "", taskType = "let_divider_choose", pipeline = [] }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO requests (id, text, mode, repo, task_type, pipeline, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)"
  ).run(id, String(text || "").slice(0, 4000), mode, String(repo || "").slice(0, 120),
    String(taskType).slice(0, 60), JSON.stringify(pipeline).slice(0, 2000), now());
  return id;
}

export function listRequests(root, { limit = 30 } = {}) {
  return openDb(root).prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function linkRequestRun(root, requestId, runId) {
  openDb(root).prepare("UPDATE requests SET run_id = ?, status = 'running' WHERE id = ?").run(runId, requestId);
}

// ---- outbox (reference: Outbox view + Brain delivery queue) ----
export function queueOutbox(root, { channel = "", text = "", runId = null }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO outbox (id, channel, text, status, run_id, created_at) VALUES (?, ?, ?, 'queued', ?, ?)"
  ).run(id, String(channel || "").slice(0, 200), String(text || "").slice(0, 4000), runId, now());
  return id;
}

export function listOutbox(root, { status = null, limit = 30 } = {}) {
  const db = openDb(root);
  if (status) return db.prepare("SELECT * FROM outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit);
  return db.prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function markOutboxSent(root, id) {
  openDb(root).prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(now(), id);
}

// ---- retro (reference: Retro view — token usage, retry rates, delivery velocity) ----
export function controlRetro(root, { days = 30 } = {}) {
  const db = openDb(root);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const runs = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(tokens),0) t, COALESCE(SUM(tool_calls),0) tc, " +
    "COALESCE(AVG(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN (julianday(finished_at)-julianday(started_at))*86400 ELSE NULL END),0) avgSec " +
    "FROM runs WHERE started_at >= ?"
  ).get(since);
  const byStatus = db.prepare("SELECT status, COUNT(*) c FROM runs WHERE started_at >= ? GROUP BY status").all(since);
  const retries = db.prepare(
    "SELECT workflow_id, COUNT(*) c FROM runs WHERE started_at >= ? GROUP BY workflow_id HAVING c > 1 ORDER BY c DESC LIMIT 10"
  ).all(since);
  const byDay = db.prepare("SELECT substr(started_at,1,10) d, COUNT(*) c FROM runs WHERE started_at >= ? GROUP BY d ORDER BY d").all(since);
  return { since, runs, byStatus, retries, byDay };
}

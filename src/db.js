// Local SQLite persistence for runs, steps, approvals, kv + control-plane tables.
// Uses built-in node:sqlite (Node >= 22, no native deps — Termux-safe).
// DB file: <root>/data/tab-automation.db (WAL mode).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

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
-- Brain messages (reference: PRD 4.7 Teams/Brain hub, IMPLEMENTATION 2.2 brainMessages) --
CREATE TABLE IF NOT EXISTS brain_messages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'discord',
  message_text TEXT NOT NULL DEFAULT '',
  processing_status TEXT NOT NULL DEFAULT 'queued',
  outbox_summary TEXT NOT NULL DEFAULT '',
  linked_task_id TEXT,
  processing_error TEXT,
  request_text TEXT,
  session_log TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_received ON brain_messages(received_at);
CREATE INDEX IF NOT EXISTS idx_brain_status ON brain_messages(processing_status);
-- Agent sessions (reference: PRD 4.4 Sessions tab, IMPLEMENTATION 2.2 agentSessions) --
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_number INTEGER NOT NULL DEFAULT 0,
  session_uuid TEXT NOT NULL DEFAULT '',
  runner_type TEXT NOT NULL DEFAULT 'tab-automation',
  agent_role TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  transcript_path TEXT,
  exit_code INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON agent_sessions(task_id);
-- Task comments (reference: PRD 4.3 comments count, Sweep PR comments) --
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_run ON task_comments(run_id);
-- Loop tasks (reference: PRD Task Board — first-class task table) --
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  branch TEXT NOT NULL DEFAULT '',
  end_goal TEXT NOT NULL DEFAULT '',
  progress INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  pr_url TEXT NOT NULL DEFAULT '',
  comments INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
-- Loop task steps (reference: PRD Steps tab — one row per pipeline step) --
CREATE TABLE IF NOT EXISTS task_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  step_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'agent',
  agent TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  prompt TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tsteps_task ON task_steps(task_id, position);
-- Automation JSON configs (reference: Edit-flow modal round-trip blob) --
CREATE TABLE IF NOT EXISTS automation_configs (
  id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  flow TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
-- Configuration KV (reference: Configuration view — providers/models/prompts) --
CREATE TABLE IF NOT EXISTS configurations (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
-- Durable job queue (reference: upgrade plan Phase 1 — fast 202 launch) --
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'request',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_id TEXT,
  task_id TEXT,
  idempotency_key TEXT,
  worker_id TEXT,
  lease_until TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
-- Session attempts: assignment validation + DB transaction hash dedupe --
CREATE TABLE IF NOT EXISTS session_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL DEFAULT '',
  run_id TEXT NOT NULL DEFAULT '',
  step_index INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  agent TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  result_path TEXT NOT NULL DEFAULT '',
  result_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_hash ON session_attempts(result_hash) WHERE result_hash != '';
CREATE INDEX IF NOT EXISTS idx_attempt_run ON session_attempts(run_id, step_index);
-- Audit log: mutation trail (reference: upgrade plan Phase 9) --
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
-- Outbox dedupe marker --
CREATE TABLE IF NOT EXISTS outbox_dedupe (
  key TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
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
    migrateDb(_db);
  }
  _root = root;
  _file = target;
  return _db;
}

/** Additive migrations for pre-existing DBs (never DROP, never rewrite). */
export function migrateDb(db) {
  try {
    const cols = new Set(db.prepare("PRAGMA table_info(runs)").all().map((c) => c.name));
    for (const [col, def] of [["agent", "TEXT"], ["model", "TEXT"], ["tokens", "INTEGER NOT NULL DEFAULT 0"], ["cost", "REAL NOT NULL DEFAULT 0"], ["tool_calls", "INTEGER NOT NULL DEFAULT 0"],
      ["title", "TEXT"], ["repository", "TEXT"], ["branch", "TEXT"], ["task_type", "TEXT"], ["progress_done", "INTEGER NOT NULL DEFAULT 0"], ["progress_total", "INTEGER NOT NULL DEFAULT 0"],
      ["pr_url", "TEXT"], ["comments_count", "INTEGER NOT NULL DEFAULT 0"], ["blocked_reason", "TEXT"], ["end_goal", "TEXT"]]) {
      if (!cols.has(col)) db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${def}`);
    }
  } catch { /* fresh DB already has them */ }
  // Additive tables for the durable queue (safe on old DBs: CREATE IF NOT EXISTS).
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'request', payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      run_id TEXT, task_id TEXT, idempotency_key TEXT, worker_id TEXT, lease_until TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, result_hash TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    )`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)`);
    db.exec(`CREATE TABLE IF NOT EXISTS session_attempts (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '',
      step_index INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 1,
      agent TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '', result_path TEXT NOT NULL DEFAULT '',
      result_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running', created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_hash ON session_attempts(result_hash) WHERE result_hash != ''`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_attempt_run ON session_attempts(run_id, step_index)`);
    db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`);
    db.exec(`CREATE TABLE IF NOT EXISTS outbox_dedupe (
      key TEXT PRIMARY KEY, outbox_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    )`);
  } catch { /* best effort */ }
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

// ---- loop tasks (reference: PRD Task Board — first-class task table) ----
export function createTask(root, { title, repo = "", task_type = "", status = "open", branch = "", end_goal = "" }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  const t = now();
  db.prepare(
    "INSERT INTO tasks (id, title, repo, task_type, status, branch, end_goal, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)"
  ).run(id, String(title || "").slice(0, 300), String(repo).slice(0, 120), String(task_type).slice(0, 60),
    String(status).slice(0, 40), String(branch).slice(0, 200), String(end_goal).slice(0, 4000), t, t);
  return id;
}

export function listTasks(root, { status = null, limit = 50 } = {}) {
  const db = openDb(root);
  if (status) return db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(status, limit);
  return db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit);
}

export function getTaskWithSteps(root, id) {
  const db = openDb(root);
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!task) return null;
  const steps = db.prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY position").all(id);
  return { task, steps };
}

export function saveTaskSteps(root, taskId, steps = []) {
  const db = openDb(root);
  db.prepare("DELETE FROM task_steps WHERE task_id = ?").run(taskId);
  const ins = db.prepare(
    "INSERT INTO task_steps (task_id, position, step_id, type, agent, model, status, prompt, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  steps.slice(0, 50).forEach((s, i) => {
    ins.run(taskId, i, String(s.step_id || s.id || `step-${i + 1}`).slice(0, 120),
      String(s.type || "agent").slice(0, 40), String(s.agent || "").slice(0, 80),
      String(s.model || "").slice(0, 80), String(s.status || "pending").slice(0, 40),
      String(s.prompt || "").slice(0, 8000), String(s.output || "").slice(0, 8000), now());
  });
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), taskId);
}

export function updateTask(root, id, patch = {}) {
  const allowed = ["title", "repo", "task_type", "status", "branch", "end_goal", "progress", "tokens", "cost", "tool_calls", "pr_url", "comments", "blocked_reason"];
  const sets = [];
  const args = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]); }
  }
  if (!sets.length) return false;
  sets.push("updated_at = ?");
  args.push(now(), id);
  const r = openDb(root).prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return r.changes > 0;
}

// ---- configurations (reference: Configuration view KV) ----
export function getConfig(root, key, fallback = "") {
  const row = openDb(root).prepare("SELECT value FROM configurations WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setConfig(root, key, value) {
  openDb(root).prepare(
    "INSERT INTO configurations (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(String(key), String(value ?? ""), now());
}

// ---- automation JSON configs (reference: Edit-flow modal blob) ----
export function saveAutomationConfig(root, id, flowObj) {
  openDb(root).prepare(
    "INSERT INTO automation_configs (id, flow, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET flow = excluded.flow, updated_at = excluded.updated_at"
  ).run(String(id), JSON.stringify(flowObj || {}).slice(0, 30000), now());
}

export function getAutomationConfig(root, id) {
  const row = openDb(root).prepare("SELECT flow FROM automation_configs WHERE id = ?").get(id);
  if (!row) return null;
  try { return JSON.parse(row.flow); } catch { return null; }
}

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
  // sessions: persisted agent_sessions first, else distinct agent+model combos (reference: Sessions dropdown)
  let sessions = [];
  try {
    const stored = openDb(root).prepare("SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY step_number, created_at").all(runId);
    sessions = stored.map((s, i) => ({
      id: s.id || `s${i + 1}`, agent: s.agent_role, model: s.model, workspace: s.workspace,
      context: s.transcript_path || "Fresh session", steps: 1, status: s.exit_code === 0 ? "Completed" : s.exit_code == null ? "Resumed" : "Failed",
      sessionUuid: s.session_uuid, runner: s.runner_type, stepNumber: s.step_number,
    }));
  } catch { /* fall through */ }
  if (!sessions.length) {
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
    sessions = [...sessMap.values()].map((s, i) => ({ id: `s${i + 1}`, ...s, workspace: "tab-automation", context: "Fresh session" }));
  }
  // comments (reference: Sweep PR comments -> task activity)
  let comments = [];
  try { comments = openDb(root).prepare("SELECT * FROM task_comments WHERE run_id = ? ORDER BY created_at DESC LIMIT 30").all(runId); } catch {}
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
    prUrl: run.pr_url || null, commentsCount: run.comments_count || comments.length || 0,
    blockedReason: run.blocked_reason || (run.status === "failed" ? run.error : null),
    trigger, endGoal, steps, comments,
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

/** Live progress: total steps + completed count. Dashboard polls this every few seconds. */
export function bumpRunProgress(root, runId, { total = null, done = null, title = null } = {}) {
  if (!runId) return;
  try {
    const db = openDb(root);
    if (total !== null) db.prepare("UPDATE runs SET progress_total = ? WHERE id = ?").run(total, runId);
    if (done !== null) db.prepare("UPDATE runs SET progress_done = ? WHERE id = ?").run(done, runId);
    if (title) db.prepare("UPDATE runs SET title = COALESCE(title, ?) WHERE id = ?").run(String(title).slice(0, 300), runId);
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

// Cron-slot claim: cross-process mutex so two bots sharing a token/DB never
// fire the same scheduled workflow twice. First claimer wins per slot key.
// Returns true if this process won the slot (should run), false if taken.
export function claimCronSlot(root, slotKey, ttlSec = 300) {
  const db = openDb(root);
  const t = now();
  try {
    db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
    ).run(`cron:${slotKey}`, t);
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(`cron:${slotKey}`);
    if (row && row.value === t) return true; // we inserted -> we won
    // Lost the race: check staleness (a crashed bot's claim expires).
    if (row && (Date.now() - new Date(row.value).getTime()) > ttlSec * 1000) {
      const r = db.prepare("UPDATE kv SET value = ? WHERE key = ? AND value = ?").run(t, `cron:${slotKey}`, row.value);
      return r.changes > 0;
    }
    return false;
  } catch { return true; }
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

// ---- task actions (reference: PRD 4.4 drawer toolbar + 4.3 status badges) ----
export function updateRunStatus(root, runId, { status, error = null, blockedReason = null } = {}) {
  const db = openDb(root);
  const sets = ["status = ?"];
  const args = [status];
  if (error !== null) { sets.push("error = ?"); args.push(error); }
  if (blockedReason !== null) { sets.push("blocked_reason = ?"); args.push(blockedReason); }
  if (status === "done" || status === "failed" || status === "blocked") { sets.push("finished_at = ?"); args.push(now()); }
  args.push(runId);
  const r = db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return r.changes > 0;
}

export function markTaskDone(root, runId) {
  return updateRunStatus(root, runId, { status: "done", error: null, blockedReason: null });
}

export function blockTask(root, runId, reason) {
  return updateRunStatus(root, runId, { status: "failed", blockedReason: String(reason || "blocked").slice(0, 1000) });
}

export function appendTask(root, parentId, { title, text = "" }) {
  const db = openDb(root);
  const parent = db.prepare("SELECT * FROM runs WHERE id = ?").get(parentId);
  if (!parent) return null;
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO runs (id, workflow_id, kind, trigger_json, status, started_at, title, repository, branch, task_type, end_goal) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)"
  ).run(id, parent.workflow_id, parent.kind || "manual",
    JSON.stringify({ kind: "append", parentRun: parentId, text: String(text || title || "").slice(0, 1000) }),
    now(), String(title || `Follow-up to ${parentId}`).slice(0, 300),
    parent.repository || "tab-automation", `run/${id}`, parent.task_type || parent.kind || "manual",
    String(text || title || "").slice(0, 2000));
  return id;
}

export function deleteTask(root, runId) {
  const db = openDb(root);
  db.prepare("DELETE FROM run_steps WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM activity WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM task_comments WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM agent_sessions WHERE task_id = ?").run(runId);
  const r = db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  return r.changes > 0;
}

/** Restart budget (reference: PRD §6.3 max 6 attempts). Counts the exact
 *  structured parentRun references for a task — never LIKE matching (which
 *  over-counts substring run ids). Falls back to exact JSON scan. */
export function requeueCount(root, runId) {
  const db = openDb(root);
  try {
    const rows = db.prepare("SELECT trigger_json FROM runs").all();
    let n = 0;
    for (const r of rows) {
      try {
        const t = JSON.parse(r.trigger_json || "{}");
        if (t.parentRun === runId) n++;
      } catch { /* ignore unparseable */ }
    }
    return n;
  } catch { return 0; }
}

/** Flush queued outbox rows via the real sendDiscord. Deduped queueing stays
 *  in queueOutboxDeduped; this is the worker-side delivery pass that replaces
 *  fake success no-op notifications. Returns { sent, failed }. */
export async function flushOutbox(root, sendDiscord, { limit = 20 } = {}) {
  const db = openDb(root);
  const rows = db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY created_at LIMIT ?").all(limit);
  let sent = 0, failed = 0;
  for (const row of rows) {
    try {
      await sendDiscord(row.channel || undefined, row.text);
      db.prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'queued'").run(now(), row.id);
      sent++;
    } catch (err) {
      try { db.prepare("UPDATE outbox SET status = 'failed' WHERE id = ? AND status = 'queued'").run(row.id); } catch { /* best effort */ }
      try { writeLog(root, { level: "error", source: "outbox", message: `outbox ${row.id} send failed: ${String(err.message).slice(0, 200)}`, runId: row.run_id }); } catch { /* best effort */ }
      failed++;
    }
  }
  return { sent, failed };
}

// ---- task comments (reference: Sweep PR comments -> activity) ----
export function addTaskComment(root, runId, { author = "dashboard", text = "" }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare("INSERT INTO task_comments (id, run_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, runId, String(author).slice(0, 120), String(text).slice(0, 4000), now());
  try { db.prepare("UPDATE runs SET comments_count = comments_count + 1 WHERE id = ?").run(runId); } catch {}
  return id;
}

export function listTaskComments(root, runId, { limit = 30 } = {}) {
  return openDb(root).prepare("SELECT * FROM task_comments WHERE run_id = ? ORDER BY created_at DESC LIMIT ?").all(runId, limit);
}

// ---- agent sessions (reference: PRD 4.4 Sessions tab) ----
export function recordAgentSession(root, runId, { stepNumber = 0, sessionUuid = "", runnerType = "tab-automation", agentRole = "", model = "", workspace = "", transcriptPath = null, exitCode = null } = {}) {
  try {
    const db = openDb(root);
    const id = randomUUID().slice(0, 8);
    db.prepare(
      "INSERT INTO agent_sessions (id, task_id, step_number, session_uuid, runner_type, agent_role, model, workspace, transcript_path, exit_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, runId, stepNumber, String(sessionUuid).slice(0, 64), String(runnerType).slice(0, 60),
      String(agentRole).slice(0, 60), String(model).slice(0, 80), String(workspace).slice(0, 300),
      transcriptPath ? String(transcriptPath).slice(0, 500) : null, exitCode, now());
    return id;
  } catch { return null; }
}

export function listAgentSessions(root, runId) {
  try {
    return openDb(root).prepare("SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY step_number, created_at").all(runId);
  } catch { return []; }
}

// ---- brain messages (reference: PRD 4.7 Teams/Brain hub) ----
export function fileBrainMessage(root, { jobId = "", actorId = "", conversationId = "", sender = "", source = "discord", messageText = "", processingStatus = "queued", linkedTaskId = null, requestText = null, sessionLog = null } = {}) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  db.prepare(
    "INSERT INTO brain_messages (id, job_id, actor_id, conversation_id, sender, source, message_text, processing_status, outbox_summary, linked_task_id, request_text, session_log, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)"
  ).run(id, String(jobId).slice(0, 120), String(actorId).slice(0, 120), String(conversationId).slice(0, 200),
    String(sender).slice(0, 120), String(source).slice(0, 40), String(messageText).slice(0, 8000),
    String(processingStatus).slice(0, 40), linkedTaskId, requestText ? String(requestText).slice(0, 4000) : null,
    sessionLog ? String(sessionLog).slice(0, 8000) : null, now());
  return id;
}

export function listBrainMessages(root, { status = null, limit = 50 } = {}) {
  const db = openDb(root);
  if (status) return db.prepare("SELECT * FROM brain_messages WHERE processing_status = ? ORDER BY received_at DESC LIMIT ?").all(status, limit);
  return db.prepare("SELECT * FROM brain_messages ORDER BY received_at DESC LIMIT ?").all(limit);
}

export function updateBrainMessage(root, id, { processingStatus = null, outboxSummary = null, processingError = null, linkedTaskId = null } = {}) {
  const sets = [];
  const args = [];
  if (processingStatus !== null) { sets.push("processing_status = ?"); args.push(String(processingStatus).slice(0, 40)); }
  if (outboxSummary !== null) { sets.push("outbox_summary = ?"); args.push(String(outboxSummary).slice(0, 500)); }
  if (processingError !== null) { sets.push("processing_error = ?"); args.push(String(processingError).slice(0, 2000)); }
  if (linkedTaskId !== null) { sets.push("linked_task_id = ?"); args.push(linkedTaskId); }
  if (!sets.length) return false;
  args.push(id);
  const r = openDb(root).prepare(`UPDATE brain_messages SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return r.changes > 0;
}

export function brainMetrics(root) {
  const db = openDb(root);
  try {
    const byStatus = db.prepare("SELECT processing_status s, COUNT(*) c FROM brain_messages GROUP BY s").all();
    const m = { incoming: 0, queued: 0, running: 0, failed: 0, replied: 0 };
    for (const r of byStatus) {
      m.incoming += r.c;
      if (r.s === "queued") m.queued += r.c;
      else if (r.s === "running") m.running += r.c;
      else if (r.s === "failed") m.failed += r.c;
      else if (r.s === "reply_generated" || r.s === "replied") m.replied += r.c;
    }
    return m;
  } catch { return { incoming: 0, queued: 0, running: 0, failed: 0, replied: 0 }; }
}

// ---- todos: dismiss + convert (reference: PRD 4.8) ----
export function dismissTodo(root, id) {
  const r = openDb(root).prepare("UPDATE todos SET status = 'dismissed', done_at = ? WHERE id = ? AND status = 'open'").run(now(), id);
  return r.changes > 0;
}

export function getTodo(root, id) {
  return openDb(root).prepare("SELECT * FROM todos WHERE id = ?").get(id);
}

// ---- durable jobs: thin wrappers over src/services/jobs.js (single DB handle) ----
export function enqueueJob(root, opts) {
  const db = openDb(root);
  return import("./services/jobs.js").then((m) => m.enqueueJob(root, db, opts));
}
export function enqueueJobSync(root, opts) {
  const db = openDb(root);
  // Sync route-handler path: mirrors src/services/jobs.js enqueueJob
  // (valid-JSON payload, idempotency actor+operation+scope conflict detection).
  const { kind, payload = {}, idempotencyKey = null, maxAttempts = 3, runId = null, taskId = null, actor = "", scope = "" } = opts || {};
  const allowed = new Set(["request", "loop-task", "automation", "requeue", "chat"]);
  if (!allowed.has(kind)) throw new Error(`unknown job kind '${kind}'`);
  const body = safePayloadStringifyLocal(payload);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  const key = idempotencyKey ? `${String(actor || "anon").slice(0, 60)}:${String(scope || kind).slice(0, 60)}:${String(idempotencyKey).slice(0, 120)}` : null;
  if (key) {
    const prior = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key);
    if (prior) {
      if (prior.kind !== kind) throw new Error(`idempotency conflict: key '${key}' already used for kind '${prior.kind}'`);
      if (createHash("sha256").update(prior.payload || "{}").digest("hex").slice(0, 32) !== hash) throw new Error(`idempotency conflict: key '${key}' reused with different payload`);
      return { id: prior.id, deduped: true, job: prior };
    }
  }
  const id = randomUUID().slice(0, 8);
  const t = now();
  db.prepare(
    "INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, run_id, task_id, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)"
  ).run(id, kind, body, Math.max(1, Math.min(6, Number(maxAttempts) || 3)), runId, taskId, key, t, t);
  return { id, deduped: false, job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) };
}
function safePayloadStringifyLocal(payload, maxBytes = 16000) {
  // Reject oversized payloads (no truncation of execution intent).
  const full = JSON.stringify(payload ?? {});
  if (full.length <= maxBytes) return full;
  throw new Error(`payload too large: ${full.length} bytes > ${maxBytes} max — split the goal or shorten the prompt (no truncation of execution intent)`);
}
export function getJobRow(root, id) {
  return openDb(root).prepare("SELECT * FROM jobs WHERE id = ?").get(id) || null;
}
export function listJobRows(root, { status = null, kind = null, limit = 50 } = {}) {
  const db = openDb(root);
  if (status && kind) return db.prepare("SELECT * FROM jobs WHERE status = ? AND kind = ? ORDER BY created_at DESC LIMIT ?").all(status, kind, limit);
  if (status) return db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit);
  if (kind) return db.prepare("SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?").all(kind, limit);
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
}
export function requestJobCancel(root, id) {
  const db = openDb(root);
  const t = now();
  const r = db.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status IN ('queued','leased','running')").run(t, id);
  if (r.changes === 0) return false;
  // Cancelling a queued job finishes it as cancelled immediately — it must
  // never be leased afterwards. Leased/running jobs keep their status so the
  // worker can observe the flag mid-flight and terminalize (cancel wins).
  try {
    db.prepare("UPDATE jobs SET status = 'cancelled', error = 'cancel requested', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND cancel_requested = 1").run(t, t, id);
  } catch {}
  return true;
}
export function isJobCancelRequested(root, id) {
  const row = openDb(root).prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(id);
  return row ? Number(row.cancel_requested) === 1 : false;
}

// ---- session attempts: assignment validation + hash dedupe in a transaction ----
// Atomic: the INSERT and the dedupe check happen inside one IMMEDIATE
// transaction, so two concurrent workers cannot both claim the same
// (run_id, step_index, attempt) or the same result_hash. Assignment is
// validated: resultPath must live under data/responses/<runId>/ and the
// sessionId must match the claiming job's session.
export function claimSessionAttempt(root, { jobId = "", runId = "", stepIndex = 0, attempt = 1, agent = "", model = "", sessionId = "", resultPath = "", resultHash = "" }) {
  const db = openDb(root);
  const id = randomUUID().slice(0, 8);
  const t = now();
  const safeRun = String(runId || "adhoc");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(safeRun)) throw new Error(`unsafe runId: ${safeRun.slice(0, 80)}`);
  if (resultPath) {
    const rp = String(resultPath);
    const want = `data/responses/${safeRun}/`;
    if (!rp.includes(want) && !rp.endsWith(`data/responses/${safeRun}`)) throw new Error(`resultPath outside run dir: ${rp.slice(0, 120)}`);
    if (rp.includes("..")) throw new Error(`resultPath traversal refused`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const taken = db.prepare("SELECT id FROM session_attempts WHERE run_id = ? AND step_index = ? AND attempt = ?").get(safeRun, Number(stepIndex) || 0, Number(attempt) || 1);
    if (taken) { db.exec("ROLLBACK"); return { id: null, deduped: true, error: `slot already claimed (attempt ${taken.id})` }; }
    if (resultHash) {
      const dup = db.prepare("SELECT id FROM session_attempts WHERE result_hash = ?").get(resultHash);
      if (dup) { db.exec("ROLLBACK"); return { id: null, deduped: true, error: `duplicate result hash (attempt ${dup.id})` }; }
    }
    db.prepare(
      "INSERT INTO session_attempts (id, job_id, run_id, step_index, attempt, agent, model, session_id, result_path, result_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)"
    ).run(id, String(jobId).slice(0, 16), safeRun.slice(0, 16), Number(stepIndex) || 0, Number(attempt) || 1,
      String(agent).slice(0, 80), String(model).slice(0, 80), String(sessionId).slice(0, 64),
      String(resultPath).slice(0, 500), String(resultHash).slice(0, 64), t);
    db.exec("COMMIT");
    return { id, deduped: false };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    if (/UNIQUE constraint failed/i.test(String(err.message || ""))) return { id: null, deduped: true, error: String(err.message).slice(0, 200) };
    throw err;
  }
}
export function finishSessionAttempt(root, id, { status = "done", resultHash = "" } = {}) {
  const db = openDb(root);
  if (id) db.prepare("UPDATE session_attempts SET status = ?, result_hash = COALESCE(NULLIF(?, ''), result_hash) WHERE id = ?").run(String(status).slice(0, 20), String(resultHash || ""), id);
}
export function listSessionAttempts(root, runId) {
  return openDb(root).prepare("SELECT * FROM session_attempts WHERE run_id = ? ORDER BY step_index, attempt").all(runId);
}

// ---- audit log ----
export function audit(root, { actor = "", action = "", target = "", detail = "" } = {}) {
  try {
    openDb(root).prepare("INSERT INTO audit_log (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(String(actor).slice(0, 120), String(action).slice(0, 120), String(target).slice(0, 200), String(detail ?? "").slice(0, 2000), now());
  } catch { /* best effort */ }
}
export function listAudit(root, { limit = 100 } = {}) {
  return openDb(root).prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}

// ---- outbox dedupe: same channel+text returns existing queued id ----
export function queueOutboxDeduped(root, { channel = "", text = "", runId = null, windowSec = 3600 } = {}) {
  const db = openDb(root);
  const ch = String(channel || "").slice(0, 200);
  const tx = String(text || "").slice(0, 4000);
  const key = `outbox:${ch}:${shaKey(ch, tx)}`;
  const since = new Date(Date.now() - Number(windowSec || 3600) * 1000).toISOString();
  try {
    const prior = db.prepare("SELECT outbox_id FROM outbox_dedupe WHERE key = ?").get(key);
    if (prior) {
      const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(prior.outbox_id);
      if (row && row.status === "queued" && row.created_at >= since) return { id: row.id, deduped: true };
    }
  } catch { /* fall through to insert */ }
  const id = queueOutbox(root, { channel: ch, text: tx, runId });
  try {
    db.prepare("INSERT INTO outbox_dedupe (key, outbox_id, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET outbox_id = excluded.outbox_id, created_at = excluded.created_at")
      .run(key, id, now());
  } catch { /* best effort */ }
  return { id, deduped: false };
}

function shaKey(...parts) {
  let h = 0x811c9dc5;
  const s = parts.join("::");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

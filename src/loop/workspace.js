// Task workspace file protocol: data/tasks/task-<id>/{task.json, handoff.md, attachments/, steps/NN-role/*}.
// The agent writes result.a<k>.json; only the reconciler writes handoff.md.
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, renameSync, realpathSync } from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const safeRole = (r) => String(r || "agent").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40) || "agent";

export function taskDir(root, taskId) {
  if (!SAFE_ID.test(String(taskId))) throw new Error(`unsafe task id '${taskId}'`);
  return path.join(root, "data", "tasks", `task-${taskId}`);
}

export function stepDir(root, taskId, pos, role) {
  return path.join(taskDir(root, taskId), "steps", `${String(Number(pos) + 1).padStart(2, "0")}-${safeRole(role)}`);
}

/** All per-attempt file paths for a step. */
export function attemptPaths(root, taskId, pos, role, attempt) {
  const dir = stepDir(root, taskId, pos, role);
  const k = `a${Number(attempt)}`;
  return {
    dir,
    prompt: path.join(dir, `prompt.${k}.md`),
    context: path.join(dir, `context.${k}.md`),
    result: path.join(dir, `result.${k}.json`),
    transcript: path.join(dir, `transcript.${k}.jsonl`),
  };
}

export function handoffPath(root, taskId) {
  return path.join(taskDir(root, taskId), "handoff.md");
}

export function atomicWrite(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Create the workspace and seed task.json + handoff.md. Idempotent. */
export function initWorkspace(root, task, steps) {
  const dir = taskDir(root, task.id);
  mkdirSync(path.join(dir, "steps"), { recursive: true });
  mkdirSync(path.join(dir, "attachments"), { recursive: true });
  writeTaskSnapshot(root, task, steps);
  const h = handoffPath(root, task.id);
  if (!existsSync(h)) {
    atomicWrite(h, `# Handoff — Task #${task.seq}: ${task.title}\n\nEnd goal:\n${task.end_goal || task.title}\n\nPipeline: ${steps.map((s) => s.role).join(" → ")}\n`);
  }
  return dir;
}

export function writeTaskSnapshot(root, task, steps) {
  atomicWrite(path.join(taskDir(root, task.id), "task.json"), JSON.stringify({
    id: task.id, seq: task.seq, title: task.title, end_goal: task.end_goal, repo: task.repo,
    task_type: task.task_type, dispatcher: task.dispatcher, status: task.status,
    steps: steps.map((s) => ({ pos: s.pos, role: s.role, goal: s.goal, status: s.status, summary: s.summary })),
  }, null, 2));
}

export function readHandoff(root, taskId) {
  const h = handoffPath(root, taskId);
  return existsSync(h) ? readFileSync(h, "utf8") : "";
}

export function appendHandoff(root, taskId, { pos, role, attempt, status, guidance = "", body = "" }) {
  const head = `\n## Step ${Number(pos) + 1} · ${role} · attempt ${attempt} · ${status} · ${new Date().toISOString()}\n`;
  const g = guidance ? `Re-queued with guidance: "${guidance}"\n\n` : "";
  appendFileSync(handoffPath(root, taskId), `${head}${g}${String(body || "(no handoff notes)").trim()}\n`);
}

export function appendHandoffNote(root, taskId, text) {
  appendFileSync(handoffPath(root, taskId), `\n> ${new Date().toISOString()} — ${String(text).replace(/\n/g, " ")}\n`);
}

/** True if `file` resolves inside `dir` (no traversal / symlink escape). */
export function isInside(dir, file) {
  const d = path.resolve(dir);
  let f = path.resolve(file);
  try { f = realpathSync(f); } catch { /* may not exist yet */ }
  let rd = d;
  try { rd = realpathSync(d); } catch {}
  return f === rd || f.startsWith(rd + path.sep) || f.startsWith(d + path.sep);
}

/** Read a workspace file for the API, refusing anything outside the task dir. */
export function readWorkspaceFile(root, taskId, file, maxBytes = 400000) {
  const dir = taskDir(root, taskId);
  if (!file || !isInside(dir, file) || !existsSync(file)) return null;
  const buf = readFileSync(file);
  return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString("utf8") : buf.toString("utf8");
}

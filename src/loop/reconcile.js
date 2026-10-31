// Reconciler: agent-written result JSON -> validated -> DB (exactly once) -> handoff.md.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import Ajv from "ajv";
import * as store from "./store.js";
import { appendHandoff, taskDir, isInside, writeTaskSnapshot } from "./workspace.js";
import { finalAssistantText, parseTranscript } from "./transcript.js";

const require = createRequire(import.meta.url);
const ajv = new Ajv({ allErrors: true, strict: false });
const validateResult = ajv.compile(require("../../schemas/step-result.schema.json"));
const validateDivider = ajv.compile(require("../../schemas/divider.schema.json"));

/** First complete top-level JSON object in text (tolerates fences, prose, duplicates). */
export function extractJson(text) {
  const s = String(text ?? "");
  const candidates = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { candidates.push(s.slice(i, j + 1)); i = j; break; } }
    }
  }
  // Prefer the last object that parses and looks like a result (agents print it as their final message).
  for (const c of candidates.reverse()) {
    try { const o = JSON.parse(c); if (o && typeof o === "object" && ("status" in o || "tasks" in o)) return o; } catch {}
  }
  return null;
}

/** Pull the agent's final text out of `muse exec --json`/plain stdout, then extract JSON. */
export function jsonFromStdout(stdout) {
  // Structured event streams: the final assistant message carries the result (deltas may split it).
  const fin = finalAssistantText(stdout);
  if (fin) { const o = extractJson(fin); if (o) return o; }
  const direct = extractJson(stdout);
  if (direct) return direct;
  // JSONL event streams: look for string fields that themselves contain the JSON.
  for (const line of String(stdout || "").split("\n").reverse()) {
    try {
      const ev = JSON.parse(line);
      for (const v of Object.values(ev || {})) if (typeof v === "string" && v.includes("{")) { const o = extractJson(v); if (o) return o; }
    } catch {}
  }
  return null;
}

export function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "no result JSON" };
  const r = { ...raw };
  let st = String(r.status || "").toLowerCase().trim();
  if (/^(complete|completed|success|ok)$/.test(st)) st = "done";
  if (!["done", "failed", "blocked"].includes(st)) st = "failed";
  r.status = st;
  r.summary = String(r.summary ?? "").slice(0, 1000);
  r.output = String(r.output ?? r.summary ?? "").slice(0, 60000);
  r.handoff = String(r.handoff ?? "").slice(0, 20000);
  r.artifacts = Array.isArray(r.artifacts) ? r.artifacts.slice(0, 20) : [];
  r.spawn_tasks = Array.isArray(r.spawn_tasks) ? r.spawn_tasks.slice(0, 10) : [];
  if (!validateResult(r)) return { ok: false, error: `result schema: ${ajv.errorsText(validateResult.errors)}`, result: r };
  return { ok: true, result: r };
}

export function normalizeDivider(raw, knownRoles) {
  if (!raw || !validateDivider(raw)) return { ok: false, error: raw ? `divider schema: ${ajv.errorsText(validateDivider.errors)}` : "no divider JSON" };
  const roles = new Set(knownRoles);
  const bad = raw.tasks.flatMap((t) => t.steps.filter((s) => !roles.has(s.role)).map((s) => s.role));
  if (bad.length) return { ok: false, error: `divider used unknown roles: ${[...new Set(bad)].join(", ")}` };
  return { ok: true, result: raw };
}

/** Read result file; fall back to stdout. Returns { raw, source, text } or null. */
export function readResult(resultPath, stdout = "") {
  if (resultPath && existsSync(resultPath)) {
    const text = readFileSync(resultPath, "utf8");
    try { return { raw: JSON.parse(text), source: "file", text }; } catch {
      const o = extractJson(text);
      if (o) return { raw: o, source: "file", text };
    }
  }
  const o = jsonFromStdout(stdout);
  return o ? { raw: o, source: "stdout", text: JSON.stringify(o) } : null;
}

/**
 * Apply one attempt's result to the DB. Idempotent via result hash.
 * Returns { applied, deduped, status, error }.
 */
export function reconcileAttempt(root, { attemptId, stdout = "", exitCode = 0, durationMs = 0, error = "", knownRoles = null }) {
  const att = store.getAttempt(root, attemptId);
  if (!att) return { applied: false, error: "unknown attempt" };
  if (att.status !== "running") return { applied: false, deduped: true, status: att.status };
  const task = store.getTask(root, att.task_id);
  const step = store.getStep(root, att.task_id, att.pos);
  if (!task || !step) return { applied: false, error: "task/step missing" };

  const got = readResult(att.result_path, stdout);
  let norm = got ? normalizeResult(got.raw) : { ok: false, error: error || `no result JSON (exit ${exitCode})` };
  if (norm.ok && got.raw.task_id && String(got.raw.task_id) !== task.id) norm = { ok: false, error: `result task_id mismatch (${got.raw.task_id})` };
  const result = norm.ok ? norm.result : { status: "failed", summary: String(norm.error || error || "step failed").slice(0, 1000), output: "", handoff: "", artifacts: [], spawn_tasks: [] };

  const hash = createHash("sha256").update(`${attemptId}\n${got?.text || result.summary}`).digest("hex");
  if (store.hashSeen(root, hash)) return { applied: false, deduped: true, status: result.status };

  const d = store.db(root);
  const t = new Date().toISOString();
  try { store.transaction(root, () => {
    store.updateAttempt(root, attemptId, { status: result.status, exit_code: exitCode, error: norm.ok ? "" : String(norm.error || "").slice(0, 2000), duration_ms: durationMs, finished_at: t, result_hash: hash });
    store.updateStep(root, task.id, step.pos, { status: result.status, summary: result.summary, output: result.output, finished_at: t });
    store.addEvent(root, task.id, result.status === "done" ? "completed" : result.status, `Step ${step.pos + 1} (${step.role}) ${result.status}${got ? ` via ${got.source}` : ""}: ${result.summary}`, { pos: step.pos, attempt: att.attempt });
    for (const a of result.artifacts) {
      if (a.kind === "file" && a.path) {
        const abs = path.resolve(task.repo || root, a.path);
        if (!isInside(taskDir(root, task.id), abs) && !isInside(task.repo || root, abs)) continue;
      }
      store.addArtifact(root, task.id, { pos: step.pos, attempt: att.attempt, kind: a.kind, title: a.title || a.kind, body: a.body || "", path: a.path || "" });
    }
    // Agents often self-report 0; the CLI's own usage stream is authoritative when present.
    const u = parseTranscript(stdout).meta?.usage;
    const tokens = Number(result.metrics?.tokens) || (Number(u?.input) || 0) + (Number(u?.output) || 0);
    const tools = Number(result.metrics?.tool_calls) || 0;
    const roles = knownRoles ? new Set(knownRoles) : null;
    for (const sp of result.status === "done" ? result.spawn_tasks : []) {
      const steps = (sp.steps || []).filter((s) => !roles || roles.has(s.role));
      if (!steps.length) continue;
      const nid = store.createTask(root, { requestId: task.request_id, title: sp.title, endGoal: sp.end_goal || "", repo: task.repo, taskType: "", dispatcher: task.dispatcher, model: task.model, steps });
      store.addEvent(root, task.id, "note", `Spawned follow-up task ${nid}: ${sp.title}`, { pos: step.pos });
    }
    const done = d.prepare("SELECT COUNT(*) AS n FROM loop_steps WHERE task_id = ? AND status = 'done'").get(task.id).n;
    store.updateTask(root, task.id, { steps_done: done, tokens: task.tokens + tokens, tool_calls: task.tool_calls + tools });
  }); } catch (e) {
    return { applied: false, error: `reconcile failed: ${e.message}` };
  }
  try {
    appendHandoff(root, task.id, { pos: step.pos, role: step.role, attempt: att.attempt, status: result.status, guidance: step.guidance, body: result.handoff || result.summary });
    store.addEvent(root, task.id, "handoff", `handoff.md updated by step ${step.pos + 1}`, { pos: step.pos, attempt: att.attempt });
    writeTaskSnapshot(root, store.getTask(root, task.id), store.listSteps(root, task.id));
  } catch { /* handoff is best effort; DB is authoritative */ }
  return { applied: true, status: result.status, error: norm.ok ? "" : norm.error, blockedReason: result.blocked_reason || result.summary };
}

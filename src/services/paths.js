// Safe fixed-root response paths + atomic write helpers.
// Fixed root: <root>/data/responses. No injection / symlink escape.
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const RESPONSES_DIR = "data/responses";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertSafeId(id, label = "id") {
  if (!SAFE_ID.test(String(id || ""))) throw new Error(`unsafe ${label}: ${String(id).slice(0, 80)}`);
  return String(id);
}

export function responsesRoot(root) {
  return path.join(String(root), RESPONSES_DIR);
}

/** Resolve <root>/data/responses/<runId>/step<N>.json safely. runId defaults to adhoc-safe.
 *  Collision-safe: when attempt+sessionId are given, the file is namespaced
 *  per attempt/session (step<N>.a<attempt>.<session8>.json) so concurrent or
 *  retried attempts never overwrite each other. Legacy step<N>.json is used
 *  when no attempt/session is supplied (read path compatibility). */
export function resultPathFor(root, runId, stepIdx, { attempt = null, sessionId = "" } = {}) {
  const safeRun = assertSafeId(runId || "adhoc", "runId");
  const n = Number(stepIdx);
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error(`unsafe stepIdx: ${stepIdx}`);
  const dir = path.join(responsesRoot(root), safeRun);
  if (attempt == null && !sessionId) {
    return { dir, file: path.join(dir, `step${n + 1}.json`), promptFile: path.join(dir, `step${n + 1}.prompt.md`) };
  }
  const a = Math.max(1, Number(attempt) || 1);
  const s = String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(-8) || "nosess";
  return { dir, file: path.join(dir, `step${n + 1}.a${a}.${s}.json`), promptFile: path.join(dir, `step${n + 1}.a${a}.${s}.prompt.md`) };
}

/** Ensure dir stays under fixed root (no symlink escape). Creates it. */
export function ensureResponsesDir(root, runId) {
  const safeRun = assertSafeId(runId || "adhoc", "runId");
  const base = path.resolve(responsesRoot(root));
  const dir = path.resolve(path.join(base, safeRun));
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error("responses path escape");
  mkdirSync(dir, { recursive: true });
  // If dir is a symlink pointing outside, refuse.
  try {
    const real = realpathSync(dir);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error("responses symlink escape");
  } catch { /* best effort if realpath fails on fresh dir */ }
  return dir;
}

/** Atomic write: tmp in same dir + rename. Returns final path. Never partial. */
export function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), "utf-8");
  renameSync(tmp, file);
  return file;
}

export function readJsonFile(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return null; }
}

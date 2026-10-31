// Trusted immutable result envelope for Muse sessions.
// Supervisor owns the envelope: assigns ids/version/attempt/session/agent/model
// + result path, computes hash externally, stores DB reconcile marker.
// Model payload (summary/output/status) is untrusted input — never self-hash.
import { createHash, randomUUID } from "node:crypto";

export const ENVELOPE_VERSION = 1;
export const TERMINAL_STATUSES = new Set(["done", "blocked", "failed", "cancelled"]);

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

/** Normalize a model status string into the trusted terminal set.
 *  Unknown statuses are failures, never silent done (fail closed). */
export function normalizeStatus(s) {
  const t = String(s || "").toLowerCase().trim();
  if (!t) return "failed";
  if (t === "done" || t === "complete" || t === "completed" || t === "success") return "done";
  if (t === "blocked" || t === "block") return "blocked";
  if (t === "failed" || t === "failure" || t === "error") return "failed";
  if (t === "cancelled" || t === "canceled" || t === "cancel") return "cancelled";
  return "failed";
}

/** Build the immutable envelope. hash covers payload only (no self-reference). */
export function buildEnvelope({ runId, stepIdx, attempt, agent, model, sessionId, cliSessionId, resultPath, payload, durationMs = 0 }) {
  const status = normalizeStatus(payload?.status);
  const env = {
    v: ENVELOPE_VERSION,
    id: randomUUID(),
    runId: String(runId || "adhoc"),
    step: Number(stepIdx) || 0,
    attempt: Number(attempt) || 1,
    agent: String(agent || ""),
    model: String(model || ""),
    sessionId: String(sessionId || ""),
    cliSessionId: String(cliSessionId || ""),
    resultPath: String(resultPath || ""),
    status,
    summary: String(payload?.summary || "").slice(0, 1000),
    output: String(payload?.output ?? payload?.summary ?? "").slice(0, 8000),
    next: String(payload?.next || ""),
    progress: Number(payload?.progress) || 0,
    tokens: Number(payload?.tokens) || 0,
    durationMs: Number(durationMs) || 0,
    createdAt: new Date().toISOString(),
  };
  env.hash = sha256({ v: env.v, runId: env.runId, step: env.step, attempt: env.attempt, agent: env.agent, model: env.model, sessionId: env.sessionId, status: env.status, summary: env.summary, output: env.output });
  return Object.freeze(env);
}

export function sha256(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

/** Validate an envelope read back from disk. Returns { ok, error }. */
export function validateEnvelope(env) {
  if (!env || typeof env !== "object") return { ok: false, error: "not an object" };
  if (env.v !== ENVELOPE_VERSION) return { ok: false, error: `unsupported envelope v${env.v}` };
  if (!isTerminal(env.status)) return { ok: false, error: `non-terminal status ${env.status}` };
  if (!env.runId || !env.agent || !env.sessionId) return { ok: false, error: "missing runId/agent/sessionId" };
  const expect = sha256({ v: env.v, runId: env.runId, step: env.step, attempt: env.attempt, agent: env.agent, model: env.model, sessionId: env.sessionId, status: env.status, summary: env.summary, output: env.output });
  if (env.hash !== expect) return { ok: false, error: "hash mismatch" };
  return { ok: true, error: null };
}

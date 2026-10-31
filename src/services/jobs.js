// Durable SQLite job queue with leases: fast 202 launch for
// requests / loop-tasks / automations. Single-concurrency worker, crash
// recovery, cancel flags, idempotency keys, outbox dedupe for side effects.
import { randomUUID, createHash } from "node:crypto";

export const JOB_KINDS = new Set(["request", "loop-task", "automation", "requeue", "chat"]);
export const JOB_STATUSES = new Set(["queued", "leased", "running", "done", "failed", "blocked", "cancelled"]);

const now = () => new Date().toISOString();

export function payloadHash(payload) {
  return createHash("sha256").update(typeof payload === "string" ? payload : JSON.stringify(payload ?? {})) .digest("hex").slice(0, 32);
}

export const MAX_PAYLOAD_BYTES = 16000;

/** Valid-JSON payload serialization: NEVER truncates execution intent.
 *  Oversized payloads are rejected (fail closed) so no step runs with a
 *  sliced prompt/goal. Always returns parseable JSON or throws. */
export function safePayloadStringify(payload, maxBytes = MAX_PAYLOAD_BYTES) {
  const full = JSON.stringify(payload ?? {});
  if (full.length <= maxBytes) return full;
  throw new Error(`payload too large: ${full.length} bytes > ${maxBytes} max — split the goal or shorten the prompt (no truncation of execution intent)`);
}

export function enqueueJob(root, db, { kind, payload = {}, idempotencyKey = null, maxAttempts = 3, runId = null, taskId = null, actor = "", scope = "" }) {
  if (!JOB_KINDS.has(kind)) throw new Error(`unknown job kind '${kind}'`);
  const body = safePayloadStringify(payload);
  const hash = payloadHash(body);
  // Scoped idempotency (actor:operation:scope): same raw key in a different
  // operation/scope enqueues independently — cross-operation reuse allowed.
  const key = idempotencyKey ? `${String(actor || "anon").slice(0, 60)}:${String(scope || kind).slice(0, 60)}:${String(idempotencyKey).slice(0, 120)}` : null;
  if (key) {
    const prior = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key);
    if (prior) {
      if (prior.kind !== kind) throw new Error(`idempotency conflict: key '${key}' already used for kind '${prior.kind}'`);
      if (payloadHash(prior.payload || "{}") !== hash) throw new Error(`idempotency conflict: key '${key}' reused with different payload`);
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

export function getJob(db, id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) || null;
}

export function listJobs(db, { status = null, kind = null, limit = 50 } = {}) {
  if (status && kind) return db.prepare("SELECT * FROM jobs WHERE status = ? AND kind = ? ORDER BY created_at DESC LIMIT ?").all(status, kind, limit);
  if (status) return db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit);
  if (kind) return db.prepare("SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?").all(kind, limit);
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
}

/** Atomic claim: one worker wins. Returns job row or null.
 *  Cancel-requested jobs are never leased: cancelling a queued job finishes
 *  it as cancelled immediately (see requestCancel), and the claim skips any
 *  leftover cancel flags so a cancel can never race into a lease. */
export function claimNextJob(db, workerId, { kinds = null, leaseSec = 300 } = {}) {
  const t = now();
  const leaseUntil = new Date(Date.now() + leaseSec * 1000).toISOString();
  const rows = kinds?.length
    ? db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND (cancel_requested = 0 OR cancel_requested IS NULL) AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY created_at LIMIT 5`).all(...kinds)
    : db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND (cancel_requested = 0 OR cancel_requested IS NULL) ORDER BY created_at LIMIT 5").all();
  for (const r of rows) {
    const res = db.prepare("UPDATE jobs SET status = 'leased', worker_id = ?, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(workerId, leaseUntil, t, r.id);
    if (res.changes > 0) return { ...r, status: "leased", worker_id: workerId, lease_until: leaseUntil };
  }
  return null;
}

/** Mark running (after claim). Fails if cancel was requested meanwhile.
 *  Cancel-race: a queued job with cancel_requested is finished as cancelled
 *  (terminal) instead of being left leased. Returns true if running. */
export function markRunning(db, id, workerId) {
  const t = now();
  const r = db.prepare("UPDATE jobs SET status = 'running', worker_id = ?, updated_at = ? WHERE id = ? AND status = 'leased' AND cancel_requested = 0").run(workerId, t, id);
  if (r.changes > 0) return true;
  // Lost the race to cancel: terminalize queued/leased jobs with cancel flag.
  try {
    db.prepare("UPDATE jobs SET status = 'cancelled', error = 'cancel requested', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','leased') AND cancel_requested = 1").run(t, t, id);
  } catch {}
  return false;
}

/** Heartbeat: extend the lease while live work continues. Only applies to
 *  non-terminal jobs still owned by this worker. Returns true if extended. */
export function heartbeatJob(db, id, workerId, { leaseSec = 300 } = {}) {
  const leaseUntil = new Date(Date.now() + Number(leaseSec || 300) * 1000).toISOString();
  const r = db.prepare("UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status IN ('leased','running') AND cancel_requested = 0")
    .run(leaseUntil, now(), id, workerId);
  return r.changes > 0;
}

/** Unified reconciler: validate one claimed assignment and record its
 *  steps/task/session markers together. Transaction checks the exact
 *  assignment (job/current attempt/current session/job cancel/terminal)
 *  before writing anything. Returns { ok, deduped, error }.
 *
 *  Pre-registered slots: runner.js claims (run/step/attempt/session) BEFORE
 *  spawning Muse with resultHash=''. The live finalize for the SAME session
 *  updates that row in place (no new run_steps row) — it is NOT a duplicate.
 *  A DIFFERENT session for the same slot is rejected (fail closed). A slot
 *  whose session finished (status terminal) is complete: same-session
 *  re-finalize dedupes, other sessions reject. Only a running pre-claim
 *  from the same session may finalize. */
export function reconcileAttempt(db, { jobId, runId, stepIndex, attempt, agent, model, sessionId, cliSessionId = "", resultPath, resultHash, status, output, summary, tokens = 0, expectedAgent = null, expectedModel = null, expectedSessionId = null, expectedResultPath = null } = {}) {
  const job = getJob(db, jobId);
  if (!job) return { ok: false, error: `unknown job '${jobId}'` };
  if (!["leased", "running"].includes(job.status)) return { ok: false, error: `job not active (status=${job.status})` };
  if (Number(job.cancel_requested) === 1) return { ok: false, error: "cancel requested", cancelled: true };
  if (Number(job.attempt || 0) + 1 !== Number(attempt)) return { ok: false, error: `stale attempt ${attempt} (job attempt=${job.attempt})` };
  // Exact pre-registered assignment validation (fail closed on tamper):
  // the live finalize must present the same agent/model/session/path that
  // was claimed before spawn. Scanner recovery passes expected*=null and
  // validates against the stored pre-claim row instead.
  const t = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const taken = db.prepare("SELECT id, job_id, agent, model, session_id, result_path, result_hash, status FROM session_attempts WHERE run_id = ? AND step_index = ? AND attempt = ?").get(runId, Number(stepIndex) || 0, Number(attempt) || 1);
    if (taken) {
      // Job binding: slot belongs to this job.
      if (taken.job_id && String(taken.job_id) !== String(jobId)) { db.exec("ROLLBACK"); return { ok: false, error: `slot claimed by job ${taken.job_id}` }; }
      // Session binding: only the pre-claimed session may finalize.
      // A different session is rejected (fail closed) — never silently deduped.
      if (taken.session_id && String(taken.session_id) !== String(sessionId)) { db.exec("ROLLBACK"); return { ok: false, error: `slot claimed by session ${taken.session_id}` }; }
      if (expectedSessionId && taken.session_id && String(taken.session_id) !== String(expectedSessionId)) { db.exec("ROLLBACK"); return { ok: false, error: `session mismatch: expected ${expectedSessionId}` }; }
      // Agent/model binding against the pre-claim (tamper => reject).
      const expA = expectedAgent ?? taken.agent;
      const expM = expectedModel ?? taken.model;
      if (expA && agent && String(expA) !== String(agent)) { db.exec("ROLLBACK"); return { ok: false, error: `agent mismatch: expected '${expA}' got '${agent}'` }; }
      if (expM && model && String(expM) !== String(model)) { db.exec("ROLLBACK"); return { ok: false, error: `model mismatch: expected '${expM}' got '${model}'` }; }
      if (expectedResultPath && resultPath && String(expectedResultPath) !== String(resultPath)) { db.exec("ROLLBACK"); return { ok: false, error: `resultPath mismatch` }; }
      const terminal = new Set(["done", "blocked", "failed", "cancelled"]);
      const alreadyDone = terminal.has(String(taken.status || "").toLowerCase());
      const hasResult = !!(taken.result_hash && String(taken.result_hash).length > 0);
      if (alreadyDone && hasResult) { db.exec("ROLLBACK"); return { ok: true, deduped: true }; }
      // Same-session finalize of a running pre-claim (status running, hash
      // empty): UPDATE the pre-registered row in place and record its steps
      // once. This is NOT a duplicate — the slot was started, not finished.
      if (!hasResult && !alreadyDone && String(taken.session_id || "") === String(sessionId || "")) {
        db.prepare("UPDATE session_attempts SET result_hash = ?, result_path = ?, status = ?, agent = ?, model = ? WHERE id = ?")
          .run(String(resultHash || "").slice(0, 64), String(resultPath || taken.result_path || "").slice(0, 500), String(status || "done").slice(0, 20), String(agent || taken.agent || "").slice(0, 80), String(model || taken.model || "").slice(0, 80), taken.id);
        db.prepare("INSERT INTO run_steps (run_id, step_id, type, agent, status, raw_text, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(runId, `step-${Number(stepIndex) + 1}`, "agent", String(agent || ""),
            status === "done" ? "ok" : "failed",
            String(output ?? summary ?? "").slice(0, 20000),
            JSON.stringify({ summary: String(summary || "").slice(0, 1000), output: String(output || "").slice(0, 8000), status, hash: resultHash || null }).slice(0, 20000), t);
        if (Number(tokens) > 0) {
          try { db.prepare("UPDATE runs SET tokens = tokens + ? WHERE id = ?").run(Number(tokens) || 0, runId); } catch { /* best effort */ }
        }
        // agent_sessions.session_uuid MUST be the real Muse CLI --session-id
        // (exportable via `muse export`), never the synthetic supervisor
        // sessionId (run:agent:ts) which `muse export` rejects. Binding stays
        // on the synthetic sessionId in session_attempts; export uses this UUID.
        const exportId1 = String(cliSessionId || "").trim() || String(sessionId || "");
        db.prepare("INSERT INTO agent_sessions (id, task_id, step_number, session_uuid, runner_type, agent_role, model, workspace, transcript_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID().slice(0, 8), runId, Number(stepIndex) || 0, String(exportId1).slice(0, 64), "muse-cli",
            String(agent || "").slice(0, 60), String(model || "").slice(0, 80), "", String(resultPath || "").slice(0, 500), t);
        db.exec("COMMIT");
        return { ok: true, deduped: false, attemptId: taken.id };
      }
      // Anything else with an existing slot is a conflict (fail closed):
      // e.g. same slot re-finalized with a different result, or a running
      // slot finalized by a foreign session that slipped past binding.
      // Only the terminal+hasResult case above dedupes.
      db.exec("ROLLBACK"); return { ok: false, error: `slot conflict (status=${taken.status || ""} hasResult=${hasResult})` };
    }
    if (resultHash) {
      const dup = db.prepare("SELECT id FROM session_attempts WHERE result_hash = ?").get(resultHash);
      if (dup) { db.exec("ROLLBACK"); return { ok: true, deduped: true }; }
    }
    const { randomUUID: uuid } = { randomUUID };
    const aid = uuid().slice(0, 8);
    db.prepare(
      "INSERT INTO session_attempts (id, job_id, run_id, step_index, attempt, agent, model, session_id, result_path, result_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(aid, String(jobId).slice(0, 16), String(runId).slice(0, 16), Number(stepIndex) || 0, Number(attempt) || 1,
      String(agent || "").slice(0, 80), String(model || "").slice(0, 80), String(sessionId || "").slice(0, 64),
      String(resultPath || "").slice(0, 500), String(resultHash || "").slice(0, 64), String(status || "done").slice(0, 20), t);
    db.prepare("INSERT INTO run_steps (run_id, step_id, type, agent, status, raw_text, output_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, `step-${Number(stepIndex) + 1}`, "agent", String(agent || ""),
        status === "done" ? "ok" : "failed",
        String(output ?? summary ?? "").slice(0, 20000),
        JSON.stringify({ summary: String(summary || "").slice(0, 1000), output: String(output || "").slice(0, 8000), status, hash: resultHash || null }).slice(0, 20000), t);
    if (Number(tokens) > 0) {
      try { db.prepare("UPDATE runs SET tokens = tokens + ? WHERE id = ?").run(Number(tokens) || 0, runId); } catch { /* best effort */ }
    }
    db.prepare("INSERT INTO agent_sessions (id, task_id, step_number, session_uuid, runner_type, agent_role, model, workspace, transcript_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uuid().slice(0, 8), runId, Number(stepIndex) || 0, String(cliSessionId || sessionId || "").slice(0, 64), "muse-cli",
        String(agent || "").slice(0, 60), String(model || "").slice(0, 80), "", String(resultPath || "").slice(0, 500), t);
    db.prepare("UPDATE session_attempts SET status = ? WHERE id = ?").run(String(status || "done").slice(0, 20), aid);
    db.exec("COMMIT");
    return { ok: true, deduped: false, attemptId: aid };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    if (/UNIQUE constraint failed/i.test(String(err.message || ""))) return { ok: true, deduped: true };
    throw err;
  }
}

export function requestCancel(db, id) {
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

export function isCancelRequested(db, id) {
  const row = db.prepare("SELECT cancel_requested, status FROM jobs WHERE id = ?").get(id);
  return row ? Number(row.cancel_requested) === 1 : false;
}

const TERMINAL = new Set(["done", "failed", "blocked", "cancelled"]);
/** Terminal transition is one-way: only queued/leased/running may move to a
 *  terminal status. Never overwrites an existing terminal (cancellation and
 *  blocked/failed results win over late done). Returns true if applied. */
export function finishJob(db, id, { status = "done", error = null, runId = null, taskId = null, resultHash = null } = {}) {
  if (!JOB_STATUSES.has(status)) throw new Error(`unknown job status '${status}'`);
  const t = now();
  const r = db.prepare("UPDATE jobs SET status = ?, error = ?, run_id = COALESCE(?, run_id), task_id = COALESCE(?, task_id), result_hash = COALESCE(?, result_hash), finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','leased','running')")
    .run(status, error ? String(error).slice(0, 2000) : null, runId, taskId, resultHash, t, t, id);
  return r.changes > 0;
}

export function failJobAttempt(db, id, { error = null, retryable = true } = {}) {
  const job = getJob(db, id);
  if (!job) return null;
  if (TERMINAL.has(job.status)) return { ...job }; // never requeue a terminal job
  if (Number(job.cancel_requested) === 1) {
    db.prepare("UPDATE jobs SET status = 'cancelled', attempt = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','leased','running')")
      .run(Number(job.attempt || 0) + 1, error ? String(error).slice(0, 2000) : "cancel requested", now(), now(), id);
    return { ...job, status: "cancelled", attempt: Number(job.attempt || 0) + 1 };
  }
  const attempt = Number(job.attempt || 0) + 1;
  const t = now();
  if (retryable && attempt < Number(job.max_attempts || 3)) {
    db.prepare("UPDATE jobs SET status = 'queued', attempt = ?, error = ?, worker_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('leased','running','queued')")
      .run(attempt, error ? String(error).slice(0, 2000) : null, t, id);
    return { ...job, status: "queued", attempt };
  }
  db.prepare("UPDATE jobs SET status = 'failed', attempt = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('leased','running','queued')")
    .run(attempt, error ? String(error).slice(0, 2000) : null, t, t, id);
  return { ...job, status: "failed", attempt };
}

/** Crash recovery: NEVER blindly replay a leased/running agent or workflow job.
 *  A lease is stale when lease_until is NULL or already past (actual expiry,
 *  not now-minus-lease). Stale jobs are parked as blocked for operator
 *  review — unless a complete validated result file is recoverable on disk,
 *  in which case the result is reconciled (not re-executed) via the unified
 *  reconciler. Returns { checked, recovered, held }. */
export function recoverStaleJobs(db, { leaseSec = 300, root = null, reconcile = null } = {}) {
  void leaseSec;
  const cutoff = now();
  const stale = db.prepare("SELECT * FROM jobs WHERE status IN ('leased','running') AND (lease_until IS NULL OR lease_until < ?)").all(cutoff);
  let recovered = 0, held = 0;
  for (const j of stale) {
    let done = false;
    // Try to recover a complete validated result instead of replaying.
    if (root && typeof reconcile === "function") {
      try {
        const r = reconcile(db, j);
        if (r && r.recovered) { recovered++; done = true; }
      } catch {}
    }
    if (done) continue;
    // Uncertain side effects: hold blocked for review, never auto-requeue.
    db.prepare("UPDATE jobs SET status = 'blocked', error = 'held: lease expired mid-execution \u2014 operator review (no auto-requeue of leased agent/workflow)', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('leased','running')").run(now(), now(), j.id);
    held++;
  }
  return { checked: stale.length, requeued: 0, recovered, held };
}

/** Outbox dedupe: same channel+hash within window returns existing id. */
export function dedupeKey(channel, text) {
  return createHash("sha256").update(`${channel}::${text}`).digest("hex").slice(0, 32);
}

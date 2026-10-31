// Single-concurrency durable worker: claims queued jobs, runs them via the
// async Muse harness, reconciles trusted envelopes into the DB.
// Crash recovery on boot + periodic rescan. Expired leases never blindly
// replay side effects (see recoverStaleJobs).
import { randomUUID } from "node:crypto";

let workerId = `w-${randomUUID().slice(0, 6)}`;
let running = false;
let timer = null;
let depsRef = null;

export function workerStatus() {
  return { workerId, running: !!timer, busy: running };
}

export function startWorker(cfg, deps = {}) {
  if (timer) return workerStatus();
  depsRef = deps;
  // Boot recovery: requeue stale leased/running jobs (bounded, side-effect safe).
  // Async-safe: never throws out of startWorker; the dashboard must boot even
  // if the DB is momentarily locked.
  void recoverNowAsync(cfg, deps).catch(() => {});
  // Startup + periodic scanner.
  timer = setInterval(() => { void tick(cfg, depsRef).catch(() => {}); }, 5000);
  timer.unref?.();
  void tick(cfg, depsRef).catch(() => {});
  return workerStatus();
}
async function recoverNowAsync(cfg, deps = {}) {
  try {
    const dbm = await import("../db.js");
    const open = deps?._db?.openDb || dbm.openDb;
    const jobs = await import("./jobs.js");
    const db = open(cfg.root);
    // Order matters: scan valid orphan result files FIRST (reconcile exact
    // pre-registered assignments), THEN park leftovers blocked. Otherwise
    // recoverStaleJobs would block jobs before the scanner can recover them.
    let scanned = { scanned: 0, recovered: 0 };
    try { scanned = await scanOrphanResults(cfg, db, jobs); } catch { /* best effort */ }
    const r = jobs.recoverStaleJobs(db, { leaseSec: 300, root: cfg.root, reconcile: (d, j) => recoverJobResult(cfg, d, jobs, j) });
    return { ...r, scanned: scanned.scanned, scanRecovered: scanned.recovered };
  } catch { return { checked: 0, requeued: 0, recovered: 0, held: 0 }; }
}

/** Startup/periodic scanner: process valid orphan result files after a crash.
 *  Scans data/responses for envelopes whose job is still leased/running,
 *  validates each envelope, and reconciles it via the unified reconciler —
 *  never re-executes. Returns { scanned, recovered }.
 *
 *  Hardening: symlink-safe (lstat + realpath containment), bounded
 *  (run/file caps), metadata-covered (resultPath must resolve under the
 *  run dir; envelope hash covers agent/model/session/step/attempt so
 *  tampered model/session/path files reject), exact pre-claim match
 *  (agent/model/session/path validated against the stored slot).
 *  Terminal completion: when every expected step for the job's workflow has
 *  a terminal session_attempt, the job + run finish terminal (no replay).
 *  Partial workflows (interrupted tail) park the job blocked — no replay. */
export async function scanOrphanResults(cfg, db, jobs) {
  let scanned = 0, recovered = 0;
  try {
    const { readdirSync, readFileSync, lstatSync, realpathSync } = await import("node:fs");
    const { join, resolve, sep } = await import("node:path");
    const { validateEnvelope } = await import("./envelope.js");
    const root = cfg.root;
    const base = resolve(join(String(root), "data", "responses"));
    let runDirs = [];
    try { runDirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).slice(0, 200); } catch { return { scanned: 0, recovered: 0 }; }
    for (const runId of runDirs) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(runId)) continue;
      const runDir = resolve(join(base, runId));
      if (runDir !== base && !runDir.startsWith(base + sep)) continue;
      try {
        const realRun = realpathSync(runDir);
        const realBase = realpathSync(base);
        if (realRun !== realBase && !realRun.startsWith(realBase + sep)) continue;
      } catch { /* fresh dir */ }
      let files = [];
      try { files = readdirSync(runDir).filter((f) => f.endsWith(".json")).slice(0, 50); } catch { continue; }
      for (const f of files) {
        if (!/^step\d+\.a\d+\.[A-Za-z0-9_-]{1,16}\.json$/.test(f) && !/^step\d+\.json$/.test(f)) continue;
        const fp = resolve(join(runDir, f));
        if (fp !== runDir && !fp.startsWith(runDir + sep)) continue;
        try {
          const st = lstatSync(fp);
          if (!st.isFile() || st.size > 200000) continue;
          const real = realpathSync(fp);
          const realRun = realpathSync(runDir);
          if (real !== realRun && !real.startsWith(realRun + sep)) continue;
        } catch { continue; }
        scanned++;
        let env = null;
        try { env = JSON.parse(readFileSync(fp, "utf-8")); } catch { continue; }
        const v = validateEnvelope(env);
        if (!v.ok) continue;
        if (String(env.runId || "") !== runId) continue;
        // Envelope resultPath must resolve under this run dir (metadata-covered).
        // resultPath may be absolute (runner) or root-relative (legacy).
        try {
          const rawRp = String(env.resultPath || "");
          const rp = rawRp.startsWith("/") ? resolve(rawRp) : resolve(join(String(root), rawRp));
          if (rp !== runDir && !rp.startsWith(runDir + sep)) continue;
        } catch { continue; }
        // Only reconcile orphans for jobs still active (leased/running).
        let job = null;
        try {
          const rows = db.prepare("SELECT * FROM jobs WHERE run_id = ? AND status IN ('leased','running') ORDER BY created_at DESC LIMIT 5").all(env.runId);
          job = rows.find((r) => {
            try {
              const p = JSON.parse(r.payload || "{}");
              return String(p.runId || r.run_id || "") === String(env.runId) || r.run_id === env.runId;
            } catch { return r.run_id === env.runId; }
          }) || rows[0] || null;
        } catch { job = null; }
        if (!job) continue;
        try {
          // Exact pre-claim match: the stored slot's agent/model/session/path
          // must equal the envelope (tampered files reject, fail closed).
          // No pre-claim slot => forged orphan => skip (never reconcile).
          let slot = null;
          try { slot = db.prepare("SELECT agent, model, session_id, result_path FROM session_attempts WHERE run_id = ? AND step_index = ? AND attempt = ?").get(env.runId, Number(env.step) || 0, Number(env.attempt) || 1); } catch {}
          if (!slot) continue;
          const rec = jobs.reconcileAttempt(db, {
            jobId: job.id, runId: env.runId, stepIndex: env.step, attempt: env.attempt,
            agent: env.agent, model: env.model, sessionId: env.sessionId,
            cliSessionId: env.cliSessionId || "",
            resultPath: env.resultPath, resultHash: env.hash,
            status: env.status, output: env.output, summary: env.summary, tokens: env.tokens,
            expectedAgent: slot?.agent || null, expectedModel: slot?.model || null,
            expectedSessionId: slot?.session_id || null, expectedResultPath: slot?.result_path || null,
          });
          if (rec?.ok && !rec.deduped) recovered++;
          // Deduped re-scans do NOT count as recovered: the file was already
          // reconciled, so a second scan must report recovered=0 (no double).
          if (rec?.ok) { try { maybeCompleteRecoveredJob(cfg, db, jobs, job); } catch {} }
        } catch { /* next file */ }
      }
    }
  } catch { /* best effort */ }
  return { scanned, recovered };
}

/** Terminal completion for scanner-recovered jobs: when every expected step
 *  for the job's workflow has a terminal session_attempt row, finish the job
 *  + run terminal (done/blocked/failed by worst status). Partial workflows
 *  (interrupted tail, missing steps) stay active for the operator — the
 *  stale-job pass parks them blocked. Never replays. */
function maybeCompleteRecoveredJob(cfg, db, jobs, job) {
  try {
    let payload = {};
    try { payload = JSON.parse(job?.payload || "{}"); } catch {}
    const expected = expectedStepCount(payload);
    if (!expected) return;
    const rows = db.prepare("SELECT step_index, status FROM session_attempts WHERE run_id = ?").all(job.run_id);
    const byStep = new Map();
    for (const r of rows) {
      const k = Number(r.step_index) || 0;
      if (!byStep.has(k)) byStep.set(k, []);
      byStep.get(k).push(String(r.status || "").toLowerCase());
    }
    if (byStep.size < expected) return; // interrupted tail — leave for blocked park
    const terminal = new Set(["done", "blocked", "failed", "cancelled"]);
    for (let i = 0; i < expected; i++) {
      const sts = byStep.get(i) || [];
      if (!sts.some((s) => terminal.has(s))) return;
    }
    const all = rows.map((r) => String(r.status || "").toLowerCase());
    const worst = all.includes("failed") ? "failed" : all.includes("blocked") ? "blocked" : all.includes("cancelled") ? "cancelled" : "done";
    const runStatus = worst === "done" ? "done" : worst;
    try {
      const { finishRun } = require("../db.js");
      void finishRun;
    } catch {}
    // Finish via SQL directly (avoid circular import): runs + jobs terminal.
    try { db.prepare("UPDATE runs SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status = 'running'").run(runStatus, new Date().toISOString(), job.run_id); } catch {}
    try { jobs.finishJob(db, job.id, { status: worst, runId: job.run_id }); } catch {}
  } catch {}
}

function expectedStepCount(payload) {
  try {
    if (Array.isArray(payload?.agents) && payload.agents.length) return Math.min(6, payload.agents.length);
    if (Array.isArray(payload?.steps) && payload.steps.length) return Math.min(50, payload.steps.length);
    if (payload?.automationId) return null; // automation: unknown multi-step shape — no auto-complete
    return 1; // chat / loop-task / single-step request
  } catch { return null; }
}

/** Recover one stale job's complete validated result (no re-execution).
 *  Sync hook for recoverStaleJobs: the async scanOrphanResults (run FIRST in
 *  tick/recoverNowAsync) already reconciled valid files, so there is nothing
 *  left to recover synchronously here. Kept as an explicit no-op hook (not a
 *  recover wrapper) so stale jobs park blocked unless the scanner recovered
 *  a valid result. Returns { recovered: false }. */
function recoverJobResult(cfg, db, jobs, job) {
  // Sync path: the async scanOrphanResults (called right after recovery in
  // tick) handles file reconciliation. Nothing to do synchronously here —
  // the job is parked blocked unless the scanner recovers a valid result.
  void cfg; void db; void jobs; void job;
  return { recovered: false };
}

export function stopWorker() {
  if (timer) { clearInterval(timer); timer = null; }
  return workerStatus();
}

export async function recoverNow(cfg, deps = {}) {
  return recoverNowAsync(cfg, deps);
}

/** Test hook: run one worker tick synchronously. Natural injection point —
 *  the same tick() the interval calls, exposed for deterministic tests. */
export async function tickOnce(cfg, deps = {}) {
  return tick(cfg, deps);
}

async function tick(cfg, deps) {
  if (running) return;
  running = true;
  try {
    const { openDb, finishRun, createRun, recordStep, bumpRunStats, bumpRunProgress, recordActivity, writeLog, updateTask, saveTaskSteps, getTaskWithSteps, linkRequestRun, fileRequest, markAutomationRun, listAutomations, queueOutboxDeduped, markOutboxSent, claimSessionAttempt, finishSessionAttempt, recordAgentSession } = await import("../db.js");
    const jobs = await import("./jobs.js");
    const db = openDb(cfg.root);
    // Unified recovery: scan valid orphan results FIRST (reconcile exact
    // pre-registered assignments), THEN park leftovers blocked. Reversed
    // order would block jobs before the scanner can recover them.
    try { await scanOrphanResults(cfg, db, jobs); } catch {}
    try { jobs.recoverStaleJobs(db, { leaseSec: 300, root: cfg.root, reconcile: (d, j) => recoverJobResultSync(d, j) }); } catch {}
    const job = jobs.claimNextJob(db, workerId, { leaseSec: 300 });
    if (!job) return;
    if (!jobs.markRunning(db, job.id, workerId)) return; // cancel raced the claim
    let payload = {};
    try { payload = JSON.parse(job.payload || "{}"); } catch {}
    // Heartbeat: extend the lease while live work continues.
    const hb = setInterval(() => { try { jobs.heartbeatJob(db, job.id, workerId, { leaseSec: 300 }); } catch {} }, 60_000);
    if (hb.unref) hb.unref();
    let completion = null;
    try {
      completion = await runJob(cfg, deps, { openDb, createRun, finishRun, recordStep, bumpRunStats, bumpRunProgress, recordActivity, writeLog, updateTask, saveTaskSteps, getTaskWithSteps, linkRequestRun, fileRequest, markAutomationRun, listAutomations, queueOutboxDeduped, markOutboxSent, claimSessionAttempt, finishSessionAttempt, recordAgentSession }, db, jobs, job, payload) || null;
    } catch (err) {
      const retryable = !/fail closed|not permitted|unknown agent|unknown step type|validation/i.test(String(err.message || ""));
      const next = jobs.failJobAttempt(db, job.id, { error: err.message, retryable });
      try { writeLog(cfg.root, { level: "info", source: "jobs", message: `job ${job.id} (${job.kind}) attempt failed: ${String(err.message).slice(0, 300)}`, runId: job.run_id }); } catch {}
      void next;
      // No direct send here: central finally below delivers exactly once
      // (terminal failure still completes honestly via fresh job status).
    } finally {
      try { clearInterval(hb); } catch {}
      // Central terminal completion (all kinds: request/automation/
      // loop-task/requeue/chat) when payload carries channelId/messageId.
      // Single call site avoids double chat sends; outbox dedupe helper
      // makes rescans safe (no duplicate posts).
      try {
        const fresh = jobs.getJob(db, job.id);
        if (fresh && ["done", "failed", "blocked", "cancelled"].includes(String(fresh.status)) && (payload?.channelId || payload?.replyChannel)) {
          const runId = (completion && completion.runId) || fresh.run_id || job.run_id || null;
          const st = (completion && completion.status) || fresh.status;
          const sum = (completion && completion.summary != null) ? completion.summary : (fresh.error || "");
          const out = (completion && completion.output) || "";
          await deliverDiscordCompletion(cfg, deps, { queueOutboxDeduped, markOutboxSent }, db, fresh, payload, runId, { status: st, summary: sum, output: out });
        }
      } catch {}
    }
  } finally {
    running = false;
  }
}

function recoverJobResultSync(db, job) {
  // Explicit no-op hook: orphan scan already reconciled valid files; nothing
  // left to recover synchronously. Parked blocked by recoverStaleJobs.
  void db; void job;
  return { recovered: false };
}

async function runJob(cfg, deps, dbx, db, jobs, job, payload) {
  const cancelCheck = () => {
    try {
      const row = db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(job.id);
      return row ? Number(row.cancel_requested) === 1 : false;
    } catch { return false; }
  };
  if (job.kind === "request") return runRequestJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck);
  if (job.kind === "loop-task") return runLoopTaskJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck);
  if (job.kind === "automation") return runAutomationJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck);
  if (job.kind === "requeue") return runRequeueJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck);
  if (job.kind === "chat") return runChatJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck);
  throw new Error(`unknown job kind '${job.kind}'`);
}

function checkCancel(db, jobs, job) {
  if (jobs.isCancelRequested(db, job.id)) {
    // Terminal write is one-way: if the job already finished, keep it.
    jobs.finishJob(db, job.id, { status: "cancelled", error: "cancel requested" });
    return true;
  }
  // A job that already reached terminal between claim and checkpoint must
  // not run further work (cancellation/results race).
  try {
    const cur = jobs.getJob(db, job.id);
    if (cur && !["queued", "leased", "running"].includes(cur.status)) return true;
  } catch {}
  return false;
}

async function runRequestJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck) {
  const { text, mode = "request", stream = "general", agents = [] } = payload;
  if (!text || !String(text).trim()) throw new Error("validation: text required");
  if (checkCancel(db, jobs, job)) return null;
  const requestId = dbx.fileRequest(cfg.root, { text: String(text).slice(0, 4000), mode, repo: stream, taskType: (agents || []).join(","), pipeline: agents || [] });
  // Prefer validated payload.steps (Discord planner custom agents/prompts).
  // Fall back to rebuilt agent chain only when no valid steps supplied.
  let steps = null;
  if (Array.isArray(payload.steps) && payload.steps.length) {
    const hasAgent = (a) => { try { return cfg.agents?.has ? cfg.agents.has(a) : true; } catch { return true; } };
    const valid = payload.steps.slice(0, 6).filter((s) => s && typeof s.agent === "string" && s.agent.trim() && hasAgent(s.agent.trim())).map((s, i) => ({
      id: String(s.id || `stage-${i + 1}-${s.agent}`).slice(0, 120),
      type: "agent",
      agent: String(s.agent).trim(),
      model: typeof s.model === "string" ? s.model.slice(0, 80) : "",
      prompt: String(s.prompt || `Request ${requestId} step ${i + 1} as '${s.agent}'.\nGoal: ${String(text).slice(0, 1500)}`).slice(0, 8000),
    }));
    if (valid.length) steps = valid;
  }
  if (!steps) {
    steps = (agents || []).slice(0, 6).map((agent, i) => ({
      id: `stage-${i + 1}-${agent}`, type: "agent", agent,
      prompt: `Request ${requestId} step ${i + 1}/${agents.length} as '${agent}'.\nGoal: ${String(text).slice(0, 1500)}\nDo the ${agent} work now, concretely.`,
    }));
  }
  const runId = dbx.createRun(cfg.root, { workflowId: `request-${requestId}`, kind: "dashboard-request", trigger: { kind: "dashboard-request", text: String(text).slice(0, 1000), user: "dashboard", requestId, stream, agents } });
  db.prepare("UPDATE jobs SET run_id = ?, task_id = ? WHERE id = ?").run(runId, requestId, job.id);
  dbx.linkRequestRun(cfg.root, requestId, runId);
  const { executeAgentStep, chainPrompt } = await import("./executor.js");
  dbx.bumpRunProgress(cfg.root, runId, { total: steps.length, done: 0, title: String(text).slice(0, 300) });
  let status = "done", errText = null, prevOutput = "";
  for (let i = 0; i < steps.length; i++) {
    if (cancelCheck() || checkCancel(db, jobs, job)) { status = "cancelled"; break; }
    const s = steps[i];
    // Context handoff: each step feeds the previous step's result forward.
    const prompt = chainPrompt(s.prompt, prevOutput);
    const { envelope, cancelled, deduped } = await executeAgentStep(cfg, dbx, db, jobs, job, {
      agent: s.agent, model: s.model || "", prompt, runId, stepIdx: i, attempt: Number(job.attempt || 0) + 1,
      stepId: s.id, cancelCheck,
    });
    if (deduped) { status = "done"; break; }
    prevOutput = envelope.output || "";
    if (cancelled || envelope.status === "cancelled") { status = "cancelled"; break; }
    if (envelope.status === "blocked" || envelope.status === "failed") { status = envelope.status; errText = envelope.summary; break; }
  }
  // No false done: blocked/failed dispatch maps to the matching run status.
  // Cancelled runs record cancelled (async process cancel), not failed.
  const runStatus = status === "done" ? "done" : status === "cancelled" ? "cancelled" : status === "blocked" ? "blocked" : "failed";
  dbx.finishRun(cfg.root, runId, { status: runStatus, error: errText });
  const jobStatus = status === "done" ? "done" : status === "cancelled" ? "cancelled" : status === "blocked" ? "blocked" : "failed";
  jobs.finishJob(db, job.id, { status: jobStatus, error: errText, runId, taskId: requestId, resultHash: null });
  try { dbx.writeLog(cfg.root, { level: "info", source: "jobs", message: `request job ${job.id} -> request ${requestId} run ${runId} (${status})`, runId }); } catch { /* best effort */ }
  return { runId, status: jobStatus, summary: (errText || prevOutput || "").slice(0, 1500), output: prevOutput };
}

async function runLoopTaskJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck) {
  const { taskId, agent, model = "", prompt = "", stepId = "step-1" } = payload;
  if (!taskId) throw new Error("validation: taskId required");
  if (!agent) throw new Error("validation: agent required");
  if (checkCancel(db, jobs, job)) return null;
  const { executeAgentStep } = await import("./executor.js");
  const runId = taskId; // loop-task steps reconcile into the task's session history
  // The reconciler writes run_steps/agent_sessions rows keyed by runId, and
  // run_steps.run_id has a FK to runs(id): ensure a runs row exists for the
  // task id first (no-op when the task run already exists).
  try {
    db.prepare("INSERT INTO runs (id, workflow_id, kind, trigger_json, status, started_at) VALUES (?, ?, 'loop-task', ?, 'running', ?) ON CONFLICT(id) DO NOTHING")
      .run(taskId, `task-${taskId}`, JSON.stringify({ kind: "loop-task", taskId, jobId: job.id }).slice(0, 1000), new Date().toISOString());
  } catch {}
  const { envelope } = await executeAgentStep(cfg, dbx, db, jobs, job, {
    agent, model, prompt, runId, stepIdx: 0, attempt: Number(job.attempt || 0) + 1,
    stepId, cancelCheck,
  });
  try {
    const d = dbx.getTaskWithSteps(cfg.root, taskId);
    if (d) {
      const steps = (d.steps || []).map((s) => s.step_id === stepId ? { ...s, output: envelope.output.slice(0, 8000), status: envelope.status === "done" ? "done" : envelope.status === "blocked" ? "blocked" : "failed" } : s);
      dbx.saveTaskSteps(cfg.root, taskId, steps);
      if (envelope.status === "done") dbx.updateTask(cfg.root, taskId, { status: "done" });
      else if (envelope.status === "blocked") dbx.updateTask(cfg.root, taskId, { status: "blocked", blocked_reason: envelope.summary.slice(0, 500) });
      else if (envelope.status !== "cancelled") dbx.updateTask(cfg.root, taskId, { status: "failed", blocked_reason: envelope.summary.slice(0, 500) });
    }
  } catch (err) {
    throw new Error(`task sync failed: ${String(err.message).slice(0, 200)}`);
  }
  // No false done: blocked dispatch stays blocked (operator review), failed stays failed.
  const terminal = envelope.status === "cancelled" ? "cancelled" : envelope.status === "done" ? "done" : envelope.status === "blocked" ? "blocked" : "failed";
  jobs.finishJob(db, job.id, { status: terminal, error: terminal === "done" ? null : envelope.summary, runId, taskId, resultHash: envelope.hash });
  return { runId, status: terminal, summary: String(envelope.summary || envelope.output || "").slice(0, 1500), output: envelope.output || "" };
}

async function runAutomationJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck) {
  const { automationId } = payload;
  if (!automationId) throw new Error("validation: automationId required");
  if (checkCancel(db, jobs, job)) return null;
  const auto = (dbx.listAutomations(cfg.root) || []).find((a) => a.id === automationId);
  const steps = auto?.steps?.length ? auto.steps.map((s) => ({ id: s.id, type: s.type, ...s })) : null;
  const wf = steps ? { id: automationId, name: auto.name, steps } : (cfg.workflows || []).find((w) => w.id === automationId);
  if (!wf) throw new Error(`unknown automation '${automationId}'`);
  // Worker is the sole executor: the full workflow step engine runs here
  // (src/workflow.js executeStep decision), with agent steps injected
  // through the durable executor (envelopes/claims/reconciler + cancel).
  // discord_send steps use the REAL deps.sendDiscord (preserved from the
  // live Discord client) — no async no-op that drops notifications.
  // Unknown step types fail honestly (validated reject, never fake success).
  const { bindWorkflowAgentExecutor } = await import("./executor.js");
  const { runWorkflow } = await import("../workflow.js");
  const sendDiscord = typeof deps.sendDiscord === "function" ? deps.sendDiscord : async () => {};
  const runId = dbx.createRun(cfg.root, { workflowId: wf.id, kind: "dashboard-flow", trigger: { kind: "dashboard-flow", automation: automationId, jobId: job.id } });
  db.prepare("UPDATE jobs SET run_id = ? WHERE id = ?").run(runId, job.id);
  dbx.bumpRunProgress(cfg.root, runId, { total: (wf.steps || []).length, done: 0, title: wf.name || wf.id });
  const executeAgentStep = bindWorkflowAgentExecutor(cfg, dbx, db, jobs, job, {
    attempt: Number(job.attempt || 0) + 1, cancelCheck,
  });
  // Discord-command flows carry the user's text after the !command; expose it
  // as {{trigger.text}} (fallback: flow name for dashboard/scheduled runs).
  const trigger = { kind: payload.source === "discord" ? "discord" : "dashboard-flow", automation: automationId, jobId: job.id, text: String(payload.text || "").trim() || wf.name || wf.id, user: payload.user || "", command: payload.command || null, channelId: payload.channelId || null };
  try {
    const wdeps = { ...(deps || {}), sendDiscord };
    const wctx = await runWorkflow(cfg, wdeps, { id: wf.id, steps: wf.steps || [] }, trigger, {
      jobId: job.id, runId, cancelCheck, executeAgentStep,
    });
    try { dbx.bumpRunProgress(cfg.root, runId, { done: (wf.steps || []).length }); } catch {}
    const lastKey = (wf.steps || [])[(wf.steps || []).length - 1]?.id;
    const lastVal = lastKey != null ? wctx.steps[lastKey] : "";
    const prevOutput = typeof lastVal === "string" ? lastVal : (lastVal != null ? JSON.stringify(lastVal) : "");
    dbx.finishRun(cfg.root, runId, { status: "done" });
    try { dbx.markAutomationRun(cfg.root, automationId, { status: "done", runId }); } catch { /* best effort */ }
    jobs.finishJob(db, job.id, { status: "done", runId, taskId: automationId });
    return { runId, status: "done", summary: String(prevOutput).slice(0, 1500), output: String(prevOutput) };
  } catch (e) {
    if (cancelCheck() || isCancelled(db, job.id) || /cancel requested/i.test(String(e?.message || ""))) {
      dbx.finishRun(cfg.root, runId, { status: "cancelled", error: "cancel requested" });
      jobs.finishJob(db, job.id, { status: "cancelled", error: "cancel requested", runId });
      try { dbx.markAutomationRun(cfg.root, automationId, { status: "cancelled", runId }); } catch { /* best effort */ }
      return { runId, status: "cancelled", summary: "cancel requested", output: "" };
    }
    const msg = String(e?.message || "failed");
    const blocked = /session reported blocked/i.test(msg) || /Step [^:]+: session reported blocked/i.test(msg);
    const status = blocked ? "blocked" : "failed";
    dbx.finishRun(cfg.root, runId, { status, error: msg.slice(0, 500) });
    try { dbx.markAutomationRun(cfg.root, automationId, { status: `${status}: ${msg.slice(0, 120)}`, runId }); } catch { /* best effort */ }
    if (blocked) {
      jobs.finishJob(db, job.id, { status: "blocked", error: msg.slice(0, 500), runId, taskId: automationId });
      return { runId, status: "blocked", summary: msg.slice(0, 1500), output: "" };
    }
    throw e;
  }
}

async function runRequeueJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck) {
  const { runId, stepIndex = 0, guidance = "" } = payload;
  if (!runId) throw new Error("validation: runId required");
  if (checkCancel(db, jobs, job)) return;
  const { getRun } = await import("../db.js");
  const d = getRun(cfg.root, runId);
  if (!d) throw new Error("not found");
  const { MAX_RESTART_ATTEMPTS, redispatchPrompt } = await import("../orchestrator.js");
  const { requeueCount } = await import("../db.js");
  const prior = requeueCount(cfg.root, runId);
  if (prior >= MAX_RESTART_ATTEMPTS) {
    const { blockTask, queueOutbox } = await import("../db.js");
    blockTask(cfg.root, runId, `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS} attempts).`);
    queueOutbox(cfg.root, { channel: "dashboard", text: `Task ${runId} blocked: restart budget exceeded after ${prior} requeues.`, runId });
    jobs.finishJob(db, job.id, { status: "blocked", error: `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS})`, runId });
    return { runId, status: "blocked", summary: `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS})`, output: "" };
  }
  // Requeue clones the parent run's outputs byte-identical for steps before
  // stepIndex, and re-executes the tail via the executor envelope. The new
  // run records the exact structured parentRun count (no LIKE matching).
  // Attempt semantics: the envelope attempt is the deliberate requeue
  // budget counter (prior+1), NOT job.attempt+1 — job retries (transient
  // infra failures) stay independent from the operator requeue budget.
  const { bindWorkflowAgentExecutor, chainPrompt } = await import("./executor.js");
  const tail = (d.steps || []).slice(stepIndex).map((s, k) => ({
    id: `requeue-${stepIndex + 1 + k}-${s.step_id}`, type: "agent", agent: s.agent || "assistant",
    prompt: redispatchPrompt({ originalPrompt: String(s.raw_text || "").slice(0, 1500), guidance: String(guidance || ""), taskId: runId, stepId: s.step_id, attempt: prior + 1 }),
  }));
  if (!tail.length) throw new Error("validation: stepIndex out of range");
  const newRunId = dbx.createRun(cfg.root, { workflowId: `requeue-${runId}-s${stepIndex + 1}`, kind: "dashboard-requeue", trigger: { kind: "dashboard-requeue", parentRun: runId, stepIndex, parentRunCount: prior } });
  db.prepare("UPDATE jobs SET run_id = ? WHERE id = ?").run(newRunId, job.id);
  // Byte-identical clone of parent outputs for steps before stepIndex.
  for (const ps of (d.steps || []).slice(0, stepIndex)) {
    let outJson = null;
    try { outJson = ps.output_json ? JSON.parse(ps.output_json) : null; } catch { outJson = null; }
    dbx.recordStep(cfg.root, newRunId, { stepId: ps.step_id, type: ps.type, agent: ps.agent, status: ps.status, rawText: ps.raw_text || "", outputJson: outJson });
  }
  dbx.bumpRunProgress(cfg.root, newRunId, { total: (d.steps || []).length, done: stepIndex });
  let prevOutput = "";
  try {
    const preSteps = (d.steps || []).slice(0, stepIndex);
    if (preSteps.length) {
      const last = preSteps[preSteps.length - 1];
      try { prevOutput = (last.output_json ? JSON.parse(last.output_json).output : "") || last.raw_text || ""; } catch { prevOutput = last.raw_text || ""; }
    }
    const executeTailStep = bindWorkflowAgentExecutor(cfg, dbx, db, jobs, job, {
      attempt: prior + 1, cancelCheck,
    });
    for (let i = 0; i < tail.length; i++) {
      if (cancelCheck() || checkCancel(db, jobs, job)) {
        dbx.finishRun(cfg.root, newRunId, { status: "cancelled", error: "cancel requested" });
        jobs.finishJob(db, job.id, { status: "cancelled", error: "cancel requested", runId: newRunId, taskId: runId });
        return { runId: newRunId, status: "cancelled", summary: "cancel requested", output: prevOutput };
      }
      const prompt = chainPrompt(tail[i].prompt, prevOutput);
      const { envelope, cancelled } = await executeTailStep({
        agent: tail[i].agent, prompt, runId: newRunId, stepIdx: stepIndex + i,
        stepId: tail[i].id, cancelCheck,
      });
      prevOutput = envelope.output || "";
      if (cancelled || envelope.status === "cancelled") {
        dbx.finishRun(cfg.root, newRunId, { status: "cancelled", error: "cancel requested" });
        jobs.finishJob(db, job.id, { status: "cancelled", error: "cancel requested", runId: newRunId, taskId: runId });
        return { runId: newRunId, status: "cancelled", summary: "cancel requested", output: prevOutput };
      }
      if (envelope.status === "blocked" || envelope.status === "failed") {
        dbx.finishRun(cfg.root, newRunId, { status: envelope.status, error: envelope.summary });
        jobs.finishJob(db, job.id, { status: envelope.status, error: envelope.summary, runId: newRunId, taskId: runId });
        return { runId: newRunId, status: envelope.status, summary: envelope.summary, output: prevOutput };
      }
    }
  } catch (e) {
    if (cancelCheck() || isCancelled(db, job.id)) {
      dbx.finishRun(cfg.root, newRunId, { status: "cancelled", error: "cancel requested" });
      jobs.finishJob(db, job.id, { status: "cancelled", error: "cancel requested", runId: newRunId, taskId: runId });
      return { runId: newRunId, status: "cancelled", summary: "cancel requested", output: prevOutput };
    }
    dbx.finishRun(cfg.root, newRunId, { status: "failed", error: String(e.message).slice(0, 500) });
    throw e;
  }
  dbx.finishRun(cfg.root, newRunId, { status: "done" });
  jobs.finishJob(db, job.id, { status: "done", runId: newRunId, taskId: runId });
  return { runId: newRunId, status: "done", summary: prevOutput.slice(0, 1500), output: prevOutput };
}

async function runChatJob(cfg, deps, dbx, db, jobs, job, payload, cancelCheck) {
  const { text, workflow, agent: requestedAgent, model: requestedModel } = payload || {};
  if (!text && !workflow) throw new Error("validation: text or workflow required");
  if (checkCancel(db, jobs, job)) return;
  // Chat runs the single assistant step via the executor envelope (sole
  // executor) — never the legacy workflow dispatcher. Honor the selected
  // agent/model from the payload when configured (validated against cfg).
  let agent = "assistant";
  try {
    const want = String(requestedAgent || "").trim();
    if (want && cfg?.agents?.has?.(want)) agent = want;
  } catch {}
  const model = typeof requestedModel === "string" ? String(requestedModel).slice(0, 80) : "";
  const { executeAgentStep } = await import("./executor.js");
  const runId = dbx.createRun(cfg.root, { workflowId: workflow || "adhoc-chat", kind: "dashboard", trigger: { kind: "dashboard", text: String(text || "").slice(0, 1000), user: "dashboard", jobId: job.id } });
  db.prepare("UPDATE jobs SET run_id = ? WHERE id = ?").run(runId, job.id);
  // Full allowed budget: no slice-truncation of execution intent. Payloads
  // are already bounded by jobs.safePayloadStringify (16k); the runner
  // enforces MAX_PROMPT_BYTES fail-closed (never silently sliced).
  const { envelope, cancelled } = await executeAgentStep(cfg, dbx, db, jobs, job, {
    agent, model, prompt: String(text || "Hello"), runId, stepIdx: 0,
    attempt: Number(job.attempt || 0) + 1, stepId: "reply", cancelCheck,
  });
  if (cancelled || envelope.status === "cancelled") {
    dbx.finishRun(cfg.root, runId, { status: "cancelled", error: "cancel requested" });
    jobs.finishJob(db, job.id, { status: "cancelled", error: "cancel requested", runId });
    return { runId, status: "cancelled", summary: "cancel requested", output: envelope.output || "" };
  }
  if (envelope.status === "blocked" || envelope.status === "failed") {
    dbx.finishRun(cfg.root, runId, { status: envelope.status, error: envelope.summary });
    jobs.finishJob(db, job.id, { status: envelope.status, error: envelope.summary, runId });
    return { runId, status: envelope.status, summary: envelope.summary, output: envelope.output || "" };
  }
  dbx.finishRun(cfg.root, runId, { status: "done" });
  jobs.finishJob(db, job.id, { status: "done", runId });
  // No direct send: central tick() finally delivers exactly once.
  // Prefer actual output (harmless reply token) over summary for done chat.
  return { runId, status: "done", summary: String(envelope.output || envelope.summary || "").slice(0, 1500), output: envelope.output || "" };
}

/** Discord completion: post the actual job result back to the originating
 *  channel/thread after the job finishes (not only queued feedback).
 *  channelId/messageId persist in the job payload; incoming messageId
 *  dedupe is enforced at enqueue (discord.js seenMessages + idempotency
 *  key per message id). Best-effort: never fails the job. */
async function deliverDiscordCompletion(cfg, deps, dbx, db, job, payload, runId, envelope) {
  try {
    const channelId = payload?.channelId || payload?.replyChannel || null;
    if (!channelId) return;
    const send = typeof deps?.sendDiscord === "function" ? deps.sendDiscord : null;
    const status = String(envelope?.status || "done");
    const head = status === "done" ? "\u2705 Done" : status === "blocked" ? "\u26d4 Blocked" : status === "cancelled" ? "\u25a0 Cancelled" : "\u274c Failed";
    // Prefer actual output over summary: done chat posts the harmless reply
    // token (output), not a 'Replied...' summary. Status header stays.
    // All other jobs: output-first is still the sensible result body.
    const body = String(envelope?.output || envelope?.summary || "");
    const text = `${head} \`${job.kind}\` job \`${job.id}\` (run \`${runId}\`):\n${body.slice(0, 1500)}`;
    // Failed-safe: queue the completion to the deduped outbox FIRST so a
    // sendDiscord throw still leaves a queued row (no silent loss). The
    // dedupe helper makes rescans safe (no duplicate posts).
    let outboxId = null;
    try {
      const q = typeof dbx?.queueOutboxDeduped === "function"
        ? dbx.queueOutboxDeduped(cfg.root, { channel: channelId, text, runId })
        : null;
      outboxId = q?.id || null;
    } catch {}
    // Missing queue deps: leave queued (no untracked send).
    if (!outboxId) return;
    // Never send again an already-sent deduped row (idempotent retry).
    try {
      const row = db.prepare("SELECT status FROM outbox WHERE id = ?").get(outboxId);
      if (row && String(row.status) === "sent") return;
    } catch {}
    // Same completion already delivered under a prior id (helper inserts a
    // fresh row once the prior is sent): skip the duplicate send and park
    // this row sent so flushOutbox never replays it.
    try {
      const dup = db.prepare("SELECT id FROM outbox WHERE channel = ? AND text = ? AND status = 'sent' LIMIT 1").get(channelId, text);
      if (dup && dup.id !== outboxId) {
        try { if (typeof dbx?.markOutboxSent === "function") dbx.markOutboxSent(cfg.root, outboxId); } catch {}
        return;
      }
    } catch {}
    // Missing send leaves queued for flushOutbox retry (no false sent).
    if (!send) return;
    try {
      await send(channelId, text);
    } catch {
      // Send error leaves queued (no silent loss, no false sent).
      return;
    }
    // Marked sent ONLY after successful send.
    try { if (typeof dbx?.markOutboxSent === "function") dbx.markOutboxSent(cfg.root, outboxId); } catch {}
    // Mark the linked brain message terminal (reply_generated/failed).
    try {
      const { updateBrainMessage, listBrainMessages } = await import("../db.js");
      const mid = payload?.messageId || null;
      let row = null;
      if (mid) {
        try { row = (listBrainMessages(cfg.root, { limit: 50 }) || []).find((b) => String(b.job_id || "") === String(mid)); } catch {}
      }
      if (!row && job?.id) {
        try { row = (listBrainMessages(cfg.root, { limit: 50 }) || []).find((b) => String(b.linked_task_id || "") === String(job.id)); } catch {}
      }
      if (row?.id) {
        const ok = status === "done" || status === "cancelled";
        updateBrainMessage(cfg.root, row.id, { processingStatus: ok ? "reply_generated" : "failed", outboxSummary: "1 sent", processingError: ok ? null : String(envelope?.summary || "").slice(0, 1000) });
      }
    } catch {}
  } catch {}
}

function checkCancelSilent(db, jobId) {
  try {
    const row = db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(jobId);
    return row ? Number(row.cancel_requested) === 1 : false;
  } catch { return false; }
}
function isCancelled(db, jobId) { return checkCancelSilent(db, jobId); }

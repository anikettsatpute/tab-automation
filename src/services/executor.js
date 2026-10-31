// Worker step executor: the SOLE path that runs agent steps.
// All sources (Discord, schedule, HTTP) durably enqueue; only this executor
// spawns Muse via runAgentStep and reconciles via the unified reconciler.
// Context handoff: each step's prompt carries the previous step's output.
import { validateEnvelope } from "./envelope.js";
import { runAgentStep } from "./runner.js";

/** Execute one agent step with context handoff + unified reconcile.
 *  Returns { envelope, cancelled, deduped }. Throws on invalid envelope or
 *  failed file/prompt writes (runner already fails those as envelopes). */
export async function executeAgentStep(cfg, dbx, db, jobs, job, {
  agent, prompt, extraContext = "", runId, stepIdx, attempt = null, stepId = "",
  cancelCheck = null, jsonContract = true, model = "",
} = {}) {
  if (!agent) throw new Error("validation: agent required");
  if (!runId) throw new Error("validation: runId required");
  // Default attempt keeps the reconciler's job.attempt+1 contract when the
  // caller does not pin an explicit envelope attempt (e.g. requeue budget).
  if (!Number.isFinite(Number(attempt))) attempt = Math.max(1, Number(job?.attempt || 0) + 1);
  const { envelope, cancelled, gateError, writeError, deduped } = await runAgentStep(cfg, {
    agent, model, prompt, extraContext, runId, stepIdx, attempt,
    jobId: job.id, cancelCheck, jsonContract,
  });
  if (gateError && !envelope) throw new Error(gateError);
  if (writeError) throw new Error(writeError);
  const v = validateEnvelope(envelope);
  if (!v.ok) throw new Error(`envelope invalid: ${v.error}`);
  // Unified reconciler: validates exact assignment (job/current attempt/
  // current session/cancel/terminal) and records steps+session markers
  // together. Pre-claimed in runner; this finalizes with the result hash.
  // Config-selected model + prior output handoff: the reconciler checks the
  // envelope model against the pre-claimed model (tamper => reject).
  const rec = jobs.reconcileAttempt
    ? jobs.reconcileAttempt(db, {
        jobId: job.id, runId, stepIndex: stepIdx, attempt,
        agent, model: envelope.model, sessionId: envelope.sessionId,
        cliSessionId: envelope.cliSessionId || "",
        resultPath: envelope.resultPath, resultHash: envelope.hash,
        status: envelope.status, output: envelope.output,
        summary: envelope.summary, tokens: envelope.tokens,
      })
    : null;
  if (rec && !rec.ok && !rec.cancelled && !rec.deduped) throw new Error(rec.error || "reconcile failed");
  if (rec?.cancelled || cancelled || envelope.status === "cancelled") {
    return { envelope, cancelled: true, deduped: false };
  }
  if (rec?.deduped || deduped) return { envelope, cancelled: false, deduped: true };
  try {
    dbx.bumpRunProgress(cfg.root, runId, { done: Number(stepIdx) + 1 });
  } catch { /* best effort */ }
  void stepId;
  return { envelope, cancelled: false, deduped: false };
}

/** Build chained prompts: step i carries step i-1's output as context.
 *  Fixes the handoff gap where request steps never fed the previous result
 *  into the next step. */
export function chainPrompt(basePrompt, prevOutput) {
  if (!prevOutput) return basePrompt;
  return `${basePrompt}\n\nPrevious step result (use as input context):\n${String(prevOutput).slice(0, 3000)}`;
}

/** Bind a workflow-compatible agent executor that preserves durable
 *  envelopes/claims and cancellation context.
 *  The workflow step engine (src/workflow.js) calls this for `agent` steps
 *  when `ctx._agentExecutor` is set (worker path) instead of dispatching
 *  directly — no direct model bypass. Returns the same
 *  `{ envelope, cancelled, deduped }` contract as executeAgentStep.
 *  `attempt` is the envelope attempt (defaults to job.attempt+1); requeue
 *  budget (prior count) stays independent for prompt labeling/budget. */
export function bindWorkflowAgentExecutor(cfg, dbx, db, jobs, job, { attempt = null, cancelCheck = null } = {}) {
  const envAttempt = Number.isFinite(Number(attempt))
    ? Math.max(1, Math.trunc(Number(attempt)))
    : Math.max(1, Number(job?.attempt || 0) + 1);
  const outerCancel = typeof cancelCheck === "function" ? cancelCheck : null;
  return (args = {}) => executeAgentStep(cfg, dbx, db, jobs, job, {
    agent: args.agent,
    model: args.model || "",
    prompt: args.prompt || "",
    extraContext: args.extraContext || "",
    runId: args.runId,
    stepIdx: args.stepIdx ?? 0,
    attempt: envAttempt,
    stepId: args.stepId || "",
    cancelCheck: typeof args.cancelCheck === "function" ? args.cancelCheck : outerCancel,
    jsonContract: args.jsonContract !== false,
  });
}

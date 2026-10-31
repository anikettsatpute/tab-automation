/**
 * OrchestratorLoop state machine — ported from
 * orchestratorloop-prd-&-specification-system/src/lib/state-machine.ts
 * Reference: docs/PRD_ORCHESTRATOR_LOOP.md §4-5, IMPLEMENTATION_AND_TECH_STACK.md §2-3.
 * Pure logic, no deps. Used by headless-dashboard control APIs + task divider.
 */

/**
 * Loop orchestrator — OUR agents are the pipeline (not the spec's 15 copied types).
 * Agents come from config/agents.json. A Muse session is spawned per step/automation-step
 * as the agent dispatcher; it writes JSON; our loop code reconciles that JSON into the DB.
 * Pure logic, no deps. Used by headless-dashboard control APIs + divider.
 */

// Agent pipeline: every step dispatches one of OUR configured agents.
// Streams (config/streams.json) group agents; pipelines chain agent->agent per stream.
// The divider picks a stream + pipeline; the loop reconciles session JSON -> DB.
// NOTE: keep in sync with config/agents.json ids.
export const AGENT_PIPELINE = ["assistant", "summarizer", "coder", "finance-india", "finance-us", "scout", "analyst", "critic", "writer", "tester"];

/** Divider: pick a stream + agents from goal text. Streams come from config; heuristics map here. */
export function divideGoal(goalText, streamsDoc = null) {
  const t = String(goalText || "").toLowerCase();
  const streams = streamsDoc?.streams || [];
  const pipelines = streamsDoc?.pipelines || [];
  const finance = /nse|bse|india|nifty|sensex|nyse|nasdaq|us market|s&p|stock|market|brief/i.test(t);
  const streamId = finance ? "finance" : "general";
  // Prefer a user-configured pipeline for this stream (first match), else heuristic agents.
  const pipe = pipelines.find((p) => p.stream === streamId);
  if (pipe?.agents?.length) return { stream: streamId, agents: pipe.agents, pipeline: pipe.id };
  const hasStream = streams.some((s) => s.id === streamId);
  const agents = finance
    ? (/nyse|nasdaq|us market/i.test(t) ? ["finance-us"] : ["finance-india"])
    : /summar|brief|tldr|compress/i.test(t) ? ["summarizer"]
    : /review|diff|patch|code/i.test(t) ? ["coder"]
    : ["assistant"];
  return { stream: hasStream ? streamId : (streams[0]?.id || "general"), agents, pipeline: null };
}

/** Pipeline for a task = the agents assigned to it (stored on the task row). */
export function dividerPipeline(taskTypeOrAgents) {
  if (Array.isArray(taskTypeOrAgents)) return taskTypeOrAgents;
  if (taskTypeOrAgents && Array.isArray(taskTypeOrAgents.agents)) return taskTypeOrAgents.agents;
  if (typeof taskTypeOrAgents === "string" && AGENT_PIPELINE.includes(taskTypeOrAgents)) return [taskTypeOrAgents];
  return ["assistant"];
}

/** JSON contract: every Muse session MUST return this shape so the loop can reconcile. */
export const SESSION_JSON_CONTRACT = {
  status: "done|failed|blocked",
  summary: "one-line what happened",
  output: "main result text",
  next: "suggested next agent id or empty",
  updates: { progress: 0, tokens: 0 },
};

export function sessionPrompt({ agent, taskTitle = "", stepGoal = "", context = "" }) {
  return (
    "You are the '" + agent + "' step of a task loop. Goal: " + taskTitle + "\n" +
    (stepGoal ? "This step: " + stepGoal + "\n" : "") +
    (context ? "Context:\n" + String(context).slice(0, 3000) + "\n" : "") +
    "\nRespond with ONLY valid JSON, no other text, no code fences, exactly this shape:\n" +
    JSON.stringify(SESSION_JSON_CONTRACT, null, 1)
  );
}

/** Reconcile session JSON into DB updates. Returns { ok, patch } — caller writes via updateTask/saveTaskSteps.
 *  Tolerant: strips fences, takes the first complete {...} object (Muse CLI
 *  sometimes emits a second copy), maps "complete" -> done. */
export function reconcileSessionJson(raw) {
  let parsed;
  try {
    let clean = String(raw ?? "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\`\`\`\s*$/i, "").trim();
    // If multiple JSON objects concatenated, take the first complete one.
    if (clean.startsWith("{")) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = 0; i < clean.length; i++) {
        const ch = clean[i];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; }
        else { if (ch === '"') inStr = true; else if (ch === "{") depth++; else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } } }
      }
      if (end !== -1 && end < clean.length) clean = clean.slice(0, end);
    }
    parsed = JSON.parse(clean);
  } catch (err) {
    return { ok: false, error: "session JSON parse failed: " + err.message, patch: null };
  }
  let status = String(parsed.status || "").toLowerCase().trim();
  if (/complete|success/.test(status)) status = "done";
  // Unknown statuses are failures, never silent done (fail closed).
  if (!["done", "failed", "blocked"].includes(status)) status = "failed";
  const patch = {
    status,
    summary: String(parsed.summary || "").slice(0, 1000),
    output: String(parsed.output || parsed.summary || "").slice(0, 8000),
    next: String(parsed.next || ""),
    progress: Number(parsed?.updates?.progress) || 0,
    tokens: Number(parsed?.updates?.tokens) || 0,
  };
  if (status === "blocked") patch.blocked_reason = patch.summary;
  return { ok: true, error: null, patch };
}

export function requeueFromStep(task, stepIndex, userGuidance = "") {
  if (stepIndex < 0 || stepIndex >= (task.stages || task.steps || []).length) {
    throw new Error(`Invalid step index: ${stepIndex}`);
  }
  const stages = (task.stages || task.steps).map((s, idx) => {
    if (idx < stepIndex) return { ...s };
    if (idx === stepIndex) {
      return { ...s, status: "running", summary: userGuidance ? `Re-running with guidance: "${userGuidance}"` : s.summary };
    }
    return { ...s, status: "pending", completedAt: undefined };
  });
  return { updatedStages: stages, resetCount: stages.length - stepIndex };
}

export function interpolateVariables(template, context = {}) {
  return String(template ?? "").replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, path) => {
    const parts = path.split(".");
    let cur = context;
    for (const part of parts) {
      if (cur == null) return match;
      cur = cur[part];
    }
    return cur !== undefined && cur !== null ? String(cur) : match;
  });
}

export function canTransition(current, target) {
  const transitions = {
    queued: ["running", "blocked", "plan_review"],
    running: ["plan_review", "size_review", "your_review", "pr_review", "blocked", "done"],
    plan_review: ["running", "blocked"],
    size_review: ["running", "blocked"],
    your_review: ["running", "pr_review", "blocked", "done"],
    pr_review: ["running", "blocked", "done"],
    blocked: ["queued", "running", "pr_review"],
    done: ["queued", "running"],
    failed: ["running", "queued"],
  };
  return transitions[current]?.includes(target) ?? false;
}

export function calculateNextRunDescription(timeOfDay, days) {
  const isEveryDay = days.includes("Every day") || days.length === 7;
  if (isEveryDay) return `Every day at ${timeOfDay}`;
  return `${days.join(", ")} at ${timeOfDay}`;
}

// ---- dispatcher + worktree (reference: IMPLEMENTATION §3 Copilot CLI dispatcher) ----
// Pure helpers so headless-dashboard/workflow can share paths + redispatch prompts
// without spawning anything here. Actual agent execution stays in workflow.js
// (chatWithTools), which already streams tool calls into activity/logs.

export function worktreePath(root, taskId) {
  return `${root}/data/tasks/task-${taskId}`;
}

export function contextFilePath(root, taskId, stepIndex) {
  return `${root}/data/responses/${taskId}/context-${stepIndex + 1}.md`;
}

export function handoffPath(root, taskId) {
  return `${worktreePath(root, taskId)}/handoff.md`;
}

/** REDISPATCH prompt (reference: IMPLEMENTATION §3.2 redispatchStep). */
export function redispatchPrompt({ originalPrompt = "", guidance = "", taskId = "", stepId = "", attempt = 1 }) {
  return (
    `REDISPATCH: This is a new execution attempt in an existing session, not permission to finish the previous attempt by merely rewriting its response.\n\n` +
    (guidance ? `Operator Guidance:\n${guidance}\n\n` : "") +
    `Original Specification (task ${taskId}, step '${stepId}', attempt ${attempt}):\n${originalPrompt}`
  );
}

/** Restart budget (reference: PRD §6.3 max 6 attempts). */
export const MAX_RESTART_ATTEMPTS = 6;

export function budgetExceeded(attemptCount) {
  return Number(attemptCount || 0) >= MAX_RESTART_ATTEMPTS;
}

/** Stage role mapping (reference: TASK_TYPES_CONFIG pipeline -> agent role). */
export function stageRole(stageName) {
  const t = String(stageName || "").toLowerCase();
  if (/planner|plan|pm spec|scenario planner/.test(t)) return "planner";
  if (/coder|code/.test(t)) return "coder";
  if (/valid|review|flight/.test(t)) return "validator";
  if (/pr|hotfix|publish|ticket|report|synthes/.test(t)) return "open-pr";
  if (/investigat|triage|config/.test(t)) return "investigator";
  if (/design/.test(t)) return "designer";
  return "assistant";
}

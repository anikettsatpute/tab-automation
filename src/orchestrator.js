/**
 * OrchestratorLoop state machine — ported from
 * orchestratorloop-prd-&-specification-system/src/lib/state-machine.ts
 * Reference: docs/PRD_ORCHESTRATOR_LOOP.md §4-5, IMPLEMENTATION_AND_TECH_STACK.md §2-3.
 * Pure logic, no deps. Used by headless-dashboard control APIs + task divider.
 */

export const TASK_TYPES_CONFIG = {
  let_divider_choose: {
    label: "Let the divider choose",
    description: "Autonomous planner assesses the goal and assigns the optimal pipeline.",
    pipeline: ["Planner", "Coder", "Validator", "Open PR"],
  },
  coding: {
    label: "Coding",
    description: "Standard development flow from architectural plan to PR creation.",
    pipeline: ["Planner", "Coder", "Validator", "Open PR"],
  },
  pm_spec_design_coding: {
    label: "PM spec, design and coding",
    description: "Full stack product requirement writing, UI concept design, and implementation.",
    pipeline: ["PM Spec", "Designer", "Planner", "Coder", "Validator", "Open PR"],
  },
  design_and_coding: {
    label: "Design and coding",
    description: "UX wireframing, design tokens, and frontend code delivery.",
    pipeline: ["Designer", "Coder", "Validator", "Open PR"],
  },
  live_site_investigation: {
    label: "Live-site investigation",
    description: "Query telemetry, logs, tenant state diffs without mutating code.",
    pipeline: ["Investigator", "Synthesizer"],
  },
  live_site_triage: {
    label: "Live-site triage",
    description: "Assess blast radius, error volume, post summary to channel.",
    pipeline: ["Triage Agent", "Reporter"],
  },
  live_site_fix: {
    label: "Live-site fix",
    description: "Urgent hotfix pipeline with expedited validation.",
    pipeline: ["Root Cause Coder", "Flight Validator", "Hotfix PR"],
  },
  icm_triage: {
    label: "IcM triage",
    description: "Ingest active incident, check linked deployments, update ticket.",
    pipeline: ["IcM Investigator", "Ticket Updater"],
  },
  ecs_flight: {
    label: "ECS flight",
    description: "Create, bump, or rollback experiment flight rules.",
    pipeline: ["Flight Configurator", "Ring Validator"],
  },
  simple_coding: {
    label: "Simple coding",
    description: "Direct code modification without formal plan stage.",
    pipeline: ["Coder", "Open PR"],
  },
  simple_coding_with_testing: {
    label: "Simple coding with testing",
    description: "Direct code edits verified with unit/scenario tests before PR.",
    pipeline: ["Coder", "Validator", "Open PR"],
  },
  reviewed_coding: {
    label: "Reviewed coding",
    description: "Requires human sign-off at each step before next agent runs.",
    pipeline: ["Planner (Review)", "Coder (Review)", "Validator (Review)", "Open PR"],
  },
  planning_only: {
    label: "Planning only",
    description: "Generates technical plan, test scenarios, risk matrix without coding.",
    pipeline: ["Planner", "Reviewer"],
  },
  code_investigation: {
    label: "Code investigation",
    description: "Deep architectural trace to explain legacy behavior.",
    pipeline: ["Code Investigator", "Report Generator"],
  },
  coding_with_declarative_scenario_tests: {
    label: "Coding with declarative scenario tests",
    description: "Generates cucumber/gherkin cases, then implements until passing.",
    pipeline: ["Scenario Planner", "Coder", "Scenario Validator", "Open PR"],
  },
};

export function dividerPipeline(taskType) {
  return (TASK_TYPES_CONFIG[taskType] || TASK_TYPES_CONFIG.let_divider_choose).pipeline;
}

/** Heuristic divider: pick pipeline from goal text. Mirrors spec §4.5. */
export function divideGoal(goalText) {
  const t = String(goalText || "").toLowerCase();
  if (/live.?site.*investig|kusto|telemetry|log.*volume|mismatch|sdf.*prod/i.test(t)) return "live_site_investigation";
  if (/triage|blast radius|incident/i.test(t)) return "live_site_triage";
  if (/hotfix|urgent fix/i.test(t)) return "live_site_fix";
  if (/icm/i.test(t)) return "icm_triage";
  if (/flight|ecs/i.test(t)) return "ecs_flight";
  if (/pm.*spec|prd|design.*cod/i.test(t)) return "pm_spec_design_coding";
  if (/design/i.test(t) && /cod/i.test(t)) return "design_and_coding";
  if (/plan only|planning only|no cod/i.test(t)) return "planning_only";
  if (/investigat|trace|explain.*code|why does/i.test(t)) return "code_investigation";
  if (/scenario|gherkin|cucumber/i.test(t)) return "coding_with_declarative_scenario_tests";
  if (/simple/i.test(t) && /test/i.test(t)) return "simple_coding_with_testing";
  if (/simple|small|trivial|one-line/i.test(t)) return "simple_coding";
  if (/review.*each|human.*sign|reviewed/i.test(t)) return "reviewed_coding";
  return "coding";
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

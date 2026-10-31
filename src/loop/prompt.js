// Step prompt builder. Every step prompt carries: role system prompt, end goal, step goal,
// handoff.md location + contents, prior step summaries, requeue guidance, and the result-file contract.
import { readFileSync } from "node:fs";
import path from "node:path";
import { readHandoff } from "./workspace.js";

const MAX_HANDOFF_INLINE = 24000;

export function resultContract({ taskId, pos, attempt, role, resultPath }) {
  return `## Output contract (mandatory)
When you are finished, write ONE JSON file to exactly this path:
  ${resultPath}
Write it atomically (write "${path.basename(resultPath)}.tmp" then rename). Do not write it anywhere else.
Shape:
{
  "v": 1, "task_id": "${taskId}", "step": ${pos}, "attempt": ${attempt}, "role": "${role}",
  "status": "done" | "failed" | "blocked",
  "summary": "one line: what happened",
  "output": "markdown: the main result of this step",
  "handoff": "markdown: what the NEXT agent must know (decisions, files touched, open issues, how to verify)",
  "artifacts": [ { "kind": "diagram", "title": "...", "body": "mermaid source" } | { "kind": "file", "title": "...", "path": "relative/path" } | { "kind": "link", "title": "...", "body": "url" } ],
  "blocked_reason": "only when status is blocked: what a human must decide or provide",
  "spawn_tasks": [ { "title": "...", "end_goal": "...", "steps": [ { "role": "agent-id", "goal": "..." } ] } ],
  "metrics": { "tokens": 0, "tool_calls": 0 }
}
Use "blocked" only when you truly cannot proceed without a human. Use "failed" if you tried and could not complete.
After writing the file, also print the same JSON as your final message.`;
}

/** Returns { prompt, context } markdown strings. */
export function buildStepPrompt(root, { cfg, task, steps, step, attempt, resultPath, agentsCatalog = [] }) {
  const agent = cfg?.agents?.get?.(step.role);
  const handoff = readHandoff(root, task.id);
  const prior = steps.filter((s) => s.pos < step.pos).map((s) => `- Step ${s.pos + 1} (${s.role}) — ${s.status}: ${s.summary || "(no summary)"}`).join("\n");
  const later = steps.filter((s) => s.pos > step.pos).map((s) => `- Step ${s.pos + 1} (${s.role}): ${s.goal}`).join("\n");
  const hp = path.join(root, "data", "tasks", `task-${task.id}`, "handoff.md");

  const context = [
    `# Context for Task #${task.seq} · step ${step.pos + 1} · attempt ${attempt}`,
    `## Task\nTitle: ${task.title}\nRepo/workspace: ${task.repo || root}\nType: ${task.task_type || "(divider-composed)"}`,
    `## End goal\n${task.end_goal || task.title}`,
    prior ? `## Previous steps\n${prior}` : "",
    later ? `## Steps after you\n${later}` : "",
    `## handoff.md (${hp})\n${handoff.length > MAX_HANDOFF_INLINE ? `…(truncated, read the file for the full log)\n${handoff.slice(-MAX_HANDOFF_INLINE)}` : handoff}`,
    attachmentsBlock(root, task.id),
    agentsCatalog.length ? `## Agents available for spawn_tasks\n${agentsCatalog.map((a) => `- ${a.id}: ${a.description || ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = [
    agent?.systemPrompt ? `# Role: ${step.role}\n${agent.systemPrompt}` : `# Role: ${step.role}`,
    `You are step ${step.pos + 1} of ${steps.length} in an automated task pipeline. Nobody will answer questions — act autonomously.`,
    `## Your step goal\n${step.goal}`,
    step.guidance ? `## Guidance from the operator (re-queue)\n${step.guidance}` : "",
    `## Communication\nRead the handoff log at ${hp} first. Earlier agents left decisions and file locations there. Your "handoff" field will be appended to it for the next agent.`,
    context,
    resultContract({ taskId: task.id, pos: step.pos, attempt, role: step.role, resultPath }),
  ].filter(Boolean).join("\n\n");

  return { prompt, context };
}

function attachmentsBlock(root, taskId) {
  try {
    const dir = path.join(root, "data", "tasks", `task-${taskId}`, "attachments");
    const idx = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    if (!Array.isArray(idx) || !idx.length) return "";
    return `## Attachments\n${idx.map((a) => `- ${path.join(dir, a.file)} (${a.name}, ${a.size} bytes)`).join("\n")}`;
  } catch { return ""; }
}

export function buildDividerPrompt({ text, repo, taskTypes, agents, forcedType = null, resultPath }) {
  return `# Role: divider
You split an operator request into one or more independent TASKS. Each task is a sequential pipeline of STEPS; each step is executed by one agent role.

## Request
${text}

${repo ? `Repo / workspace: ${repo}\n` : ""}
## Available agent roles (use ONLY these ids)
${agents.map((a) => `- ${a.id}: ${a.description || ""}`).join("\n")}

## Task-type templates (optional; reuse when they fit, otherwise compose steps yourself)
${taskTypes.map((t) => `- ${t.id} (${t.name}): ${t.description}\n  steps: ${t.steps.map((s) => s.role).join(" → ")}`).join("\n") || "(none)"}
${forcedType ? `\nThe operator chose task type "${forcedType}" — use its steps for every task.\n` : ""}
## Rules
- Prefer ONE task unless the request clearly contains separable pieces of work.
- 1–8 steps per task; each step goal must be concrete and checkable.
- Use depends_on (list of other task keys) only when a task needs another's result.
- end_goal is rich markdown: what "done" looks like.

## Output
Write JSON to ${resultPath} (atomic .tmp + rename) AND print it as your final message:
{ "summary": "one line", "tasks": [ { "key": "t1", "title": "...", "task_type": "generic|<id>|", "end_goal": "markdown", "depends_on": [], "steps": [ { "role": "<agent id>", "goal": "..." } ] } ] }`;
}

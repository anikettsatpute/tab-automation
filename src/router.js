// AI intent router for @Harness mentions: one short headless CLI session
// (Muse default, Copilot optional) returns a JSON decision; the planner
// executes it deterministically. Routing only — real work is still queued.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDispatcher } from "./loop/dispatchers.js";
import { finalAssistantText } from "./loop/transcript.js";

export const ROUTER_ACTIONS = [
  "chat", "clarify", "list_todos", "add_todo", "complete_todo",
  "list_reminders", "add_reminder", "list_catalog", "run_automation", "create_task",
];

export function routerDispatcher() {
  const v = String(process.env.ROUTER_DISPATCHER || "muse").trim().toLowerCase();
  return v === "off" || v === "none" ? null : v === "copilot" ? "copilot" : "muse";
}

export const routerDir = (root, id) => path.join(root, "data", "router", String(id).replace(/[^\w-]/g, "").slice(0, 40) || "adhoc");

export function buildRouterPrompt({ text, user, history = [], automations = [], pipelines = [], todos = [], files = [], now = new Date() }) {
  const ist = new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
  const hist = history.length ? history.map((h) => `[${h.user}]: ${String(h.text).slice(0, 300)}`).join("\n") : "(none)";
  const autos = automations.length ? automations.map((a) => `- ${a.id}${a.command ? ` (!${a.command})` : ""}: ${a.description || a.name || ""}`.trim()).join("\n") : "(none)";
  const pipes = pipelines.length ? pipelines.map((p) => `- ${p.id}: ${p.name}${p.description ? ` — ${p.description}` : ""} [${(p.steps || []).map((s) => s.role).join(" → ")}]`).join("\n") : "(none)";
  const td = todos.length ? todos.map((t) => `- ${t.id}: ${t.text}${t.due ? ` (due ${t.due})` : ""}`).join("\n") : "(none)";
  const fl = files.length ? files.map((f) => `- ${f.path}${f.summary ? ` — ${f.summary}` : ""}`).join("\n") : "(none)";
  return `You are Harness, the intent router for a personal automation assistant on Discord.
You have READ-ONLY tools: use them to inspect context (read files, list automations/tasks, check runs) before deciding. Do NOT do the work yourself, do NOT edit files, do NOT launch anything — just decide.
Reply with ONLY one JSON object, no prose, no code fences.

Now: UTC ${now.toISOString().slice(0, 16).replace("T", " ")}, IST ${ist}. Assume IST unless the user says otherwise.

Actions (pick exactly one):
- chat: greetings, quick facts, or questions answerable in a few sentences. Put the answer in "reply".
- clarify: the request is ambiguous or missing something essential (which automation, what goal, when). Put ONE short question in "question".
- list_todos | list_reminders | list_catalog (automations + pipelines): user wants to see them.
- add_todo: {"text", "due"?: ISO date, "priority"?: P1-P4}
- complete_todo: {"id"} — id MUST be from the open todos below.
- add_reminder: {"text", "at": ISO 8601 datetime with offset, resolved from the user's relative time}
- run_automation: {"automationId", "text"?} — automationId MUST be from the automations list.
- create_task: {"taskType", "goal"} — real multi-step work (research, code, write, review). taskType MUST be from the pipelines list; use "generic" when none fits better. goal = a clear end goal.

Shape: {"action": "...", "reply"?: "", "question"?: "", "text"?: "", "due"?: "", "priority"?: "", "id"?: "", "at"?: "", "automationId"?: "", "taskType"?: "", "goal"?: "", "reason": "one line why"}

Automations:
${autos}

Pipelines (task types):
${pipes}

Open todos:
${td}

Repo files of interest (read-only, use read tools to inspect):
${fl}

Recent channel conversation (oldest first):
${hist}

Message from ${user || "user"}:
${String(text).slice(0, 4000)}`;
}

/** Last parseable JSON object with an "action" key (handles fences/prose). */
export function parseDecision(raw) {
  const s = String(raw ?? "");
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { found.push(s.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (const c of found.reverse()) {
    try { const o = JSON.parse(c); if (o && ROUTER_ACTIONS.includes(o.action)) return o; } catch {}
  }
  return null;
}

/** Run one routing session. Returns { decision|null, session } (never throws). */
export async function routeIntent(cfg, { id, prompt, timeoutMs = 120000 }) {
  const dispatcher = routerDispatcher();
  const dir = routerDir(cfg.root, id);
  const session = { dispatcher, dir: path.relative(cfg.root, dir), prompt: "prompt.md", transcript: "transcript.jsonl", startedAt: new Date().toISOString() };
  if (!dispatcher) return { decision: null, session: { ...session, error: "router disabled" } };
  try {
    mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, "prompt.md");
    writeFileSync(promptFile, prompt);
    const r = await getDispatcher(dispatcher).dispatch(cfg, {
      key: `router:${id}`, role: "assistant", model: "", cwd: cfg.root, promptFile, promptText: prompt,
      taskDir: dir, transcriptPath: path.join(dir, "transcript.jsonl"), timeoutMs, maxModelSteps: 40, mcp: true,
    });
    const text = finalAssistantText(r.stdout) || r.stdout;
    const decision = parseDecision(text);
    Object.assign(session, { sessionId: r.sessionId || "", exitCode: r.exitCode, durationMs: r.durationMs, error: decision ? undefined : (r.error || `no valid decision (exit ${r.exitCode}) ${String(r.stderr || "").slice(0, 200)}`.trim()) });
    if (decision) writeFileSync(path.join(dir, "decision.json"), JSON.stringify(decision, null, 2));
    return { decision, session };
  } catch (e) {
    return { decision: null, session: { ...session, error: String(e.message || e).slice(0, 300) } };
  }
}

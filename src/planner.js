// Rick planner: routes Discord messages to queued chat replies or queued pipelines.
// No direct model calls here: classification + pipeline planning are
// deterministic; the worker is the sole model executor (Meta-gated,
// envelope file, reconciliation, in-channel delivery).
import { chunk } from "./workflow.js";
import { saveMemory, searchMemory, formatMemories, recentChannel } from "./memory.js";
import { listRuns, addTodo, listTodos, completeTodo, addReminder, listReminders, listAutomations } from "./db.js";
import { loadTaskTypes } from "./loop/task-types.js";
import { buildRouterPrompt, routerDispatcher } from "./router.js";

const routerDispatcherId = () => routerDispatcher() || "muse";

const BIG_TASK_HINTS = /\b(order|book|buy|plan|organize|arrange|research|compare|track|monitor|pay|send|create|build|make me|do it|handle)\b/i;

function agentCatalog(cfg) {
  return [...cfg.agents.values()].map((a) => `- ${a.id}: ${a.description || a.systemPrompt.slice(0, 100)}`).join("\n");
}

/** Tool catalog: built-ins + custom + configured MCP servers. */
function toolCatalog(cfg) {
  const lines = [
    "- web_search: search the web",
    "- web_news: recent headlines",
    "- web_fetch: read a page",
    "- github_search: find repos, MCP servers, libraries",
    "- oauth_discover: check OAuth/auth for a server URL",
  ];
  for (const s of cfg.mcpServers ?? []) {
    const auth = s.authStatus === "needed" ? " (needs sign-in)" : s.authStatus === "ok" ? " (connected)" : "";
    lines.push(`- mcp:${s.id} [${s.transport}]${auth} ${s.note || ""}`.trim());
  }
  return lines.join("\n");
}

/** Ground-truth workflow catalog. The ONLY list Rick may claim exists. */
export function workflowCatalog(cfg) {
  return (cfg.workflows ?? []).map((w) => {
    const trig = w.trigger?.type === "discord" ? `!${w.trigger.command}`
      : w.trigger?.type === "schedule" ? `schedule ${w.trigger.cron}` : "manual";
    const steps = (w.steps ?? []).map((s) => `${s.id}:${s.type}`).join(" -> ");
    return `- ${w.id} [${trig}] :: ${steps}${w.description ? ` — ${w.description}` : ""}`;
  }).join("\n");
}

/** Resolve "run it / that one / yes" against recent channel history.
 *  Returns a workflow id or null. Checks: explicit id/name mention first,
 *  then the most recent workflow Rick listed in this channel.
 *  Ambiguous (several listed, bare "run it") -> null so Rick asks which one. */
export function resolveRunTarget(cfg, text, channelHistory) {
  const lower = text.toLowerCase();
  // 1. explicit id or !command mention
  for (const w of cfg.workflows ?? []) {
    if (lower.includes(w.id.toLowerCase())) return w.id;
    const cmd = w.trigger?.type === "discord" ? w.trigger.command : null;
    if (cmd && (lower.includes(`!${cmd}`) || lower.includes(cmd.toLowerCase()))) return w.id;
  }
  // 2. anaphoric ("run it", "that one", "yes do it") -> last workflow Rick mentioned here
  if (/\b(run it|that one|do it|yes|go ahead|run that|start it)\b/i.test(text)) {
    for (let i = channelHistory.length - 1; i >= 0; i--) {
      const h = channelHistory[i];
      if (h.user !== "Rick" && h.user !== "Harness") continue;
      const mentioned = (cfg.workflows ?? []).filter((w) => h.text.includes(w.id));
      if (mentioned.length === 1) return mentioned[0].id;
      if (mentioned.length > 1) return null; // ambiguous — ask, don't guess
    }
  }
  return null;
}

/** Decide simple-fact vs big-task. Deterministic heuristic only — no model
 *  call. Ambiguous short text defaults to simple-fact (queued chat); the
 *  worker is the sole model executor (Meta gate, envelope, reconcile). */
export function classifyTask(cfg, text) {
  void cfg;
  const t = String(text || "");
  if (t.length > 300 || BIG_TASK_HINTS.test(t)) return "big-task";
  return "simple-fact";
}

/** Generic-prompt router: plain-English task types map to real automations
 *  AND repeatable task types (tasks ≠ automations).
 *  "research X" -> deep-research, "review this" -> ship-it, "brief me" -> finance,
 *  "spike X" / "tech spike" -> task type tech-spike, "bug ..." -> bug-fix,
 *  "regression ..." -> regression-check, "feature ..." -> feature-build.
 *  Returns {kind:'workflow',id} | {kind:'taskType',id} | null. No LLM — deterministic. */
export function routeGenericPrompt(cfg, text) {
  const t = String(text || "").toLowerCase();
  const has = (...ws) => ws.some((w) => t.includes(w));
  // Repeatable task types first: explicit per-goal pipelines (tasks, not automations).
  if (has("tech spike", "spike this", "spike the", "open question", "should we adopt", "evaluate whether", "compare options", "trade-off", "tradeoff")) return { kind: "taskType", id: "tech-spike" };
  if (has("bug:", "bug report", "it crashes", "stack trace", "repro steps", "steps to repro", "expected vs actual", "fix this bug")) return { kind: "taskType", id: "bug-fix" };
  if (has("regression", "regression test", "verify no break", "smoke test the release")) return { kind: "taskType", id: "regression-check" };
  if (has("feature request", "build me a", "add support for", "acceptance criteria")) return { kind: "taskType", id: "feature-build" };
  // Self-contained automations (trigger + steps baked in).
  if (has("deep research", "research this", "research the", "investigate this", "look into")) return { kind: "workflow", id: "deep-research" };
  if (has("ship it", "ship this", "review this", "red team", "red-team", "code review")) return { kind: "workflow", id: "ship-it" };
  if (has("scout this", "scout the", "find out about", "dig into")) return { kind: "workflow", id: "scout-test" };
  if (has("brief me", "morning brief", "market brief", "premarket", "pre-market")) {
    return { kind: "workflow", id: has("us", "nasdaq", "nyse", "s&p") ? "premarket-us" : "premarket-india" };
  }
  if (has("summarize this", "tl;dr", "tldr this")) return null; // single-agent fast path handles it
  return null;
}

/** Build a pipeline workflow doc deterministically (no model call).
 *  The planner never executes inference: explicit workflow mention reuses
 *  the REAL automation; otherwise a single selected-assistant step carries
 *  the full goal + history. The worker is the sole model executor. */
export function planPipeline(cfg, text, historyBlock = "") {
  const t = String(text || "");
  for (const w of cfg.workflows ?? []) {
    if (t.toLowerCase().includes(String(w.id || "").toLowerCase())) return { useWorkflow: w.id };
  }
  const agentIds = [...(cfg.agents?.keys?.() ?? [])];
  const agent = agentIds.includes("assistant") ? "assistant" : (agentIds[0] || "assistant");
  const goal = `${t.slice(0, 1500)}${String(historyBlock || "").slice(0, 1500)}`.slice(0, 4000);
  const stepId = "step-1";
  const steps = [{ id: stepId, type: "agent", agent, prompt: goal }];
  return {
    id: `pipeline-${Date.now().toString(36)}`,
    name: "Rick pipeline",
    trigger: { type: "manual" },
    steps: [...steps, { id: "report", type: "discord_send", message: `✅ Done — here's the result:\n\n{{steps.${stepId}}}` }],
  };
}

function routerCatalogs(cfg) {
  const autos = new Map();
  for (const w of cfg.workflows ?? []) if (w.enabled !== false) autos.set(w.id, { id: w.id, name: w.name || w.id, description: w.description || "", command: w.trigger?.type === "discord" ? w.trigger.command : null });
  try {
    for (const a of listAutomations(cfg.root)) if (a.enabled) autos.set(a.id, { id: a.id, name: a.name || a.id, description: a.description || "", command: a.trigger_type === "discord" ? a.trigger_config?.command || null : null });
  } catch {}
  let pipelines = [];
  try { pipelines = loadTaskTypes(cfg.root); } catch {}
  return { automations: [...autos.values()], pipelines };
}

const fmtTodos = (rows) => rows.length ? rows.map((t) => `• \`${t.id}\` ${t.text}${t.due ? ` — due ${t.due}` : ""}${t.priority ? ` (${t.priority})` : ""}`).join("\n") : "No open todos.";

/** AI-routed handling. Returns a planner result, or null to fall back to keyword routing. */
async function aiRoute(cfg, deps, msg, text, channelHistory) {
  const { automations, pipelines } = routerCatalogs(cfg);
  const todos = listTodos(cfg.root, { limit: 30 });
  const prompt = buildRouterPrompt({ text, user: msg.author?.tag, history: channelHistory, automations, pipelines, todos });
  await msg.channel?.sendTyping?.().catch(() => {});
  const { decision: d, session } = await deps.routeIntent(cfg, { id: msg.id || `adhoc-${Date.now().toString(36)}`, prompt });
  if (!d) {
    deps.log?.(`[router] fallback to keyword routing: ${session?.error || "no decision"}`);
    return null;
  }
  const say = async (t) => { for (const part of chunk(t)) await msg.reply(part); };
  const remember = (reply) => {
    saveMemory(cfg.root, { kind: "chat", user: msg.author?.tag, text, channelId: msg.channelId });
    saveMemory(cfg.root, { kind: "reply", user: "Rick", text: String(reply).slice(0, 500), channelId: msg.channelId });
  };
  const base = { router: { ...session, decision: d } };
  const user = msg.author?.tag || "";
  const userId = msg.author?.id || "";
  switch (d.action) {
    case "clarify": {
      const q = String(d.question || "Can you say a bit more about what you want?");
      remember(q); await say(`🤔 ${q}`);
      return { ...base, kind: "clarify" };
    }
    case "chat": {
      if (!String(d.reply || "").trim()) return null;
      remember(d.reply); await say(String(d.reply));
      return { ...base, kind: "chat-reply" };
    }
    case "list_todos": {
      const r = `📝 Open todos:\n${fmtTodos(todos)}`;
      remember(r); await say(r);
      return { ...base, kind: "list" };
    }
    case "list_reminders": {
      const rows = listReminders(cfg.root, {});
      const r = rows.length ? `⏰ Pending reminders:\n${rows.map((x) => `• \`${x.id}\` ${x.text} — ${x.at}`).join("\n")}` : "⏰ No pending reminders.";
      remember(r); await say(r);
      return { ...base, kind: "list" };
    }
    case "list_catalog": {
      const r = `⚙️ Automations:\n${automations.map((a) => `• \`${a.id}\`${a.description ? ` — ${a.description}` : ""}`).join("\n") || "(none)"}\n\n🧩 Pipelines:\n${pipelines.map((p) => `• \`${p.id}\` — ${p.name}`).join("\n") || "(none)"}`;
      remember(r); await say(r);
      return { ...base, kind: "list" };
    }
    case "add_todo": {
      if (!String(d.text || "").trim()) return null;
      const pr = /^P[1-4]$/.test(String(d.priority || "")) ? d.priority : "P3";
      const id = addTodo(cfg.root, { text: d.text, due: d.due || null, priority: pr, user, channelId: msg.channelId });
      const r = `📝 Added todo \`${id}\`: ${d.text}${d.due ? ` — due ${d.due}` : ""} (${pr})`;
      remember(r); await say(r);
      return { ...base, kind: "todo" };
    }
    case "complete_todo": {
      const ok = d.id && completeTodo(cfg.root, String(d.id));
      const r = ok ? `✅ Done: todo \`${d.id}\`` : `Couldn't find open todo \`${d.id || "?"}\`.\n${fmtTodos(todos)}`;
      remember(r); await say(r);
      return { ...base, kind: "todo" };
    }
    case "add_reminder": {
      const at = new Date(String(d.at || ""));
      if (!d.text || Number.isNaN(at.getTime())) { await say("⏰ When should I remind you, and about what?"); return { ...base, kind: "clarify" }; }
      const id = addReminder(cfg.root, { text: d.text, at: at.toISOString(), user, channelId: msg.channelId });
      const r = `⏰ Reminder \`${id}\` set for ${at.toISOString().slice(0, 16).replace("T", " ")} UTC: ${d.text}`;
      remember(r); await say(r);
      return { ...base, kind: "reminder" };
    }
    case "run_automation": {
      const a = automations.find((x) => x.id === d.automationId);
      if (!a) { await say(`Which automation? Available: ${automations.map((x) => `\`${x.id}\``).join(", ")}`); return { ...base, kind: "clarify" }; }
      const wf = (cfg.workflows ?? []).find((w) => w.id === a.id) || { id: a.id, name: a.name, steps: [] };
      remember(`Queued automation ${a.id}`);
      const ctx = await deps.runWorkflow(wf, {
        kind: "discord", automation: a.id, command: a.command || a.id,
        text: String(d.text || text), user, userId, channelId: msg.channelId, messageId: msg.id || null,
      }, msg.channelId, say);
      return { ...base, kind: "workflow", pipeline: a.id, jobId: ctx?._jobId || ctx?.jobId || null, status: "queued" };
    }
    case "create_task": {
      const tt = pipelines.find((p) => p.id === d.taskType) || pipelines.find((p) => p.id === "generic") || pipelines[0];
      const goal = String(d.goal || text).trim();
      if (!tt || !goal) return null;
      const store = await import("./loop/store.js");
      const reqId = store.createRequest(cfg.root, {
        text: goal, mode: "direct", taskType: tt.id, dispatcher: routerDispatcherId(),
        source: `discord:${msg.channelId}:${userId || "0"}:${msg.id || "0"}`,
      });
      remember(`Created ${tt.id} task (request ${reqId}): ${goal}`);
      await say(`🧩 On it — **${tt.name}** pipeline (${(tt.steps || []).map((s) => s.role).join(" → ")}). I'll reply here with the result.`);
      return { ...base, kind: "task", taskType: tt.id, requestId: reqId, jobId: `req:${reqId}`, status: "queued" };
    }
    default:
      return null;
  }
}

/** Handle one Discord message via Rick: classify, reply or run pipeline. */
export async function handleRickMessage(cfg, deps, msg, text) {
  // Single-response contract: exactly ONE user-visible ack per message.
  // Task/automation launches reply once ("queued"); progress + final result
  // stream afterwards. No "On it" + "Plan" + "Done" triple chatter.
  // Cross-process idempotency: if the SAME goal text already launched a
  // discord run in the last 5 min (e.g. a stale bot with the same token
  // answered first), do NOT launch again — just point at the existing run.
  // This makes double-delivery harmless no matter which process fires second.
  try {
    const { listRuns } = await import("./db.js");
    const goal = String(text || "").trim().slice(0, 400);
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const r of listRuns(cfg.root, { limit: 15 })) {
      let trig = {};
      try { trig = JSON.parse(r.trigger_json || "{}"); } catch { continue; }
      if (!String(trig.kind || "").startsWith("discord")) continue;
      if (String(trig.text || "").trim().slice(0, 400) !== goal) continue;
      if (new Date(r.started_at || 0).getTime() < cutoff) continue;
      try { const { writeLog } = await import("./db.js"); writeLog(cfg.root, { level: "info", source: "rick-route", message: `dedupe: goal already launched as ${r.id} (${r.workflow_id}) — skipping second launch` }); } catch {}
      return { kind: "duplicate", runId: r.id, workflow: r.workflow_id };
    }
  } catch { /* never block handling on the guard */ }
  const channelHistory = recentChannel(cfg.root, msg.channelId, 12);
  const historyBlock = channelHistory.length
    ? `\n\nRecent conversation in this channel (oldest first, use for "run it" / follow-ups):\n${channelHistory.map((h) => `[${h.user}]: ${h.text.slice(0, 300)}`).join("\n")}`
    : "";

  // AI router first (deps.routeIntent wired in index.js); keyword routing below is the fallback.
  if (typeof deps.routeIntent === "function") {
    const routed = await aiRoute(cfg, deps, msg, text, channelHistory);
    if (routed) return routed;
  }

  // 0) list automations -> deterministic full catalog, no LLM involved
  if (/\b(list|show|what).{0,30}(automation|workflow)/i.test(text) || /\bautomations\b/i.test(text)) {
    const reply = `⚙️ Automations (say "run <id>" or \`!<command>\`):\n${workflowCatalog(cfg)}`;
    saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
    saveMemory(cfg.root, { kind: "reply", user: "Rick", text: reply.slice(0, 500), channelId: msg.channelId });
    for (const part of chunk(reply)) await msg.reply(part);
    return { kind: "list" };
  }

  // 0b) "run it" / explicit workflow mention -> run the REAL workflow, never a hallucinated pipeline
  const targetId = resolveRunTarget(cfg, text, channelHistory);
  // 0b2) generic prompts -> route to flows (automations) OR task types (repeatable pipelines).
  // Tasks ≠ automations: a task type launch creates a task row + per-goal run;
  // an automation run is self-contained. Both show live progress in the dashboard.
  const generic = routeGenericPrompt(cfg, text);
  if (generic?.kind === "taskType" && !targetId) {
    const { createTask, saveTaskSteps } = await import("./db.js");
    const { loadJson } = await import("./setup-api.js");
    const doc = loadJson("config/streams.json", { taskTypes: [] });
    const type = (doc.taskTypes || []).find((t) => t.id === generic.id);
    if (type) {
      saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
      await msg.channel.sendTyping().catch(() => {});
      await msg.reply(`🧩 Task queued: **${type.name}** (${(type.agents || []).join(" → ")}). Watch the dashboard Tasks tab — progress streams there.`);
      const taskId = createTask(cfg.root, {
        title: `${type.name}: ${text.slice(0, 80)}`, repo: type.stream || "general",
        task_type: type.id, status: "open", end_goal: text.slice(0, 4000),
      });
      const steps = (type.agents || []).map((agent, i) => ({
        id: `stage-${i + 1}-${agent}`, type: "agent", agent,
        prompt: `Task ${taskId} (${type.id}) step ${i + 1}/${type.agents.length} as '${agent}'.\nGoal: ${text.slice(0, 1500)}\nDo the ${agent} work now, concretely.`,
      }));
      saveTaskSteps(cfg.root, taskId, steps.map((s, i) => ({ step_id: s.id, type: s.type, agent: s.agent, model: "", status: "pending", prompt: s.prompt, output: "", position: i })));
      const wf = { id: `task-${taskId}`, name: `${type.name} ${taskId}`, trigger: { type: "manual" }, steps };
      // Durable enqueue: the worker is the sole executor. The task row +
      // steps are created now; the worker runs the agent chain and syncs
      // task_steps on completion. Reply is the queue ack only.
      const { enqueueJobSync } = await import("./db.js");
      const { id: jobId } = enqueueJobSync(cfg.root, {
        kind: "request",
        payload: { text: String(text).slice(0, 4000), mode: "request", stream: type.stream || "general", agents: type.agents || [], taskId },
        idempotencyKey: `discord-task:${taskId}`,
      });
      saveMemory(cfg.root, { kind: "reply", user: "Rick", text: `Task ${taskId} [${type.id}] queued as job ${jobId}`.slice(0, 500), channelId: msg.channelId });
      return { kind: "task", taskType: type.id, taskId, jobId, status: "queued" };
    }
  }
  if (generic?.kind === "workflow" && !targetId) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === generic.id);
    if (wf) {
      saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
      await msg.channel.sendTyping().catch(() => {});
      // Durable enqueue only: the worker runs the REAL configured steps.
      // No awaiting runWorkflow — the handle is a queue ack ({ _jobId }),
      // never a fake complete brain status. Completion posts via the
      // worker's deliverDiscordCompletion (job payload carries channelId +
      // messageId for the in-thread reply link).
      const ctx = await deps.runWorkflow(wf, {
        kind: "discord", command: wf.trigger?.command || wf.id,
        text, user: msg.author.tag, channelId: msg.channelId,
        messageId: msg.id || null,
      }, msg.channelId, async (t) => { for (const part of chunk(t)) await msg.reply(part); });
      saveMemory(cfg.root, { kind: "reply", user: "Rick", text: `Queued workflow ${wf.id} as job ${ctx?._jobId || ctx?.jobId || "?"}`.slice(0, 500), channelId: msg.channelId });
      return { kind: "workflow", pipeline: wf.id, jobId: ctx?._jobId || ctx?.jobId || null, status: "queued" };
    }
  }
  if (targetId) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === targetId);
    if (wf) {
      saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
      await msg.channel.sendTyping().catch(() => {});
      // Durable enqueue only (see above): queue ack now, worker delivers.
      const ctx = await deps.runWorkflow(wf, {
        kind: "discord", command: wf.trigger?.command || wf.id,
        text, user: msg.author.tag, channelId: msg.channelId,
        messageId: msg.id || null,
      }, msg.channelId, async (t) => { for (const part of chunk(t)) await msg.reply(part); });
      saveMemory(cfg.root, { kind: "reply", user: "Rick", text: `Queued workflow ${wf.id} as job ${ctx?._jobId || ctx?.jobId || "?"}`.slice(0, 500), channelId: msg.channelId });
      return { kind: "workflow", pipeline: wf.id, jobId: ctx?._jobId || ctx?.jobId || null, status: "queued" };
    }
  }
  // 0c) bare "run it" with no resolvable target -> ask which one (never guess, never invent)
  if (/\b(run it|that one|do it|run that|start it)\b/i.test(text)) {
    const reply = `Which one? Say "run <id>":\n${workflowCatalog(cfg)}`;
    saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
    saveMemory(cfg.root, { kind: "reply", user: "Rick", text: reply.slice(0, 500), channelId: msg.channelId });
    for (const part of chunk(reply)) await msg.reply(part);
    return { kind: "clarify" };
  }

  // 0d) fast path: simple todo/reminder requests skip classification entirely —
  // still queued (no direct model call). The worker runs the assistant step.
  const isSimpleTask = /\b(remind me|remind .*?in \d+\s*(min|hour)|add (a )?todo|remember to (do|buy|call|pay|fill|send)?)\b/i.test(text);
  const kind = isSimpleTask ? "simple-fact" : classifyTask(cfg, text);
  if (kind === "simple-fact") {
    // Durable queued chat: no direct model call in the planner. The worker
    // (sole executor, Meta-gated) runs assistant via executeAgentStep,
    // writes the envelope file, reconciles, and delivers the completion
    // to channelId/messageId. Single queue-ack now; Brain stays running.
    saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
    await msg.channel.sendTyping().catch(() => {});
    const hits = searchMemory(cfg.root, text, 5).filter((h) => h.text !== text);
    const catalog = workflowCatalog(cfg);
    const nowUtc = new Date();
    const ist = new Date(nowUtc.getTime() + 5.5 * 3600_000);
    const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");
    const fullPrompt = `User ${msg.author.tag} says: ${text}${historyBlock}\n\n${formatMemories(hits)}\n\nNow: UTC ${fmt(nowUtc)}, IST (India) ${fmt(ist)}. You manage todos/reminders with tools: todo_add(text, due?, priority?) saves a todo; todo_list shows them; todo_done(id) completes; remind_add(text, at=ISO datetime) sets a reminder — resolve relative times ("in 15 minutes", "tomorrow 12pm", "at 11pm") against the times above, assume IST unless the user says otherwise, and call the tool immediately in this same reply. Confirm briefly what you saved and when it fires. Daily digest posts automatically at 08:00; due reminders fire on time.\n\nREAL automations (never invent others; offer to run one by exact id):\n${catalog}`.slice(0, 4000);
    const chatWf = { id: "adhoc-chat", steps: [{ id: "reply", type: "agent", agent: "assistant", prompt: fullPrompt }] };
    const ctx = await deps.runWorkflow(chatWf, {
      kind: "discord", text: fullPrompt, user: msg.author.tag, channelId: msg.channelId,
      messageId: msg.id || null,
    }, msg.channelId, async (t) => { for (const part of chunk(t)) await msg.reply(part); });
    saveMemory(cfg.root, { kind: "reply", user: "Rick", text: `Queued chat as job ${ctx?._jobId || ctx?.jobId || "?"}`.slice(0, 500), channelId: msg.channelId });
    return { kind, jobId: ctx?._jobId || ctx?.jobId || null, status: "queued" };
  }
  // big-task: deterministic plan + enqueue pipeline. Single queue-ack AFTER
  // the plan is built (no "On it" pre-message) so one goal = one reply +
  // worker result. No direct agent execution in the planner: planPipeline
  // only builds the doc; deps.runWorkflow enqueues; the worker is the sole
  // executor.
  const pipeline = planPipeline(cfg, text, historyBlock);
  // planner chose an existing automation -> enqueue it (worker runs it)
  if (pipeline.useWorkflow) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === pipeline.useWorkflow);
    const ctx = await deps.runWorkflow(wf, {
      kind: "discord", command: wf.trigger?.command || wf.id,
      text, user: msg.author.tag, channelId: msg.channelId,
      messageId: msg.id || null,
    }, msg.channelId, async (t) => { for (const part of chunk(t)) await msg.reply(part); });
    saveMemory(cfg.root, { kind: "pipeline", user: msg.author.tag, text: `${text} => workflow ${wf.id} job ${ctx?._jobId || ctx?.jobId || "?"}`, channelId: msg.channelId });
    return { kind, pipeline: wf.id, jobId: ctx?._jobId || ctx?.jobId || null, status: "queued" };
  }
  const names = pipeline.steps.filter((s) => s.type === "agent").map((s) => s.agent).join(" → ");
  // Ephemeral pipeline: enqueue as a request job carrying the REAL planned
  // agents + prompts (never forced to ["assistant"]). Worker runs the chain.
  const ctx = await deps.runWorkflow(pipeline, {
    kind: "discord-pipeline", text, user: msg.author.tag, channelId: msg.channelId,
    messageId: msg.id || null,
    agents: pipeline.steps.filter((s) => s.type === "agent").map((s) => s.agent),
    steps: pipeline.steps,
  }, msg.channelId, async (t) => { for (const part of chunk(t)) await msg.reply(part); });
  saveMemory(cfg.root, { kind: "pipeline", user: msg.author.tag, text: `${text} => ${names} job ${ctx?._jobId || ctx?.jobId || "?"}`, channelId: msg.channelId });
  return { kind, pipeline: pipeline.id, jobId: ctx?._jobId || ctx?.jobId || null, status: "queued" };
}

// Rick planner: routes Discord messages to simple-fact replies or big-task pipelines.
// A pipeline is an ephemeral workflow built from available agents + tools,
// executed with the same engine (addressable {{steps.*}} vars, yes/no conditions,
// owner approval steps), with progress + final result posted back in-channel.
import { chatWithTools } from "./agent.js";
import { runWorkflow, chunk } from "./workflow.js";
import { saveMemory, searchMemory, formatMemories, recentChannel } from "./memory.js";
import { listRuns, addTodo, listTodos, completeTodo, addReminder } from "./db.js";

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

/** Decide simple-fact vs big-task. Heuristic first, agent fallback for ambiguity. */
export async function classifyTask(cfg, text) {
  if (text.length > 300 || BIG_TASK_HINTS.test(text)) return "big-task";
  if (/^(who|what|when|where|why|how|is|are|can|do|does|price|news|weather)\b/i.test(text.trim()) && text.length < 200) return "simple-fact";
  // Ambiguous: ask the assistant agent (cheap, one call)
  try {
    const verdict = await chatWithTools(cfg, "assistant",
      `Classify this user request as exactly one word, no other text: "simple-fact" (answerable directly) or "big-task" (needs multiple steps, tools, or agents).\nRequest: ${text.slice(0, 500)}`,
      {});
    return /big-task/i.test(verdict) ? "big-task" : "simple-fact";
  } catch {
    return "simple-fact";
  }
}

/** Generic-prompt router: plain-English task types map to real automations.
 *  "research X" -> deep-research, "review this" -> ship-it, "brief me" -> finance.
 *  Returns a workflow id or null. No LLM — deterministic keyword match. */
export function routeGenericPrompt(cfg, text) {
  const t = String(text || "").toLowerCase();
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has("deep research", "research this", "research the", "investigate this", "look into")) return "deep-research";
  if (has("ship it", "ship this", "review this", "red team", "red-team", "code review")) return "ship-it";
  if (has("scout this", "scout the", "find out about", "dig into")) return "scout-test";
  if (has("brief me", "morning brief", "market brief", "premarket", "pre-market")) {
    return has("us", "nasdaq", "nyse", "s&p") ? "premarket-us" : "premarket-india";
  }
  if (has("summarize this", "tl;dr", "tldr this")) return null; // single-agent fast path handles it
  return null;
}

/** Build a pipeline workflow doc from the planner agent.
 *  The planner sees the REAL workflow/agent/tool catalogs so it reuses
 *  existing automations instead of inventing new ones. */
export async function planPipeline(cfg, text, historyBlock = "") {
  const agents = agentCatalog(cfg);
  const workflows = workflowCatalog(cfg);
  const tools = toolCatalog(cfg);
  const spec = await chatWithTools(cfg, "assistant",
    `You are Rick's pipeline planner. Ground truth — never invent IDs outside these lists.\n\nEXISTING AUTOMATIONS (prefer these; reply {"useWorkflow": "<id>"} if one fits):\n${workflows}\n\nAvailable agents:\n${agents}\n\nAvailable tools:\n${tools}\n\nUser request: ${text.slice(0, 1000)}${historyBlock.slice(0, 1500)}\n\n` +
    `If an existing automation fits, respond with ONLY {"useWorkflow": "<exact-id>"}. Otherwise respond with ONLY valid JSON, no other text: {"steps": [{"id": "<stepid>", "agent": "<agent-id>", "prompt": "<prompt using {{steps.<earlier-id>}} refs where needed>", "output": "text"}]}. ` +
    `Max 6 steps. First step prompt must include the user request. Keep prompts short. Only use agent IDs from the list above.`,
    {});
  let doc;
  try {
    const clean = String(spec).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    doc = JSON.parse(clean);
  } catch {
    throw new Error("Planner did not return valid JSON");
  }
  if (doc.useWorkflow) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === doc.useWorkflow);
    if (!wf) throw new Error(`Planner chose unknown workflow '${doc.useWorkflow}'`);
    return { useWorkflow: wf.id };
  }
  const steps = (doc.steps ?? []).slice(0, 6);
  if (!steps.length) throw new Error("Planner returned no steps");
  for (const s of steps) {
    if (!cfg.agents.has(s.agent)) throw new Error(`Planner used unknown agent '${s.agent}'`);
    s.type = "agent";
  }
  return {
    id: `pipeline-${Date.now().toString(36)}`,
    name: "Rick pipeline",
    trigger: { type: "manual" },
    steps: [...steps, { id: "report", type: "discord_send", message: `✅ Done — here's the result:\n\n{{steps.${steps[steps.length - 1].id}}}` }],
  };
}

/** Handle one Discord message via Rick: classify, reply or run pipeline. */
export async function handleRickMessage(cfg, deps, msg, text) {
  const channelHistory = recentChannel(cfg.root, msg.channelId, 12);
  const historyBlock = channelHistory.length
    ? `\n\nRecent conversation in this channel (oldest first, use for "run it" / follow-ups):\n${channelHistory.map((h) => `[${h.user}]: ${h.text.slice(0, 300)}`).join("\n")}`
    : "";

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
  // 0b2) generic task-type prompts ("research X", "review this", "brief me") -> route to flows
  const genericId = routeGenericPrompt(cfg, text);
  if (genericId && !targetId) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === genericId);
    if (wf) {
      saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
      await msg.channel.sendTyping().catch(() => {});
      await msg.reply(`▶️ Got it — running **${wf.id}** (${wf.name})… watch the dashboard Runs tab move.`);
      const replyTo = async (t) => { for (const part of chunk(t)) await msg.reply(part); };
      const ctx = await deps.runWorkflow(wf, {
        kind: "discord", command: wf.trigger?.command || wf.id,
        text, user: msg.author.tag, channelId: msg.channelId,
      }, msg.channelId, replyTo);
      saveMemory(cfg.root, { kind: "reply", user: "Rick", text: `Ran workflow ${wf.id}: ${Object.keys(ctx.steps).join(", ")}`.slice(0, 500), channelId: msg.channelId });
      return { kind: "workflow", pipeline: wf.id, steps: Object.keys(ctx.steps) };
    }
  }
  if (targetId) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === targetId);
    if (wf) {
      saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
      await msg.channel.sendTyping().catch(() => {});
      await msg.reply(`▶️ Running **${wf.id}**…`);
      const replyTo = async (t) => { for (const part of chunk(t)) await msg.reply(part); };
      const ctx = await deps.runWorkflow(wf, {
        kind: "discord", command: wf.trigger?.command || wf.id,
        text, user: msg.author.tag, channelId: msg.channelId,
      }, msg.channelId, replyTo);
      saveMemory(cfg.root, { kind: "reply", user: "Rick", text: `Ran workflow ${wf.id}: ${Object.keys(ctx.steps).join(", ")}`.slice(0, 500), channelId: msg.channelId });
      return { kind: "workflow", pipeline: wf.id, steps: Object.keys(ctx.steps) };
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
  // one agent call with tools, one reply. No pipeline, no "breaking into steps".
  const isSimpleTask = /\b(remind me|remind .*?in \d+\s*(min|hour)|add (a )?todo|remember to (do|buy|call|pay|fill|send)?)\b/i.test(text);
  const kind = isSimpleTask ? "simple-fact" : await classifyTask(cfg, text);
  if (kind === "simple-fact") {
    saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text, channelId: msg.channelId });
    const hits = searchMemory(cfg.root, text, 5).filter((h) => h.text !== text);
    const catalog = workflowCatalog(cfg);
    const nowUtc = new Date();
    const ist = new Date(nowUtc.getTime() + 5.5 * 3600_000);
    const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");
    const reply = await chatWithTools(cfg, "assistant",
      `User ${msg.author.tag} says: ${text}${historyBlock}`,
      { extraContext: `${formatMemories(hits)}\n\nNow: UTC ${fmt(nowUtc)}, IST (India) ${fmt(ist)}. You manage todos/reminders with tools: todo_add(text, due?, priority?) saves a todo; todo_list shows them; todo_done(id) completes; remind_add(text, at=ISO datetime) sets a reminder — resolve relative times ("in 15 minutes", "tomorrow 12pm", "at 11pm") against the times above, assume IST unless the user says otherwise, and call the tool immediately in this same reply. Confirm briefly what you saved and when it fires. Daily digest posts automatically at 08:00; due reminders fire on time.\n\nREAL automations (never invent others; offer to run one by exact id):\n${catalog}`,
        toolCtx: { user: msg.author.tag, channelId: msg.channelId } });
    saveMemory(cfg.root, { kind: "reply", user: "Rick", text: reply.slice(0, 500), channelId: msg.channelId });
    for (const part of chunk(reply)) await msg.reply(part);
    return { kind };
  }
  // big-task: plan + run pipeline, stream progress
  await msg.reply("🔧 On it — breaking this into steps…");
  const pipeline = await planPipeline(cfg, text, historyBlock);
  // planner chose an existing automation -> run it directly
  if (pipeline.useWorkflow) {
    const wf = (cfg.workflows ?? []).find((w) => w.id === pipeline.useWorkflow);
    await msg.reply(`▶️ This matches **${wf.id}** — running it…`);
    const replyTo = async (t) => { for (const part of chunk(t)) await msg.reply(part); };
    const ctx = await deps.runWorkflow(wf, {
      kind: "discord", command: wf.trigger?.command || wf.id,
      text, user: msg.author.tag, channelId: msg.channelId,
    }, msg.channelId, replyTo);
    saveMemory(cfg.root, { kind: "pipeline", user: msg.author.tag, text: `${text} => workflow ${wf.id}`, channelId: msg.channelId });
    return { kind, pipeline: wf.id, steps: Object.keys(ctx.steps) };
  }
  const names = pipeline.steps.filter((s) => s.type === "agent").map((s) => s.agent).join(" → ");
  await msg.reply(`📋 Plan (${pipeline.steps.length - 1} steps): ${names}`);
  const ctx = await deps.runWorkflow(pipeline, {
    kind: "discord-pipeline", text, user: msg.author.tag, channelId: msg.channelId,
  }, msg.channelId);
  saveMemory(cfg.root, { kind: "pipeline", user: msg.author.tag, text: `${text} => ${names}`, channelId: msg.channelId });
  return { kind, pipeline: pipeline.id, steps: Object.keys(ctx.steps) };
}

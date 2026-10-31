import { Client, GatewayIntentBits, Events } from "discord.js";
import { chunk } from "./workflow.js";
import { saveMemory, searchMemory, formatMemories, memoryStats } from "./memory.js";
import { handleRickMessage, workflowCatalog } from "./planner.js";
import { listRuns, getRun, addTodo, listTodos, completeTodo, addReminder, listReminders, fileBrainMessage, updateBrainMessage, queueOutboxDeduped, listAutomations } from "./db.js";
import { onLoopEvent } from "./loop/engine.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { commandBindings, findCommandBinding } from "./discord-commands.js";
export { findCommandBinding };

// Durable Discord enqueue args: preserves configured workflow agents/prompts
// (automation kind runs the real steps; ephemeral pipelines run as request
// with their agent chain), persists channel/thread reply context in the
// payload, and keys idempotency by incoming messageId (never Date.now).
// Pure + side-effect free: safe to import from tests without booting the bot.
export function buildDiscordJobArgs(wf, trigger, cfg) {
  const triggerKind = trigger?.kind || "discord";
  const msgId = trigger?.messageId || trigger?.msgId || null;
  const channelId = trigger?.channelId || null;
  const text = String(trigger?.text || "").slice(0, 4000);
  const user = trigger?.user || "";
  const wfAgents = Array.isArray(wf?.steps)
    ? wf.steps.filter((s) => s?.agent).map((s) => s.agent).slice(0, 6)
    : [];
  const triggerAgents = Array.isArray(trigger?.agents) ? trigger.agents.filter(Boolean).slice(0, 6) : [];
  let kind = "chat";
  if (triggerKind === "dashboard-requeue") kind = "requeue";
  else if (triggerKind === "dashboard-flow" || trigger?.automation) kind = "automation";
  else if (triggerKind === "discord-task" || triggerKind === "request") kind = "request";
  else if (triggerKind === "discord-pipeline") kind = "request";
  else if (triggerKind === "discord" || String(triggerKind).startsWith("discord")) {
    const known = (cfg?.workflows || []).some((w) => w.id === wf?.id);
    kind = known ? "automation" : "chat";
  }
  let payload;
  if (kind === "request") {
    const agents = triggerAgents.length ? triggerAgents : wfAgents.length ? wfAgents : ["assistant"];
    payload = {
      text, mode: "request", stream: trigger?.stream || "general",
      agents, taskId: trigger?.taskId || undefined,
      channelId, messageId: msgId, user,
    };
    if (Array.isArray(trigger?.steps) && trigger.steps.length) payload.steps = trigger.steps.slice(0, 6);
    else if (wfAgents.length && Array.isArray(wf?.steps)) payload.steps = wf.steps.slice(0, 6);
  } else if (kind === "requeue") {
    payload = { runId: trigger?.parentRun || "", stepIndex: trigger?.stepIndex || 0, guidance: String(trigger?.guidance || "").slice(0, 2000) };
  } else if (kind === "automation") {
    payload = {
      automationId: trigger?.automation || wf?.id,
      text, user, channelId, messageId: msgId,
      source: "discord", command: trigger?.command || null,
    };
  } else {
    payload = { text, workflow: wf?.id, channelId, messageId: msgId, user };
  }
  // Durable key: messageId only — never Date.now. Without a messageId use a
  // deterministic content hash so retries dedupe instead of fanning out.
  let idempotencyKey = null;
  if (msgId) idempotencyKey = `discord:${triggerKind}:${wf?.id}:${msgId}`;
  else if (text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    idempotencyKey = `discord:${triggerKind}:${wf?.id}:hash-${h.toString(36)}`;
  }
  return { kind, payload, idempotencyKey };
}

/** Discord-command automation lookup: dashboard-created flows (DB, enabled)
 *  win over config/workflows.json so new automations work without a restart. */
export function findDiscordAutomation(cfg, cmd) {
  try {
    const a = listAutomations(cfg.root).find((x) => x.enabled && x.trigger_type === "discord" && x.trigger_config?.command === cmd);
    if (a) return { id: a.id, name: a.name, trigger: { type: "discord", command: cmd }, steps: a.steps };
  } catch { /* DB optional */ }
  return (cfg.workflows || []).find((w) => w.trigger?.type === "discord" && w.trigger?.command === cmd && w.enabled !== false) || null;
}

function findAutomationById(cfg, id) {
  try {
    const a = listAutomations(cfg.root).find((x) => x.id === id && x.enabled);
    if (a) return { id: a.id, name: a.name, trigger: { type: "discord" }, steps: a.steps };
  } catch { /* DB optional */ }
  return (cfg.workflows || []).find((w) => w.id === id && w.enabled !== false) || null;
}

/** Discord commands that exist only in the DB (created from the dashboard). */
function dbCommandCatalog(cfg) {
  try {
    const fileIds = new Set((cfg.workflows || []).map((w) => w.id));
    const extra = listAutomations(cfg.root).filter((a) => a.enabled && a.trigger_type === "discord" && a.trigger_config?.command && !fileIds.has(a.id));
    let out = extra.length ? "\n" + extra.map((a) => `- ${a.id} [!${a.trigger_config.command}] :: ${(a.steps || []).map((s) => `${s.id}:${s.type}`).join(" -> ")}${a.description ? ` — ${a.description}` : ""}`).join("\n") : "";
    const p = path.join(cfg.root, "config", "discord.json");
    const binds = existsSync(p) ? commandBindings(JSON.parse(readFileSync(p, "utf8"))) : [];
    if (binds.length) out += "\n" + binds.map((b) => `- [!${b.command}] → ${b.kind} ${b.target}`).join("\n");
    return out;
  } catch { return ""; }
}

/** Loop pipelines filed from Discord (request.source = "discord:<channel>")
 *  report back to that channel when each task reaches a terminal state. */
async function postLoopResult(cfg, send, ev) {
  if (ev?.type !== "task" || !["done", "failed", "blocked"].includes(ev.status)) return;
  const store = await import("./loop/store.js");
  const task = store.getTask(cfg.root, ev.taskId);
  const req = task?.request_id ? store.getRequest(cfg.root, task.request_id) : null;
  const m = /^discord:(\d{5,25})$/.exec(req?.source || "");
  if (!m) return;
  const steps = store.listSteps(cfg.root, task.id);
  const last = [...steps].reverse().find((s) => s.status === "done" && (s.output || s.summary));
  const head = ev.status === "done" ? "✅" : ev.status === "blocked" ? "⛔" : "❌";
  const body = ev.status === "done"
    ? String(last?.output || last?.summary || "(no output)")
    : String(task.blocked_reason || task.status_note || "see dashboard");
  await send(m[1], `${head} Pipeline **${task.task_type || "task"}** · task #${task.seq} ${ev.status} (${steps.map((s) => s.role).join(" → ")}):\n${body.slice(0, 1800)}`);
}

export function startDiscord(cfg, deps) {
  // Redelivery guard: one Discord message id = one handling. Discord.js can
  // emit the same message twice (reconnect/resume); without this, one user
  // goal spawns a task AND a stray pipeline run.
  // Two layers: (1) exact msg.id dedupe, (2) same-author+same-text within
  // 90s dedupe — covers redeliveries that arrive with a fresh id.
  const seenMessages = new Set();
  const recentTexts = new Map(); // key author|channel|textHash -> epoch ms
  const MAX_SEEN = 500;
  const DUP_WINDOW_MS = 90000;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: ["CHANNEL"],
  });

  client.once(Events.ClientReady, (c) => {
    deps.log?.(`[discord] connected as ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (msg) => {
    try {
      if (msg.author.bot) return;
      if (msg.id && seenMessages.has(msg.id)) return;
      if (msg.id) {
        seenMessages.add(msg.id);
        if (seenMessages.size > MAX_SEEN) seenMessages.delete(seenMessages.values().next().value);
      }
      const text = (msg.content ?? "").trim();
      if (!text) return;
      // Same author + same text within 90s = redelivery with a fresh id. Skip.
      // (Prevents the "task queued" + stray "Plan" double-run for one goal.)
      try {
        const key = `${msg.author?.id || "?"}|${msg.channelId}|${text.length}|${text.slice(0, 120)}`;
        const nowMs = Date.now();
        const prev = recentTexts.get(key);
        if (prev && nowMs - prev < DUP_WINDOW_MS) {
          deps.log?.(`[discord] duplicate delivery skipped (${msg.id})`);
          return;
        }
        recentTexts.set(key, nowMs);
        if (recentTexts.size > MAX_SEEN) recentTexts.delete(recentTexts.keys().next().value);
      } catch { /* never block handling on the guard */ }

      // 1) !command workflows (e.g. !review <text>)
      if (text.startsWith("!")) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        if (cmd === "remember" && rest.length) {
          saveMemory(cfg.root, { kind: "note", user: msg.author.tag, text: rest.join(" "), channelId: msg.channelId });
          await msg.reply("Noted — I'll remember that.");
          return;
        }
        if (cmd === "recall") {
          const hits = searchMemory(cfg.root, rest.join(" ") || text, 5);
          const reply = `🧠 What I recall:\n${formatMemories(hits)}`;
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        if (cmd === "memory") {
          const s = memoryStats(cfg.root);
          await msg.reply(`🧠 Memory: ${s.total} entries. Oldest ${s.oldest ?? "—"}, newest ${s.newest ?? "—"}.`);
          return;
        }
        if (cmd === "history") {
          const rows = listRuns(cfg.root, { limit: 10 });
          const reply = rows.length
            ? `📜 Recent runs:\n${rows.map((r) => `- ${r.id} ${r.workflow_id} [${r.status}] ${r.started_at}`).join("\n")}`
            : "No runs yet.";
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        if (cmd === "run" && rest[0]) {
          const run = getRun(cfg.root, rest[0]);
          if (!run) { await msg.reply(`No run '${rest[0]}'.`); return; }
          const reply = `📦 Run ${run.id} (${run.workflow_id}, ${run.status}):\n` +
            run.steps.map((s) => `- ${s.step_id} [${s.type}] ${s.status}: ${String(s.raw_text).slice(0, 200)}`).join("\n");
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        if (cmd === "todo" && rest.length) {
          const id = addTodo(cfg.root, { text: rest.join(" "), user: msg.author.tag, channelId: msg.channelId });
          await msg.reply(`✅ Todo saved \`${id}\`.`);
          return;
        }
        if (cmd === "todos") {
          const rows = listTodos(cfg.root, {});
          const reply = rows.length
            ? `📋 Open todos:\n${rows.map((t) => `- \`${t.id}\` [${t.priority}] ${t.text}${t.due ? ` (due ${t.due.slice(0, 16).replace("T", " ")})` : ""}`).join("\n")}`
            : "No open todos.";
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        if (cmd === "done" && rest[0]) {
          await msg.reply(completeTodo(cfg.root, rest[0]) ? `✅ Done \`${rest[0]}\`.` : `No open todo \`${rest[0]}\`.`);
          return;
        }
        if (cmd === "digest") {
          // Durable enqueue: the worker runs the digest; reply is the ack.
          const wf = (cfg.workflows || []).find((w) => w.id === "todo-digest");
          if (!wf) { await msg.reply("No todo-digest workflow configured."); return; }
          await msg.channel.sendTyping().catch(() => {});
          const { enqueueJobSync } = await import("./db.js");
          const { id: jobId } = enqueueJobSync(cfg.root, { kind: "automation", payload: { automationId: "todo-digest", channelId: msg.channelId, messageId: msg.id }, idempotencyKey: `discord:digest:${msg.id}` });
          await msg.reply(`⏳ Digest queued as job \`${jobId}\` — results post here when done.`);
          return;
        }
        if (cmd === "remind" && rest.length >= 2) {
          // !remind <ISO datetime> <text>  e.g. !remind 2026-10-27T12:00 fill the form
          const [at, ...words] = rest;
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at)) {
            await msg.reply("Usage: `!remind 2026-10-27T12:00 <text>` — or just say `@Harness remind me to … at 12pm tomorrow`.");
            return;
          }
          const id = addReminder(cfg.root, { text: words.join(" "), at, user: msg.author.tag, channelId: msg.channelId });
          await msg.reply(`⏰ Reminder set \`${id}\` for ${at}.`);
          return;
        }
        if (cmd === "reminders") {
          const rows = listReminders(cfg.root, {});
          const reply = rows.length
            ? `⏰ Pending reminders:\n${rows.map((r) => `- \`${r.id}\` @ ${r.at.slice(0, 16).replace("T", " ")}: ${r.text}`).join("\n")}`
            : "No pending reminders.";
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        if (cmd === "automations" || cmd === "workflows" || cmd === "list") {
          const reply = `⚙️ Automations (say "run <id>" or \`!<command>\`):\n${workflowCatalog(cfg)}${dbCommandCatalog(cfg)}`;
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        if (cmd === "pipelines") {
          const { loadTaskTypes } = await import("./loop/task-types.js");
          const list = loadTaskTypes(cfg.root);
          const reply = list.length
            ? `🧬 Agent pipelines (say \`!pipeline <id> <goal>\`):\n${list.map((t) => `- **${t.id}** — ${t.steps.map((s) => s.role).join(" → ")}${t.description ? ` · ${t.description}` : ""}`).join("\n")}`
            : "No pipelines configured — add one in Control Room → Configuration → Pipelines.";
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        const startPipeline = async (typeId, goal, usage) => {
          const { loadTaskTypes } = await import("./loop/task-types.js");
          const tt = loadTaskTypes(cfg.root).find((t) => t.id === typeId);
          if (!tt || !goal.length) {
            await msg.reply(`Usage: \`${usage}\`. ${tt ? "" : `Unknown pipeline \`${typeId || ""}\`. `}Try \`!pipelines\`.`);
            return;
          }
          const store = await import("./loop/store.js");
          const requestId = store.createRequest(cfg.root, { text: goal.join(" "), mode: "direct", source: `discord:${msg.channelId}`, taskType: tt.id, dispatcher: "muse" });
          await msg.reply(`🧬 Pipeline **${tt.id}** (${tt.steps.map((s) => s.role).join(" → ")}) queued as request \`${requestId}\` — the final output posts here when the last agent finishes.`);
        };
        if (cmd === "pipeline") {
          const [typeId, ...goal] = rest;
          await startPipeline(typeId, goal, "!pipeline <id> <goal>");
          return;
        }
        // Dashboard-configured bindings (config/discord.json "commands"), read live.
        const binding = findCommandBinding(cfg, cmd);
        if (binding?.kind === "pipeline") {
          await startPipeline(binding.target, rest, `!${cmd} <goal>`);
          return;
        }
        const wf = binding?.kind === "automation" ? findAutomationById(cfg, binding.target) : findDiscordAutomation(cfg, cmd);
        if (wf) {
          // Durable enqueue: worker is the sole executor; reply is the ack.
          // kind=automation so the flow's real steps run with {{trigger.text}}.
          await msg.channel.sendTyping().catch(() => {});
          const { enqueueJobSync } = await import("./db.js");
          const { kind, payload, idempotencyKey } = buildDiscordJobArgs(wf, { kind: "discord", automation: wf.id, command: cmd, text: rest.join(" "), user: msg.author?.tag || "", channelId: msg.channelId, messageId: msg.id }, cfg);
          const { id: jobId } = enqueueJobSync(cfg.root, { kind, payload, idempotencyKey });
          await msg.reply(`⏳ **${wf.id}** queued as job \`${jobId}\` — results post here when done.`);
          return;
        }
        // Unknown !command: don't silently ignore — show what's actually available
        {
          const reply = `❓ Unknown command \`!${cmd}\`.\n\n⚙️ Automations:\n${workflowCatalog(cfg)}${dbCommandCatalog(cfg)}\n\nBuilt-ins: !remember !recall !memory !history !run <id> !automations !pipelines !pipeline <id> <goal>`;
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
      }

      // 2) Always-on mention / DM / allowlisted channel
      const mentioned = msg.mentions.has(client.user);
      const isDM = !msg.guild;
      const inListen = cfg.discord.listenChannels.length === 0
        ? false
        : cfg.discord.listenChannels.includes(msg.channelId);
      if (!(mentioned || isDM || inListen)) return;

      const prompt = text
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim() || "Hello";
      // Brain inbox (reference: PRD 4.7 Brain messages table + metrics).
      // Every inbound mention/DM is filed; status flips as Rick replies/fails.
      let brainId = null;
      try {
        brainId = fileBrainMessage(cfg.root, {
          jobId: msg.id || "", actorId: msg.author?.id || "", conversationId: msg.channelId || "",
          sender: msg.author?.tag || "discord", source: isDM ? "dm" : "discord",
          messageText: prompt.slice(0, 4000), processingStatus: "running",
        });
      } catch {}
      await msg.channel.sendTyping().catch(() => {});
      // Rick: classify simple-fact vs big-task; pipelines report back in-channel.
      // Inbound carries the job link: handleRickMessage returns { jobId } for
      // queued launches; the worker's deliverDiscordCompletion posts the ACTUAL
      // result back to this channel/thread on completion (payload channelId +
      // messageId). The brain row stays "running" until the worker finishes —
      // awaiting the queue handle does NOT mark fake complete status.
      try {
        const res = await handleRickMessage(cfg, deps, msg, prompt);
        const jobId = res?.jobId || res?.runId || null;
        try {
          if (brainId) {
            if (jobId && res?.status === "queued") {
              updateBrainMessage(cfg.root, brainId, { processingStatus: "running", linkedTaskId: String(jobId), outboxSummary: `queued ${jobId}` });
            } else if (res && !String(res.kind || "").startsWith("dup") && res.kind !== "clarify" && res.kind !== "list") {
              updateBrainMessage(cfg.root, brainId, { processingStatus: "reply_generated", outboxSummary: "1 sent" });
            } else {
              updateBrainMessage(cfg.root, brainId, { processingStatus: "reply_generated", outboxSummary: "1 sent" });
            }
          }
        } catch {}
      } catch (err) {
        try { if (brainId) updateBrainMessage(cfg.root, brainId, { processingStatus: "failed", processingError: String(err.message).slice(0, 1000) }); } catch { /* best effort */ }
        // Deduped outbox (no fake success): the worker delivers via real sendDiscord.
        try { queueOutboxDeduped(cfg.root, { channel: msg.channelId, text: `Brain turn failed for ${msg.author?.tag || "user"}: ${String(err.message).slice(0, 300)}` }); } catch { /* best effort */ }
        throw err;
      }
      return;
    } catch (err) {
      deps.log?.(`[discord] message handler failed: ${err.message}`);
      try { await msg.reply("Sorry — that failed. Check the Tab logs."); } catch {}
    }
  });

  client.login(cfg.discord.token).catch((err) => {
    deps.log?.(`[discord] login failed: ${err.message}`);
    process.exitCode = 1;
  });

  const sendDiscord = async (channelOverride, message) => {
    const channelId = channelOverride || cfg.discord.channelId;
    if (!channelId) {
      deps.log?.(`[discord] no channel configured, message dropped: ${message.slice(0, 120)}`);
      return;
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);
    for (const part of chunk(message)) await channel.send(part);
  };
onLoopEvent((ev) => { postLoopResult(cfg, sendDiscord, ev).catch((e) => deps.log?.(`[discord] pipeline report failed: ${e.message}`)); });

  
  return { client, sendDiscord };
}

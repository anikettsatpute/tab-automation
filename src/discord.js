import { Client, GatewayIntentBits, Events } from "discord.js";
import { chatWithTools } from "./agent.js";
import { chunk } from "./workflow.js";
import { saveMemory, searchMemory, formatMemories, memoryStats } from "./memory.js";
import { handleRickMessage, workflowCatalog } from "./planner.js";
import { listRuns, getRun, addTodo, listTodos, completeTodo, addReminder, listReminders, fileBrainMessage, updateBrainMessage, queueOutbox } from "./db.js";

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
          const reply = `⚙️ Automations (say "run <id>" or \`!<command>\`):\n${workflowCatalog(cfg)}`;
          for (const part of chunk(reply)) await msg.reply(part);
          return;
        }
        const wf = cfg.workflows.find(
          (w) => w.trigger?.type === "discord" && w.trigger?.command === cmd
        );
        if (wf) {
          await msg.channel.sendTyping().catch(() => {});
          const replyTo = async (t) => { for (const part of chunk(t)) await msg.reply(part); };
          await deps.runWorkflow(wf, {
            kind: "discord",
            command: cmd,
            text: rest.join(" "),
            user: msg.author.tag,
            channelId: msg.channelId,
          }, msg.channelId, replyTo);
          return;
        }
        // Unknown !command: don't silently ignore — show what's actually available
        {
          const reply = `❓ Unknown command \`!${cmd}\`.\n\n⚙️ Automations:\n${workflowCatalog(cfg)}\n\nBuilt-ins: !remember !recall !memory !history !run <id> !automations`;
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
      // Rick: classify simple-fact vs big-task; pipelines report back in-channel
      try {
        await handleRickMessage(cfg, deps, msg, prompt);
        try { if (brainId) updateBrainMessage(cfg.root, brainId, { processingStatus: "reply_generated", outboxSummary: "1 sent" }); } catch {}
      } catch (err) {
        try { if (brainId) updateBrainMessage(cfg.root, brainId, { processingStatus: "failed", processingError: String(err.message).slice(0, 1000) }); } catch {}
        try { queueOutbox(cfg.root, { channel: msg.channelId, text: `Brain turn failed for ${msg.author?.tag || "user"}: ${String(err.message).slice(0, 300)}` }); } catch {}
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

  return { client, sendDiscord };
}

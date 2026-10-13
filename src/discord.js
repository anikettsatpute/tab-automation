import { Client, GatewayIntentBits, Events } from "discord.js";
import { chatWithTools } from "./agent.js";
import { chunk } from "./workflow.js";
import { saveMemory, searchMemory, formatMemories, memoryStats } from "./memory.js";

export function startDiscord(cfg, deps) {
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
      const text = (msg.content ?? "").trim();
      if (!text) return;

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
        const wf = cfg.workflows.find(
          (w) => w.trigger?.type === "discord" && w.trigger?.command === cmd
        );
        if (wf) {
          await msg.channel.sendTyping().catch(() => {});
          await deps.runWorkflow(wf, {
            kind: "discord",
            command: cmd,
            text: rest.join(" "),
            user: msg.author.tag,
            channelId: msg.channelId,
          }, msg.channelId);
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
      await msg.channel.sendTyping().catch(() => {});
      // Persist + recall: every mention/DM is saved, relevant past context is injected
      saveMemory(cfg.root, { kind: "chat", user: msg.author.tag, text: prompt, channelId: msg.channelId });
      const hits = searchMemory(cfg.root, prompt, 5).filter((h) => h.text !== prompt);
      const memCtx = formatMemories(hits);
      const reply = await chatWithTools(cfg, "assistant", `User ${msg.author.tag} says: ${prompt}`, { extraContext: memCtx });
      saveMemory(cfg.root, { kind: "reply", user: "TabBot", text: reply.slice(0, 500), channelId: msg.channelId });
      for (const part of chunk(reply)) await msg.reply(part);
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

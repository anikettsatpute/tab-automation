import { Client, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";

const { cfg, errors } = loadConfig();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const text = process.argv.slice(2).join(" ") || "test";
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", async (c) => {
  try {
    const ch = await c.channels.fetch(cfg.discord.channelId);
    await ch.send(text);
    console.log("SENT-OK");
  } catch (err) {
    console.error("SEND-FAIL:", err.message);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});
await client.login(cfg.discord.token);

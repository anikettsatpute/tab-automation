import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const root = process.cwd();
loadEnv({ path: path.join(root, ".env") });
loadEnv({ path: path.join(root, ".env.local") }); // allow reuse of Harness creds file

function readJson(rel) {
  const p = path.join(root, rel);
  if (!existsSync(p)) throw new Error(`Missing config file: ${rel}`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

function str(name, fallback = "") {
  const raw = process.env[name] ?? process.env[name.toLowerCase()] ?? fallback;
  return String(raw).trim();
}

export function loadConfig() {
  const agentsDoc = readJson("config/agents.json");
  const workflowsDoc = readJson("config/workflows.json");

  const agents = new Map((agentsDoc.agents ?? []).map((a) => [a.id, a]));
  const workflows = workflowsDoc.workflows ?? [];

  const cfg = {
    root,
    discord: {
      token: str("DISCORD_BOT_TOKEN"),
      applicationId: str("DISCORD_APPLICATION_ID"),
      guildId: str("DISCORD_GUILD_ID"),
      channelId: str("DISCORD_CHANNEL_ID"),
      financeChannelId: str("FINANCE_CHANNEL_ID") || str("DISCORD_CHANNEL_ID"),
      listenChannels: str("DISCORD_LISTEN_CHANNELS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    azure: {
      endpoint: str("AZURE_OPENAI_ENDPOINT").replace(/\/$/, ""),
      apiKey: str("AZURE_OPENAI_API_KEY"),
      deployment: str("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini"),
      apiVersion: str("AZURE_OPENAI_API_VERSION", "2024-10-21"),
    },
    agents,
    workflows,
  };

  const errors = [];
  if (!cfg.discord.token) errors.push("DISCORD_BOT_TOKEN is missing");
  if (!cfg.azure.endpoint) errors.push("AZURE_OPENAI_ENDPOINT is missing");
  if (!cfg.azure.apiKey) errors.push("AZURE_OPENAI_API_KEY is missing");
  if (agents.size === 0) errors.push("config/agents.json has no agents");
  if (workflows.length === 0) errors.push("config/workflows.json has no workflows");

  // duplicate / dangling checks
  const ids = new Set();
  for (const w of workflows) {
    if (!w.id) errors.push("A workflow is missing id");
    else if (ids.has(w.id)) errors.push(`Duplicate workflow id: ${w.id}`);
    else ids.add(w.id);
    const walk = (steps = []) => {
      for (const s of steps) {
        if (s.type === "agent" && s.agent && !agents.has(s.agent)) {
          errors.push(`Workflow ${w.id}: step ${s.id} references unknown agent '${s.agent}'`);
        }
        if (s.then) walk(s.then);
        if (s.else) walk(s.else);
      }
    };
    walk(w.steps);
  }

  return { cfg, errors };
}

export function resolveDeployment(agent, fallback) {
  let d = (agent?.deployment ?? "").trim();
  if (!d) return fallback;
  if (d.startsWith("env:")) {
    const v = (process.env[d.slice(4)] ?? "").trim();
    return v || fallback;
  }
  return d;
}

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

function readJsonOptional(rel, fallback) {
  const p = path.join(root, rel);
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

function str(name, fallback = "") {
  const raw = process.env[name] ?? process.env[name.toLowerCase()] ?? fallback;
  return String(raw).trim();
}

export function loadConfig() {
  const agentsDoc = readJson("config/agents.json");
  const workflowsDoc = readJson("config/workflows.json");
  const providersDoc = readJsonOptional("config/providers.json", { providers: [] });
  const toolsDoc = readJsonOptional("config/tools.json", { servers: [] });
  const discordDoc = readJsonOptional("config/discord.json", {});

  const agents = new Map((agentsDoc.agents ?? []).map((a) => [a.id, a]));
  const workflows = workflowsDoc.workflows ?? [];

  const cfg = {
    root,
    discord: {
      token: str("DISCORD_BOT_TOKEN"),
      applicationId: str("DISCORD_APPLICATION_ID"),
      guildId: str("DISCORD_GUILD_ID"),
      channelId: str("DISCORD_CHANNEL_ID") || discordDoc.mainChannelId || "",
      financeChannelId: str("FINANCE_CHANNEL_ID") || str("DISCORD_CHANNEL_ID") || discordDoc.mainChannelId || "",
      listenChannels: str("DISCORD_LISTEN_CHANNELS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      ownerUserId: str("DISCORD_OWNER_USER_ID") || discordDoc.ownerUserId || "",
      extraChannels: discordDoc.extraChannels ?? [],
    },
    azure: {
      endpoint: str("AZURE_OPENAI_ENDPOINT").replace(/\/$/, ""),
      apiKey: str("AZURE_OPENAI_API_KEY"),
      deployment: str("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini"),
      apiVersion: str("AZURE_OPENAI_API_VERSION", "2024-10-21"),
    },
    providers: providersDoc.providers ?? [],
    defaultProvider: providersDoc.defaultProvider || "azure",
    mcpServers: toolsDoc.servers ?? [],
    agents,
    workflows,
  };

  const errors = [];
  if (!cfg.discord.token) errors.push("DISCORD_BOT_TOKEN is missing");
  // Provider creds: at least one provider must be usable (azure legacy OR providers.json entry with key)
  const hasAzure = Boolean(cfg.azure.endpoint && cfg.azure.apiKey);
  const hasOtherProvider = (cfg.providers ?? []).some((p) => {
    const keyEnv = p.keyEnv || "";
    return keyEnv && String(process.env[keyEnv] ?? "").trim();
  });
  if (!hasAzure && !hasOtherProvider) errors.push("No provider credentials: set AZURE_OPENAI_* or add providers.json + key env");
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
        if (s.type === "subflow" && s.workflow === w.id) {
          errors.push(`Workflow ${w.id}: step ${s.id} calls itself as subflow (banned)`);
        }
        if (s.type === "agent" && s.output === "json" && s.outputSchema) {
          const v = validateOutputSchema(s.outputSchema);
          if (v) errors.push(`Workflow ${w.id}: step ${s.id} bad outputSchema: ${v}`);
        }
        if (s.then) walk(s.then);
        if (s.else) walk(s.else);
      }
    };
    walk(w.steps);
  }

  return { cfg, errors };
}

const SCHEMA_TYPES = new Set(["bool", "int", "string"]);

function validateOutputSchema(schema) {
  if (!schema || typeof schema !== "object") return "must be an object";
  const keys = Object.keys(schema);
  if (keys.length === 0) return "must define at least 1 var";
  if (keys.length > 8) return `max 8 vars, got ${keys.length}`;
  for (const k of keys) {
    if (!SCHEMA_TYPES.has(schema[k])) return `var '${k}' must be bool|int|string, got '${schema[k]}'`;
  }
  return null;
}

export function resolveDeployment(agent, fallback) {
  let d = (agent?.deployment ?? agent?.model ?? "").trim();
  if (!d) return fallback;
  if (d.startsWith("env:")) {
    const v = (process.env[d.slice(4)] ?? "").trim();
    return v || fallback;
  }
  return d;
}

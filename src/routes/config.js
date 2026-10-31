// Control routes: configuration — providers, agents, streams, KV + test dispatch.
// Model selection lives here: agent.provider -> providers.json, agent.model override,
// per-call model override in dispatchAgent. Hot-reloads cfg in place.
import { getConfig, setConfig, writeLog, listAutomations } from "../db.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../loop/workspace.js";

const REDACTED = "••••••";
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SNOWFLAKE_RE = /^\d{5,25}$/;
const PROVIDER_TYPES = new Set(["azure-foundry", "openrouter", "meta", "muse"]);

/** The GET endpoint masks secret-looking values; a save must never write the
 *  mask back to disk. Any "••••••" in the incoming doc is replaced with the
 *  on-disk value at the same path (arrays matched by item id). */
export function unredact(incoming, onDisk) {
  if (incoming === REDACTED) return onDisk;
  if (Array.isArray(incoming)) {
    const byId = new Map((Array.isArray(onDisk) ? onDisk : []).filter((x) => x && x.id).map((x) => [x.id, x]));
    return incoming.map((x, i) => unredact(x, x && x.id ? byId.get(x.id) : (Array.isArray(onDisk) ? onDisk[i] : undefined)));
  }
  if (incoming && typeof incoming === "object") {
    const out = {};
    for (const [k, v] of Object.entries(incoming)) {
      const prev = onDisk && typeof onDisk === "object" ? onDisk[k] : undefined;
      if (v === REDACTED && prev === undefined) continue; // never persist a bare mask
      out[k] = unredact(v, prev);
    }
    return out;
  }
  return incoming;
}

export function validateProviders(doc) {
  const seen = new Set();
  for (const p of doc.providers ?? []) {
    if (!p || !ID_RE.test(String(p.id || ""))) return `provider id '${p?.id ?? ""}' must be lowercase letters/digits/-/_`;
    if (seen.has(p.id)) return `duplicate provider '${p.id}'`;
    seen.add(p.id);
    if (!PROVIDER_TYPES.has(p.type)) return `provider ${p.id}: unknown type '${p.type}'`;
    if (p.keyEnv && !ENV_RE.test(p.keyEnv)) return `provider ${p.id}: keyEnv must be an env var NAME like MY_API_KEY`;
    if (p.endpoint && !/^https:\/\/[^\s]+$/.test(p.endpoint)) return `provider ${p.id}: endpoint must be an https URL`;
    if (p.models && (!Array.isArray(p.models) || p.models.some((m) => !/^[A-Za-z0-9._:/-]{1,80}$/.test(String(m))))) return `provider ${p.id}: models must be a list of model ids`;
  }
  if (doc.defaultProvider && !seen.has(doc.defaultProvider)) return `default provider '${doc.defaultProvider}' is not defined`;
  return null;
}

export function validateAgents(doc, providerIds) {
  const seen = new Set();
  for (const a of doc.agents ?? []) {
    if (!a || !ID_RE.test(String(a.id || ""))) return `agent id '${a?.id ?? ""}' must be lowercase letters/digits/-/_`;
    if (seen.has(a.id)) return `duplicate agent '${a.id}'`;
    seen.add(a.id);
    if (!String(a.systemPrompt || "").trim()) return `agent ${a.id}: systemPrompt required`;
    if (a.provider && !providerIds.has(a.provider)) return `agent ${a.id}: unknown provider ${a.provider}`;
    if (a.temperature != null && a.temperature !== "" && !(Number(a.temperature) >= 0 && Number(a.temperature) <= 2)) return `agent ${a.id}: temperature must be 0–2`;
  }
  return null;
}

/** Agents still referenced by pipelines/automations cannot be deleted. */
function agentRefs(root, cfg) {
  const refs = new Map();
  const add = (agent, where) => { if (agent) refs.set(agent, [...(refs.get(agent) || []), where]); };
  for (const t of readCfg(root, "config/task-types.json", { taskTypes: [] }).taskTypes || []) for (const s of t.steps || []) add(s.role, `pipeline ${t.id}`);
  const walk = (wid, steps = []) => { for (const s of steps) { add(s.agent, `automation ${wid}`); walk(wid, s.then); walk(wid, s.else); } };
  for (const w of cfg.workflows || []) walk(w.id, w.steps);
  try { for (const a of listAutomations(root)) walk(a.id, a.steps); } catch { /* DB optional */ }
  return refs;
}

function readCfg(root, rel, fallback) {
  const p = path.join(root, rel);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
const writeCfg = (root, rel, obj) => atomicWrite(path.join(root, rel), JSON.stringify(obj, null, 2) + "\n");

function discordView(root, cfg) {
  const doc = readCfg(root, "config/discord.json", {});
  const env = (n) => !!String(process.env[n] || "").trim();
  return {
    mainChannelId: doc.mainChannelId || "", extraChannels: doc.extraChannels || [],
    ownerUserId: doc.ownerUserId || "", guildId: doc.guildId || "",
    // Secrets never leave the server: only report whether they are set.
    tokenSet: env("DISCORD_BOT_TOKEN"),
    envOverrides: { mainChannelId: env("DISCORD_CHANNEL_ID"), ownerUserId: env("DISCORD_OWNER_USER_ID"), guildId: env("DISCORD_GUILD_ID") },
    effective: { channelId: cfg.discord?.channelId || "", ownerUserId: cfg.discord?.ownerUserId || "" },
  };
}

export function registerConfigRoutes(app, ctx) {
  const { root, cfg } = ctx;

  app.get("/api/control/config", async (c) => {
    try {
      // Config truthfulness: secrets never leave the server. keyEnv names are
      // safe (env names, not values); any embedded secret-looking values redacted.
      const { redactConfig } = await import("../services/access.js");
      const providers = readCfg(root, "config/providers.json", { defaultProvider: "azure", providers: [] });
      return c.json({
        ok: true,
        providers: {
          ...redactConfig(providers),
          // keyEnv is a NAME; report only whether its value is set.
          keyStatus: Object.fromEntries((providers.providers || []).map((p) => [p.id, !!(p.keyEnv && String(process.env[p.keyEnv] || "").trim())])),
        },
        agents: redactConfig(readCfg(root, "config/agents.json", { agents: [] })),
        streams: readCfg(root, "config/streams.json", { streams: [], pipelines: [] }),
        discord: discordView(root, cfg),
        kv: { providerDefault: getConfig(root, "provider.default", ""), modelDefault: getConfig(root, "model.default", "") },
        access: { tokenRequired: !!(process.env.CONTROL_TOKEN || "").trim(), local: true },
      });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  const guardAll = async (c) => {
    const { mutationGuard, originCheck } = await import("../services/access.js");
    const o = originCheck(c);
    if (!o.ok) return c.json({ error: o.error }, o.status);
    const g = mutationGuard(c);
    return g.ok ? null : c.json({ error: g.error }, g.status);
  };

  app.post("/api/control/config", async (c) => {
    const denied = await guardAll(c); if (denied) return denied;
    const { auditActor } = await import("../services/access.js");
    try {
      const body = await c.req.json().catch(() => ({}));
      const { kv } = body;
      let providers = null; let agents = null;
      if (body.providers) {
        const disk = readCfg(root, "config/providers.json", { providers: [] });
        const { keyStatus: _ks, ...rest } = body.providers;
        providers = unredact(rest, disk);
        const err = validateProviders(providers);
        if (err) return c.json({ error: err }, 400);
      }
      if (body.agents) {
        agents = unredact(body.agents, readCfg(root, "config/agents.json", { agents: [] }));
        for (const a of agents.agents ?? []) if (a.temperature === "" || a.temperature == null) delete a.temperature; else a.temperature = Number(a.temperature);
        const provIds = new Set(((providers || { providers: cfg.providers }).providers ?? []).map((p) => p.id));
        const err = validateAgents(agents, provIds);
        if (err) return c.json({ error: err }, 400);
        const keep = new Set((agents.agents ?? []).map((a) => a.id));
        for (const [id, where] of agentRefs(root, cfg)) {
          if (!keep.has(id) && cfg.agents?.has?.(id)) return c.json({ error: `agent ${id} is still used by ${where.slice(0, 3).join(", ")} — remove it there first` }, 409);
        }
      }
      if (providers) {
        writeCfg(root, "config/providers.json", providers);
        // Mutate in place: the loop engine holds a shallow copy of cfg.
        if (Array.isArray(cfg.providers)) cfg.providers.splice(0, cfg.providers.length, ...(providers.providers ?? []));
        else cfg.providers = providers.providers ?? [];
        cfg.defaultProvider = providers.defaultProvider || "azure";
      }
      if (agents) {
        writeCfg(root, "config/agents.json", agents);
        if (cfg.agents instanceof Map) { cfg.agents.clear(); for (const a of agents.agents ?? []) cfg.agents.set(a.id, a); }
        else cfg.agents = new Map((agents.agents ?? []).map((a) => [a.id, a]));
      }
      if (kv) for (const [k, v] of Object.entries(kv)) setConfig(root, k, String(v));
      const { audit } = await import("../db.js");
      audit(root, { actor: auditActor(c), action: "config.update", target: "config", detail: [providers ? "providers" : "", agents ? "agents" : "", kv ? "kv" : ""].filter(Boolean).join(",") });
      writeLog(root, { level: "info", source: "dashboard-config", message: "configuration updated" });
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Discord routing config (channel/guild/owner ids). The bot token stays in
  // .env and is never read or written here.
  app.get("/api/control/config/discord", (c) => c.json({ ok: true, discord: discordView(root, cfg) }));
  app.post("/api/control/config/discord", async (c) => {
    const denied = await guardAll(c); if (denied) return denied;
    const { auditActor } = await import("../services/access.js");
    try {
      const b = await c.req.json().catch(() => ({}));
      const ids = { mainChannelId: String(b.mainChannelId || "").trim(), ownerUserId: String(b.ownerUserId || "").trim(), guildId: String(b.guildId || "").trim() };
      for (const [k, v] of Object.entries(ids)) if (v && !SNOWFLAKE_RE.test(v)) return c.json({ error: `${k} must be a numeric Discord id` }, 400);
      const extra = (Array.isArray(b.extraChannels) ? b.extraChannels : String(b.extraChannels || "").split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
      if (extra.length > 20 || extra.some((v) => !SNOWFLAKE_RE.test(v))) return c.json({ error: "extraChannels must be up to 20 numeric Discord ids" }, 400);
      const doc = { ...readCfg(root, "config/discord.json", {}), ...ids, extraChannels: extra };
      writeCfg(root, "config/discord.json", doc);
      // Hot-apply where no env var overrides the file value.
      if (cfg.discord) {
        if (!String(process.env.DISCORD_CHANNEL_ID || "").trim()) cfg.discord.channelId = doc.mainChannelId;
        if (!String(process.env.DISCORD_OWNER_USER_ID || "").trim()) cfg.discord.ownerUserId = doc.ownerUserId;
        cfg.discord.extraChannels = extra;
      }
      const { audit } = await import("../db.js");
      audit(root, { actor: auditActor(c), action: "config.discord", target: "discord", detail: "ids updated" });
      return c.json({ ok: true, discord: discordView(root, cfg) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/config/test", async (c) => {
    const { mutationGuard } = await import("../services/access.js");
    const g = mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { agent, model, prompt } = await c.req.json().catch(() => ({}));
      if (!agent) return c.json({ error: "agent required" }, 400);
      // Fail closed: test dispatch goes through the provider gate (muse only).
      const { gateProvider } = await import("../services/provider-gate.js");
      try { gateProvider(cfg, agent); } catch (e) { return c.json({ error: e.message }, 403); }
      const { dispatchAgent } = await import("../agent.js");
      const out = await dispatchAgent(cfg, { agent, model: model || "", prompt: prompt || "" });
      return c.json({ ok: true, output: String(out?.raw || out).slice(0, 4000) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/audit", async (c) => {
    try {
      const { listAudit } = await import("../db.js");
      return c.json({ ok: true, audit: listAudit(root, { limit: Math.min(Number(c.req.query("limit")) || 100, 500) }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

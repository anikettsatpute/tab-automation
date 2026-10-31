// Control routes: configuration — providers, agents, streams, KV + test dispatch.
// Model selection lives here: agent.provider -> providers.json, agent.model override,
// per-call model override in dispatchAgent. Hot-reloads cfg in place.
import { getConfig, setConfig, writeLog } from "../db.js";
import { loadJson, saveJson } from "../setup-api.js";

export function registerConfigRoutes(app, ctx) {
  const { root, cfg } = ctx;

  app.get("/api/control/config", async (c) => {
    try {
      // Config truthfulness: secrets never leave the server. keyEnv names are
      // safe (env names, not values); any embedded secret-looking values redacted.
      const { redactConfig } = await import("../services/access.js");
      return c.json({
        ok: true,
        providers: redactConfig(loadJson("config/providers.json", { defaultProvider: "azure", providers: [] })),
        agents: redactConfig(loadJson("config/agents.json", { agents: [] })),
        streams: loadJson("config/streams.json", { streams: [], pipelines: [] }),
        kv: { providerDefault: getConfig(root, "provider.default", ""), modelDefault: getConfig(root, "model.default", "") },
        access: { tokenRequired: !!(process.env.CONTROL_TOKEN || "").trim(), local: true },
      });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/config", async (c) => {
    const { mutationGuard, originCheck, auditActor } = await import("../services/access.js");
    const o = originCheck(c);
    if (!o.ok) return c.json({ error: o.error }, o.status);
    const g = mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { providers, agents, kv } = await c.req.json().catch(() => ({}));
      if (providers) {
        const types = new Set(["azure-foundry", "openrouter", "meta", "muse"]);
        for (const p of providers.providers ?? []) {
          if (!p.id) return c.json({ error: "provider missing id" }, 400);
          if (p.type && !types.has(p.type)) return c.json({ error: `provider ${p.id}: unknown type ${p.type}` }, 400);
        }
        saveJson("config/providers.json", providers);
        cfg.providers = providers.providers ?? [];
        cfg.defaultProvider = providers.defaultProvider || "azure";
      }
      if (agents) {
        for (const a of agents.agents ?? []) {
          if (!a.id || !a.systemPrompt) return c.json({ error: `agent missing id/systemPrompt` }, 400);
          if (a.provider) {
            const ids = new Set((cfg.providers ?? []).map((p) => p.id));
            if (!ids.has(a.provider)) return c.json({ error: `agent ${a.id}: unknown provider ${a.provider}` }, 400);
          }
        }
        saveJson("config/agents.json", agents);
        cfg.agents = new Map((agents.agents ?? []).map((a) => [a.id, a]));
      }
      if (kv) for (const [k, v] of Object.entries(kv)) setConfig(root, k, String(v));
      const { audit } = await import("../db.js");
      audit(root, { actor: auditActor(c), action: "config.update", target: "config", detail: [providers ? "providers" : "", agents ? "agents" : "", kv ? "kv" : ""].filter(Boolean).join(",") });
      writeLog(root, { level: "info", source: "dashboard-config", message: "configuration updated" });
      return c.json({ ok: true });
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

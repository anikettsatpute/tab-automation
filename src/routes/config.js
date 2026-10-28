// Control routes: configuration — providers, agents, streams, KV + test dispatch.
// Model selection lives here: agent.provider -> providers.json, agent.model override,
// per-call model override in dispatchAgent. Hot-reloads cfg in place.
import { getConfig, setConfig, writeLog } from "../db.js";
import { loadJson, saveJson } from "../setup-api.js";

export function registerConfigRoutes(app, ctx) {
  const { root, cfg } = ctx;

  app.get("/api/control/config", (c) => {
    try {
      return c.json({
        ok: true,
        providers: loadJson("config/providers.json", { defaultProvider: "azure", providers: [] }),
        agents: loadJson("config/agents.json", { agents: [] }),
        streams: loadJson("config/streams.json", { streams: [], pipelines: [] }),
        kv: { providerDefault: getConfig(root, "provider.default", ""), modelDefault: getConfig(root, "model.default", "") },
      });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/config", async (c) => {
    try {
      const { providers, agents, kv } = await c.req.json().catch(() => ({}));
      if (providers) {
        const types = new Set(["azure-foundry", "openrouter", "meta"]);
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
      writeLog(root, { level: "info", source: "dashboard-config", message: "configuration updated" });
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/config/test", async (c) => {
    try {
      const { agent, model, prompt } = await c.req.json().catch(() => ({}));
      if (!agent) return c.json({ error: "agent required" }, 400);
      const { dispatchAgent } = await import("../agent.js");
      const out = await dispatchAgent(cfg, { agent, model: model || "", prompt: prompt || "" });
      return c.json({ ok: true, output: String(out).slice(0, 4000) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

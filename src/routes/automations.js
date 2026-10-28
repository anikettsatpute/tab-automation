// Control routes: automations (DB-backed flows + config fallback) + todos convert.
import {
  listRuns, listAutomations, saveAutomation, deleteAutomation,
  setAutomationEnabled, markAutomationRun, dismissTodo, getTodo, fileRequest,
} from "../db.js";
import { loadJson } from "../setup-api.js";

export function registerAutomationRoutes(app, ctx) {
  const { root, cfg, log } = ctx;

  app.get("/api/control/automations", (c) => {
    try {
      const dbFlows = listAutomations(root);
      if (dbFlows.length) {
        return c.json({
          ok: true, source: "db", flows: dbFlows.map((a) => ({
            id: a.id, title: a.name, description: a.description,
            configFileName: `${a.id}.json`, enabled: a.enabled,
            trigger: { type: a.trigger_type, ...(a.trigger_config || {}) },
            steps: (a.steps || []).map((s, i) => ({ id: s.id, type: s.type, title: s.title || `${s.type} ${i + 1}`, details: s.details || JSON.stringify(s).slice(0, 200) })),
            state: a.state,
          })),
        });
      }
      const workflows = loadJson("config/workflows.json", { workflows: [] });
      const runs = listRuns(root, { limit: 50 });
      const lastByWf = new Map();
      for (const r of runs) if (!lastByWf.has(r.workflow_id)) lastByWf.set(r.workflow_id, r);
      const flows = (workflows.workflows || []).map((w) => {
        const last = lastByWf.get(w.id);
        return {
          id: w.id, title: w.id, description: w.description || "", configFileName: `${w.id}.json`,
          enabled: w.enabled !== false,
          trigger: { type: w.trigger?.type || "manual", cron: w.trigger?.cron || "", command: w.trigger?.command || "" },
          steps: (w.steps || []).map((s) => ({ id: s.id, type: s.type, title: `${s.type}: ${s.id}`, details: (s.prompt || s.message || s.text || "").slice(0, 200), agent: s.agent || null })),
          lastStatus: last?.status || null, lastRunAt: last?.started_at || null,
        };
      });
      return c.json({ ok: true, source: "config", flows });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/automations", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      if (!b.id && !b.title && !b.name) return c.json({ error: "id or title required" }, 400);
      const id = saveAutomation(root, {
        id: b.id || b.title || b.name,
        name: b.title || b.name || b.id,
        description: b.description || "",
        trigger_type: b.trigger?.type || b.trigger_type || "manual",
        trigger_config: { ...(b.trigger || {}), ...(b.trigger_config || {}) },
        steps: (b.steps || []).map((s, i) => ({ id: s.id || `step-${i + 1}`, type: s.type || "agent", title: s.title || "", details: s.details || "", ...s })),
        enabled: b.enabled !== false,
      });
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/automations/:id/run", async (c) => {
    try {
      const id = c.req.param("id");
      const { runWorkflow } = await import("../workflow.js");
      const auto = listAutomations(root).find((a) => a.id === id);
      const steps = auto?.steps?.length ? auto.steps.map((s) => ({ id: s.id, type: s.type, ...s })) : null;
      const wf = steps ? { id, name: auto.name, steps } : (cfg.workflows || []).find((w) => w.id === id);
      if (!wf) return c.json({ error: "not found" }, 404);
      const ctx2 = await runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, { kind: "dashboard-flow", automation: id });
      try { markAutomationRun(root, id, { status: "done", runId: ctx2._runId || null }); } catch {}
      return c.json({ ok: true, runId: ctx2._runId || null });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/automations/:id/enable", async (c) => {
    try {
      const { enabled } = await c.req.json().catch(() => ({}));
      setAutomationEnabled(root, c.req.param("id"), enabled !== false);
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/automations/:id/delete", async (c) => {
    try { deleteAutomation(root, c.req.param("id")); return c.json({ ok: true }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/todos/dismiss", async (c) => {
    try {
      const { id } = await c.req.json().catch(() => ({}));
      return c.json({ ok: dismissTodo(root, id) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/todos/convert", async (c) => {
    try {
      const { id } = await c.req.json().catch(() => ({}));
      const t = getTodo(root, id);
      if (!t) return c.json({ error: "not found" }, 404);
      const requestId = fileRequest(root, { text: t.text, mode: "request", repo: "tab-automation", taskType: "let_divider_choose", pipeline: [] });
      return c.json({ ok: true, requestId });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

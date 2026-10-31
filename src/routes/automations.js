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
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const b = await c.req.json().catch(() => ({}));
      if (!b.id && !b.title && !b.name) return c.json({ error: "id or title required" }, 400);
      const ttype = b.trigger?.type || b.trigger_type || "manual";
      if (ttype === "discord") {
        const cmd = String(b.trigger?.command || b.trigger_config?.command || "");
        if (!/^[a-z][a-z0-9_-]{0,23}$/.test(cmd)) return c.json({ error: "discord trigger needs a command like 'haiku' (lowercase, no '!')" }, 400);
        const BUILTIN = ["remember", "recall", "memory", "history", "run", "todo", "todos", "done", "digest", "remind", "reminders", "automations", "workflows", "list", "pipelines", "pipeline"];
        if (BUILTIN.includes(cmd)) return c.json({ error: `!${cmd} is a built-in command` }, 400);
        const id = b.id || b.title || b.name;
        const clash = listAutomations(root).find((a) => a.id !== id && a.trigger_type === "discord" && a.trigger_config?.command === cmd);
        if (clash) return c.json({ error: `!${cmd} is already used by ${clash.id}` }, 409);
      }
      for (const s of b.steps || []) {
        if ((s.type === "agent" || s.type === "run_agent") && s.agent && cfg.agents && !cfg.agents.has(s.agent)) return c.json({ error: `step ${s.id}: unknown agent '${s.agent}'` }, 400);
      }
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
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const id = c.req.param("id");
      const { idempotencyKey } = await c.req.json().catch(() => ({}));
      const auto = listAutomations(root).find((a) => a.id === id);
      const wf = auto ? { id } : (cfg.workflows || []).find((w) => w.id === id);
      if (!wf) return c.json({ error: "not found" }, 404);
      const { enqueueJobSync, audit } = await import("../db.js");
      const { id: jobId, deduped, job } = enqueueJobSync(root, {
        kind: "automation", payload: { automationId: id }, idempotencyKey: idempotencyKey || null,
      });
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: "automation.run.enqueue", target: id, detail: `job ${jobId}` });
      return c.json({ ok: true, jobId, deduped: !!deduped, status: job.status, hint: "202 accepted — poll /api/control/jobs/:id for runId" }, deduped ? 200 : 202);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Dry-run: real non-side-effect simulation, step-by-step trace. Never a fake success.
  app.post("/api/control/automations/:id/dry-run", async (c) => {
    try {
      const id = c.req.param("id");
      const auto = listAutomations(root).find((a) => a.id === id);
      const steps = auto?.steps?.length ? auto.steps.map((s) => ({ id: s.id, type: s.type, ...s })) : null;
      const wf = steps ? { id, name: auto.name, steps } : (cfg.workflows || []).find((w) => w.id === id);
      if (!wf) return c.json({ error: "not found" }, 404);
      const { dryRunAutomation } = await import("../services/triggers.js");
      return c.json({ ok: true, dryRun: true, ...dryRunAutomation(wf) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Next-run: backend-computed from cron/everyMinutes + timezone label.
  app.get("/api/control/automations/:id/next-run", async (c) => {
    try {
      const auto = listAutomations(root).find((a) => a.id === c.req.param("id"));
      if (!auto) return c.json({ error: "not found" }, 404);
      const { describeTrigger } = await import("../services/triggers.js");
      const d = describeTrigger(auto.trigger_type, auto.trigger_config || {});
      if (!d.ok) return c.json({ ok: false, automation: auto.id, error: d.error }, 400);
      return c.json({ ok: true, automation: auto.id, trigger: { type: auto.trigger_type, ...(auto.trigger_config || {}) }, ...d, state: auto.state || null });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Trigger validation on save: invalid cron / unsupported event rejected
  // with field errors (never silently succeeding).
  app.post("/api/control/automations/validate", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const { describeTrigger } = await import("../services/triggers.js");
      const d = describeTrigger(b.trigger?.type || b.trigger_type || "manual", { ...(b.trigger || {}), ...(b.trigger_config || {}) });
      if (!d.ok) return c.json({ ok: false, error: d.error }, 400);
      return c.json({ ok: true, ...d });
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

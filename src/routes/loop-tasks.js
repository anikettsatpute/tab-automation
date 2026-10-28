// Control routes: loop task tables — tasks + task_steps first-class tables.
import { createTask, listTasks, getTaskWithSteps, saveTaskSteps, updateTask, writeLog } from "../db.js";

export function registerLoopTaskRoutes(app, ctx) {
  const { root, cfg } = ctx;

  app.get("/api/control/loop-tasks", (c) => {
    try {
      const status = c.req.query("status") || null;
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
      return c.json({ ok: true, tasks: listTasks(root, { status, limit }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/loop-tasks", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      if (!b.title) return c.json({ error: "title required" }, 400);
      const id = createTask(root, b);
      if (Array.isArray(b.steps)) saveTaskSteps(root, id, b.steps);
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/loop-tasks/:id", (c) => {
    try {
      const d = getTaskWithSteps(root, c.req.param("id"));
      if (!d) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true, ...d });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/loop-tasks/:id", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const ok = updateTask(root, c.req.param("id"), b.task || {});
      if (Array.isArray(b.steps)) saveTaskSteps(root, c.req.param("id"), b.steps);
      return c.json({ ok });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Dispatch an agent for a loop task step (reference: dispatchAgent + model selection).
  app.post("/api/control/loop-tasks/:id/dispatch", async (c) => {
    try {
      const { agent, model, prompt, stepId } = await c.req.json().catch(() => ({}));
      if (!agent) return c.json({ error: "agent required" }, 400);
      const { dispatchAgent } = await import("../agent.js");
      const out = await dispatchAgent(cfg, { agent, model: model || "", prompt: prompt || "" });
      const d = getTaskWithSteps(root, c.req.param("id"));
      if (d) {
        const steps = (d.steps || []).map((s) =>
          s.step_id === stepId ? { ...s, output: String(out).slice(0, 8000), status: "done" } : s);
        saveTaskSteps(root, c.req.param("id"), steps);
      }
      writeLog(root, { level: "info", source: "loop-dispatch", message: `task ${c.req.param("id")} step ${stepId || "?"} <- ${agent}/${model || "default"}`, runId: null });
      return c.json({ ok: true, output: String(out).slice(0, 4000) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

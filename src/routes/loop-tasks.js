// Control routes: loop task tables — tasks + task_steps first-class tables.
// Tasks ≠ automations: automations are self-contained (trigger + steps baked in);
// task types are repeatable pipeline templates — each launch takes a fresh goal/input
// and runs the agent chain per goal (e.g. bug-fix per bug report).
import { createTask, listTasks, getTaskWithSteps, saveTaskSteps, updateTask, writeLog } from "../db.js";
import { loadJson } from "../setup-api.js";

export function registerLoopTaskRoutes(app, ctx) {
  const { root, cfg, log } = ctx;

  // Task types: repeatable pipeline templates (vs self-contained automations).
  app.get("/api/control/task-types", (c) => {
    try {
      const doc = loadJson("config/streams.json", { taskTypes: [] });
      return c.json({ ok: true, taskTypes: doc.taskTypes || [] });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Launch a task from a type + goal: creates the task row with per-goal
  // steps, then enqueues a request job (fast 202). The worker runs the agent
  // chain and reconciles envelopes; task_steps sync happens in the worker.
  app.post("/api/control/task-types/:id/launch", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { goal, title, idempotencyKey } = await c.req.json().catch(() => ({}));
      if (!goal || !String(goal).trim()) return c.json({ error: "goal required" }, 400);
      const doc = loadJson("config/streams.json", { taskTypes: [] });
      const type = (doc.taskTypes || []).find((t) => t.id === c.req.param("id"));
      if (!type) return c.json({ error: "unknown task type" }, 404);
      const { enqueueJobSync, audit } = await import("../db.js");
      const taskId = createTask(root, {
        title: title || `${type.name}: ${String(goal).slice(0, 80)}`,
        repo: type.stream || "general", task_type: type.id, status: "open",
        end_goal: String(goal).slice(0, 4000),
      });
      const steps = (type.agents || []).map((agent, i) => ({
        id: `stage-${i + 1}-${agent}`, type: "agent", agent,
        prompt: `Task ${taskId} (${type.id}) step ${i + 1}/${type.agents.length} as '${agent}'.\nGoal: ${String(goal).slice(0, 1500)}\nDo the ${agent} work now, concretely.`,
      }));
      saveTaskSteps(root, taskId, steps.map((s, i) => ({ step_id: s.id, type: s.type, agent: s.agent, model: "", status: "pending", prompt: s.prompt, output: "", position: i })));
      const { id: jobId, deduped, job } = enqueueJobSync(root, {
        kind: "request",
        payload: { text: String(goal).slice(0, 4000), mode: "request", stream: type.stream || "general", agents: type.agents || [], taskId },
        idempotencyKey: idempotencyKey || null,
      });
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: "task-type.launch.enqueue", target: taskId, detail: `job ${jobId} type=${type.id}` });
      writeLog(root, { level: "info", source: "dashboard-task", message: `task ${taskId} [${type.id}] enqueued as ${jobId}`, runId: null });
      return c.json({ ok: true, taskId, jobId, deduped: !!deduped, status: job.status, agents: type.agents, hint: "202 accepted — poll /api/control/jobs/:id for runId" }, deduped ? 200 : 202);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

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

  // Dispatch an agent for a loop task step: fast 202 enqueue (never await
  // long work in the request). Worker runs the Muse session + reconciles.
  app.post("/api/control/loop-tasks/:id/dispatch", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { agent, model, prompt, stepId, idempotencyKey } = await c.req.json().catch(() => ({}));
      if (!agent) return c.json({ error: "agent required" }, 400);
      if (!(cfg.agents?.has?.(agent))) return c.json({ error: `unknown agent '${agent}'` }, 400);
      const { enqueueJobSync, audit } = await import("../db.js");
      const { id: jobId, deduped, job } = enqueueJobSync(root, {
        kind: "loop-task",
        payload: { taskId: c.req.param("id"), agent, model: model || "", prompt: prompt || "", stepId: stepId || "step-1" },
        idempotencyKey: idempotencyKey || null,
      });
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: "loop-task.dispatch.enqueue", target: c.req.param("id"), detail: `job ${jobId} agent=${agent}` });
      writeLog(root, { level: "info", source: "loop-dispatch", message: `task ${c.req.param("id")} step ${stepId || "?"} <- ${agent}/${model || "default"} enqueued as ${jobId}`, runId: null });
      return c.json({ ok: true, jobId, deduped: !!deduped, status: job.status, hint: "202 accepted — poll /api/control/jobs/:id" }, deduped ? 200 : 202);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

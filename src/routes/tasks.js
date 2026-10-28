// Control routes: overview, tasks (runs+steps), agents, tools, activity, logs,
// approvals, todos, chat. The run/task observability surface.
import {
  listRuns, getRun, getTaskDetail, pendingApprovals, decideApproval,
  controlOverview, controlRetro, listActivity, listLogs, listTodos, addTodo,
  completeTodo, dismissTodo, getTodo, addReminder, listReminders, writeLog,
  fileRequest,
} from "../db.js";
import { loadJson } from "../setup-api.js";

export function registerTaskRoutes(app, ctx) {
  const { root, cfg, log } = ctx;

  app.get("/api/control/overview", (c) => {
    try {
      const days = Math.min(Number(c.req.query("days")) || 7, 90);
      return c.json({ ok: true, ...controlOverview(root, { days }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/tasks", (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
      const status = c.req.query("status") || null;
      const workflowId = c.req.query("workflow") || null;
      let runs = listRuns(root, { workflowId, limit: limit * 2 });
      if (status) runs = runs.filter((r) => r.status === status);
      runs = runs.slice(0, limit).map((r) => {
        let full = r;
        try { full = getRun(root, r.id) || r; } catch {}
        let trigger = {};
        try { trigger = JSON.parse(full.trigger_json || "{}"); } catch {}
        const steps = (full.steps || []).map((s) => ({ id: s.step_id, type: s.type, agent: s.agent, status: s.status, text: String(s.raw_text || "").slice(0, 800), at: s.created_at }));
        const doneSteps = steps.filter((s) => s.status === "ok" || s.status === "done").length;
        return {
          id: full.id, workflow: full.workflow_id, kind: full.kind, status: full.status,
          agent: full.agent || null, model: full.model || null,
          tokens: full.tokens || 0, cost: full.cost || 0, toolCalls: full.tool_calls || 0,
          startedAt: full.started_at, finishedAt: full.finished_at, error: full.error,
          title: full.title || trigger.text || full.workflow_id,
          repository: full.repository || "tab-automation",
          branch: full.branch || `run/${full.id}`,
          taskType: full.task_type || full.kind || "manual",
          progress: { completed: full.progress_total ? full.progress_done : doneSteps, total: full.progress_total || steps.length || 1 },
          prUrl: full.pr_url || null, commentsCount: full.comments_count || 0,
          blockedReason: full.blocked_reason || (full.status === "failed" ? full.error : null),
          trigger: { text: trigger.text || "", user: trigger.user || "" },
          steps,
        };
      });
      return c.json({ ok: true, tasks: runs });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/agents", (c) => {
    try {
      const agentsDoc = loadJson("config/agents.json", { agents: [] });
      const stats = controlOverview(root, { days: 30 });
      const byAgent = new Map((stats.byAgent || []).map((a) => [a.agent, a]));
      const agents = (agentsDoc.agents || []).map((a) => ({
        id: a.id, description: a.description || "", provider: a.provider || "",
        model: a.model || a.deployment || "", tools: a.tools || ["*"],
        runs: byAgent.get(a.id)?.c || 0, tokens: byAgent.get(a.id)?.t || 0,
      }));
      return c.json({ ok: true, agents });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/tools", (c) => {
    try {
      const toolsDoc = loadJson("config/tools.json", { servers: [], customTools: [] });
      const stats = controlOverview(root, { days: 30 });
      const usage = new Map((stats.byTool || []).map((t) => [t.tool, t]));
      const mcp = (toolsDoc.servers || []).map((s) => ({
        id: s.id, kind: "mcp", transport: s.transport, auth: s.authStatus || "ok",
        calls: usage.get(s.id)?.c || 0, avgMs: Math.round(usage.get(s.id)?.avgMs || 0),
      }));
      const custom = (toolsDoc.customTools || []).map((t) => ({
        id: `custom_${t.id}`, kind: "custom", transport: "http", auth: "ok",
        calls: usage.get(`custom_${t.id}`)?.c || 0, avgMs: Math.round(usage.get(`custom_${t.id}`)?.avgMs || 0),
      }));
      return c.json({ ok: true, tools: [...mcp, ...custom] });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/activity", (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
      const runId = c.req.query("run") || null;
      return c.json({ ok: true, activity: listActivity(root, { runId, limit }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/logs", (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
      return c.json({ ok: true, logs: listLogs(root, { level: c.req.query("level") || null, limit }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/approvals", (c) => {
    try { return c.json({ ok: true, approvals: pendingApprovals(root) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/approvals/decide", async (c) => {
    try {
      const { id, status, decidedBy } = await c.req.json().catch(() => ({}));
      if (!id || !["approved", "denied"].includes(status)) return c.json({ error: "id + status approved|denied required" }, 400);
      decideApproval(root, id, { status, decidedBy: decidedBy || "dashboard" });
      writeLog(root, { level: "info", source: "dashboard", message: `approval ${id} ${status}` });
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/todos", (c) => {
    try { return c.json({ ok: true, todos: listTodos(root, { status: c.req.query("status") || "open" }), reminders: listReminders(root, {}) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/todos", async (c) => {
    try {
      const { text, due, priority } = await c.req.json().catch(() => ({}));
      if (!text) return c.json({ error: "text required" }, 400);
      const id = addTodo(root, { text, due: due || null, priority: priority || "P3" });
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/todos/done", async (c) => {
    try {
      const { id } = await c.req.json().catch(() => ({}));
      return c.json({ ok: completeTodo(root, id) });
    } catch (err) { return c.json({ error: err.message }, 500); }
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

  app.post("/api/control/remind", async (c) => {
    try {
      const { text, at } = await c.req.json().catch(() => ({}));
      if (!text || !at) return c.json({ error: "text + at required" }, 400);
      const id = addReminder(root, { text, at });
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/chat", async (c) => {
    try {
      const { text, workflow } = await c.req.json().catch(() => ({}));
      if (!text && !workflow) return c.json({ error: "text or workflow required" }, 400);
      const { runWorkflow } = await import("../workflow.js");
      const wf = (cfg.workflows || []).find((w) => w.id === (workflow || "assistant-chat")) ||
        { id: "adhoc-chat", trigger: { type: "manual" }, steps: [{ id: "reply", type: "agent", agent: "assistant", prompt: text || "Hello" }] };
      const trigger = { kind: "dashboard", text: text || "", user: "dashboard" };
      runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, trigger).catch((e) => {
        try { writeLog(root, { level: "error", source: "dashboard-chat", message: e.message }); } catch {}
      });
      try { writeLog(root, { level: "info", source: "dashboard-chat", message: `started ${wf.id}: ${String(text || "").slice(0, 200)}` }); } catch {}
      return c.json({ ok: true, workflow: wf.id, hint: "Started — watch Tasks for steps." });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/retro", (c) => {
    try {
      const days = Math.min(Number(c.req.query("days")) || 30, 90);
      return c.json({ ok: true, ...controlRetro(root, { days }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/task/:id", (c) => {
    try {
      const d = getTaskDetail(root, c.req.param("id"));
      if (!d) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true, task: d });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

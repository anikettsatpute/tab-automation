// Headless dashboard — the UX for the headless bot (src/index.js).
// The bot owns data/tab-automation.db and runs tasks; this HTTP server gives
// it a visual face: Control Room at /dashboard + JSON feed for runs/steps,
// conversation, approvals. No tablet/adb indirection here — local DB is truth.
//
// Enabled via config/dashboard.json { enabled, refreshSec, ... } — the same
// file the setup wizard writes. Port: HEADLESS_PORT || DASHBOARD_PORT || 3001
// (3000 is the setup wizard on a dev PC; on the tablet only headless runs so
// you may set HEADLESS_PORT=3000 there).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { listRuns, getRun, getTaskDetail, pendingApprovals, decideApproval, controlOverview, controlRetro, listActivity, listLogs, listTodos, addTodo, completeTodo, addReminder, listReminders, writeLog, fileRequest, listRequests, linkRequestRun, queueOutbox, listOutbox, markOutboxSent } from "./db.js";
import { loadAll } from "./memory.js";
import { getDashboardConfig } from "./dashboard-db.js";
import { loadJson } from "./setup-api.js";

const root = process.cwd();

export function startHeadlessDashboard(cfg, { log = console.log } = {}) {
  let dashCfg = { enabled: true, refreshSec: 3 };
  try { dashCfg = getDashboardConfig(root, loadJson); } catch { /* defaults */ }
  if (!dashCfg.enabled) {
    log("[dashboard] disabled via config/dashboard.json — skipping HTTP server");
    return null;
  }
  const app = new Hono();
  const distDash = path.join(root, "dist-dashboard");

  app.get("/api/dashboard/config", (c) => c.json(dashCfg));

  app.get("/api/dashboard", (c) => {
    try {
      const tools = loadJson("config/tools.json", { servers: [] });
      const workflows = loadJson("config/workflows.json", { workflows: [] });
      const runs = listRuns(root, { limit: 10 });
      const approvals = pendingApprovals(root);
      return c.json({
        enabled: true,
        at: new Date().toISOString(),
        source: "headless-local",
        servers: (tools.servers ?? []).map((s) => ({ id: s.id, transport: s.transport, authStatus: s.authStatus || "ok" })),
        workflows: (workflows.workflows ?? []).map((w) => ({ id: w.id, trigger: w.trigger?.type || "manual" })),
        runs: runs.slice(0, 10),
        approvals: approvals.slice(0, 10),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/feed", async (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 8, 20);
      const baseRuns = listRuns(root, { limit });
      const runs = baseRuns.map((r) => {
        let full = r;
        try { full = getRun(root, r.id) || r; } catch { /* keep base */ }
        let trigger = {};
        try { trigger = JSON.parse(full.trigger_json || "{}"); } catch { /* ignore */ }
        return {
          id: full.id, workflowId: full.workflow_id, kind: full.kind, status: full.status,
          startedAt: full.started_at, finishedAt: full.finished_at, error: full.error,
          trigger: { text: trigger.text || "", user: trigger.user || "", kind: trigger.kind || full.kind, channelId: trigger.channelId || "" },
          steps: (full.steps || []).map((s) => ({
            id: s.step_id, type: s.type, agent: s.agent, status: s.status,
            text: String(s.raw_text || "").slice(0, 1200), at: s.created_at,
          })),
        };
      });
      let messages = [];
      try {
        const all = loadAll(root);
        messages = all.filter((e) => ["chat", "reply", "pipeline"].includes(e.kind)).slice(-30).map((e) => ({
          ts: e.ts, kind: e.kind, user: e.user, text: String(e.text || "").slice(0, 800), channelId: e.channelId,
        }));
      } catch { /* memory optional */ }
      const stats = {
        running: runs.filter((r) => r.status === "running").length,
        done: runs.filter((r) => r.status === "done").length,
        failed: runs.filter((r) => r.status === "failed").length,
        total: runs.length,
      };
      return c.json({ enabled: true, at: new Date().toISOString(), source: "headless-local", runs, messages, stats });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/health", (c) => c.json({
    ok: true, at: new Date().toISOString(), service: "headless",
    workflows: (cfg.workflows || []).length, agents: cfg.agents ? [...cfg.agents.keys()].length : 0,
  }));

  // ---- control-plane APIs (reference: OrchestratorLoop task control plane) ----
  // Overview: header stats + charts (runs by day, by agent, top tools)
  app.get("/api/control/overview", (c) => {
    try {
      const days = Math.min(Number(c.req.query("days")) || 7, 90);
      return c.json({ ok: true, ...controlOverview(root, { days }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Tasks: runs + steps (reference: Tasks table with status/agent/model/tokens)
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
          // PRD TaskItem card fields
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

  // Agents: config + live stats (reference: Agents view)
  app.get("/api/control/agents", (c) => {
    try {
      const agentsDoc = loadJson("config/agents.json", { agents: [] });
      const { controlOverview: ov } = { controlOverview };
      const stats = ov(root, { days: 30 });
      const byAgent = new Map((stats.byAgent || []).map((a) => [a.agent, a]));
      const agents = (agentsDoc.agents || []).map((a) => ({
        id: a.id, description: a.description || "", provider: a.provider || "",
        model: a.model || a.deployment || "", tools: a.tools || ["*"],
        runs: byAgent.get(a.id)?.c || 0, tokens: byAgent.get(a.id)?.t || 0,
      }));
      return c.json({ ok: true, agents });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Tools: MCP servers + custom tools with usage (reference: Tools view)
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

  // Activity: tool-call timeline (reference: Tool Calls view)
  app.get("/api/control/activity", (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
      const runId = c.req.query("run") || null;
      return c.json({ ok: true, activity: listActivity(root, { runId, limit }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Logs: structured logs (reference: Logs view)
  app.get("/api/control/logs", (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
      return c.json({ ok: true, logs: listLogs(root, { level: c.req.query("level") || null, limit }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Approvals: pending + decide (reference: approval gate)
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

  // Todos + reminders (reference: task tracking)
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
  app.post("/api/control/remind", async (c) => {
    try {
      const { text, at } = await c.req.json().catch(() => ({}));
      if (!text || !at) return c.json({ error: "text + at required" }, 400);
      const id = addReminder(root, { text, at });
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Chat: run a workflow or ask the assistant from the dashboard (reference: prompt box)
  app.post("/api/control/chat", async (c) => {
    try {
      const { text, workflow } = await c.req.json().catch(() => ({}));
      if (!text && !workflow) return c.json({ error: "text or workflow required" }, 400);
      const { runWorkflow } = await import("./workflow.js");
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

  // Submit a request: task-divider intake (reference: PRD 4.5 Submit a request modal).
  // mode=request -> divider picks pipeline; mode=direct -> pipeline from taskType.
  app.post("/api/control/requests", async (c) => {
    try {
      const { text, mode, repo, taskType } = await c.req.json().catch(() => ({}));
      if (!text || !String(text).trim()) return c.json({ error: "text required" }, 400);
      const { divideGoal, dividerPipeline, TASK_TYPES_CONFIG } = await import("./orchestrator.js");
      const { runWorkflow } = await import("./workflow.js");
      const cleanMode = mode === "direct" ? "direct" : "request";
      const picked = cleanMode === "direct"
        ? (TASK_TYPES_CONFIG[taskType] ? taskType : "coding")
        : divideGoal(text);
      const pipeline = dividerPipeline(picked);
      const requestId = fileRequest(root, { text: String(text).slice(0, 4000), mode: cleanMode, repo: repo || "tab-automation", taskType: picked, pipeline });
      // Enqueue as a real workflow run: divider step (records choice) + agent steps per pipeline.
      const steps = [
        { id: "divider", type: "log", text: `Task-divider: mode=${cleanMode} picked '${picked}' -> ${pipeline.join(" -> ")}` },
        ...pipeline.slice(0, 6).map((stage, i) => ({
          id: `stage-${i + 1}-${stage.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          type: "agent", agent: "assistant",
          prompt: `OrchestratorLoop stage ${i + 1}/${pipeline.length} (${stage}) for request ${requestId}.\nGoal: ${String(text).slice(0, 1500)}\nDo the ${stage} work now, concretely.`,
        })),
      ];
      const wf = { id: `request-${requestId}`, name: `Request ${requestId}`, trigger: { type: "manual" }, steps };
      const trigger = { kind: "dashboard-request", text: String(text).slice(0, 1000), user: "dashboard", requestId, taskType: picked };
      const ctx = await runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, trigger);
      try { linkRequestRun(root, requestId, ctx._runId || null); } catch {}
      try { writeLog(root, { level: "info", source: "dashboard-request", message: `request ${requestId} -> ${picked} (${pipeline.join("->")})`, runId: ctx._runId || null }); } catch {}
      return c.json({ ok: true, requestId, taskType: picked, pipeline, runId: ctx._runId || null });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
  app.get("/api/control/requests", (c) => {
    try { return c.json({ ok: true, requests: listRequests(root, { limit: 30 }) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Re-queue from step N (reference: PRD 4.4 Re-queue from step N).
  // Earlier steps preserved; this step + downstream reset and re-run.
  app.post("/api/control/task/:id/requeue", async (c) => {
    try {
      const id = c.req.param("id");
      const { stepIndex, guidance } = await c.req.json().catch(() => ({}));
      const d = getTaskDetail(root, id);
      if (!d) return c.json({ error: "not found" }, 404);
      const idx = Number(stepIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= (d.steps || []).length) {
        return c.json({ error: `stepIndex 0..${(d.steps || []).length - 1} required` }, 400);
      }
      const { runWorkflow } = await import("./workflow.js");
      const tail = d.steps.slice(idx).map((s, k) => ({
        id: `requeue-${idx + 1 + k}-${s.id}`, type: "agent", agent: s.agent || "assistant",
        prompt: `REDISPATCH (request ${id}, attempt ${k + 1}): re-run step '${s.id}' (${s.type}).\n` +
          (guidance ? `Operator guidance:\n${String(guidance).slice(0, 1500)}\n\n` : "") +
          `Original step output:\n${String(s.text || "").slice(0, 1500)}`,
      }));
      const wf = { id: `requeue-${id}-s${idx + 1}`, name: `Re-queue ${id} from step ${idx + 1}`, trigger: { type: "manual" }, steps: tail };
      const trigger = { kind: "dashboard-requeue", text: guidance || `re-run from step ${idx + 1}`, user: "dashboard", parentRun: id, stepIndex: idx };
      const ctx = await runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, trigger);
      try { writeLog(root, { level: "info", source: "dashboard-requeue", message: `requeue ${id} from step ${idx + 1}: ${String(guidance || "").slice(0, 200)}`, runId: ctx._runId || null }); } catch {}
      return c.json({ ok: true, runId: ctx._runId || null, steps: tail.length });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Outbox queue (reference: PRD 4.2 Outbox view)
  app.get("/api/control/outbox", (c) => {
    try { return c.json({ ok: true, outbox: listOutbox(root, { limit: 30 }) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });
  app.post("/api/control/outbox", async (c) => {
    try {
      const { channel, text } = await c.req.json().catch(() => ({}));
      if (!text) return c.json({ error: "text required" }, 400);
      const id = queueOutbox(root, { channel: channel || "", text });
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
  app.post("/api/control/outbox/sent", async (c) => {
    try {
      const { id } = await c.req.json().catch(() => ({}));
      if (!id) return c.json({ error: "id required" }, 400);
      markOutboxSent(root, id);
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Retro (reference: PRD 4.2 Retro view — velocity, tokens, retries)
  app.get("/api/control/retro", (c) => {
    try {
      const days = Math.min(Number(c.req.query("days")) || 30, 90);
      return c.json({ ok: true, ...controlRetro(root, { days }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Task detail: full board pane (reference: Overview/Steps/Activity/Diagrams/Sessions)
  app.get("/api/control/task/:id", (c) => {
    try {
      const d = getTaskDetail(root, c.req.param("id"));
      if (!d) return c.json({ error: "not found" }, 404);
      return c.json({ ok: true, task: d });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Brain messages: Discord-facing poller view (reference: Brain messages table)
  app.get("/api/control/brain", (c) => {
    try {
      const all = loadAll(root);
      const msgs = all.filter((e) => ["chat", "reply", "pipeline"].includes(e.kind)).slice(-100).reverse().map((e, i) => ({
        id: `m${i}`, ts: e.ts, sender: e.user || "system", text: e.text || "", kind: e.kind, channelId: e.channelId || "",
        status: e.kind === "chat" ? "incoming" : "replied",
      }));
      return c.json({ ok: true, messages: msgs, poller: { enabled: true, intervalMin: 2, completionUpdates: true } });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Automations: workflow cards (reference: YOUR FLOWS list)
  app.get("/api/control/automations", (c) => {
    try {
      const workflows = loadJson("config/workflows.json", { workflows: [] });
      const runs = listRuns(root, { limit: 50 });
      const lastByWf = new Map();
      for (const r of runs) if (!lastByWf.has(r.workflow_id)) lastByWf.set(r.workflow_id, r);
      const flows = (workflows.workflows || []).map((w) => {
        const last = lastByWf.get(w.id);
        return {
          id: w.id, trigger: w.trigger?.type || "manual", cron: w.trigger?.cron || "", command: w.trigger?.command || "",
          steps: (w.steps || []).map((s) => ({ id: s.id, type: s.type, agent: s.agent || null })),
          enabled: w.enabled !== false,
          lastStatus: last?.status || null, lastRunAt: last?.started_at || null,
        };
      });
      return c.json({ ok: true, flows });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // static Control Room build
  app.get("/dashboard/assets/:file", (c) => {
    const file = path.join(distDash, "assets", c.req.param("file"));
    if (!existsSync(file)) return c.json({ error: "not found" }, 404);
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    return c.body(readFileSync(file), 200, { "Content-Type": type });
  });
  app.get("/dashboard", (c) => {
    const index = path.join(distDash, "index.html");
    if (existsSync(index)) return c.html(readFileSync(index, "utf-8"));
    return c.text("dist-dashboard/ missing. Run: npm run dashboard:build", 500);
  });
  app.get("/dashboard/*", (c) => {
    if (c.req.path.includes("/assets/")) return c.json({ error: "not found" }, 404);
    const index = path.join(distDash, "index.html");
    if (existsSync(index)) return c.html(readFileSync(index, "utf-8"));
    return c.text("dist-dashboard/ missing. Run: npm run dashboard:build", 500);
  });
  app.get("/", (c) => c.redirect("/dashboard"));

  const PORT = Number(process.env.HEADLESS_PORT || process.env.DASHBOARD_PORT || 3001);
  serve({ fetch: app.fetch, port: PORT }, () => {
    log(`[dashboard] headless Control Room: http://localhost:${PORT}/dashboard`);
  });
  return { port: PORT };
}

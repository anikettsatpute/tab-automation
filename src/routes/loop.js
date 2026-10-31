// OrchestratorLoop control plane API — everything under /api/control/loop/* (auth via central middleware).
import { existsSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { streamSSE } from "hono/streaming";
import * as access from "../services/access.js";
import { ownerForRequest, getAttachmentOwned, deleteAttachmentOwned } from "../services/attachments.js";
import * as store from "../loop/store.js";
import { readHandoff, readWorkspaceFile, taskDir, isInside, atomicWrite } from "../loop/workspace.js";
import { dispatcherStatus } from "../loop/dispatchers.js";
import { loadTaskTypes, upsertTaskType, deleteTaskType } from "../loop/task-types.js";
import { requeue, taskAction, engineStatus, onLoopEvent } from "../loop/engine.js";

const { mutationGuard, auditActor } = access;

const P = "/api/control/loop";
const guard = (c) => { const g = mutationGuard(c); return g.ok ? null : c.json({ error: g.error }, g.status); };
const body = (c) => c.req.json().catch(() => ({}));
const bad = (c, e, s = 400) => c.json({ error: e?.message || String(e) }, s);
const MODEL_RE = /^[A-Za-z0-9._:-]{0,64}$/;

export function registerLoopRoutes(app, { root, cfg, log }) {
  const roles = () => (cfg.agents ? [...cfg.agents.keys()] : []);
  const loadTask = (c) => store.getTask(root, c.req.param("id"));

  // ---------- status / control ----------
  app.get(`${P}/status`, (c) => c.json({ ok: true, counts: store.statusCounts(root), engine: engineStatus(root) }));
  app.post(`${P}/pause`, (c) => guard(c) || (store.setPaused(root, true), c.json({ ok: true, paused: true })));
  app.post(`${P}/resume`, (c) => guard(c) || (store.setPaused(root, false), c.json({ ok: true, paused: false })));
  app.get(`${P}/dispatchers`, (c) => c.json({ dispatchers: dispatcherStatus({ fresh: c.req.query("fresh") === "1" }) }));
  app.get(`${P}/agents`, (c) => c.json({ agents: cfg.agents ? [...cfg.agents.values()].map((a) => ({ id: a.id, description: a.description || "", model: a.model || "" })) : [] }));

  // ---------- task types ----------
  app.get(`${P}/task-types`, (c) => c.json({ taskTypes: loadTaskTypes(root) }));
  app.post(`${P}/task-types`, async (c) => {
    const g = guard(c); if (g) return g;
    try { return c.json({ ok: true, taskTypes: upsertTaskType(root, await body(c), roles()) }); } catch (e) { return bad(c, e); }
  });
  app.delete(`${P}/task-types/:id`, (c) => guard(c) || c.json({ ok: true, taskTypes: deleteTaskType(root, c.req.param("id")) }));

  // ---------- requests ----------
  app.get(`${P}/requests`, (c) => c.json({ requests: store.listRequests(root, { limit: Math.min(Number(c.req.query("limit")) || 50, 200) }) }));
  app.post(`${P}/requests`, async (c) => {
    const g = guard(c); if (g) return g;
    const b = await body(c);
    const text = String(b.text || "").trim();
    if (!text) return bad(c, "text required");
    const dispatcher = b.dispatcher === "copilot" ? "copilot" : "muse";
    const model = String(b.model || "");
    if (!MODEL_RE.test(model)) return bad(c, "invalid model id");
    const taskType = String(b.taskType || "");
    if (taskType && !loadTaskTypes(root).some((t) => t.id === taskType)) return bad(c, `unknown task type '${taskType}'`);
    const repo = String(b.repo || "").trim();
    if (repo && (!path.isAbsolute(repo) || !existsSync(repo) || !statSync(repo).isDirectory())) return bad(c, "repo must be an existing absolute directory");
    const avail = dispatcherStatus().find((d) => d.id === dispatcher);
    if (avail && !avail.ok) return bad(c, `${avail.label} unavailable: ${avail.error}`, 409);

    // Materialise owned in-memory attachments to disk so the loop can copy them into task workspaces.
    const owner = ownerForRequest(c, access);
    const atts = [];
    const ids = Array.isArray(b.attachments) ? b.attachments.slice(0, 3) : [];
    const reqDir = path.join(root, "data", "requests", "_uploads");
    for (const id of ids) {
      const a = getAttachmentOwned(id, owner);
      if (!a) return bad(c, `attachment ${String(id).slice(0, 20)} not found or expired`);
      mkdirSync(reqDir, { recursive: true });
      const file = path.join(reqDir, `${a.id}-${a.name}`);
      if (!isInside(reqDir, file)) return bad(c, "unsafe attachment name");
      atomicWrite(file, a.text);
      atts.push({ name: a.name, size: a.size, path: file });
      deleteAttachmentOwned(id, owner);
    }
    try {
      const id = store.createRequest(root, { text, mode: b.mode === "direct" ? "direct" : "request", source: auditActor(c) || "dashboard", repo, taskType, dispatcher, model, attachments: atts });
      log(`[loop] request ${id} filed (${dispatcher})`);
      return c.json({ ok: true, id, request: store.getRequest(root, id) });
    } catch (e) { return bad(c, e); }
  });

  // ---------- tasks ----------
  app.get(`${P}/tasks`, (c) => {
    const status = c.req.query("status") || null;
    if (status && !store.TASK_STATUSES.includes(status)) return bad(c, "bad status");
    return c.json({ tasks: store.listTasks(root, { status, q: c.req.query("q") || "", limit: Math.min(Number(c.req.query("limit")) || 200, 500) }), counts: store.statusCounts(root) });
  });
  app.get(`${P}/tasks/:id`, (c) => {
    const d = store.taskDetail(root, c.req.param("id"));
    return d ? c.json(d) : bad(c, "not found", 404);
  });
  app.get(`${P}/tasks/:id/events`, (c) => {
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    return c.json({ events: store.listEvents(root, t.id, { after: Number(c.req.query("after")) || 0 }) });
  });
  app.get(`${P}/tasks/:id/handoff`, (c) => {
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    return c.json({ handoff: readHandoff(root, t.id) });
  });
  app.get(`${P}/tasks/:id/sessions`, (c) => {
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    return c.json({ sessions: store.listAttempts(root, t.id) });
  });
  // Raw attempt files: prompt | context | result | transcript (confined to the task workspace).
  app.get(`${P}/tasks/:id/attempts/:attemptId/:kind`, (c) => {
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    const a = store.getAttempt(root, c.req.param("attemptId"));
    if (!a || a.task_id !== t.id) return bad(c, "attempt not found", 404);
    const col = { prompt: "prompt_path", context: "context_path", result: "result_path", transcript: "transcript_path" }[c.req.param("kind")];
    if (!col) return bad(c, "kind must be prompt|context|result|transcript");
    const f = a[col];
    if (!f || !isInside(taskDir(root, t.id), f) || !existsSync(f)) return c.json({ text: "" });
    return c.json({ text: readWorkspaceFile(root, t.id, f) });
  });
  app.post(`${P}/tasks/:id/requeue`, async (c) => {
    const g = guard(c); if (g) return g;
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    const b = await body(c);
    try { requeue(root, t.id, Number(b.fromStep ?? 0), String(b.guidance || "").slice(0, 4000)); return c.json({ ok: true, task: store.getTask(root, t.id) }); }
    catch (e) { return bad(c, e); }
  });
  app.post(`${P}/tasks/:id/action`, async (c) => {
    const g = guard(c); if (g) return g;
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    const b = await body(c);
    const steps = Array.isArray(b.steps) ? b.steps.filter((s) => s && roles().includes(s.role) && String(s.goal || "").trim()).slice(0, 12) : [];
    try { taskAction(root, t.id, String(b.action || ""), { text: String(b.text || "").slice(0, 2000), steps }); return c.json({ ok: true, task: store.getTask(root, t.id) }); }
    catch (e) { return bad(c, e); }
  });
  // Append a brand-new task to the same request (detail header "Append task").
  app.post(`${P}/tasks/:id/append-task`, async (c) => {
    const g = guard(c); if (g) return g;
    const t = loadTask(c); if (!t) return bad(c, "not found", 404);
    const b = await body(c);
    const title = String(b.title || "").trim();
    const steps = (Array.isArray(b.steps) ? b.steps : []).filter((s) => s && roles().includes(s.role) && String(s.goal || "").trim()).slice(0, 12);
    if (!title || !steps.length) return bad(c, "title and steps[{role, goal}] required");
    const id = store.createTask(root, { requestId: t.request_id, title, endGoal: String(b.endGoal || title), repo: t.repo, taskType: "", dispatcher: t.dispatcher, model: t.model, dependsOn: b.after ? [t.id] : [], steps });
    return c.json({ ok: true, id });
  });

  // ---------- activity + live stream ----------
  app.get(`${P}/activity`, (c) => c.json({ events: store.recentEvents(root, { limit: Math.min(Number(c.req.query("limit")) || 100, 500) }) }));
  app.get(`${P}/stream`, (c) => streamSSE(c, async (stream) => {
    let open = true;
    const queue = [];
    let wake = null;
    const off = onLoopEvent((ev) => { queue.push(ev); wake?.(); });
    stream.onAbort(() => { open = false; off(); wake?.(); });
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ counts: store.statusCounts(root), engine: engineStatus(root) }) });
    while (open) {
      if (!queue.length) await new Promise((r) => { wake = r; setTimeout(r, 20000); });
      wake = null;
      if (!open) break;
      if (!queue.length) { await stream.writeSSE({ event: "heartbeat", data: "{}" }); continue; }
      const ev = queue.shift();
      await stream.writeSSE({ event: "loop", data: JSON.stringify({ ...ev, counts: store.statusCounts(root) }) });
    }
  }));
}

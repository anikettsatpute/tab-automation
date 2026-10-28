// Control routes: requests (stream+agent divider), task actions, outbox, brain.
import {
  getTaskDetail, writeLog, fileRequest, listRequests, linkRequestRun,
  requeueCount, blockTask, queueOutbox, markTaskDone, addTaskComment,
  listTaskComments, appendTask, deleteTask, listAgentSessions, listOutbox,
  markOutboxSent, fileBrainMessage, listBrainMessages, updateBrainMessage,
  brainMetrics,
} from "../db.js";
import { loadAll } from "../memory.js";
import { loadJson } from "../setup-api.js";

export function registerRequestRoutes(app, ctx) {
  const { root, cfg, log } = ctx;

  app.post("/api/control/requests", async (c) => {
    try {
      const { text, mode, stream, agents, pipeline: pipelineId } = await c.req.json().catch(() => ({}));
      if (!text || !String(text).trim()) return c.json({ error: "text required" }, 400);
      const { divideGoal, dividerPipeline } = await import("../orchestrator.js");
      const { runWorkflow } = await import("../workflow.js");
      const streamsDoc = loadJson("config/streams.json", { streams: [], pipelines: [] });
      const agentIds = new Set((cfg.agents ? [...cfg.agents.keys()] : []));
      const cleanMode = mode === "direct" ? "direct" : "request";
      let picked, streamId;
      if (cleanMode === "direct") {
        streamId = stream || streamsDoc.streams[0]?.id || "general";
        const pipe = (streamsDoc.pipelines || []).find((p) => p.id === (pipelineId || ""));
        picked = Array.isArray(agents) ? agents.filter((a) => agentIds.has(a))
          : pipe?.agents?.filter((a) => agentIds.has(a)) || [];
      } else {
        const d = divideGoal(text, streamsDoc);
        picked = d.agents;
        streamId = d.stream;
      }
      const pipeline = dividerPipeline(picked.length ? picked : ["assistant"]);
      const requestId = fileRequest(root, { text: String(text).slice(0, 4000), mode: cleanMode, repo: streamId, taskType: pipeline.join(","), pipeline });
      const steps = [
        { id: "divider", type: "log", text: `Divider: mode=${cleanMode} stream=${streamId} agents ${pipeline.join(" -> ")}` },
        ...pipeline.slice(0, 6).map((agent, i) => ({
          id: `stage-${i + 1}-${agent}`,
          type: "agent", agent,
          prompt: `Request ${requestId} step ${i + 1}/${pipeline.length} as '${agent}'.\nGoal: ${String(text).slice(0, 1500)}\nDo the ${agent} work now, concretely.`,
        })),
      ];
      const wf = { id: `request-${requestId}`, name: `Request ${requestId}`, trigger: { type: "manual" }, steps };
      const trigger = { kind: "dashboard-request", text: String(text).slice(0, 1000), user: "dashboard", requestId, stream: streamId, agents: pipeline };
      const ctx2 = await runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, trigger);
      try { linkRequestRun(root, requestId, ctx2._runId || null); } catch {}
      try { writeLog(root, { level: "info", source: "dashboard-request", message: `request ${requestId} [${streamId}] -> agents ${pipeline.join("->")}`, runId: ctx2._runId || null }); } catch {}
      return c.json({ ok: true, requestId, stream: streamId, agents: pipeline, pipeline, runId: ctx2._runId || null });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/requests", (c) => {
    try { return c.json({ ok: true, requests: listRequests(root, { limit: 30 }) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

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
      const { MAX_RESTART_ATTEMPTS, redispatchPrompt } = await import("../orchestrator.js");
      const prior = requeueCount(root, id);
      if (prior >= MAX_RESTART_ATTEMPTS) {
        blockTask(root, id, `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS} attempts). Investigator summary queued to outbox.`);
        queueOutbox(root, { channel: "dashboard", text: `Task ${id} blocked: restart budget exceeded after ${prior} requeues. Needs human review.`, runId: id });
        writeLog(root, { level: "warn", source: "dashboard-requeue", message: `requeue ${id} denied: budget exceeded (${prior})`, runId: id });
        return c.json({ error: `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS}) — task blocked`, blocked: true }, 429);
      }
      const { runWorkflow } = await import("../workflow.js");
      const tail = d.steps.slice(idx).map((s, k) => ({
        id: `requeue-${idx + 1 + k}-${s.id}`, type: "agent", agent: s.agent || "assistant",
        prompt: redispatchPrompt({ originalPrompt: String(s.text || "").slice(0, 1500), guidance: String(guidance || ""), taskId: id, stepId: s.id, attempt: prior + k + 1 }),
      }));
      const wf = { id: `requeue-${id}-s${idx + 1}`, name: `Re-queue ${id} from step ${idx + 1}`, trigger: { type: "manual" }, steps: tail };
      const trigger = { kind: "dashboard-requeue", text: guidance || `re-run from step ${idx + 1}`, user: "dashboard", parentRun: id, stepIndex: idx };
      const ctx2 = await runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, trigger);
      try { writeLog(root, { level: "info", source: "dashboard-requeue", message: `requeue ${id} from step ${idx + 1}: ${String(guidance || "").slice(0, 200)}`, runId: ctx2._runId || null }); } catch {}
      return c.json({ ok: true, runId: ctx2._runId || null, steps: tail.length, attempt: prior + 1, budget: MAX_RESTART_ATTEMPTS });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/task/:id/action", async (c) => {
    try {
      const id = c.req.param("id");
      const { action, text, title } = await c.req.json().catch(() => ({}));
      const d = getTaskDetail(root, id);
      if (!d) return c.json({ error: "not found" }, 404);
      if (action === "done") {
        markTaskDone(root, id);
        writeLog(root, { level: "info", source: "dashboard-task", message: `task ${id} marked done`, runId: id });
        return c.json({ ok: true, status: "done" });
      }
      if (action === "request-changes") {
        if (!text) return c.json({ error: "text required" }, 400);
        addTaskComment(root, id, { author: "dashboard", text: `Review feedback: ${String(text).slice(0, 2000)}` });
        writeLog(root, { level: "info", source: "dashboard-task", message: `task ${id} review feedback: ${String(text).slice(0, 200)}`, runId: id });
        return c.json({ ok: true });
      }
      if (action === "sweep") {
        const note = text ? String(text).slice(0, 2000) : "Swept latest PR comments (no new threads).";
        addTaskComment(root, id, { author: "pr-sweep", text: note });
        writeLog(root, { level: "info", source: "dashboard-sweep", message: `task ${id} PR sweep: ${note.slice(0, 200)}`, runId: id });
        return c.json({ ok: true, comments: listTaskComments(root, id, { limit: 5 }) });
      }
      if (action === "append") {
        const child = appendTask(root, id, { title: title || text || `Follow-up to ${id}`, text: text || "" });
        if (!child) return c.json({ error: "append failed" }, 500);
        writeLog(root, { level: "info", source: "dashboard-task", message: `task ${id} appended -> ${child}`, runId: id });
        return c.json({ ok: true, childId: child });
      }
      if (action === "delete") {
        deleteTask(root, id);
        writeLog(root, { level: "info", source: "dashboard-task", message: `task ${id} deleted` });
        return c.json({ ok: true, deleted: true });
      }
      if (action === "block") {
        blockTask(root, id, text || "Blocked from dashboard.");
        queueOutbox(root, { channel: "dashboard", text: `Task ${id} blocked: ${String(text || "manual block").slice(0, 500)}`, runId: id });
        return c.json({ ok: true, status: "failed" });
      }
      return c.json({ error: "unknown action (done|request-changes|sweep|append|delete|block)" }, 400);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/task/:id/comments", (c) => {
    try { return c.json({ ok: true, comments: listTaskComments(root, c.req.param("id"), { limit: 30 }) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/task/:id/sessions", (c) => {
    try { return c.json({ ok: true, sessions: listAgentSessions(root, c.req.param("id")) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

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

  app.get("/api/control/brain", (c) => {
    try {
      const stored = listBrainMessages(root, { limit: 50 });
      const metrics = brainMetrics(root);
      if (stored.length) {
        return c.json({
          ok: true,
          messages: stored.map((m) => ({
            id: m.id, jobId: m.job_id, actorId: m.actor_id, conversationId: m.conversation_id,
            sender: m.sender, source: m.source, receivedAt: m.received_at, messageText: m.message_text,
            processingStatus: m.processing_status, outboxSummary: m.outbox_summary,
            linkedTaskId: m.linked_task_id, processingError: m.processing_error,
            requestText: m.request_text, sessionLog: m.session_log,
          })),
          metrics,
          poller: { enabled: true, intervalMin: 2, completionUpdates: true, channel: "discord", lastScan: new Date().toISOString() },
        });
      }
      const all = loadAll(root);
      const msgs = all.filter((e) => ["chat", "reply", "pipeline"].includes(e.kind)).slice(-100).reverse().map((e, i) => ({
        id: `m${i}`, ts: e.ts, sender: e.user || "system", text: e.text || "", kind: e.kind, channelId: e.channelId || "",
        status: e.kind === "chat" ? "incoming" : "replied",
      }));
      return c.json({ ok: true, messages: msgs, metrics, poller: { enabled: true, intervalMin: 2, completionUpdates: true } });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/brain", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      if (!b.messageText && !b.text) return c.json({ error: "messageText required" }, 400);
      const id = fileBrainMessage(root, {
        jobId: b.jobId || "", actorId: b.actorId || "", conversationId: b.conversationId || "",
        sender: b.sender || "dashboard", source: b.source || "web-ui",
        messageText: b.messageText || b.text || "", processingStatus: "queued",
        linkedTaskId: b.linkedTaskId || null,
      });
      return c.json({ ok: true, id });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/brain/:id", async (c) => {
    try {
      const ok = updateBrainMessage(root, c.req.param("id"), await c.req.json().catch(() => ({})));
      return c.json({ ok });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

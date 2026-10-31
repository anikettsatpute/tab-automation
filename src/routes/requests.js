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
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { text, mode, stream, agents, pipeline: pipelineId, preview, idempotencyKey, attachments: attachmentIds } = await c.req.json().catch(() => ({}));
      if (!text || !String(text).trim()) return c.json({ error: "text required" }, 400);
      const { divideGoal, dividerPipeline } = await import("../orchestrator.js");
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
      // Preview / no-enqueue intake: divider plan without enqueueing.
      if (preview) {
        return c.json({ ok: true, preview: true, stream: streamId, agents: pipeline, pipeline, steps: pipeline.map((a, i) => ({ id: `stage-${i + 1}-${a}`, type: "agent", agent: a })) });
      }
      // Scoped attachments: opaque IDs bound to the current session owner.
      // Content is embedded into the job payload (sanitized text-only);
      // oversized payloads fail closed with an explicit 400 (no truncation).
      // Idempotency retry: one-time refs are consumed on first intake, so a
      // retried POST with the same idempotencyKey would otherwise 400 on the
      // (now-gone) attachment IDs before reaching the job dedupe check.
      // Pre-check the scoped job key first: exact base-payload match returns
      // the original job (200 deduped); base mismatch returns an explicit
      // idempotency conflict. Same key scope as enqueueJobSync
      // (anon:request:<key> — requests pass no actor/scope). No broadening.
      let attachmentFiles = [];
      const rawIds = Array.isArray(attachmentIds) ? attachmentIds.slice(0, 8) : [];
      const rawKey = idempotencyKey ? String(idempotencyKey).slice(0, 120) : null;
      if (rawKey && rawIds.length) {
        try {
          const { openDb } = await import("../db.js");
          const scopedKey = `anon:request:${rawKey}`;
          const prior = openDb(root).prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(scopedKey);
          if (prior) {
            if (prior.kind !== "request") {
              return c.json({ error: `idempotency conflict: key '${scopedKey}' already used for kind '${prior.kind}'` }, 400);
            }
            let prevPayload = {};
            try { prevPayload = JSON.parse(prior.payload || "{}"); } catch {}
            const curBase = { text: String(text).slice(0, 4000), mode: cleanMode, stream: streamId, agents: pipeline };
            const prevBase = { text: prevPayload.text, mode: prevPayload.mode, stream: prevPayload.stream, agents: prevPayload.agents };
            const prevHasAttach = Array.isArray(prevPayload.attachments) && prevPayload.attachments.length > 0;
            if (JSON.stringify(curBase) === JSON.stringify(prevBase) && prevHasAttach) {
              return c.json({ ok: true, jobId: prior.id, deduped: true, status: prior.status, stream: prevPayload.stream, agents: prevPayload.agents, pipeline: prevPayload.agents, attachments: (prevPayload.attachments || []).map((f) => ({ name: f.name, size: f.size })), hint: "202 accepted — poll /api/control/jobs/:id for runId" }, 200);
            }
            return c.json({ error: `idempotency conflict: key '${scopedKey}' reused with different payload` }, 400);
          }
        } catch {}
      }
      if (rawIds.length) {
        const access = await import("../services/access.js");
        const at = await import("../services/attachments.js");
        const owner = at.ownerForRequest(c, access);
        for (const aid of rawIds) {
          const f = at.getAttachmentOwned(aid, owner);
          if (!f) {
            return c.json({ error: `attachment not found or expired: '${String(aid).slice(0, 32)}' — re-upload and retry (refs are single-session)` }, 400);
          }
          attachmentFiles.push({ name: f.name, size: f.size, text: at.sanitizeForPrompt(f.text) });
        }
      }
      const { enqueueJobSync, audit } = await import("../db.js");
      let payload = { text: String(text).slice(0, 4000), mode: cleanMode, stream: streamId, agents: pipeline };
      if (attachmentFiles.length) {
        // Intake-time context (no worker change): the worker already honors
        // caller-built payload.steps, so embed sanitized attachment text in
        // step 1's prompt. Explicit 8k per-step cap — never silent truncation.
        const at = await import("../services/attachments.js");
        const section = at.buildAttachmentSection(attachmentFiles);
        const goal = String(text).slice(0, 1500);
        const step1 = `Goal: ${goal}${section}\nDo the work now, concretely.`;
        if (Buffer.byteLength(step1, "utf8") > 8000) {
          return c.json({ error: `step 1 prompt too large with attachments (${Buffer.byteLength(step1, "utf8")} bytes > 8000 max) — remove or shorten an attachment and retry (no truncation)` }, 400);
        }
        payload.steps = pipeline.slice(0, 6).map((agent, i) => ({
          id: `stage-${i + 1}-${agent}`,
          type: "agent",
          agent,
          prompt: i === 0 ? step1 : `Goal: ${goal}\nDo the ${agent} work now, concretely.`,
        }));
        payload.attachments = attachmentFiles;
      }
      let jobId, deduped, job;
      try {
        ({ id: jobId, deduped, job } = enqueueJobSync(root, {
          kind: "request",
          payload,
          idempotencyKey: idempotencyKey || null,
        }));
      } catch (err) {
        // Explicit payload-overflow error (jobs.js rejects >16k, no truncation).
        if (/payload too large/i.test(String(err.message || ""))) {
          return c.json({ error: `${err.message} — remove or shorten an attachment and retry` }, 400);
        }
        throw err;
      }
      // Consume one-time upload refs on successful intake (no replay).
      if (attachmentFiles.length) {
        try {
          const access = await import("../services/access.js");
          const at = await import("../services/attachments.js");
          const owner = at.ownerForRequest(c, access);
          for (const aid of rawIds) at.deleteAttachmentOwned(aid, owner);
        } catch {}
      }
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: deduped ? "request.deduped" : "request.enqueue", target: jobId, detail: `${cleanMode} ${streamId} ${pipeline.join("->")}${attachmentFiles.length ? ` +${attachmentFiles.length} attach` : ""}` });
      try { writeLog(root, { level: "info", source: "dashboard-request", message: `request enqueued ${jobId} [${streamId}] -> ${pipeline.join("->")}${attachmentFiles.length ? ` (+${attachmentFiles.length} attachments)` : ""}` }); } catch {}
      return c.json({ ok: true, jobId, deduped: !!deduped, status: job.status, stream: streamId, agents: pipeline, pipeline, attachments: attachmentFiles.map((f) => ({ name: f.name, size: f.size })), hint: "202 accepted — poll /api/control/jobs/:id for runId" }, deduped ? 200 : 202);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/requests", (c) => {
    try { return c.json({ ok: true, requests: listRequests(root, { limit: 30 }) }); }
    catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/task/:id/requeue", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const id = c.req.param("id");
      const { stepIndex, guidance, idempotencyKey } = await c.req.json().catch(() => ({}));
      const d = getTaskDetail(root, id);
      if (!d) return c.json({ error: "not found" }, 404);
      const idx = Number(stepIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= (d.steps || []).length) {
        return c.json({ error: `stepIndex 0..${(d.steps || []).length - 1} required` }, 400);
      }
      const { MAX_RESTART_ATTEMPTS } = await import("../orchestrator.js");
      const prior = requeueCount(root, id);
      if (prior >= MAX_RESTART_ATTEMPTS) {
        blockTask(root, id, `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS} attempts). Investigator summary queued to outbox.`);
        queueOutbox(root, { channel: "dashboard", text: `Task ${id} blocked: restart budget exceeded after ${prior} requeues. Needs human review.`, runId: id });
        writeLog(root, { level: "warn", source: "dashboard-requeue", message: `requeue ${id} denied: budget exceeded (${prior})`, runId: id });
        return c.json({ error: `Restart budget exceeded (${prior}/${MAX_RESTART_ATTEMPTS}) — task blocked`, blocked: true }, 429);
      }
      const { enqueueJobSync, audit } = await import("../db.js");
      const { id: jobId, deduped, job } = enqueueJobSync(root, {
        kind: "requeue",
        payload: { runId: id, stepIndex: idx, guidance: String(guidance || "").slice(0, 2000) },
        idempotencyKey: idempotencyKey || null,
      });
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: "task.requeue.enqueue", target: id, detail: `job ${jobId} from step ${idx + 1}` });
      try { writeLog(root, { level: "info", source: "dashboard-requeue", message: `requeue ${id} from step ${idx + 1} enqueued as ${jobId}`, runId: id }); } catch {}
      return c.json({ ok: true, jobId, deduped: !!deduped, status: job.status, attempt: prior + 1, budget: MAX_RESTART_ATTEMPTS, hint: "202 accepted — poll /api/control/jobs/:id for runId" }, deduped ? 200 : 202);
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
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { channel, text } = await c.req.json().catch(() => ({}));
      if (!text) return c.json({ error: "text required" }, 400);
      const { queueOutboxDeduped, audit } = await import("../db.js");
      const { id, deduped } = queueOutboxDeduped(root, { channel: channel || "", text });
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: "outbox.queue", target: id, detail: deduped ? "deduped" : "queued" });
      return c.json({ ok: true, id, deduped: !!deduped });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/outbox/sent", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { id } = await c.req.json().catch(() => ({}));
      if (!id) return c.json({ error: "id required" }, 400);
      markOutboxSent(root, id);
      const { audit } = await import("../db.js");
      audit(root, { actor: (await import("../services/access.js")).auditActor(c), action: "outbox.sent", target: id, detail: "" });
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

  // Router session for one inbound message: decision + parsed CLI transcript + linked loop tasks.
  app.get("/api/control/brain/:id/session", async (c) => {
    try {
      const row = listBrainMessages(root, { limit: 500 }).find((m) => m.id === c.req.param("id"));
      // Legacy memory-backed rows (m0, m1…) have no stored session.
      if (!row) return c.json({ ok: true, router: null, prompt: null, chat: null, tasks: [], requestId: null });
      const { routerDir } = await import("../router.js");
      const { parseTranscript } = await import("../loop/transcript.js");
      const { readFileSync, existsSync } = await import("node:fs");
      const dir = routerDir(root, row.job_id || row.id);
      const read = (f, max) => { const p = `${dir}/${f}`; return existsSync(p) ? readFileSync(p, "utf8").slice(0, max) : null; };
      let router = null;
      try { router = row.session_log ? JSON.parse(row.session_log) : null; } catch {}
      const tx = read("transcript.jsonl", 2000000);
      let tasks = [];
      const reqId = /^req:(\w+)$/.exec(row.linked_task_id || "")?.[1];
      if (reqId) {
        const store = await import("../loop/store.js");
        tasks = (store.listRequests(root, { limit: 200 }).find((r) => r.id === reqId)?.tasks) || [];
      }
      return c.json({ ok: true, router, prompt: read("prompt.md", 20000), chat: tx ? parseTranscript(tx) : null, tasks, requestId: reqId || null });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/brain", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
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
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const ok = updateBrainMessage(root, c.req.param("id"), await c.req.json().catch(() => ({})));
      return c.json({ ok });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  // Scoped safe attachments: text-only UTF-8 allowlist, opaque
  // session-bound IDs, in-memory only (no filesystem, no public downloads).
  // Same-origin authenticated POST; refs checked against the current session
  // owner at intake; TTL cleanup. See src/services/attachments.js.
  app.get("/api/control/requests/attachments", async (c) => {
    const at = await import("../services/attachments.js");
    return c.json({
      ok: true, supported: true,
      allowlist: at.ATTACH_ALLOWLIST,
      maxFiles: at.MAX_ATTACH_FILES,
      maxFileBytes: at.MAX_ATTACH_FILE_BYTES,
      maxTotalBytes: at.MAX_ATTACH_TOTAL_BYTES,
      note: "text-only UTF-8 (.txt/.md/.json/.csv); content embedded into request context at intake",
    });
  });

  app.post("/api/control/requests/attachments", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const at = await import("../services/attachments.js");
      const access = await import("../services/access.js");
      const owner = at.ownerForRequest(c, access);
      let body = null;
      try { body = await c.req.json(); } catch { body = null; }
      if (!body || typeof body !== "object") {
        return c.json({ error: "JSON body required: { filename, content, mime? } (text-only)" }, 400);
      }
      const { filename, content, mime } = body;
      if (typeof content !== "string") {
        return c.json({ error: "content must be a UTF-8 string (text-only uploads; no binary/multipart)" }, 400);
      }
      if (Buffer.byteLength(content, "utf8") > 65536) {
        return c.json({ error: "content too large for transport: paste text instead or shorten the file" }, 400);
      }
      const created = at.createAttachment({ owner, filename, mime, content });
      const { audit } = await import("../db.js");
      audit(root, { actor: access.auditActor(c), action: "request.attach.upload", target: created.id, detail: `${created.name} ${created.size}b` });
      return c.json({ ok: true, ...created }, 201);
    } catch (err) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get("/api/control/requests/attachments/list", async (c) => {
    try {
      const at = await import("../services/attachments.js");
      const access = await import("../services/access.js");
      const owner = at.ownerForRequest(c, access);
      return c.json({ ok: true, attachments: at.listAttachmentsOwned(owner) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/requests/attachments/delete", async (c) => {
    const g = (await import("../services/access.js")).mutationGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const at = await import("../services/attachments.js");
      const access = await import("../services/access.js");
      const owner = at.ownerForRequest(c, access);
      const { id } = await c.req.json().catch(() => ({}));
      if (!id) return c.json({ error: "id required" }, 400);
      const ok = at.deleteAttachmentOwned(id, owner);
      if (!ok) return c.json({ error: "attachment not found or expired" }, 404);
      return c.json({ ok: true, deleted: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

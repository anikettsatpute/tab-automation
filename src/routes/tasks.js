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

  // Chat launch: fast 202 enqueue (worker runs the workflow). Never awaits
  // long model work in the request; poll /api/control/jobs/:id for runId.
  app.post("/api/control/chat", async (c) => {
    const { sessionGuard, auditActor } = await import("../services/access.js");
    const g = sessionGuard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const { text, workflow, idempotencyKey } = await c.req.json().catch(() => ({}));
      if (!text && !workflow) return c.json({ error: "text or workflow required" }, 400);
      const wf = (cfg.workflows || []).find((w) => w.id === (workflow || "assistant-chat")) ||
        { id: "adhoc-chat", trigger: { type: "manual" }, steps: [{ id: "reply", type: "agent", agent: "assistant", prompt: text || "Hello" }] };
      const { enqueueJobSync, audit } = await import("../db.js");
      const { id: jobId, deduped, job } = enqueueJobSync(root, {
        kind: "chat", payload: { text: String(text || "").slice(0, 4000), workflow: wf.id }, idempotencyKey: idempotencyKey || null,
      });
      audit(root, { actor: auditActor(c), action: deduped ? "chat.deduped" : "chat.enqueue", target: jobId, detail: wf.id });
      try { writeLog(root, { level: "info", source: "dashboard-chat", message: `chat ${wf.id} enqueued as ${jobId}` }); } catch {}
      return c.json({ ok: true, workflow: wf.id, jobId, deduped: !!deduped, status: job.status, hint: "202 accepted — poll /api/control/jobs/:id for runId" }, deduped ? 200 : 202);
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

  // Live session transcript: runs `muse export --session <cliSessionId>`
  // and returns a parsed, UI-ready transcript (user/assistant/tool turns).
  // Cached 60s per session so repeated opens don't re-spawn the CLI.
  // Legacy rows store the synthetic supervisor id (run:agent:ts) in
  // agent_sessions.session_uuid; the real Muse CLI UUID lives read-only in
  // the expected session_attempts result envelope (cliSessionId). Resolve it
  // lazily with strict association + envelope hash checks (no DB writes).
  const _exportCache = new Map();
  const CLI_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const isCliUuid = (v) => CLI_UUID_RE.test(String(v || ""));
  app.get("/api/control/task/:id/sessions/:idx/export", async (c) => {
    try {
      const runId = c.req.param("id");
      const { listAgentSessions, listSessionAttempts } = await import("../db.js");
      const { validateEnvelope } = await import("../services/envelope.js");
      const sessions = listAgentSessions(root, runId);
      const s = sessions[Number(c.req.param("idx"))];
      if (!s) return c.json({ error: "session not found" }, 404);
      let cliId = s.session_uuid;
      let legacyResolved = false;
      if (!cliId || cliId.length < 8) return c.json({ error: "no CLI session id recorded" }, 404);
      // Prefer DB real UUID when present; otherwise lazily resolve legacy
      // synthetic ids from the expected session_attempts result envelope.
      // Read-only: no DB writes, no backfill. Never spawn a model here.
      if (!isCliUuid(cliId)) {
        const attempts = listSessionAttempts(root, runId) || [];
        const cand = attempts.filter((a) => Number(a.step_index) === Number(s.step_number) && String(a.session_id) === String(s.session_uuid));
        if (!cand.length) {
          return c.json({ error: `no exportable CLI session id (stored '${String(cliId).slice(0, 64)}' is not a Muse session UUID; no matching session_attempts row)` }, 404);
        }
        const row = cand.find((a) => String(a.agent || "") === String(s.agent_role || "") && String(a.model || "") === String(s.model || "")) || cand[0];
        if (String(row.run_id) !== String(runId) || String(row.session_id) !== String(s.session_uuid)) {
          return c.json({ error: "session_attempts association mismatch" }, 404);
        }
        if (s.agent_role && row.agent && String(row.agent) !== String(s.agent_role)) {
          return c.json({ error: "agent mismatch for legacy session" }, 404);
        }
        if (s.model && row.model && String(row.model) !== String(s.model)) {
          return c.json({ error: "model mismatch for legacy session" }, 404);
        }
        const rawPath = String(row.result_path || s.transcript_path || "");
        if (!rawPath) return c.json({ error: "no result path for legacy session" }, 404);
        if (rawPath.includes("..")) return c.json({ error: "resultPath traversal refused" }, 404);
        const want = `data/responses/${runId}/`;
        if (!rawPath.includes(want) && !rawPath.endsWith(`data/responses/${runId}`)) {
          return c.json({ error: "resultPath outside run dir" }, 404);
        }
        const { resolve: resolvePath, sep } = await import("node:path");
        const { existsSync: existsSync2, readFileSync: readFileSync2, realpathSync: realpathSync2 } = await import("node:fs");
        const base = resolvePath(String(root), "data", "responses", String(runId));
        const abs = resolvePath(rawPath.startsWith("/") ? rawPath : resolvePath(String(root), rawPath));
        if (abs !== base && !abs.startsWith(base + sep)) {
          return c.json({ error: "resultPath outside run dir" }, 404);
        }
        if (!existsSync2(abs)) return c.json({ error: "result envelope missing" }, 404);
        try {
          const real = realpathSync2(abs);
          const realBase = realpathSync2(base);
          if (real !== realBase && !real.startsWith(realBase + sep)) {
            return c.json({ error: "responses symlink escape" }, 404);
          }
        } catch { /* best effort; resolved-path check already passed */ }
        let env;
        try { env = JSON.parse(readFileSync2(abs, "utf8")); } catch { return c.json({ error: "result envelope parse failed" }, 404); }
        const v = validateEnvelope(env);
        if (!v.ok) return c.json({ error: `result envelope invalid: ${v.error}` }, 404);
        if (String(env.runId) !== String(runId) || String(env.sessionId) !== String(s.session_uuid)) {
          return c.json({ error: "envelope run/session mismatch" }, 404);
        }
        if (String(env.agent) !== String(row.agent || s.agent_role) || String(env.model) !== String(row.model || s.model)) {
          return c.json({ error: "envelope agent/model mismatch" }, 404);
        }
        if (!isCliUuid(env.cliSessionId)) {
          return c.json({ error: `no exportable CLI session id (envelope cliSessionId missing for '${String(cliId).slice(0, 64)}')` }, 404);
        }
        cliId = String(env.cliSessionId);
        legacyResolved = true;
      }
      const hit = _exportCache.get(cliId);
      if (hit && Date.now() - hit.at < 60000) return c.json({ ok: true, cached: true, ...hit.data });
      const { spawnSync } = await import("node:child_process");
      const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "sess-exp-"));
      const out = join(dir, "export.json");
      const r = spawnSync("muse", ["export", "--session", cliId, "--out", out], { timeout: 45000, encoding: "utf8" });
      if (r.status !== 0) { try { rmSync(dir, { recursive: true, force: true }); } catch {} return c.json({ error: `muse export failed: ${String(r.stderr || r.stdout || r.error || "").slice(0, 300)}` }, 502); }
      let doc;
      try { doc = JSON.parse(readFileSync(out, "utf8")); } catch (e) { try { rmSync(dir, { recursive: true, force: true }); } catch {} return c.json({ error: "export parse failed" }, 502); }
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      // Transcript turns: export_schema_version 1 carries messages TWO ways:
      // (a) direct envelope payloads on record events (runtime.session run
      //     started / assistant_message_committed, runtime.user_intent with
      //     model_messages), and (b) legacy nested envelope.children with
      //     record_json payloads. Read both; the old children-only parser
      //     returned zero turns on real exports.
      const turns = [];
      const pushTurn = (at, kind, text) => {
        const t = String(text || "").slice(0, 4000);
        if (!t) return;
        turns.push({ at: at || null, kind: String(kind || "event").slice(0, 60), text: t });
      };
      const textOf = (p) => {
        if (!p || typeof p !== "object") return typeof p === "string" ? p : "";
        return p.text || p.content || p.input_text || p.prompt || (typeof p.message === "string" ? p.message : "");
      };
      for (const e of doc.events || []) {
        const env = e.envelope || {};
        // (a) direct envelope payload
        if (env.payload_type && env.payload !== undefined) {
          const pt = String(env.payload_type || "");
          const p = env.payload || {};
          const rec = (p && typeof p.record === "object" && p.record) || null;
          if (pt === "runtime.user_intent.accepted" && Array.isArray(p.model_messages)) {
            for (const m of p.model_messages) {
              const parts = Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("\n") : String(m.content || "");
              pushTurn(e.recorded_at || null, "user", parts);
            }
          } else if (pt === "runtime.session" && p && p.kind === "run" && p.event) {
            const ev = p.event;
            if (ev.kind === "started" && ev.prompt) pushTurn(e.recorded_at || null, "prompt", ev.prompt);
            else if (ev.kind === "assistant_message_committed" && ev.text) pushTurn(e.recorded_at || null, "assistant", ev.text);
            else if (ev.kind === "tool_call_committed" || ev.kind === "tool_result_committed") pushTurn(e.recorded_at || null, "tool", textOf(ev) || JSON.stringify(ev).slice(0, 2000));
          } else if (/message|prompt|completion|tool|intent/.test(pt)) {
            const t = textOf(p) || (rec ? textOf(rec) : "");
            if (t) pushTurn(e.recorded_at || null, pt.split(".").pop(), t);
          }
        }
        // (b) legacy nested children with record_json
        for (const k of env.children || []) {
          let rec2;
          try { rec2 = JSON.parse(k.record_json || "{}"); } catch { continue; }
          const pt = rec2.payload_type || "";
          const p = rec2.payload || {};
          const text = textOf(p);
          if (pt.includes("message") || pt.includes("prompt") || pt.includes("completion") || pt.includes("tool")) {
            pushTurn(rec2.recorded_at || null, pt.split(".").pop(), text || JSON.stringify(p).slice(0, 4000));
          }
          if (turns.length > 200) break;
        }
        if (turns.length > 200) break;
      }
      const meta = (doc.sessions || [])[0] || {};
      const data = {
        sessionId: cliId, agent: s.agent_role, model: s.model,
        turnCount: meta.turn_count ?? turns.length, stepCount: meta.step_count ?? null,
        exitReason: meta.session_end?.exit_reason || null, turns: turns.slice(0, 100),
        legacy: legacyResolved, syntheticId: legacyResolved ? s.session_uuid : undefined,
      };
      _exportCache.set(cliId, { at: Date.now(), data });
      return c.json({ ok: true, cached: false, ...data });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

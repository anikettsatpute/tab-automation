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

  // Launch a task from a type + goal: creates the task row with per-goal steps,
  // then runs the agent chain (each step spawns a Muse session, JSON reconciled).
  // Tasks ≠ automations: same pipeline shape (agent chain), but repeatable per
  // goal — one task row + one run per launch. After the run we sync run_steps
  // back into task_steps so the Loop-tasks pane shows real outputs, not pending.
  app.post("/api/control/task-types/:id/launch", async (c) => {
    try {
      const { goal, title } = await c.req.json().catch(() => ({}));
      if (!goal || !String(goal).trim()) return c.json({ error: "goal required" }, 400);
      const doc = loadJson("config/streams.json", { taskTypes: [] });
      const type = (doc.taskTypes || []).find((t) => t.id === c.req.param("id"));
      if (!type) return c.json({ error: "unknown task type" }, 404);
      const { runWorkflow } = await import("../workflow.js");
      const { getRun, listRuns } = await import("../db.js");
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
      const wf = { id: `task-${taskId}`, name: `${type.name} ${taskId}`, trigger: { type: "manual" }, steps };
      const trigger = { kind: "dashboard-task", text: String(goal).slice(0, 1000), user: "dashboard", taskId, taskType: type.id };
      let runCtx = null, runError = null;
      try {
        runCtx = await runWorkflow(cfg, { log, sendDiscord: async () => {} }, wf, trigger);
      } catch (e) {
        runError = e;
      }
      // Sync run_steps -> task_steps so Loop tasks pane shows real per-step outputs.
      let runId = runCtx?._runId || null;
      if (!runId) {
        try {
          const cand = listRuns(root, { workflowId: `task-${taskId}`, limit: 1 })[0];
          if (cand) runId = cand.id;
        } catch {}
      }
      let runStatus = runCtx ? "done" : "failed";
      let runErrText = runError ? String(runError.message || runError).slice(0, 500) : "";
      try {
        if (runId) {
          const full = getRun(root, runId);
          if (full) {
            runStatus = full.status || runStatus;
            runErrText = full.error || runErrText;
            const rsteps = full.steps || [];
            const synced = steps.map((s, i) => {
              const rs = rsteps.find((x) => x.step_id === s.id) || rsteps[i];
              const st = !rs ? "pending" : rs.status === "ok" ? "done" : rs.status === "failed" ? "failed" : "pending";
              let out = "";
              if (rs) {
                try {
                  const oj = rs.output_json ? JSON.parse(rs.output_json) : null;
                  out = String(oj?.output || oj?.summary || rs.raw_text || "").slice(0, 8000);
                } catch { out = String(rs.raw_text || "").slice(0, 8000); }
              }
              return { step_id: s.id, type: s.type, agent: s.agent, model: "", status: st, prompt: s.prompt, output: out, position: i };
            });
            saveTaskSteps(root, taskId, synced);
            const doneCount = synced.filter((s) => s.status === "done").length;
            updateTask(root, taskId, {
              status: runStatus === "done" ? "done" : "failed",
              progress: Math.round((doneCount / Math.max(1, synced.length)) * 100),
              tokens: full.tokens || 0,
              blocked_reason: runStatus === "done" ? "" : (runErrText || "step failed").slice(0, 500),
            });
          }
        } else {
          updateTask(root, taskId, { status: "failed", progress: 0, blocked_reason: runErrText.slice(0, 500) || "no run" });
        }
      } catch {}
      writeLog(root, { level: "info", source: "dashboard-task", message: `task ${taskId} [${type.id}] launched -> run ${runId || "?"} (${runStatus})`, runId: runId || null });
      return c.json({ ok: true, taskId, runId, agents: type.agents, status: runStatus, error: runStatus === "done" ? undefined : runErrText });
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

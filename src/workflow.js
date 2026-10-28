import { chatCompletion } from "./azure.js";
import { chatWithTools } from "./agent.js";
import { runTool } from "./webtools.js";
import { saveMemory, searchMemory, formatMemories } from "./memory.js";
import { runFinanceBriefing } from "./finance-brief.js";
import { createRun, finishRun, recordStep, recordActivity, writeLog, bumpRunStats } from "./db.js";

const MAX_DISCORD = 1900;
const MAX_SUBFLOW_DEPTH = 5;

export function renderTemplate(text, ctx) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const val = lookup(ctx, key.trim());
    if (val == null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });
}

function lookup(ctx, key) {
  if (key === "now") return new Date().toISOString();
  if (key === "date") return new Date().toISOString().slice(0, 10);
  // steps.<subflow-prefix>.<step> may contain dots in the prefix; try longest match
  if (key.startsWith("steps.")) {
    const rest = key.slice("steps.".length);
    const steps = ctx.steps ?? {};
    if (rest in steps) return steps[rest] ?? "";
    // fall through to dotted walk for nested objects
  }
  const parts = key.split(".");
  let cur = ctx;
  for (const p of parts) {
    if (cur == null) return "";
    cur = cur[p];
  }
  return cur ?? "";
}

/** Parse agent text into a coerced object per outputSchema {var: bool|int|string}. */
export function parseJsonOutput(text, outputSchema) {
  let raw = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, value: null, error: `JSON parse failed: ${err.message}`, raw: text };
  }
  if (!outputSchema) return { ok: true, value: parsed, error: null, raw: text };
  const out = {};
  for (const [k, t] of Object.entries(outputSchema)) {
    let v = parsed?.[k];
    if (t === "bool") {
      if (typeof v === "string") v = /^(true|yes|1)$/i.test(v.trim());
      out[k] = Boolean(v);
    } else if (t === "int") {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? Math.trunc(n) : 0;
    } else {
      out[k] = v == null ? "" : String(v);
    }
  }
  return { ok: true, value: out, error: null, raw: text };
}

export function jsonPromptSuffix(outputSchema) {
  if (!outputSchema) return "";
  const fields = Object.entries(outputSchema).map(([k, t]) => `"${k}": <${t}>`).join(", ");
  return `\n\nRespond with ONLY valid JSON, no other text, no code fences, exactly this shape: { ${fields} }. Max 8 fields as listed.`;
}

function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return ["true", "yes", "1", "y"].includes(s);
}

function checkCondition(cond, ctx) {
  const left = renderTemplate(cond.left ?? "", ctx);
  const right = renderTemplate(cond.right ?? "", ctx);
  switch (cond.operator) {
    case "contains": return left.includes(right);
    case "not_contains": return !left.includes(right);
    case "equals": return left === right;
    case "not_equals": return left !== right;
    case "matches": try { return new RegExp(right).test(left); } catch { return false; }
    case "longer_than": return left.length > Number(right);
    case "is_true": return truthy(left);
    case "is_false": return !truthy(left);
    default: return false;
  }
}

export function chunk(text, size = MAX_DISCORD) {
  if (text.length <= size) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function runWorkflow(cfg, deps, workflow, triggerCtx = {}) {
  const ctx = {
    now: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    trigger: triggerCtx,
    steps: {},
    workflow: workflow.id,
    _depth: triggerCtx._depth ?? 0,
  };
  let runId = null;
  try {
    runId = createRun(cfg.root, { workflowId: workflow.id, kind: triggerCtx.kind || "manual", trigger: triggerCtx });
  } catch (err) {
    deps.log?.(`[db] createRun failed (continuing without persistence): ${err.message}`);
  }
  ctx._runId = runId;
  // Worktree + context snapshot (reference: IMPLEMENTATION §3.1 Step 1).
  // Best-effort: never break a run if the FS is read-only.
  try {
    const { worktreePath, contextFilePath, handoffPath } = await import("./orchestrator.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    if (runId) {
      mkdirSync(worktreePath(cfg.root, runId), { recursive: true });
      mkdirSync(`${cfg.root}/data/responses/${runId}`, { recursive: true });
      writeFileSync(handoffPath(cfg.root, runId),
        `# handoff — run ${runId} (${workflow.id})\nstarted: ${ctx.now}\ntrigger: ${JSON.stringify(triggerCtx).slice(0, 500)}\n`, { flag: "w" });
      (workflow.steps ?? []).forEach((s, i) => {
        try { writeFileSync(contextFilePath(cfg.root, runId, i), `# context — step ${i + 1} ${s.id} (${s.type})\n\n${s.prompt || s.message || s.text || s.template || ""}\n`.slice(0, 20000), { flag: "w" }); } catch {}
      });
    }
  } catch { /* best effort */ }
  try {
    await runSteps(cfg, deps, workflow.steps ?? [], ctx);
    if (runId) { try { finishRun(cfg.root, runId, { status: "done" }); } catch {} }
  } catch (err) {
    if (runId) { try { finishRun(cfg.root, runId, { status: "failed", error: err.message }); } catch {} }
    throw err;
  }
  return ctx;
}

/** Collect task items for a task step: explicit fields or agent JSON via `from`. */
function collectTaskItems(step, ctx) {
  if (Array.isArray(step.tasks)) {
    return step.tasks.map((t) => typeof t === "string" ? { title: renderTemplate(t, ctx) } : {
      title: renderTemplate(t.title ?? t.text ?? "", ctx), text: renderTemplate(t.text ?? t.title ?? "", ctx),
      due: t.due || null, priority: t.priority || "P3",
    });
  }
  if (step.from) {
    let src = ctx.steps[step.from];
    if (typeof src === "string") { try { src = JSON.parse(src); } catch { /* keep raw */ } }
    const arr = Array.isArray(src) ? src : src?.tasks;
    if (Array.isArray(arr)) return arr.map((t) => typeof t === "string" ? { title: t } : t);
  }
  const single = renderTemplate(step.title ?? step.text ?? "", ctx);
  return single ? [{ title: single, due: step.due || null, priority: step.priority || "P3" }] : [];
}

async function runSteps(cfg, deps, steps, ctx) {
  // Live progress: total up front so the dashboard shows 0/N immediately.
  try {
    const { bumpRunProgress } = await import("./db.js");
    bumpRunProgress(cfg.root, ctx._runId, { total: steps.length, done: 0, title: ctx.trigger?.text || ctx.workflow });
  } catch {}
  for (let i = 0; i < steps.length; i++) {
    ctx._stepIdx = i;
    await runStep(cfg, deps, steps[i], ctx);
    // Live progress: bump done count after each step so the board moves.
    try {
      const { bumpRunProgress } = await import("./db.js");
      bumpRunProgress(cfg.root, ctx._runId, { done: i + 1 });
    } catch {}
  }
}

function persistStep(cfg, deps, ctx, step, { status = "ok", rawText = "", outputJson = null, agent = null }) {
  if (!ctx._runId) return;
  try {
    recordStep(cfg.root, ctx._runId, {
      stepId: step.id, type: step.type, agent: agent ?? step.agent ?? null,
      status, rawText, outputJson,
    });
  } catch (err) {
    deps.log?.(`[db] recordStep failed: ${err.message}`);
  }
}

async function runStep(cfg, deps, step, ctx) {
  deps.log?.(`[${ctx.workflow}] step ${step.id} (${step.type})`);
  const t0 = Date.now();
  const done = (status, extra = "") => {
    try {
      recordActivity(cfg.root, { runId: ctx._runId, kind: "step", actor: step.agent || ctx.workflow, action: `${step.type}:${step.id}`, detail: extra, durationMs: Date.now() - t0, status });
    } catch {}
  };
  // Reference palette aliases: Run agent/Create task/File request/Notify/Run automation/Wait
  if (step.type === "run_agent") step = { ...step, type: "agent" };
  if (step.type === "notify") step = { ...step, type: "discord_send" };
  if (step.type === "wait") step = { ...step, type: "delay", ms: step.ms ?? ((step.seconds ?? 0) * 1000 || 1000) };
  if (step.type === "run_automation") step = { ...step, type: "subflow" };
  if (step.type === "create_task") step = { ...step, type: "task" };
  switch (step.type) {
    case "agent": {
      let prompt = renderTemplate(step.prompt ?? "", ctx);
      if (step.output === "json" && step.outputSchema) prompt += jsonPromptSuffix(step.outputSchema);
      const mem = step.memory === false ? "" : formatMemories(searchMemory(cfg.root, prompt, 4));
      const tAgent = Date.now();
      // Loop dispatch: ONE Muse session per step as the agent dispatcher.
      // Session writes JSON (SESSION_JSON_CONTRACT); our loop reconciles it into the DB.
      // Model selection lives in configuration (step.model > agent.model > provider.modelDefault).
      const { dispatchAgent } = await import("./agent.js");
      const session = await dispatchAgent(cfg, {
        agent: step.agent || "assistant", model: step.model || "",
        prompt, extraContext: mem,
        toolCtx: {
          runId: ctx._runId, user: ctx.trigger?.user || "", channelId: ctx.trigger?.channelId || "",
          taskTitle: ctx.trigger?.text || ctx.workflow, stepGoal: step.id,
        },
        useTools: step.tools !== false,
        jsonContract: step.jsonContract !== false,
      });
      const out = session.raw;
      const patch = session.patch || null;
      // Session record (reference: Sessions tab + agentSessions).
      try {
        const { recordAgentSession } = await import("./db.js");
        recordAgentSession(cfg.root, ctx._runId, {
          stepNumber: ctx._stepIdx ?? 0, sessionUuid: session.sessionId,
          runnerType: "tab-automation", agentRole: step.agent || "assistant",
          model: step.model || cfg.agents?.get?.(step.agent)?.model || cfg.agents?.get?.(step.agent)?.deployment || "",
          workspace: "tab-automation",
        });
      } catch {}
      try {
        recordActivity(cfg.root, { runId: ctx._runId, kind: "tool", actor: step.agent || ctx.workflow, action: `agent:${step.agent || "assistant"}`, detail: String(prompt).slice(0, 300), durationMs: Date.now() - tAgent, status: session.ok ? "ok" : "failed" });
      } catch {}
      // Reconcile session JSON into the run: status/summary/output/next/updates.
      if (session.ok && patch) {
        try {
          const { bumpRunStats } = await import("./db.js");
          if (patch.tokens) bumpRunStats(cfg.root, ctx._runId, { tokens: patch.tokens });
        } catch {}
        if (patch.next) ctx.steps[`${step.id}.next`] = patch.next;
        if (patch.status === "blocked" || patch.status === "failed") {
          persistStep(cfg, deps, ctx, step, { status: "failed", rawText: out, outputJson: patch, agent: step.agent });
          if (step.saveAs) ctx.steps[step.saveAs] = patch;
          ctx.steps[step.id] = patch;
          throw new Error(`Step ${step.id}: session reported ${patch.status} — ${patch.summary}`);
        }
      } else if (!session.ok) {
        persistStep(cfg, deps, ctx, step, { status: "failed", rawText: out, outputJson: { _parseError: session.error }, agent: step.agent });
        throw new Error(`Step ${step.id}: session JSON invalid (${session.error})`);
      }
      let stored = patch?.output ?? out;
      let outputJson = patch || null;
      if (step.output === "json") {
        // Session patch is already structured JSON — use it directly.
        // Only re-parse when the step explicitly needs outputSchema coercion
        // AND the patch lacks those fields (legacy text-mode steps).
        const needsCoerce = step.outputSchema && !Object.keys(step.outputSchema).every((k) => patch && patch[k] !== undefined && k !== "output" && k !== "summary");
        if (!needsCoerce && patch) {
          stored = patch;
          outputJson = patch;
        } else {
          const parsed = parseJsonOutput(patch?.output ?? out, step.outputSchema);
          if (parsed.ok) {
            stored = parsed.value;
            outputJson = parsed.value;
          } else {
            stored = { _raw: out, _parseError: parsed.error };
            outputJson = stored;
            persistStep(cfg, deps, ctx, step, { status: "failed", rawText: out, outputJson: stored, agent: step.agent });
            if (step.saveAs) ctx.steps[step.saveAs] = stored;
            ctx.steps[step.id] = stored;
            throw new Error(`Step ${step.id}: agent did not return valid JSON (${parsed.error})`);
          }
        }
      }
      if (step.saveAs) ctx.steps[step.saveAs] = stored;
      ctx.steps[step.id] = stored;
      persistStep(cfg, deps, ctx, step, { rawText: out, outputJson, agent: step.agent });
      done("ok", String(out).slice(0, 300));
      return stored;
    }
    case "discord_send": {
      const message = renderTemplate(step.message ?? "", ctx);
      await deps.sendDiscord?.(renderTemplate(step.channel ?? "", ctx) || undefined, message);
      ctx.steps[step.id] = message;
      persistStep(cfg, deps, ctx, step, { rawText: message });
      done("ok", message.slice(0, 200));
      return message;
    }
    case "condition": {
      const ok = checkCondition(step.condition ?? {}, ctx);
      ctx.steps[step.id] = ok ? "true" : "false";
      persistStep(cfg, deps, ctx, step, { rawText: ok ? "true" : "false" });
      await runSteps(cfg, deps, ok ? step.then ?? [] : step.else ?? [], ctx);
      return ok;
    }
    case "subflow": {
      const targetId = renderTemplate(step.workflow ?? "", ctx);
      if (!targetId) throw new Error(`Step ${step.id}: subflow missing 'workflow'`);
      if (targetId === ctx.workflow) throw new Error(`Step ${step.id}: subflow cannot call itself`);
      if ((ctx._depth ?? 0) >= MAX_SUBFLOW_DEPTH) throw new Error(`Step ${step.id}: max subflow depth ${MAX_SUBFLOW_DEPTH} exceeded`);
      const target = (cfg.workflows ?? []).find((w) => w.id === targetId);
      if (!target) throw new Error(`Step ${step.id}: unknown workflow '${targetId}'`);
      const subCtx = {
        now: ctx.now, date: ctx.date,
        trigger: { ...ctx.trigger, _depth: (ctx._depth ?? 0) + 1, parent: ctx.workflow },
        steps: ctx.steps,
        workflow: targetId,
        _depth: (ctx._depth ?? 0) + 1,
        _runId: ctx._runId,
      };
      const before = new Set(Object.keys(ctx.steps));
      await runSteps(cfg, deps, target.steps ?? [], subCtx);
      const prefix = step.prefix ?? targetId;
      for (const k of Object.keys(ctx.steps)) {
        if (!before.has(k) && !k.startsWith(`${prefix}.`)) ctx.steps[`${prefix}.${k}`] = ctx.steps[k];
      }
      ctx.steps[step.id] = `subflow ${targetId} done (${Object.keys(subCtx.steps).length} steps)`;
      persistStep(cfg, deps, ctx, step, { rawText: ctx.steps[step.id] });
      return ctx.steps[step.id];
    }
    case "transform": {
      const template = step.template ?? "";
      const out = renderTemplate(template, ctx);
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: out });
      return out;
    }
    case "delay": {
      await new Promise((r) => setTimeout(r, step.ms ?? 1000));
      persistStep(cfg, deps, ctx, step, { rawText: `delayed ${step.ms ?? 1000}ms` });
      return true;
    }
    case "http": {
      const url = renderTemplate(step.url ?? "", ctx);
      const res = await fetch(url, {
        method: (step.method ?? "GET").toUpperCase(),
        headers: step.headers ?? {},
        body: step.body ? renderTemplate(step.body, ctx) : undefined,
      });
      const text = await res.text();
      const out = `HTTP ${res.status}: ${text.slice(0, 2000)}`;
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: out });
      try { recordActivity(cfg.root, { runId: ctx._runId, kind: "tool", actor: ctx.workflow, action: `http:${(step.method ?? "GET").toUpperCase()}`, detail: `${url} -> ${res.status}`, durationMs: Date.now() - t0, status: res.ok ? "ok" : "failed" }); } catch {}
      done(res.ok ? "ok" : "failed", out.slice(0, 200));
      return out;
    }
    case "log": {
      const text = renderTemplate(step.text ?? "", ctx);
      deps.log?.(`[${ctx.workflow}] ${text}`);
      ctx.steps[step.id] = text;
      persistStep(cfg, deps, ctx, step, { rawText: text });
      return text;
    }
    case "finance": {
      const rawMarket = renderTemplate(step.market ?? "india", ctx).trim().toLowerCase();
      const market = rawMarket.includes("us") ? "us" : "india";
      const result = await runFinanceBriefing(cfg, deps, {
        market,
        post: step.post !== false,
        channel: renderTemplate(step.channel ?? "", ctx) || undefined,
      });
      if (step.saveAs) ctx.steps[step.saveAs] = result.message;
      ctx.steps[step.id] = result.message;
      persistStep(cfg, deps, ctx, step, { rawText: result.message });
      return result.message;
    }
    case "web": {
      const action = (step.action ?? "search").toLowerCase();
      const arg = renderTemplate(step.query ?? step.url ?? step.topic ?? "", ctx);
      let out;
      const toolName = action === "fetch" ? "web_fetch" : action === "news" ? "web_news" : action === "github" ? "github_search" : action === "oauth" ? "oauth_discover" : "web_search";
      if (action === "fetch") out = await runTool("web_fetch", { url: arg });
      else if (action === "news") out = await runTool("web_news", { topic: arg, region: step.region ?? "IN" });
      else if (action === "github") out = await runTool("github_search", { query: arg, count: step.count ?? 6 });
      else if (action === "oauth") out = await runTool("oauth_discover", { url: arg });
      else out = await runTool("web_search", { query: arg, count: step.count ?? 6 });
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: out });
      try { recordActivity(cfg.root, { runId: ctx._runId, kind: "tool", actor: step.agent || ctx.workflow, action: toolName, detail: String(arg).slice(0, 300), durationMs: Date.now() - t0, status: String(out).startsWith("ERROR") ? "failed" : "ok" }); } catch {}
      done("ok", String(out).slice(0, 200));
      return out;
    }
    case "remember": {
      const text = renderTemplate(step.text ?? "", ctx);
      saveMemory(cfg.root, { kind: step.kind ?? "note", user: "workflow", text, channelId: "" });
      ctx.steps[step.id] = text;
      persistStep(cfg, deps, ctx, step, { rawText: text });
      return text;
    }
    case "recall": {
      const q = renderTemplate(step.query ?? "", ctx);
      const hits = searchMemory(cfg.root, q, step.limit ?? 5);
      const out = formatMemories(hits);
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: out });
      return out;
    }
    case "task": {
      // Reference Create-task step: agent JSON -> persisted TASK rows -> todos.
      // Accepts explicit {title, text, tasks:[...]} or {from:"<agentStepId>"} pointing at agent JSON.
      const { addTodo } = await import("./db.js");
      const items = collectTaskItems(step, ctx);
      const created = [];
      for (const item of items.slice(0, 25)) {
        const id = addTodo(cfg.root, {
          text: String(item.title || item.text || "").slice(0, 1000) || `(task from ${step.id})`,
          due: item.due || null, priority: item.priority || "P3",
          project: `flow:${ctx.workflow}`,
          user: ctx.trigger?.user || "", channelId: ctx.trigger?.channelId || "",
        });
        created.push({ id, title: item.title || item.text || "" });
      }
      const out = { created: created.length, tasks: created };
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: JSON.stringify(out), outputJson: out });
      done("ok", `${created.length} tasks`);
      return out;
    }
    case "file_request": {
      const { addReminder, addTodo } = await import("./db.js");
      const what = renderTemplate(step.what ?? step.text ?? "", ctx);
      const out = { filed: what.slice(0, 500) };
      try {
        if (step.at) addReminder(cfg.root, { text: what.slice(0, 1000), at: renderTemplate(step.at, ctx), user: ctx.trigger?.user || "", channelId: ctx.trigger?.channelId || "" });
        else addTodo(cfg.root, { text: `[request] ${what}`.slice(0, 1000), project: `flow:${ctx.workflow}`, user: ctx.trigger?.user || "", channelId: ctx.trigger?.channelId || "" });
      } catch {}
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: JSON.stringify(out), outputJson: out });
      return out;
    }
    case "digest": {
      const { listTodos, listReminders } = await import("./db.js");
      const open = listTodos(cfg.root, { status: "open", limit: step.limit ?? 20 });
      const pending = listReminders(cfg.root, {});
      const lines = [`📋 Todo digest — ${ctx.date} (${open.length} open, ${pending.length} reminders)`];
      for (const t of open) lines.push(`- [${t.priority}] ${t.text}${t.due ? ` (due ${t.due.slice(0, 16).replace("T", " ")})` : ""} \`${t.id}\``);
      for (const r of pending) lines.push(`- ⏰ ${r.text} @ ${r.at.slice(0, 16).replace("T", " ")}`);
      if (!open.length && !pending.length) lines.push("All clear — nothing open.");
      const out = lines.join("\n");
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      persistStep(cfg, deps, ctx, step, { rawText: out });
      return out;
    }
    default:
      throw new Error(`Unknown step type '${step.type}' in step '${step.id}'`);
  }
}

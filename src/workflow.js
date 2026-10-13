import { chatCompletion } from "./azure.js";

const MAX_DISCORD = 1900;

export function renderTemplate(text, ctx) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const val = lookup(ctx, key.trim());
    return val == null ? "" : String(val);
  });
}

function lookup(ctx, key) {
  if (key === "now") return new Date().toISOString();
  if (key === "date") return new Date().toISOString().slice(0, 10);
  const parts = key.split(".");
  let cur = ctx;
  for (const p of parts) {
    if (cur == null) return "";
    cur = cur[p];
  }
  return cur ?? "";
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
  };
  await runSteps(cfg, deps, workflow.steps ?? [], ctx);
  return ctx;
}

async function runSteps(cfg, deps, steps, ctx) {
  for (const step of steps) {
    await runStep(cfg, deps, step, ctx);
  }
}

async function runStep(cfg, deps, step, ctx) {
  deps.log?.(`[${ctx.workflow}] step ${step.id} (${step.type})`);
  switch (step.type) {
    case "agent": {
      const prompt = renderTemplate(step.prompt ?? "", ctx);
      const out = await chatCompletion(cfg, step.agent, prompt);
      if (step.saveAs) ctx.steps[step.saveAs] = out;
      ctx.steps[step.id] = out;
      return out;
    }
    case "discord_send": {
      const message = renderTemplate(step.message ?? "", ctx);
      await deps.sendDiscord?.(renderTemplate(step.channel ?? "", ctx) || undefined, message);
      ctx.steps[step.id] = message;
      return message;
    }
    case "condition": {
      const ok = checkCondition(step.condition ?? {}, ctx);
      ctx.steps[step.id] = ok ? "true" : "false";
      await runSteps(cfg, deps, ok ? step.then ?? [] : step.else ?? [], ctx);
      return ok;
    }
    case "delay": {
      await new Promise((r) => setTimeout(r, step.ms ?? 1000));
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
      return out;
    }
    case "log": {
      const text = renderTemplate(step.text ?? "", ctx);
      deps.log?.(`[${ctx.workflow}] ${text}`);
      ctx.steps[step.id] = text;
      return text;
    }
    default:
      throw new Error(`Unknown step type '${step.type}' in step '${step.id}'`);
  }
}

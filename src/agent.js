import { resolveProvider, buildChatRequest } from "./providers.js";
import { TOOL_DEFS, runTool } from "./webtools.js";
import { customToolDefs, runCustomTool } from "./custom-tools.js";
import { TODO_TOOL_DEFS, runTodoTool } from "./todos.js";
import { loadJson } from "./setup-api.js";

const MAX_ITERS = 5;

export const CREATE_TOOL_DEF = {
  name: "create_tool",
  description: "Create a new custom HTTP tool from a plain-language need (e.g. 'control my Havells bulb: on/off, color, brightness at https://...'). Use when no existing tool can do the job. The tool is proposed, tested, and saved for reuse. Physical/financial tools require owner approval.",
  parameters: {
    type: "object",
    properties: {
      need: { type: "string", description: "What the tool should do + any known API details (base URL, auth, endpoints)" },
      testArgs: { type: "string", description: "Optional JSON args for a live test call, e.g. '{\"state\":\"on\"}'" },
    },
    required: ["need"],
  },
};

/** Tools visible to an agent: web built-ins + custom, filtered by agent.tools allowlist.
 *  Default (no allowlist or ["*"]) = everything. create_tool is always available. */
function allToolDefs(cfg, agent) {
  const custom = customToolDefs(loadJson("config/tools.json", {}).customTools);
  let defs = [...TOOL_DEFS, ...TODO_TOOL_DEFS, ...custom];
  const allow = agent?.tools;
  if (allow && !(allow.length === 1 && allow[0] === "*")) {
    const set = new Set(allow);
    defs = defs.filter((t) => set.has(t.name) || set.has(`custom_${t.name}`) || set.has(t.name.replace(/^custom_/, "")));
  }
  return [...defs, CREATE_TOOL_DEF].map((t) => ({ type: "function", function: t }));
}

async function runAnyTool(cfg, name, args, ctx = {}) {
  if (name === "create_tool") return agentCreateTool(cfg, null, args);
  if (name.startsWith("todo_") || name.startsWith("remind_")) return runTodoTool(cfg.root, name, args, ctx);
  if (name.startsWith("custom_")) {
    const tools = loadJson("config/tools.json", {}).customTools ?? [];
    const tool = tools.find((t) => `custom_${t.id}` === name);
    if (!tool) throw new Error(`Unknown custom tool '${name}'`);
    return runCustomTool(tool, args);
  }
  return runTool(name, args);
}

/** Agent-driven tool creation: generate spec -> live test -> save.
 *  Physical/financial tools (approvalRequired) are saved as pending unless
 *  opts.preApproved (owner already approved via Discord). */
export async function agentCreateTool(cfg, agent, { need, testArgs }, opts = {}) {
  const { validateCustomTool, runCustomTool: runCT } = await import("./custom-tools.js");
  const { saveJson } = await import("./setup-api.js");
  // 1. generate via the agent's own model
  const agentId = agent?.id ? [...cfg.agents.keys()].find((k) => cfg.agents.get(k) === agent) || "assistant" : "assistant";
  const spec = await chatWithTools(cfg, agentId,
    `Design a custom HTTP tool. User need: ${String(need).slice(0, 1000)}\n` +
    `First RESEARCH with web_search + github_search + web_fetch (at least 2 searches, always include one github_search for existing MCP servers/libraries). If the target uses OAuth, run oauth_discover on its base URL and include endpoints in your reasoning.\n` +
    `Respond with ONLY valid JSON: {"tool": {"id": "<snake_case>", "description": "", "method": "GET|POST|PUT|DELETE", "url": "<https with {{params.x}} vars>", "headers": {}, "bodyTemplate": "", "params": {"<name>": {"description": "", "required": true}}, "timeoutMs": 20000, "approvalRequired": false}}\n` +
    `Rules: id [a-z0-9_], max 8 params, https only, approvalRequired=true for physical/financial actions.`,
    {});
  const clean = String(spec).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const tool = JSON.parse(clean).tool;
  const err = validateCustomTool(tool);
  if (err) return `ERROR: generated tool invalid: ${err}`;
  // 2. live test if args supplied
  let testOut = "(no test args — skipping live test)";
  if (testArgs) {
    try {
      testOut = await runCT(tool, JSON.parse(testArgs));
    } catch (e) {
      return `ERROR: tool generated but live test failed: ${e.message}. Not saved. Refine 'need' and retry.`;
    }
    if (String(testOut).startsWith("ERROR")) return `ERROR: live test failed: ${testOut}. Not saved.`;
  }
  // 3. approval gate for physical tools
  if (tool.approvalRequired && !opts.preApproved) {
    return `PENDING_APPROVAL: tool '${tool.id}' needs owner approval (physical/financial action). Spec: ${JSON.stringify(tool).slice(0, 800)}\nTest: ${String(testOut).slice(0, 300)}`;
  }
  // 4. save
  const { loadJson } = await import("./setup-api.js");
  const doc = loadJson("config/tools.json", {});
  doc.customTools = [...(doc.customTools ?? []).filter((t) => t.id !== tool.id), tool];
  saveJson("config/tools.json", doc);
  return `SAVED custom_${tool.id}: ${tool.description}. Test: ${String(testOut).slice(0, 300)}`;
}

// Agentic chat: model may call web_fetch / web_search / web_news, results feed back in.
// Falls back to plain chatCompletion behavior when the endpoint errors on tools.
// dispatchAgent: loop-engine entry point. Model selection stays in configuration:
// per-call `model` > agent.model/deployment (env: supported) > provider.modelDefault.
// Empty prompt falls back to agent.defaultPrompt (config/agents.json).
//
// Muse session model: every step/automation-step spawns ONE `muse exec` session
// as the agent dispatcher. The session writes JSON (SESSION_JSON_CONTRACT) to
// stdout AND to data/responses/<runId>/step<N>.json; our loop code reconciles
// that JSON into the DB (tasks/task_steps/runs). The session never writes the
// DB directly. Provider "muse" (default) uses the Muse CLI + MUSE_KEY;
// other providers (azure/openrouter/meta) keep the HTTP chat path.
export async function dispatchAgent(cfg, { agent = "assistant", model = "", prompt = "", extraContext = "", toolCtx = {}, useTools = true, jsonContract = true } = {}) {
  const base = cfg.agents.get(agent);
  if (!base) throw new Error(`Unknown agent '${agent}'`);
  const text = String(prompt ?? "").trim() || String(base.defaultPrompt ?? "").trim();
  if (!text) throw new Error(`Empty prompt and no defaultPrompt for agent '${agent}'`);
  const effective = model?.trim() ? { ...base, model: model.trim() } : base;
  const resolved = resolveProvider({ ...cfg, agents: new Map(cfg.agents).set(agent, effective) }, effective);
  // Muse CLI path (default provider): headless `muse exec` session per step.
  if (resolved.type === "muse") {
    return dispatchViaMuse(cfg, { agent, base: effective, model: resolved.model, prompt: text, extraContext, toolCtx, jsonContract });
  }
  const effCfg = { ...cfg, agents: new Map(cfg.agents).set(agent, effective) };
  // Wrap the prompt so the session returns reconciliable JSON.
  // Force JSON mode on the call so long system prompts can't override the contract.
  // When jsonContract is on, the system prompt IS the contract — agent prose can't win.
  const { sessionPrompt } = await import("./orchestrator.js");
  const contractText = sessionPrompt({ agent, taskTitle: toolCtx.taskTitle || "", stepGoal: toolCtx.stepGoal || "", context: extraContext });
  const finalPrompt = jsonContract ? `${text}\n\n---\n${contractText}` : (extraContext ? `${text}\n\nContext:\n${extraContext}` : text);
  const sysPrompt = jsonContract
    ? `You are the '${agent}' agent in a task loop. You MUST respond with ONLY valid JSON matching this shape, no other text, no markdown, no code fences: {"status": "done|failed|blocked", "summary": "one-line what happened", "output": "main result text", "next": "suggested next agent id or empty", "updates": {"progress": 0, "tokens": 0}}. Do the work described by the user, then put your result in the output field.`
    : base.systemPrompt;
  const effJson = jsonContract ? { ...effective, systemPrompt: sysPrompt, output: "json" } : effective;
  const effCfgJson = { ...effCfg, agents: new Map(effCfg.agents).set(agent, effJson) };
  const sessionId = `${toolCtx.runId || "adhoc"}:${agent}:${Date.now().toString(36)}`;
  const t0 = Date.now();
  let raw;
  if (!useTools) {
    raw = await plainCall(effCfgJson, effJson, [
      { role: "system", content: base.systemPrompt + "\n\n" + contractText },
      { role: "user", content: finalPrompt },
    ], { resolved });
  } else {
    raw = await chatWithTools(effCfgJson, agent, finalPrompt, { extraContext: "", toolCtx });
  }
  // Reconcile: parse session JSON -> DB patch. Raw text preserved for audit.
  const { reconcileSessionJson } = await import("./orchestrator.js");
  const rec = jsonContract ? reconcileSessionJson(raw) : { ok: true, patch: { status: "done", summary: String(raw).slice(0, 300), output: String(raw).slice(0, 8000), next: "", progress: 0, tokens: 0 } };
  try {
    const { recordActivity } = await import("./db.js");
    recordActivity(cfg.root, {
      runId: toolCtx.runId || null, kind: "session", actor: agent,
      action: `session:${sessionId}`, detail: `contract=${jsonContract ? "json" : "raw"} ok=${rec.ok} status=${rec.patch?.status || "?"}`,
      durationMs: Date.now() - t0, status: rec.ok ? "ok" : "failed",
    });
  } catch {}
  return { sessionId, agent, model: effective.model || "", raw, ...rec };
}

// Muse CLI dispatch: one headless `muse exec` session per step.
// Writes the session JSON to data/responses/<runId>/step<N>.json (step1.json
// style) + reconciles it into a DB patch via reconcileSessionJson.
// Model: resolved muse model id (default muse-spark-1.3 contributor).
async function dispatchViaMuse(cfg, { agent, base, model, prompt, extraContext = "", toolCtx = {}, jsonContract = true }) {
  // Async spawn (never spawnSync): the HTTP server + Discord must stay
  // responsive while a Muse session thinks (60-120s per step). Blocking the
  // event loop freezes the dashboard + health checks mid-run.
  const { spawn } = await import("node:child_process");
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { reconcileSessionJson, sessionPrompt } = await import("./orchestrator.js");
  const { MUSE_DEFAULT_MODEL } = await import("./providers.js");
  const museModel = (model || MUSE_DEFAULT_MODEL).trim() || MUSE_DEFAULT_MODEL;
  const runId = toolCtx.runId || "adhoc";
  const stepIdx = Number(toolCtx.stepIdx ?? toolCtx.stepNumber ?? 0) || 0;
  const sessionId = `${runId}:${agent}:${Date.now().toString(36)}`;
  const t0 = Date.now();
  // Step files: data/responses/<runId>/step<N>.json (+ .prompt.md for audit).
  const dir = `${cfg.root}/data/responses/${runId}`;
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const stepFile = `${dir}/step${stepIdx + 1}.json`;
  const promptFile = `${dir}/step${stepIdx + 1}.prompt.md`;
  const contractText = sessionPrompt({ agent, taskTitle: toolCtx.taskTitle || "", stepGoal: toolCtx.stepGoal || "", context: extraContext });
  const finalPrompt = jsonContract
    ? `${base.systemPrompt || ""}\n\n---\nTask: ${prompt}\n${extraContext ? `\nContext:\n${String(extraContext).slice(0, 3000)}\n` : ""}\n---\n${contractText}`
    : `${base.systemPrompt || ""}\n\nTask: ${prompt}${extraContext ? `\n\nContext:\n${extraContext}` : ""}`;
  try { writeFileSync(promptFile, finalPrompt.slice(0, 20000)); } catch {}
  // Headless session: prompt via --prompt-file (avoids shell-quoting issues),
  // JSON answer parsed from stdout. Session id links the CLI log to our run.
  const promptTmp = `${dir}/step${stepIdx + 1}.input.txt`;
  try { writeFileSync(promptTmp, finalPrompt.slice(0, 30000)); } catch {}
  const { randomUUID } = await import("node:crypto");
  const cliSession = randomUUID();
  const args = [
    "exec", "--provider", "meta", "--model", museModel, "--contributor-mode", "on",
    "--approval-mode", "never", "--disable-sandbox",
    "--session-id", cliSession,
    "--prompt-file", promptTmp,
  ];
  const env = { ...process.env };
  // MUSE_KEY from .env authenticates the CLI (meta provider).
  if (!env.MUSE_KEY && cfg.museKey) env.MUSE_KEY = cfg.museKey;
  // Async run with timeout: collects stdout/stderr without blocking the loop.
  const runMuse = () => new Promise((resolve) => {
    let raw = "", stderr = "";
    let child;
    try {
      child = spawn("muse", args, { env, cwd: cfg.root, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ raw: "", stderr: String(err.message || err), status: 1, spawnError: err });
      return;
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 300000);
    child.stdout?.on("data", (d) => { raw += String(d); if (raw.length > 8 * 1024 * 1024) raw = raw.slice(-8 * 1024 * 1024); });
    child.stderr?.on("data", (d) => { stderr += String(d); if (stderr.length > 512 * 1024) stderr = stderr.slice(-512 * 1024); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ raw, stderr, status: 1, spawnError: err }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ raw, stderr, status: Number(code ?? 1) }); });
  });
  let raw = "", stderr = "", status = 0;
  try {
    const r = await runMuse();
    raw = String(r.raw || "");
    stderr = String(r.stderr || "");
    status = Number(r.status ?? (r.spawnError ? 1 : 0));
    if (r.spawnError && !raw) throw r.spawnError;
  } catch (err) {
    const rec0 = { ok: false, error: `muse exec failed: ${String(err.message || err).slice(0, 300)}`, patch: null };
    try {
      const { recordActivity } = await import("./db.js");
      recordActivity(cfg.root, { runId: toolCtx.runId || null, kind: "session", actor: agent, action: `session:${sessionId}`, detail: `muse model=${museModel} failed: ${rec0.error}`, durationMs: Date.now() - t0, status: "failed" });
    } catch {}
    return { sessionId, agent, model: museModel, raw: "", error: rec0.error, ...rec0, stepFile };
  }
  // Muse prints log lines to stderr; JSON answer is the last {...} block on stdout.
  let jsonText = raw.trim();
  const lastBrace = jsonText.lastIndexOf("{");
  if (jsonText.startsWith("muse:") || !jsonText.startsWith("{")) {
    const m = jsonText.match(/\{[\s\S]*\}\s*$/);
    if (m) jsonText = m[0];
    else if (lastBrace !== -1) jsonText = jsonText.slice(lastBrace);
  }
  try { writeFileSync(stepFile, jsonText.slice(0, 20000)); } catch {}
  if (status !== 0 && !jsonText) {
    const errText = `muse exec exit ${status}: ${stderr.slice(0, 300)}`;
    try {
      const { recordActivity } = await import("./db.js");
      recordActivity(cfg.root, { runId: toolCtx.runId || null, kind: "session", actor: agent, action: `session:${sessionId}`, detail: `muse model=${museModel} ${errText}`, durationMs: Date.now() - t0, status: "failed" });
    } catch {}
    return { sessionId, agent, model: museModel, raw, error: errText, ok: false, patch: null, stepFile };
  }
  const rec = jsonContract
    ? reconcileSessionJson(jsonText)
    : { ok: true, patch: { status: "done", summary: jsonText.slice(0, 300), output: jsonText.slice(0, 8000), next: "", progress: 0, tokens: 0 } };
  // If the model returned status "complete" (schema-shaped) map to done.
  if (rec.patch && !["done", "failed", "blocked"].includes(rec.patch.status)) {
    if (/complete|success/i.test(rec.patch.status)) rec.patch.status = "done";
  }
  try {
    const { recordActivity, bumpRunStats } = await import("./db.js");
    if (rec.ok && rec.patch?.tokens) bumpRunStats(cfg.root, runId === "adhoc" ? null : runId, { tokens: rec.patch.tokens });
    recordActivity(cfg.root, {
      runId: toolCtx.runId || null, kind: "session", actor: agent,
      action: `session:${sessionId}`, detail: `muse model=${museModel} file=${stepFile.split("/").slice(-2).join("/")} ok=${rec.ok} status=${rec.patch?.status || rec.error || "?"}`,
      durationMs: Date.now() - t0, status: rec.ok ? "ok" : "failed",
    });
  } catch {}
  void existsSync;
  void readFileSync;
  return { sessionId, agent, model: museModel, raw: jsonText, stepFile, ...rec };
}
export async function chatWithTools(cfg, agentId, userPrompt, { extraContext = "", toolCtx = {} } = {}) {
  const agent = cfg.agents.get(agentId);
  if (!agent) throw new Error(`Unknown agent '${agentId}'`);
  const resolved = resolveProvider(cfg, agent);
  // Muse provider has no HTTP endpoint — route simple chats through the CLI too.
  if (resolved.type === "muse") {
    const out = await dispatchViaMuse(cfg, { agent: agentId, base: agent, model: resolved.model, prompt: userPrompt, extraContext, toolCtx, jsonContract: false });
    if (!out.ok) throw new Error(out.error || "muse chat failed");
    return out.raw;
  }
  const tools = allToolDefs(cfg, agent);
  const runId = toolCtx.runId || null;
  const tStart = Date.now();
  const note = async (action, detail, ms, status = "ok") => {
    if (!runId) return;
    try {
      const { recordActivity, bumpRunStats } = await import("./db.js");
      recordActivity(cfg.root, { runId, kind: "tool", actor: agentId, action, detail: String(detail ?? "").slice(0, 1000), durationMs: ms, status });
      bumpRunStats(cfg.root, runId, { toolCalls: 1, agent: agentId, model: resolved.model || agent.model || agent.deployment || null });
    } catch {}
  };

  const system = extraContext ? `${agent.systemPrompt}\n\nContext from memory:\n${extraContext}` : agent.systemPrompt;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];

  for (let iter = 0; iter < MAX_ITERS; iter += 1) {
    const { url, headers, body } = buildChatRequest(resolved, agent, messages, { withTools: true, tools });

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      // Endpoint may reject tools (some Foundry routes do) -> retry once without tools
      if (iter === 0) {
        const retry = await plainCall(cfg, agent, messages);
        if (retry) return retry;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    // token usage -> run stats (reference: Tokens/Cost columns)
    try {
      const u = data?.usage;
      if (runId && u && (u.total_tokens || u.prompt_tokens)) {
        const { bumpRunStats } = await import("./db.js");
        const total = Number(u.total_tokens || (Number(u.prompt_tokens || 0) + Number(u.completion_tokens || 0))) || 0;
        bumpRunStats(cfg.root, runId, { tokens: total, agent: agentId, model: resolved.model || agent.model || agent.deployment || null });
      }
    } catch {}
    const toolCalls = msg?.tool_calls ?? [];
    if (!toolCalls.length) {
      const text = (msg?.content ?? "").trim();
      if (!text) throw new Error("Azure OpenAI returned an empty response");
      return text;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* keep {} */ }
      let result;
      const callT0 = Date.now();
      try {
        result = name === "create_tool"
          ? await agentCreateTool(cfg, agent, args)
          : await runAnyTool(cfg, name, args, toolCtx);
      } catch (err) {
        result = `ERROR: ${String(err.message).slice(0, 200)}`;
      }
      await note(name || "tool", `${JSON.stringify(args).slice(0, 300)} -> ${String(result).slice(0, 300)}`, Date.now() - callT0, String(result).startsWith("ERROR") ? "failed" : "ok");
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 6000) });
    }
  }
  // Out of iterations: force a final answer without tools
  return plainCall(cfg, agent, messages) ?? "I ran out of tool steps — please narrow the question.";
}

async function plainCall(cfg, agent, messages, { resolved = null } = {}) {
  const r = resolved || resolveProvider(cfg, agent);
  const slim = messages.filter((m) => m.role === "system" || m.role === "user");
  const { url, headers, body } = buildChatRequest(r, agent, slim, { withTools: false });
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

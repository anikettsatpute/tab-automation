// Async Muse multi-turn tool harness: prompt + context + configured agent.
// Supervisor builds prompt+context, spawns `muse exec` with scoped budgets,
// supports in-flight cancellation via process-tree kill, writes the trusted
// immutable envelope atomically under data/responses/<runId>/step<N>.json.
// Model default: Meta Muse CLI muse-spark-1.3 contributor mode on.
// Respects configured agents; fails closed on non-permitted providers.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveMuseApiKey } from "../providers.js";

const DEFAULT_BUDGETS = {
  wallMs: 300000,          // 5 min wall clock per step
  maxModelSteps: 25,       // --max-model-steps cap
  maxToolBytes: 24000,     // --max-tool-output-bytes cap
};

// Coherent prompt budget (bytes, UTF-8): systemPrompt + task + full
// extraContext + JSON contract must fit. Job payloads already reject >16k
// (jobs.js safePayloadStringify, fail closed); this covers the wrapped
// prompt. Oversized prompts are REJECTED before spawn (failed envelope,
// no truncation, no model call) — never silently sliced.
export const MAX_PROMPT_BYTES = 32000;

// Secrets that must never reach the `muse exec` subprocess. MUSE_KEY is
// Meta auth and is kept; everything below is irrelevant to the model run
// (Discord bot tokens, Azure/OpenRouter/Meta HTTP keys, tunnel auth).
const STRIPPED_ENV_KEYS = [
  "DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID",
  "DISCORD_CHANNEL_ID", "FINANCE_CHANNEL_ID", "DISCORD_LISTEN_CHANNELS",
  "DISCORD_OWNER_USER_ID", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION",
  "OPENROUTER_API_KEY", "META_API_KEY", "GITHUB_TOKEN",
  "CONTROL_TOKEN", "CONTROL_ALLOWED_ORIGIN",
];

/** Build the child env: inherit tooling (PATH/HOME/etc) but strip
 *  Discord/Azure/tunnel secrets. MUSE_KEY (Meta auth) is preserved. */
export function buildChildEnv(cfg) {
  const env = { ...process.env };
  for (const k of STRIPPED_ENV_KEYS) delete env[k];
  // Prefix sweep for Discord/Azure/Control families (future keys included).
  for (const k of Object.keys(env)) {
    if (k === "MUSE_KEY" || k.startsWith("MUSE_")) continue;
    if (k.startsWith("DISCORD_") || k.startsWith("AZURE_") || k.startsWith("CONTROL_")) delete env[k];
  }
  if (!env.MUSE_KEY && cfg?.museKey) env.MUSE_KEY = cfg.museKey;
  return env;
}

const activeChildren = new Map(); // sessionId -> ChildProcess

export function cancelSession(sessionId) {
  const child = activeChildren.get(sessionId);
  if (!child) return false;
  try {
    // Process-tree kill: child was spawned detached so the whole group dies.
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  } catch { return false; }
  activeChildren.delete(sessionId);
  return true;
}

export function activeSessionCount() {
  return activeChildren.size;
}

/**
 * Run one agent step headlessly.
 * @returns { envelope, cancelled } — envelope is the trusted immutable result.
 * Never throws on model failure: failures become failed envelopes.
 */
export async function runAgentStep(cfg, {
  agent, model = "", prompt = "", extraContext = "",
  runId = "adhoc", stepIdx = 0, attempt = 1, jobId = "",
  budgets = {}, cancelCheck = null, jsonContract = true,
} = {}) {
  const t0 = Date.now();
  const { gateProvider, contributorArgs } = await import("./provider-gate.js");
  const { reconcileSessionJson, sessionPrompt } = await import("../orchestrator.js");
  const { buildEnvelope } = await import("./envelope.js");
  const { resultPathFor, ensureResponsesDir, atomicWriteJson } = await import("./paths.js");

  // Fail closed BEFORE spawning anything: provider gate + model allowlist.
  // No other-provider fallback; unknown models are rejected, never defaulted.
  let gated;
  try {
    gated = gateProvider(cfg, agent);
  } catch (err) {
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: model || "", sessionId: `n/a:${Date.now().toString(36)}`, cliSessionId: "", resultPath: "", payload: { status: "failed", summary: String(err.message).slice(0, 300), output: "" }, durationMs: Date.now() - t0 }), cancelled: false, gateError: err.message };
  }
  let museModel;
  try {
    const { gateModel } = await import("./provider-gate.js");
    museModel = model?.trim() ? gateModel(model) : gated.model;
  } catch (err) {
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: model || "", sessionId: `n/a:${Date.now().toString(36)}`, cliSessionId: "", resultPath: "", payload: { status: "failed", summary: String(err.message).slice(0, 300), output: "" }, durationMs: Date.now() - t0 }), cancelled: false, gateError: err.message };
  }
  const base = cfg.agents.get(agent);
  const sessionId = `${runId}:${agent}:${Date.now().toString(36)}`;
  const cliSession = randomUUID();

  // Pre-register the expected assignment BEFORE spawning Muse: the exact
  // (run/step/attempt/session) slot is claimed up front so a crash or a
  // duplicate spawn can never double-reconcile the same step. The claim
  // uses the SAME collision-safe per-attempt/session file the envelope
  // will be written to (never the shared legacy step<N>.json).
  let preClaim = null;
  let file = "";
  let dir = "";
  let promptFile = "";
  try {
    const { openDb, claimSessionAttempt } = await import("../db.js");
    openDb(cfg.root);
    const { resultPathFor: rpf, ensureResponsesDir: ensureDir } = await import("./paths.js");
    const pre = rpf(cfg.root, runId, stepIdx, { attempt, sessionId });
    file = pre.file; dir = pre.dir; promptFile = pre.promptFile;
    ensureDir(cfg.root, runId);
    preClaim = claimSessionAttempt(cfg.root, { jobId, runId, stepIndex: stepIdx, attempt, agent, model: museModel, sessionId, resultPath: pre.file, resultHash: "" });
    if (preClaim.deduped) {
      return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: pre.file, payload: { status: "failed", summary: preClaim.error || "slot already claimed", output: "" }, durationMs: Date.now() - t0 }), cancelled: false, gateError: preClaim.error, deduped: true };
    }
  } catch (err) {
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: "", payload: { status: "failed", summary: `pre-claim failed: ${String(err.message).slice(0, 200)}`, output: "" }, durationMs: Date.now() - t0 }), cancelled: false, gateError: err.message };
  }

  // Collision-safe result path already resolved above (pre-claim file).
  // Re-resolve defensively in case the pre-claim block was skipped.
  if (!file) {
    const rp = resultPathFor(cfg.root, runId, stepIdx, { attempt, sessionId });
    file = rp.file; dir = rp.dir; promptFile = rp.promptFile;
    ensureResponsesDir(cfg.root, runId);
  }
  // Full approved context: extraContext is preserved whole (no 3k slice).
  // sessionPrompt gets context:"" so the contract adds no second truncated
  // copy; the single extraContext block below is the coherent budget.
  const contractText = sessionPrompt({ agent, taskTitle: "", stepGoal: "", context: "" });
  const finalPrompt = jsonContract
    ? `${base?.systemPrompt || ""}\n\n---\nTask: ${prompt}${extraContext ? `\n\nContext:\n${String(extraContext)}\n` : ""}\n---\n${contractText}`
    : `${base?.systemPrompt || ""}\n\nTask: ${prompt}${extraContext ? `\n\nContext:\n${extraContext}` : ""}`;
  // Explicit documented limit: reject BEFORE spawn, never truncate.
  const promptBytes = Buffer.byteLength(finalPrompt, "utf8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: file, payload: { status: "failed", summary: `prompt too large: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} max — split the goal or shorten context (no truncation of execution intent)`, output: "" }, durationMs: Date.now() - t0 }), cancelled: false, gateError: `prompt too large: ${promptBytes} > ${MAX_PROMPT_BYTES}` };
  }
  // Prompt-file write failures fail the job (never a silent catch that runs
  // the model with a missing/empty prompt file). Full prompt preserved.
  try {
    writeFileSync(promptFile, finalPrompt);
  } catch (err) {
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: file, payload: { status: "failed", summary: `prompt write failed: ${String(err.message).slice(0, 200)}`, output: "" }, durationMs: Date.now() - t0 }), cancelled: false, writeError: err.message };
  }
  const promptTmp = `${dir}/step${Number(stepIdx) + 1}.input.txt`;
  try {
    writeFileSync(promptTmp, finalPrompt);
  } catch (err) {
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: file, payload: { status: "failed", summary: `prompt write failed: ${String(err.message).slice(0, 200)}`, output: "" }, durationMs: Date.now() - t0 }), cancelled: false, writeError: err.message };
  }

  const wallMs = Number(budgets.wallMs) || DEFAULT_BUDGETS.wallMs;
  const maxModelSteps = Number(budgets.maxModelSteps) || DEFAULT_BUDGETS.maxModelSteps;
  const maxToolBytes = Number(budgets.maxToolBytes) || DEFAULT_BUDGETS.maxToolBytes;
  // Sandbox + approval stay ON: --disable-sandbox/--yolo/--disable-approval
  // are never passed. cwd is cfg.root (repo root, NOT an isolated run dir
  // and NOT read-only); containment is via prompt + approval-mode, not a
  // scoped mount. Coder shell/write capabilities are preserved (no
  // --disable-shell/--disable-write/--disable-web-tools here).
  const args = [
    "exec", "--provider", "meta", "--model", museModel, ...contributorArgs(),
    "--approval-mode", "never",
    "--no-foreign-personal-context",
    "--disable-reminders",
    "--disable-request-user-input",
    "--max-model-steps", String(maxModelSteps),
    "--max-tool-output-bytes", String(maxToolBytes),
    "--session-id", cliSession,
    "--prompt-file", promptTmp,
  ];
  const env = buildChildEnv(cfg);
  const museApiKey = resolveMuseApiKey(cfg, agent).key;
  if (museApiKey) args.push("--api-key-stdin");
  const museStdin = museApiKey ? "pipe" : "ignore";

  let child = null;
  const raw = await new Promise((resolve) => {
    let out = "", errText = "";
    try {
      child = spawn("muse", args, { env, cwd: cfg.root, stdio: [museStdin, "pipe", "pipe"], detached: true });
      if (museApiKey && child?.stdin) {
        try {
          child.stdin.on("error", () => {});
          child.stdin.write(museApiKey);
          child.stdin.end();
        } catch {}
      }
    } catch (e) {
      resolve({ out: "", errText: String(e.message || e), status: 1, spawnError: e });
      return;
    }
    activeChildren.set(sessionId, child);
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }, wallMs);
    // Cooperative cancel polling: kill the tree as soon as cancel is requested.
    let cancelTimer = null;
    if (typeof cancelCheck === "function") {
      cancelTimer = setInterval(() => {
        try {
          if (cancelCheck()) { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
        } catch {}
      }, 500);
      cancelTimer.unref?.();
    }
    child.stdout?.on("data", (d) => { out += String(d); if (out.length > 4 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024); });
    child.stderr?.on("data", (d) => { errText += String(d); if (errText.length > 256 * 1024) errText = errText.slice(-256 * 1024); });
    child.on("error", (e) => { clearTimeout(timer); if (cancelTimer) clearInterval(cancelTimer); activeChildren.delete(sessionId); resolve({ out, errText, status: 1, spawnError: e }); });
    child.on("close", (code, signal) => { clearTimeout(timer); if (cancelTimer) clearInterval(cancelTimer); activeChildren.delete(sessionId); resolve({ out, errText, status: Number(code ?? 1), signal }); });
  });

  const cancelled = typeof cancelCheck === "function" ? (() => { try { return !!cancelCheck(); } catch { return false; } })() : false;
  const durationMs = Date.now() - t0;
  let jsonText = String(raw.out || "").trim();
  if (jsonText && !jsonText.startsWith("{")) {
    const m = jsonText.match(/\{[\s\S]*\}\s*$/);
    if (m) jsonText = m[0];
  }
  let payload;
  // Cancellation wins over any model output (results race): a late done
  // envelope must never overwrite a cancel request.
  if (cancelled) {
    payload = { status: "cancelled", summary: "cancel requested", output: "" };
  } else if (raw.signal === "SIGKILL" && !jsonText) {
    // Killed by wall-clock/cancel with no output: retryable failure, not done.
    payload = { status: "failed", summary: "muse exec killed (timeout or cancel) with no output", output: "" };
  } else if (raw.spawnError && !jsonText) {
    payload = { status: "failed", summary: `muse exec failed: ${String(raw.spawnError.message || raw.spawnError).slice(0, 300)}`, output: "" };
  } else if (raw.status !== 0 && !jsonText) {
    payload = { status: "failed", summary: `muse exec exit ${raw.status}: ${String(raw.errText || "").slice(0, 300)}`, output: "" };
  } else if (jsonContract) {
    const rec = reconcileSessionJson(jsonText);
    payload = rec.ok ? rec.patch : { status: "failed", summary: rec.error, output: "" };
  } else {
    payload = { status: "done", summary: jsonText.slice(0, 300), output: jsonText.slice(0, 8000), next: "", progress: 0, tokens: 0 };
  }

  const envelope = buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: file, payload, durationMs });
  // File write failures fail the job (never a silent catch that loses the result).
  try {
    atomicWriteJson(file, envelope);
  } catch (err) {
    try {
      const { recordActivity } = await import("../db.js");
      recordActivity(cfg.root, { runId: runId === "adhoc" ? null : runId, kind: "session", actor: agent, action: `session:${sessionId}`, detail: `result write failed: ${String(err.message).slice(0, 200)}`, durationMs, status: "failed" });
    } catch { /* best effort */ }
    return { envelope: buildEnvelope({ runId, stepIdx, attempt, agent, model: museModel, sessionId, cliSessionId: cliSession, resultPath: file, payload: { status: "failed", summary: `result write failed: ${String(err.message).slice(0, 200)}`, output: "" }, durationMs }), cancelled, writeError: err.message };
  }
  try {
    const { recordActivity } = await import("../db.js");
    recordActivity(cfg.root, { runId: runId === "adhoc" ? null : runId, kind: "session", actor: agent, action: `session:${sessionId}`, detail: `muse model=${museModel} status=${envelope.status} attempt=${attempt}`, durationMs, status: envelope.status === "done" ? "ok" : "failed" });
  } catch { /* best effort */ }
  return { envelope, cancelled, attemptId: preClaim?.id || null };
}

export { DEFAULT_BUDGETS };

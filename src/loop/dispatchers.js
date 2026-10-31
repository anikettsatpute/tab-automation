// Dispatcher adapters: spawn one headless agent session (Muse CLI or GitHub Copilot CLI).
// Contract: dispatch(opts) -> Promise<{ exitCode, signal, stdout, stderr, durationMs, sessionId, error? }>.
// The agent is told to write its result JSON to opts.resultPath; stdout is kept as a fallback + transcript.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildChildEnv } from "../services/runner.js";
import { resolveMuseApiKey } from "../providers.js";

const active = new Map(); // key -> ChildProcess
const MAX_STDOUT = 2 * 1024 * 1024;

export function cancelDispatch(key) {
  const child = active.get(key);
  if (!child) return false;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  active.delete(key);
  return true;
}
export const activeDispatches = () => [...active.keys()];

function run(bin, args, { key, cwd, env, stdin = null, timeoutMs, transcriptPath }) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let child;
    let stdout = "", stderr = "";
    const tx = transcriptPath ? createWriteStream(transcriptPath, { flags: "a" }) : null;
    try {
      child = spawn(bin, args, { cwd, env, stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      tx?.end();
      resolve({ exitCode: 1, signal: null, stdout: "", stderr: "", durationMs: 0, error: `spawn failed: ${e.message}` });
      return;
    }
    active.set(key, child);
    if (stdin != null) { child.stdin.on("error", () => {}); child.stdin.end(stdin); }
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }, timeoutMs);
    child.stdout.on("data", (d) => { const s = String(d); tx?.write(s); if (stdout.length < MAX_STDOUT) stdout += s; });
    child.stderr.on("data", (d) => { if (stderr.length < 256 * 1024) stderr += String(d); });
    const done = (exitCode, signal, error) => {
      clearTimeout(timer); active.delete(key); tx?.end();
      resolve({ exitCode, signal, stdout, stderr, durationMs: Date.now() - t0, ...(error ? { error } : {}) });
    };
    child.on("error", (e) => done(1, null, `spawn failed: ${e.message}`));
    child.on("close", (code, signal) => done(code ?? 1, signal, signal === "SIGKILL" ? "killed (timeout or cancel)" : undefined));
  });
}

// ---------- Muse CLI ----------
const museBin = () => process.env.MUSE_BIN || "muse";

export const muse = {
  id: "muse",
  label: "Muse CLI",
  available() {
    const r = spawnSync(museBin(), ["--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0 ? { ok: true, version: String(r.stdout).trim() } : { ok: false, error: r.error?.message || String(r.stderr || "").trim() || "muse not found" };
  },
  async dispatch(cfg, { key, role, model, cwd, promptFile, transcriptPath, timeoutMs = 900000, maxModelSteps = 60, outputSchema = null }) {
    const sessionId = randomUUID();
    const args = [
      "exec", "--provider", "meta", "--model", model || "muse-spark-1.3", "--contributor-mode", "on",
      "--approval-mode", "never", "--no-foreign-personal-context", "--disable-reminders", "--disable-request-user-input",
      "--max-model-steps", String(maxModelSteps), "--max-tool-output-bytes", "24000",
      "--session-id", sessionId, "--prompt-file", promptFile,
    ];
    if (outputSchema) args.push("--output-schema", outputSchema);
    // Opt-in: bwrap cannot create namespaces in some hosts (e.g. flatpak), which blocks every shell call.
    if (process.env.LOOP_MUSE_SANDBOX === "off") args.push("--disable-sandbox");
    const apiKey = resolveMuseApiKey(cfg, role).key;
    if (apiKey) args.push("--api-key-stdin");
    const r = await run(museBin(), args, { key, cwd, env: buildChildEnv(cfg), stdin: apiKey || null, timeoutMs, transcriptPath });
    return { ...r, sessionId };
  },
};

// ---------- GitHub Copilot CLI ----------
// Prefer the npm-installed CLI: VS Code puts an install-prompt shim named `copilot` earlier on PATH.
const LOCAL_COPILOT = path.join(os.homedir(), ".local/bin/copilot");
const copilotBin = () => process.env.COPILOT_BIN || (existsSync(LOCAL_COPILOT) ? LOCAL_COPILOT : "copilot");

export const copilot = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  available() {
    const r = spawnSync(copilotBin(), ["--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    if (r.status === 0 && !/Cannot find GitHub Copilot CLI|Install GitHub Copilot CLI/i.test(out)) return { ok: true, version: String(r.stdout).trim().split("\n")[0] };
    return { ok: false, error: r.error?.message || "GitHub Copilot CLI not installed (npm i -g @github/copilot, then `copilot` once to log in)" };
  },
  async dispatch(cfg, { key, model, cwd, promptText, taskDir, transcriptPath, timeoutMs = 900000 }) {
    // Headless: prompt via -p; tools auto-approved because nobody can answer prompts in Auto mode.
    const args = ["-p", promptText, "--allow-all-tools", "--add-dir", taskDir];
    if (model) args.push("--model", model);
    const extra = String(process.env.COPILOT_EXTRA_ARGS || "").trim();
    if (extra) args.push(...extra.split(/\s+/));
    const r = await run(copilotBin(), args, { key, cwd, env: buildChildEnv(cfg), timeoutMs, transcriptPath });
    return { ...r, sessionId: "" };
  },
};

export const DISPATCHERS = { muse, copilot };

export function getDispatcher(id) {
  const d = DISPATCHERS[id];
  if (!d) throw new Error(`unknown dispatcher '${id}' (use muse or copilot)`);
  return d;
}

let _avail = null;
let _availAt = 0;
/** Cached availability (60s) — probing spawns processes. */
export function dispatcherStatus({ fresh = false } = {}) {
  if (!fresh && _avail && Date.now() - _availAt < 60000) return _avail;
  _avail = Object.values(DISPATCHERS).map((d) => ({ id: d.id, label: d.label, ...d.available() }));
  _availAt = Date.now();
  return _avail;
}

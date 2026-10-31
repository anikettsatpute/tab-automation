// MCP registry + per-agent injection.
// Servers live in config/tools.json (no secret values). Each server gets a stable
// number; its secrets live in .env as MCP_<num>_<SLOT>. Agents opt in via
// agents.json `mcp: [serverId]` (default: none). At spawn time only the granted,
// ready servers are passed to the CLI, with their secrets copied into per-run
// MCP_RUN_<num>_<KEY> vars so Muse sees whole-value ${VAR} references.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../loop/workspace.js";
import { writeEnv } from "./envfile.js";

export const MCP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SLOT_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
const REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const FORBIDDEN_REF = /^(DISCORD_|AZURE_|CONTROL_|MUSE_|MCP_RUN_)/;

const toolsPath = (root) => path.join(root, "config", "tools.json");

export function readTools(root) {
  const p = toolsPath(root);
  if (!existsSync(p)) return { servers: [], customTools: [] };
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { servers: [], customTools: [] }; }
}
export function writeTools(root, doc) {
  atomicWrite(toolsPath(root), JSON.stringify(doc, null, 2) + "\n");
}

/** Servers with a stable `num` (assigned once, never reused). Persists new numbers. */
export function listServers(root) {
  const doc = readTools(root);
  const servers = doc.servers || [];
  let next = Math.max(0, Number(doc.mcpNextNum) || 0, ...servers.map((s) => Number(s.num) || 0)) + 1;
  let changed = false;
  for (const s of servers) if (!Number(s.num)) { s.num = next++; changed = true; }
  if (changed || (doc.mcpNextNum || 0) < next - 1) { doc.mcpNextNum = next - 1; doc.servers = servers; writeTools(root, doc); }
  return servers;
}

export const OAUTH_PROVIDERS = {
  google: {
    label: "Google",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    extraParams: { access_type: "offline", prompt: "consent" },
    helpUrl: "https://console.cloud.google.com/apis/credentials",
    clientHint: "One-time: Google Cloud Console → enable the Gmail API → APIs & Services → Credentials → Create OAuth client ID (Web application) → add the redirect URI below → paste the Client ID and secret here.",
  },
};

// stdio packages that take a bearer token via env: sign in on their behalf.
const KNOWN_OAUTH = [
  { test: (a) => /^gmail-mcp(@[\w.-]+)?$/.test(a), provider: "google", tokenEnv: "GOOGLE_ACCESS_TOKEN",
    scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic" },
];
export function oauthPreset(s) {
  if (s.transport === "http") return null;
  return KNOWN_OAUTH.find((k) => (s.args || []).some((a) => k.test(String(a)))) || null;
}

export const secretKey = (num, slot) => `MCP_${num}_${slot}`;
const envVal = (k) => String(process.env[k] ?? "").trim();

/** Every ${VAR} referenced by a server's env/headers. */
export function serverRefs(s) {
  const refs = new Set();
  for (const v of [...Object.values(s.env || {}), ...Object.values(s.headers || {})]) {
    for (const m of String(v).matchAll(REF_RE)) refs.add(m[1]);
  }
  return [...refs];
}

/** A reference is allowed if it is this server's own MCP_<num>_* var, or a
 *  non-MCP var outside the stripped secret families (legacy setups). */
export function refAllowed(s, name) {
  if (FORBIDDEN_REF.test(name)) return false;
  if (/^MCP_\d+_/.test(name)) return name.startsWith(`MCP_${s.num}_`);
  return true;
}

/** Status for UI + injection: ready | needs-secret | needs-auth | error | disabled. */
export function serverStatus(s) {
  if (s.enabled === false) return { status: "disabled", missing: [] };
  const bad = serverRefs(s).filter((r) => !refAllowed(s, r));
  if (bad.length) return { status: "error", missing: [], hint: `forbidden reference: ${bad.join(", ")}` };
  const missing = serverRefs(s).filter((r) => !envVal(r));
  for (const sl of s.secrets || []) { const k = secretKey(s.num, sl.slot); if (sl.required !== false && !envVal(k) && !missing.includes(k)) missing.push(k); }
  const oauthy = !!(s.oauth || oauthPreset(s));
  if (oauthy && !envVal(secretKey(s.num, "ACCESS_TOKEN")) && !missing.includes(secretKey(s.num, "ACCESS_TOKEN"))) missing.push(secretKey(s.num, "ACCESS_TOKEN"));
  if (missing.length) return { status: oauthy ? "needs-auth" : "needs-secret", missing };
  if (s.authStatus === "needed") return { status: "needs-auth", missing: [], hint: s.authHint || "" };
  if (s.authStatus === "error") return { status: "error", missing: [], hint: s.authHint || "" };
  return { status: "ready", missing: [] };
}

/** How this server signs in: discover (http), provider preset, or custom endpoints. */
export function signInInfo(s) {
  const preset = oauthPreset(s);
  const provider = s.oauth?.provider || preset?.provider || "";
  const p = OAUTH_PROVIDERS[provider];
  const kind = p ? "provider" : s.transport === "http" ? "discover" : "custom";
  return {
    kind, provider, label: p?.label || "", helpUrl: p?.helpUrl || "", clientHint: p?.clientHint || "",
    scope: s.oauth?.scope ?? preset?.scope ?? "", tokenEnv: s.oauth?.tokenEnv || preset?.tokenEnv || "",
    authorizationEndpoint: kind === "custom" ? s.oauth?.authorizationEndpoint || "" : "",
    tokenEndpoint: kind === "custom" ? s.oauth?.tokenEndpoint || "" : "",
    clientSet: !!envVal(secretKey(s.num, "CLIENT_ID")),
    suggested: kind !== "custom" || !!s.oauth,
  };
}

/** Public view: no secret values, only set/unset per slot. */
export function publicServer(s, agents = []) {
  const st = serverStatus(s);
  return {
    num: s.num, id: s.id, name: s.name || "", note: s.note || "", transport: s.transport === "http" ? "http" : "stdio",
    command: s.command || "", args: s.args || [], url: s.url || "", env: s.env || {}, headers: s.headers || {},
    enabled: s.enabled !== false,
    secrets: (s.secrets || []).map((sl) => ({ slot: sl.slot, label: sl.label || "", key: secretKey(s.num, sl.slot), set: !!envVal(secretKey(s.num, sl.slot)) })),
    oauth: s.oauth ? { authorizationEndpoint: s.oauth.authorizationEndpoint || "", tokenEndpoint: s.oauth.tokenEndpoint || "", scope: s.oauth.scope || "", accessEnv: s.oauth.accessEnv || "",
      signedIn: !!envVal(secretKey(s.num, "ACCESS_TOKEN")), signedInAt: s.oauth.signedInAt || "", expiresAt: Number(envVal(secretKey(s.num, "EXPIRES_AT"))) || 0, canRefresh: !!envVal(secretKey(s.num, "REFRESH_TOKEN")) } : null,
    signIn: signInInfo(s),
    authHint: s.authHint || "", lastTestedAt: s.lastTestedAt || "",
    ...st,
    agents: agents.filter((a) => (a.mcp || []).includes(s.id)).map((a) => a.id),
  };
}

const expand = (v) => String(v).replace(REF_RE, (_, k) => envVal(k));
const runKey = (num, kind, k) => `MCP_RUN_${num}_${kind}_${String(k).toUpperCase().replace(/[^A-Z0-9]/g, "_")}`.slice(0, 64);

/** Refresh an OAuth access token when it is within 2 minutes of expiry. */
export async function ensureFreshToken(root, s, { refresh, force = false } = {}) {
  if (!s.oauth?.tokenEndpoint) return { ok: true };
  const exp = Number(envVal(secretKey(s.num, "EXPIRES_AT"))) || 0;
  if (!force && (!exp || exp > Date.now() + 120000)) return { ok: true };
  const rt = envVal(secretKey(s.num, "REFRESH_TOKEN"));
  if (!rt) return { ok: false, error: "token expired and no refresh token — sign in again" };
  try {
    const doRefresh = refresh || (await import("../oauth.js")).refreshAccessToken;
    const t = await doRefresh(s.oauth.tokenEndpoint, { refreshToken: rt, clientId: envVal(secretKey(s.num, "CLIENT_ID")), clientSecret: envVal(secretKey(s.num, "CLIENT_SECRET")) });
    saveTokens(root, s, t);
    return { ok: true, refreshed: true };
  } catch (e) {
    return { ok: false, error: `refresh failed: ${String(e.message).slice(0, 200)}` };
  }
}

export function saveTokens(root, s, t) {
  const patch = { [secretKey(s.num, "ACCESS_TOKEN")]: t.access_token };
  if (t.refresh_token) patch[secretKey(s.num, "REFRESH_TOKEN")] = t.refresh_token;
  patch[secretKey(s.num, "EXPIRES_AT")] = t.expires_in ? String(Date.now() + Number(t.expires_in) * 1000) : null;
  writeEnv(root, patch);
}

/** Resolve one agent's MCP grant into CLI args + child env. Never throws.
 *  Servers that are not ready are skipped (a failing server would abort the whole Muse run). */
export async function mcpForAgent(cfg, agentId, opts = {}) {
  const out = { used: [], skipped: [], env: {}, muse: [], copilot: null };
  const agent = agentId ? cfg?.agents?.get?.(agentId) : null;
  const grant = Array.isArray(agent?.mcp) ? agent.mcp : [];
  if (!grant.length) return out;
  let servers;
  try { servers = listServers(cfg.root); } catch (e) { out.skipped.push({ id: "*", reason: e.message }); return out; }
  const copilotServers = {};
  for (const id of grant) {
    const s = servers.find((x) => x.id === id);
    if (!s) { out.skipped.push({ id, reason: "not configured" }); continue; }
    const fresh = await ensureFreshToken(cfg.root, s, opts);
    if (!fresh.ok) { out.skipped.push({ id, reason: fresh.error }); continue; }
    const st = serverStatus(s);
    if (st.status !== "ready") { out.skipped.push({ id, reason: `${st.status}${st.missing?.length ? `: ${st.missing.join(", ")}` : ""}${st.hint ? `: ${st.hint}` : ""}` }); continue; }
    const museEntry = s.transport === "http" ? { transport: "streamable_http", url: s.url } : { transport: "stdio", command: s.command, args: s.args || [] };
    const cpEntry = s.transport === "http" ? { type: "http", url: s.url, tools: ["*"] } : { type: "local", command: s.command, args: s.args || [], tools: ["*"] };
    for (const [field, kind] of [["env", "E"], ["headers", "H"]]) {
      const src = s[field] || {};
      if (!Object.keys(src).length) continue;
      museEntry[field] = {}; cpEntry[field] = {};
      for (const [k, v] of Object.entries(src)) {
        const rk = runKey(s.num, kind, k);
        out.env[rk] = expand(v);
        museEntry[field][k] = `\${${rk}}`;
        cpEntry[field][k] = out.env[rk];
      }
    }
    out.muse.push("-c", `mcpServers.${s.id}=${JSON.stringify(museEntry)}`);
    copilotServers[s.id] = cpEntry;
    out.used.push(s.id);
  }
  if (out.used.length) out.copilot = { mcpServers: copilotServers };
  return out;
}

/** Copilot reads --additional-mcp-config from a file; values are literal, so the
 *  file is 0600 in a private temp dir and must be removed after the run. */
export function writeCopilotConfig(conf) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tab-mcp-"));
  const file = path.join(dir, "mcp.json");
  writeFileSync(file, JSON.stringify(conf), { mode: 0o600 });
  return { file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

/** Resolved env/headers for a probe (same expansion as a real run). */
export function resolvedFields(s) {
  const f = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, expand(v)]));
  return { env: f(s.env), headers: f(s.headers) };
}

/** Handshake + tools/list. Returns { ok, tools, status?, hint }. */
export async function probeServer(s, { baseEnv = {}, timeoutMs = 60000 } = {}) {
  const { env, headers } = resolvedFields(s);
  return s.transport === "http" ? probeHttp(s.url, headers, timeoutMs) : probeStdio(s, { ...baseEnv, ...env }, timeoutMs);
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tab-automation", version: "1" } } };

async function probeStdio(s, env, timeoutMs) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let child, buf = "", err = "", done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child?.kill("SIGKILL"); } catch {} resolve(r); };
    const t = setTimeout(() => finish({ ok: false, tools: [], hint: `no tools/list reply in ${Math.round(timeoutMs / 1000)}s${err ? `: ${err.slice(-200)}` : ""}` }), timeoutMs);
    try { child = spawn(s.command, s.args || [], { env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { finish({ ok: false, tools: [], hint: e.message }); return; }
    child.on("error", (e) => finish({ ok: false, tools: [], hint: e.message }));
    child.on("close", (code) => finish({ ok: false, tools: [], hint: `exited (${code})${err ? `: ${err.slice(-300)}` : ""}` }));
    child.stderr.on("data", (d) => { if (err.length < 8000) err += String(d); });
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (m.id === 2) {
          finish(m.error ? { ok: false, tools: [], hint: String(m.error.message || "tools/list failed").slice(0, 300) } : { ok: true, tools: (m.result?.tools || []).map((x) => x.name) });
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(INIT) + "\n");
  });
}

function rpcBody(text) {
  const t = String(text || "").trim();
  if (t.startsWith("{")) { try { return JSON.parse(t); } catch { return null; } }
  for (const line of t.split(/\r?\n/).reverse()) if (line.startsWith("data:")) { try { return JSON.parse(line.slice(5).trim()); } catch {} }
  return null;
}

async function probeHttp(url, headers, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const post = (body, sid) => fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body) });
  try {
    const r1 = await post(INIT);
    if (r1.status === 401 || r1.status === 403) return { ok: false, tools: [], status: r1.status, authRequired: true, hint: `HTTP ${r1.status}: sign-in required` };
    if (!r1.ok) return { ok: false, tools: [], status: r1.status, hint: `HTTP ${r1.status}` };
    const sid = r1.headers.get("mcp-session-id") || "";
    const init = rpcBody(await r1.text());
    if (!init?.result) return { ok: false, tools: [], hint: "not an MCP server (no initialize result)" };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid).then((r) => r.text()).catch(() => {});
    const r2 = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sid);
    const list = rpcBody(await r2.text());
    if (!list?.result) return { ok: false, tools: [], status: r2.status, hint: String(list?.error?.message || `tools/list HTTP ${r2.status}`).slice(0, 300) };
    return { ok: true, tools: (list.result.tools || []).map((x) => x.name) };
  } catch (e) {
    return { ok: false, tools: [], hint: e.name === "AbortError" ? "timed out" : `unreachable: ${String(e.message).slice(0, 200)}` };
  } finally { clearTimeout(t); }
}

/** Muse aborts the whole run when a server fails to start; flag it so the next run skips it. */
export function noteMcpFailure(root, stderr) {
  const m = /MCP server `([^`]+)` failed/.exec(String(stderr || ""));
  if (!m) return null;
  try {
    const doc = readTools(root);
    const s = (doc.servers || []).find((x) => x.id === m[1]);
    if (s) { s.authStatus = "error"; s.authHint = "Failed to start during an agent run — fix and Test again."; writeTools(root, doc); }
  } catch {}
  return m[1];
}

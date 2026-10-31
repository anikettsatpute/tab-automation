// Shared Control Room state, helpers, API client.
// Imported by main.js + every view module. Single source of truth for S.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const S = {
  view: "board", detailTab: "overview", sel: null, detail: null, fromTab: null,
  kindFilter: "all", lastOk: 0,
  cfg: { enabled: true, refreshSec: 3 },
  ov: null, tasks: [], agents: [], tools: [], activity: [], logs: [],
  approvals: [], todos: [], reminders: [], feed: null, brain: null, flows: [],
  requests: [], outbox: [], retro: null,
  auth: { checked: false, required: false, local: true, via: null, busy: false, error: "", token: "" },
  q: "", timer: null, logLevel: "", showReq: false, reqMode: "request",
  reqDispatcher: "muse", reqModel: "", reqTaskType: "", reqRepo: "", reqText: "", reqBusy: false, reqMsg: "",
  reqAttachNote: "Text-only uploads (.txt/.md/.json/.csv, 4KB/file, 3 files max). Copied into every task workspace under attachments/.",
  reqAttachments: [], reqAttachBusy: false, reqAttachErr: "", reqDraftRestored: false,
  expandedSteps: new Set(), expandedVariants: new Set(), rerunText: "",
  brainSel: null, brainTab: "details", brainQ: "", brainLimit: 30, brainFocusReturn: null, flowSel: null,
  flowEdit: null, flowTrig: "schedule", flowTime: "11:00 AM", flowDays: ["Every day"], flowCron: "", flowRule: "",
  flowMsg: "", flowDryBusy: false, flowDryResult: null, cfgData: null, cfgMsg: "",
  // OrchestratorLoop: tasks/counts/engine from /api/control/loop/*.
  loopTasks: [], loopCounts: {}, loopEngine: null, loopRequests: [], loopActivity: [],
  dispatchers: [], loopTypes: [], loopAgents: [], todoForm: false,
  openSteps: new Set(), files: {}, handoff: null, appendForm: false, boardTab: "tasks", runSel: null,
  cmdOpen: false, cmdIdx: 0, theme: "dark",
  groupBy: "status", sortBy: "recent", statusFilter: "", todoTab: "open", todoQ: "", todoSource: "all", showTypes: false,
  showCtx: false, sessIdx: 0, sessExport: null, sessToolFilter: "all", diagFull: false, reqChanges: "", appendTitle: "",
  paused: false, confirmDel: false, statusMsg: "", _renderedModal: false,
  // render/request coordination (frontend-only, no backend change)
  offline: false, lastFetchOk: 0, stale: false, detailVer: 0, detailAbort: null, detailError: "",
  jobPolls: {}, lastBlockedIds: new Set(),
  // SSE live feed (frontend-only): versioned snapshot id, connection flag.
  // feedVersion tracks the last applied SSE snapshot version; sseConnected
  // gates the /api/feed poll fallback so live updates are never clobbered.
  feedVersion: null, sseConnected: false,
};

// Fallback agent ids for the flow editor until /api/control/loop/agents loads.
export const AGENT_OPTS = ["assistant", "summarizer", "coder", "finance-india", "finance-us", "scout", "analyst", "critic", "writer", "tester"];
export const agentIds = () => (S.loopAgents?.length ? S.loopAgents.map((a) => a.id) : AGENT_OPTS);
export const streamName = (id) => (S.cfgData?.streams?.streams || []).find((s) => s.id === id)?.name || id;

// Abortable, version-tolerant API client. Returns { data, status } via api(),
// or throws ApiError with .status/.body so callers can render field errors.
// Accepts 202 { job } payloads: callers poll with pollJob() until completion.
export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}
export async function api(path, opts = {}, { timeoutMs = 15000, signal: extSignal = null } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onExt = () => ctrl.abort();
  if (extSignal) { if (extSignal.aborted) ctrl.abort(); else extSignal.addEventListener("abort", onExt, { once: true }); }
  try {
    // Same-origin cookies carry the session (minted by POST /api/control/login).
    // The CONTROL_TOKEN value itself never lives in JS, URLs, or storage.
    const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, signal: ctrl.signal, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if ((res.status === 401 || res.status === 403) && data?.authRequired) {
        S.auth.required = true;
        S.auth.via = data?.via || null;
        S.auth.error = data?.error || data?.message || `HTTP ${res.status}`;
      }
      throw new ApiError(data.error || data.message || `HTTP ${res.status}`, res.status, data);
    }
    return data;
  } catch (e) {
    if (e?.name === "AbortError") throw new ApiError("Request timed out — backend may be busy. Data shown is the last good snapshot.", 0, null);
    throw e;
  } finally { clearTimeout(t); if (extSignal) extSignal.removeEventListener?.("abort", onExt); }
}
// Auth handshake: who may use this Control Room, and how to log in.
// GET /api/control/auth/status is public (no secrets): { tokenRequired, local }.
// Local browsers mint a session without typing the token; remote browsers post
// the CONTROL_TOKEN once via the login form -> HttpOnly SameSite cookie.
export async function refreshAuthStatus() {
  try {
    const r = await api("/api/control/auth/status");
    S.auth.checked = true;
    S.auth.local = !!r.local;
    if (r.via) S.auth.via = r.via;
    // Required only when a token is configured AND this browser isn't authed
    // (local socket or valid session cookie). Public status never leaks why.
    S.auth.required = !!r.tokenRequired && !r.authed && !S.auth.via;
    if (!S.auth.required) S.auth.error = "";
    return r;
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      S.auth.checked = true;
      S.auth.required = true;
      S.auth.error = e.message;
      return null;
    }
    throw e;
  }
}
export async function loginWithToken(token) {
  S.auth.busy = true;
  S.auth.error = "";
  try {
    const r = await api("/api/control/login", { method: "POST", body: JSON.stringify({ token }) });
    S.auth.busy = false;
    S.auth.required = false;
    S.auth.via = r?.via || "session";
    S.auth.token = "";
    S.auth.error = "";
    return r;
  } catch (e) {
    S.auth.busy = false;
    S.auth.error = e.message;
    throw e;
  }
}
export async function logoutSession() {
  try { await api("/api/control/logout", { method: "POST", body: JSON.stringify({}) }); } catch { /* best effort */ }
  S.auth.required = true;
  S.auth.via = null;
}
// Poll a backend job record until terminal. Works with queued/running/done/failed/cancelled.
// Expects GET <statusUrl> -> { job: { status, ... } } or { status, ... }. Returns final payload.
// Terminal set mirrors backend JOB_STATUSES (src/services/jobs.js, read-only):
// queued/leased/running are pending; done/failed/blocked/cancelled are terminal.
export const TERMINAL_JOB = new Set(["done", "completed", "succeeded", "failed", "error", "blocked", "cancelled", "canceled"]);
export const isJobTerminal = (st) => TERMINAL_JOB.has(String(st || "").toLowerCase());
// Backend job rows use snake_case (run_id); some sync replies use camelCase
// (runId). Accept both, plus the nested { job: {...} } envelope, so callers
// never navigate to a null run after a successful 202 poll.
export function jobRunId(...payloads) {
  for (const p of payloads) {
    if (!p) continue;
    const cand = p.runId || p.run_id || p.job?.run_id || p.job?.runId || p.data?.run_id || null;
    if (cand) return cand;
  }
  return null;
}
// Stable region hash for the keyed renderer: length + djb2 over the FULL
// string. The old length+first-64-chars prefix could skip real updates when
// two payloads shared a prefix (stale region, lost state).
export function regionHash(html) {
  let h = 5381;
  for (let i = 0; i < html.length; i++) h = ((h << 5) + h + html.charCodeAt(i)) >>> 0;
  return `${html.length}:${h.toString(36)}`;
}
export async function pollJob(statusUrl, { intervalMs = 1500, timeoutMs = 120000, signal = null, onTick = null } = {}) {
  const start = Date.now();
  for (;;) {
    if (signal?.aborted) throw new ApiError("Cancelled.", 0, null);
    const data = await api(statusUrl, {}, { signal });
    const job = data.job || data;
    const st = String(job?.status || "").toLowerCase();
    if (onTick) { try { onTick(job); } catch {} }
    if (isJobTerminal(st)) return data;
    if (Date.now() - start > timeoutMs) throw new ApiError("Still running — polling timed out. Check the run list; it will appear when done.", 0, job);
    await new Promise((r, rej) => { const h = setTimeout(r, intervalMs); signal?.addEventListener?.("abort", () => { clearTimeout(h); rej(new ApiError("Cancelled.", 0, null)); }, { once: true }); });
  }
}
// POST that tolerates sync { ok/runId } AND async 202 { job } responses.
// Returns { sync, job, final } where final is the polled terminal payload (or null).
export async function postJob(path, body, { poll = true, onTick = null, signal = null } = {}) {
  const data = await api(path, { method: "POST", body: JSON.stringify(body || {}) }, { signal });
  const jobRef = data.job || (data.jobId ? { id: data.jobId } : null);
  const statusUrl = data.statusUrl || data.jobUrl || (jobRef?.id ? `/api/control/jobs/${jobRef.id}` : null);
  if (!poll || !statusUrl) return { sync: data, job: jobRef || null, final: null };
  const final = await pollJob(statusUrl, { onTick, signal });
  return { sync: data, job: jobRef, final };
}

export const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 7 ? d + " days ago" : d < 30 ? Math.floor(d / 7) + "w ago" : iso.slice(0, 10);
};

export const statusBadge = (st) => {
  const m = { done: ["Done", "ok"], ok: ["Done", "ok"], failed: ["Blocked", "bad"], blocked: ["Blocked", "bad"], running: ["Running", "run"], queued: ["Queued", ""], pending: ["Queued", ""], cancelled: ["Cancelled", ""], canceled: ["Cancelled", ""], sent: ["Sent", "ok"] };
  const [label, cls] = m[String(st || "").toLowerCase()] || [st || "—", ""];
  return `<span class="tag ${cls}">${esc(label)}</span>`;
};
// Session provenance: only claim Fresh/Resumed when the backend proves it.
// A bare session id is NOT resume evidence — label it honestly.
export const sessionProvenance = (s) => {
  if (!s) return { label: "No session", tone: "", hint: "No session recorded for this step yet." };
  if (s.resumed === true || s.fresh === false) return { label: "Resumed", tone: "run", hint: "Backend reports this continued a prior session." };
  if (s.fresh === true || s.resumed === false) return { label: "Fresh", tone: "ok", hint: "Backend reports a new session." };
  if (s.sessionUuid || s.sessionId || s.id) return { label: "Session id only", tone: "", hint: "Provenance unavailable — backend did not confirm fresh vs resumed." };
  return { label: "No session", tone: "", hint: "No session recorded for this step yet." };
};

// Where did this run come from? kind drives the origin chip + grouping.
// schedule = cron automation · discord/discord-task/discord-pipeline = Discord
// dashboard/dashboard-requeue = Control Room · chat = Assistant · manual = ad-hoc
export const KIND_LABEL = {
  schedule: "automation", discord: "discord", "discord-task": "discord",
  "discord-pipeline": "discord", dashboard: "control room",
  "dashboard-requeue": "control room", chat: "assistant", manual: "manual",
};

export const kindOf = (r) => String(r?.kind || r?.taskType || "manual").toLowerCase();
export const kindLabel = (r) => KIND_LABEL[kindOf(r)] || kindOf(r) || "manual";
export const isAutomationRun = (r) => kindOf(r) === "schedule";
// Attention = blocked / failed in the last 24h. PR/ADO are out of scope — never gate on prUrl.
export const needsAttention = (r) => {
  if (r?.status === "failed" || !!r?.blockedReason) return true;
  if (r?.status === "failed" || r?.status === "blocked") return true;
  try {
    const at = new Date(r?.startedAt || r?.finishedAt || r?.created_at || 0).getTime();
    if (r?.status === "failed" && Date.now() - at < 24 * 3600 * 1000) return true;
  } catch {}
  return false;
};
export const failedLast24h = (r) => {
  if (r?.status !== "failed") return false;
  try { return Date.now() - new Date(r?.finishedAt || r?.startedAt || 0).getTime() < 24 * 3600 * 1000; } catch { return false; }
};

// Titles leak raw Discord markup (<@&123>, <#456>) and generic finance
// labels ("india"). Clean them once, everywhere cards/banners/detail render.
export const cleanTitle = (t) => String(t ?? "")
  .replace(/<@!?&?\d+>/g, "").replace(/<#\d+>/g, "").replace(/<:\w+:\d+>/g, "")
  .replace(/\s{2,}/g, " ").trim();

const GENERIC_TITLES = new Set(["india", "us", "general", "task", "new task", "untitled", "—", "-"]);

export const displayTitle = (r) => {
  const c = cleanTitle(r?.title || r?.workflow || "task");
  if (!c || GENERIC_TITLES.has(c.toLowerCase())) {
    const w = String(r?.workflow || r?.taskType || r?.kind || "task");
    return w.replace(/[-_]+/g, " ").trim() || "task";
  }
  return c;
};

export function setStatus(msg) {
  S.statusMsg = msg;
  const el = $("#status");
  if (el) el.textContent = msg;
}

// Request draft persistence (localStorage, non-secret only): goal text,
// stream/pipeline/mode/agents. NEVER uploaded content, credentials, or
// session tokens. Restored once per modal open; cleared on server-acked
// submit. Key is namespaced to avoid collisions.
const REQ_DRAFT_KEY = "tab.reqDraft.v1";
export function saveReqDraft() {
  try {
    const draft = {
      text: String($("#req-text")?.value || "").slice(0, 4000),
      mode: S.reqMode, dispatcher: S.reqDispatcher, model: S.reqModel,
      taskType: S.reqTaskType, repo: S.reqRepo,
      at: Date.now(),
    };
    // Refuse to persist anything that looks like a credential.
    if (/CONTROL_TOKEN|tab_session|Bearer\s+\S{8,}|sk-(live|ant)|xox[baprs]-/i.test(draft.text)) return;
    localStorage.setItem(REQ_DRAFT_KEY, JSON.stringify(draft));
  } catch { /* storage unavailable — draft simply not persisted */ }
}
export function restoreReqDraft() {
  if (S.reqDraftRestored) return false;
  S.reqDraftRestored = true;
  try {
    const raw = localStorage.getItem(REQ_DRAFT_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return false;
    if (d.mode === "request" || d.mode === "direct") S.reqMode = d.mode;
    if (d.dispatcher === "muse" || d.dispatcher === "copilot") S.reqDispatcher = d.dispatcher;
    if (typeof d.model === "string") S.reqModel = d.model.slice(0, 64);
    if (typeof d.taskType === "string") S.reqTaskType = d.taskType.slice(0, 64);
    if (typeof d.repo === "string") S.reqRepo = d.repo.slice(0, 500);
    const t = typeof d.text === "string" ? d.text.slice(0, 4000) : "";
    // Apply text after render (caller sets #req-text value).
    S._draftText = /CONTROL_TOKEN|tab_session|Bearer\s+\S{8,}|sk-(live|ant)|xox[baprs]-/i.test(t) ? "" : t;
    return !!t;
  } catch { return false; }
}
export function clearReqDraft() {
  try { localStorage.removeItem(REQ_DRAFT_KEY); } catch {}
  S._draftText = "";
  S.reqDraftRestored = false;
}

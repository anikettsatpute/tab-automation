// Shared Control Room state, helpers, API client.
// Imported by main.js + every view module. Single source of truth for S.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const S = {
  view: "board", boardTab: "tasks", detailTab: "overview", sel: null, detail: null,
  cfg: { enabled: true, refreshSec: 3 },
  ov: null, tasks: [], agents: [], tools: [], activity: [], logs: [],
  approvals: [], todos: [], reminders: [], feed: null, brain: null, flows: [],
  requests: [], outbox: [], retro: null,
  q: "", auto: true, timer: null, logLevel: "", showReq: false, reqMode: "request",
  reqAgents: ["assistant"], reqStream: "general", reqPipeline: "", reqBusy: false, reqMsg: "",
  expandedSteps: new Set(), expandedVariants: new Set(), rerunText: "",
  brainSel: null, brainTab: "details", brainQ: "", flowSel: null,
  flowEdit: null, flowTrig: "schedule", flowTime: "11:00 AM", flowDays: ["Every day"], flowCron: "", flowRule: "",
  flowMsg: "", cfgData: null, cfgMsg: "",
  loopTasks: [], loopSel: null, loopDetail: null, loopForm: null, todoForm: false,
  cmdOpen: false, cmdIdx: 0, theme: "dark",
  groupBy: "status", sortBy: "recent", statusFilter: "", todoTab: "open", todoQ: "", todoSource: "all",
  showCtx: false, sessIdx: 0, diagFull: false, reqChanges: "", appendTitle: "",
  paused: false, confirmDel: false, statusMsg: "", _renderedModal: false,
};

// Agent pipeline: OUR agents from config/agents.json are the pipeline.
// Streams group agents; pipelines chain agent->agent. Divider picks stream+pipeline.
export const AGENT_OPTS = ["assistant", "summarizer", "coder", "finance-india", "finance-us"];
export const streamName = (id) => (S.cfgData?.streams?.streams || []).find((s) => s.id === id)?.name || id;
export const streamPipes = (sid) => (S.cfgData?.streams?.pipelines || []).filter((p) => !sid || p.stream === sid);

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, signal: ctrl.signal, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(t); }
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
  const m = { done: ["Done", "ok"], failed: ["Blocked", "bad"], blocked: ["Blocked", "bad"], running: ["Running", "run"], pr_review: ["PR review", "review"], plan_review: ["Plan review", "review"], size_review: ["Size review", "review"], your_review: ["Your review", "review"], queued: ["Queued", ""] };
  const [label, cls] = m[st] || [st || "—", ""];
  return `<span class="tag ${cls}">${esc(label)}</span>`;
};

export function setStatus(msg) {
  S.statusMsg = msg;
  const el = $("#status");
  if (el) el.textContent = msg;
}

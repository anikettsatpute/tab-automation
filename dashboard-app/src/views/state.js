// Shared Control Room state, helpers, API client.
// Imported by main.js + every view module. Single source of truth for S.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const S = {
  view: "board", boardTab: "attention", detailTab: "overview", sel: null, detail: null, fromTab: null,
  kindFilter: "all", lastOk: 0,
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
  taskTypes: [],
  cmdOpen: false, cmdIdx: 0, theme: "dark",
  groupBy: "status", sortBy: "recent", statusFilter: "", todoTab: "open", todoQ: "", todoSource: "all", showTypes: false,
  showCtx: false, sessIdx: 0, diagFull: false, reqChanges: "", appendTitle: "",
  paused: false, confirmDel: false, statusMsg: "", _renderedModal: false,
};

// Agent pipeline: OUR agents from config/agents.json are the pipeline.
// Streams group agents; pipelines chain agent->agent. Divider picks stream+pipeline.
// NOTE: keep in sync with config/agents.json ids (scout/analyst/critic/writer/tester added).
export const AGENT_OPTS = ["assistant", "summarizer", "coder", "finance-india", "finance-us", "scout", "analyst", "critic", "writer", "tester"];
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
export const needsAttention = (r) => r?.status === "failed" || !!r?.blockedReason || !!r?.prUrl;

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

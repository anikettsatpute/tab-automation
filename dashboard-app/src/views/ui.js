// Shared UI kit: page headers, stat cards, empty states, icons.
// Every view imports from here so the Control Room looks like one product.
// Icons: bundled offline via the `lucide` npm package (no runtime CDN).
// icon() emits inline SVG for every name used in views; unknown names fall
// back to the empty `<i data-lucide>` hook which hides via CSS and lets the
// adjacent text label carry meaning.
import { esc } from "./state.js";
import {
  Activity, Archive, ArrowLeft, ArrowRight, BarChart3, Bot, Brain, Check,
  CheckCircle2, Circle, CircleDashed, Clock, Coins, Command, FileText,
  Fingerprint, GitBranch, History, Inbox, KeyRound, Layers, LayoutDashboard,
  List, ListChecks, ListOrdered, Loader, Lock, LogOut, Maximize2, Menu,
  MessageSquare, MessageSquareWarning, MessagesSquare, Moon, OctagonAlert,
  OctagonPause, Paperclip, Pause, Play, Plus, RefreshCw, Repeat, RotateCcw,
  Rss, Save, ScrollText, Search, Send, Server, Settings2, ShieldCheck, Siren,
  SunMoon, Terminal, Timer, Trash2, Waves, WifiOff, Workflow, Wrench, X,
  XCircle, Zap,
} from "lucide";

// Named map only — never import the full `icons` registry (2000+ entries).
// Keys are the kebab-case names used across views (rg `icon("...")`).
const NODES = {
  activity: Activity, archive: Archive, "arrow-left": ArrowLeft, "arrow-right": ArrowRight,
  "bar-chart-3": BarChart3, bot: Bot, brain: Brain, check: Check,
  "check-circle-2": CheckCircle2, circle: Circle, "circle-dashed": CircleDashed,
  clock: Clock, coins: Coins, command: Command, "file-text": FileText,
  fingerprint: Fingerprint, "git-branch": GitBranch, history: History, inbox: Inbox,
  "key-round": KeyRound, layers: Layers, "layout-dashboard": LayoutDashboard,
  list: List, "list-checks": ListChecks, "list-ordered": ListOrdered, loader: Loader,
  lock: Lock, "log-out": LogOut, "maximize-2": Maximize2, menu: Menu,
  "message-square": MessageSquare, "message-square-warning": MessageSquareWarning,
  "messages-square": MessagesSquare, moon: Moon, "octagon-alert": OctagonAlert,
  "octagon-pause": OctagonPause, paperclip: Paperclip, pause: Pause, play: Play,
  plus: Plus, "refresh-cw": RefreshCw, repeat: Repeat, "rotate-ccw": RotateCcw,
  rss: Rss, save: Save, "scroll-text": ScrollText, search: Search, send: Send,
  server: Server, "settings-2": Settings2, "shield-check": ShieldCheck, siren: Siren,
  "sun-moon": SunMoon, terminal: Terminal, timer: Timer, "trash-2": Trash2,
  waves: Waves, "wifi-off": WifiOff, workflow: Workflow, wrench: Wrench, x: X,
  "x-circle": XCircle, zap: Zap,
};

const SVG_ATTRS = {
  xmlns: "http://www.w3.org/2000/svg", width: 24, height: 24, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor", "stroke-width": 2,
  "stroke-linecap": "round", "stroke-linejoin": "round",
};

const attrsStr = (o) =>
  Object.entries(o).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`).join("");

function nodeToSvg(node) {
  return (node || []).map(([tag, attrs, kids]) =>
    `<${tag}${attrsStr(attrs || {})}>${kids ? nodeToSvg(kids) : ""}</${tag}>`).join("");
}

export const icon = (name, cls = "") => {
  const node = NODES[name];
  if (!node) return `<i data-lucide="${name}" class="ic ${cls}" aria-hidden="true"></i>`;
  return `<svg${attrsStr(SVG_ATTRS)} class="ic ${cls}" data-lucide="${name}" aria-hidden="true">${nodeToSvg(node)}</svg>`;
};

export function refreshIcons() {
  // Inline SVG above needs no enhancement; keep the hook for any stray
  // `<i data-lucide>` from unknown names or third-party markup.
  try { window.lucide?.createIcons?.(); } catch { /* text labels carry meaning */ }
}

// Page header: title + subtitle + right-side actions. One pattern everywhere.
// h1: exactly one per view (axe page-has-heading-one); styled via .phead h1.
export const pageHead = (title, sub = "", actions = "") => `
  <div class="phead"><div><h1>${esc(title)}${sub ? ` <span class="hint">${esc(sub)}</span>` : ""}</h1></div>
  <span class="spacer"></span><div class="row">${actions}</div></div>`;

// Stat cards row: [{icon, label, value, tone}]. tone: ok|bad|run|warn|dim.
export const statRow = (stats = []) => `
  <div class="stats">${stats.map((s) => `
    <div class="stat ${s.tone || ""}">
      <span class="sic">${icon(s.icon || "activity")}</span>
      <span class="sval">${s.value}</span><span class="slab">${esc(s.label)}</span>
    </div>`).join("")}</div>`;

// Empty state with icon + CTA.
export const emptyState = (ic, title, hint = "", cta = "") => `
  <div class="empty"><span class="eic">${icon(ic)}</span><b>${esc(title)}</b>
  ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}${cta}</div>`;

// Section card: titled container for a group of content.
export const section = (title, inner, extra = "") => `
  <section class="card sec"><h3>${icon("layers")} ${esc(title)} ${extra}</h3>${inner}</section>`;

// Status pill shared by tables + cards (maps run status -> tone).
export const pill = (status) => {
  const m = { done: "ok", ok: "ok", failed: "bad", blocked: "bad", running: "run", queued: "", sent: "ok" };
  const label = { done: "Done", ok: "Done", failed: "Blocked", blocked: "Blocked", running: "Running", queued: "Queued", sent: "Sent" }[status] || status || "—";
  return `<span class="tag ${m[status] || ""}">${esc(label)}</span>`;
};

// Origin chip: where a run came from.
export const originChip = (kind) =>
  `<span class="kbd kind">${icon("git-branch")} ${esc(kind)}</span>`;

// Progress bar with label. The bar itself carries an accessible name (axe
// aria-progressbar-name); the adjacent hint text is the visual label.
export const progress = (done, total) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<span class="mpbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Progress: ${done} of ${total} steps, ${pct} percent"><span style="width:${pct}%"></span></span>
  <span class="hint">${done}/${total} steps · ${pct}%</span>`;
};

// Filter toolbar: search + selects in one row.
export const toolbar = (inner) => `<div class="toolbar">${inner}</div>`;
export const searchBox = (id, val, ph) =>
  `<label class="sr" for="${id}">Search</label><span class="sbox">${icon("search")}<input id="${id}" type="search" value="${esc(val || "")}" placeholder="${esc(ph)}" autocomplete="off" aria-label="Search"></span>`;
export const selectBox = (id, opts, cur, label) =>
  `<label class="sr" for="${id}">${esc(label)}</label><select id="${id}" class="sel">${opts.map(([v, l]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;

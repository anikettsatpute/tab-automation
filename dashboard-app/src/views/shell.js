// Shell views: sidebar + topbar + attention banners.
import { S, esc, ago, statusBadge, displayTitle } from "./state.js";
import { icon } from "./ui.js";

const NAV_ITEMS = [
  ["board", "Board", "layout-dashboard"], ["assistant", "Assistant", "bot"],
  ["brain", "Brain messages", "brain"], ["todos", "TODOs", "list-checks"],
  ["automations", "Automations", "workflow"], ["config", "Configuration", "settings-2"],
  ["requests", "Requests", "inbox"], ["outbox", "Outbox", "send"],
  ["activity", "Activity", "activity"], ["retro", "Retro", "bar-chart-3"],
];

const NAV_COUNT = () => ({
  board: S.tasks.length, brain: (S.brain?.messages?.length ?? S.brain?.metrics?.incoming ?? 0),
  todos: S.todos.length, automations: S.flows.length, requests: S.requests.length,
  outbox: S.outbox.length, activity: S.activity.length,
});

export function sidebar() {
  const tasks = S.tasks || [];
  const counts = NAV_COUNT();
  const n = (fn) => tasks.filter(fn).length;
  const stats = [["Running", n((r) => r.status === "running"), "run", "loader"], ["Blocked", n((r) => r.status === "failed" || r.blockedReason), "bad", "octagon-alert"], ["Queued", n((r) => r.status === "queued"), "", "clock"], ["Done", n((r) => r.status === "done"), "ok", "check-circle-2"], ["PR review", n((r) => !!r.prUrl), "review", "git-pull-request"]];
  return `
  <aside class="side" aria-label="Primary navigation">
    <div class="brand"><div class="logo" aria-hidden="true">${icon("zap")}</div><div><b>Rick Control Room</b><span>tab-automation</span></div></div>
    <button class="btn primary block" id="newtask" type="button">${icon("plus")} New task</button>
    <nav aria-label="Views">${NAV_ITEMS.map(([v, l, ic]) => `<button type="button" class="nav ${S.view === v ? "on" : ""}" data-view="${v}" ${S.view === v ? 'aria-current="page"' : ""}><span class="nlab">${icon(ic)} ${esc(l)}</span>${counts[v] ? `<span class="ncount" aria-label="${counts[v]} items">${counts[v]}</span>` : ""}</button>`).join("")}</nav>
    <div class="sstat"><h4 id="status-h">STATUS</h4>
      <div role="group" aria-labelledby="status-h">${stats.map(([l, c, cls, ic]) => `<button type="button" class="srow2 ${S.statusFilter === l ? "on" : ""}" data-statusf="${esc(l)}" aria-pressed="${S.statusFilter === l}"><i class="dot ${cls}" aria-hidden="true"></i>${icon(ic)} ${esc(l)} <b>${c}</b></button>`).join("")}</div>
    </div>
    <div class="spal"><span>Command palette</span><kbd>⌘K</kbd></div>
  </aside>`;
}

export function topbar() {
  return `
  <header class="top">
    <button type="button" class="btn sm ghost menubtn" id="menu" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button>
    <span class="ws">${icon("server")} tab-automation</span>
    <label class="sr" for="fq">Filter tasks</label>
    <input id="fq" type="search" placeholder="Filter tasks ( / )" value="${esc(S.q)}" aria-label="Filter tasks" autocomplete="off">
    <button type="button" class="btn sm" id="cmds" aria-haspopup="dialog">${icon("command")} Commands <kbd aria-hidden="true">⌘K</kbd></button>
    <button type="button" class="btn sm ${S.paused ? "" : "on"}" id="resume" aria-pressed="${S.paused}" title="Pause or resume live refresh">${S.paused ? `${icon("play")} Resume` : `${icon("pause")} Pause`}</button>
    <button type="button" class="btn sm ghost" id="refresh" aria-label="Refresh now">${icon("refresh-cw")} Refresh</button>
    <button type="button" class="btn sm ghost" id="theme" aria-label="Switch to ${S.theme === "dark" ? "light" : "dark"} theme" aria-pressed="${S.theme === "light"}">${icon("sun-moon")} Theme</button>
    <span class="spacer"></span>
    <span class="pill ${S.paused ? "paused" : "ok"}" role="status">${S.paused ? `${icon("pause")} Paused` : `<span class="pulse" aria-hidden="true"></span>Live`}</span>
  </header>`;
}

export function attentionBanners() {
  const blocked = S.tasks.find((r) => r.status === "failed" || r.blockedReason);
  const review = S.tasks.find((r) => r.prUrl);
  if (!blocked && !review) return "";
  return `<div class="banners" role="alert">
    ${blocked ? `<button type="button" class="banner bad" data-sel="${esc(blocked.id)}" aria-label="Blocked task: ${esc(displayTitle(blocked).slice(0, 70))}"><span class="pulse2" aria-hidden="true"></span>${icon("octagon-alert")}<b>${esc(displayTitle(blocked).slice(0, 70))}</b><span class="mono">#${esc(String(blocked.id).slice(0, 6))} • Blocked</span></button>` : ""}
    ${review ? `<button type="button" class="banner review" data-sel="${esc(review.id)}" aria-label="Task awaiting review: ${esc(displayTitle(review).slice(0, 70))}"><span class="dot2" aria-hidden="true"></span>${icon("git-pull-request")}<b>${esc(displayTitle(review).slice(0, 70))}</b><span class="mono">#${esc(String(review.id).slice(0, 6))} • PR review</span></button>` : ""}
  </div>`;
}

// Shell views: sidebar + topbar + attention banners.
import { S, esc, ago, statusBadge } from "./state.js";

export const NAV = [
  ["board", "Board"], ["assistant", "Assistant"], ["brain", "Brain messages"], ["todos", "TODOs"],
  ["automations", "Automations"], ["config", "Configuration"], ["requests", "Requests"],
  ["outbox", "Outbox"], ["activity", "Activity"], ["retro", "Retro"],
];

const NAV_COUNT = () => ({
  board: S.tasks.length, brain: (S.brain?.messages?.length ?? S.brain?.metrics?.incoming ?? 0),
  todos: S.todos.length, automations: S.flows.length, requests: S.requests.length,
  outbox: S.outbox.length, activity: S.activity.length,
});

export function sidebar() {
  const t = S.ov?.totals || {};
  const counts = NAV_COUNT();
  const queued = Math.max(0, (t.runs || 0) - (t.running || 0) - (t.done || 0) - (t.failed || 0));
  const stats = [["Queued", queued, ""], ["Running", t.running ?? 0, "run"], ["Plan review", 0, ""], ["Size review", 0, ""], ["Your review", 0, ""], ["PR review", S.tasks.filter((r) => r.prUrl).length, "review"], ["Blocked", t.failed ?? 0, "bad"], ["Done", t.done ?? 0, "ok"]];
  return `
  <aside class="side" aria-label="Primary navigation">
    <div class="brand"><div class="logo" aria-hidden="true">🤖</div><div><b>OrchestratorLoop</b><span>Task control plane</span></div></div>
    <button class="btn primary block" id="newtask" type="button">+ New task</button>
    <nav aria-label="Views">${NAV.map(([v, l]) => `<button type="button" class="nav ${S.view === v ? "on" : ""}" data-view="${v}" ${S.view === v ? 'aria-current="page"' : ""}><span>${esc(l)}</span>${counts[v] ? `<span class="ncount" aria-label="${counts[v]} items">${counts[v]}</span>` : ""}</button>`).join("")}</nav>
    <div class="sstat"><h4 id="status-h">STATUS</h4>
      <div role="group" aria-labelledby="status-h">${stats.map(([l, c, cls]) => `<button type="button" class="srow2 ${S.statusFilter === l ? "on" : ""}" data-statusf="${esc(l)}" aria-pressed="${S.statusFilter === l}"><i class="dot ${cls}" aria-hidden="true"></i>${esc(l)} <b>${c}</b></button>`).join("")}</div>
    </div>
    <div class="spal"><span>Command palette</span><kbd>⌘K</kbd></div>
  </aside>`;
}

export function topbar() {
  return `
  <header class="top">
    <button type="button" class="btn sm ghost menubtn" id="menu" aria-label="Open navigation" aria-expanded="false">Menu</button>
    <div class="brand sm"><div class="logo" aria-hidden="true">⚡</div><div><b>OrchestratorLoop</b><span>Task control plane</span></div></div>
    <span class="ws">tab-automation</span>
    <label class="sr" for="fq">Filter tasks</label>
    <input id="fq" type="search" placeholder="Filter tasks ( / )" value="${esc(S.q)}" aria-label="Filter tasks" autocomplete="off">
    <button type="button" class="btn sm" id="cmds" aria-haspopup="dialog">Commands <kbd aria-hidden="true">⌘K</kbd></button>
    <button type="button" class="btn sm ${S.auto ? "on" : ""}" id="autobtn" aria-pressed="${S.auto}">Auto refresh</button>
    <button type="button" class="btn sm" id="resume" aria-pressed="${S.paused}">${S.paused ? "Resume" : "Pause"}</button>
    <button type="button" class="btn sm ghost" id="refresh" aria-label="Refresh now">Refresh</button>
    <button type="button" class="btn sm ghost" id="theme" aria-label="Switch to ${S.theme === "dark" ? "light" : "dark"} theme" aria-pressed="${S.theme === "light"}">Theme</button>
    <span class="spacer"></span>
    <span class="pill ok" role="status"><span class="pulse" aria-hidden="true"></span>Live</span>
  </header>`;
}

export function attentionBanners() {
  const blocked = S.tasks.find((r) => r.status === "failed" || r.blockedReason);
  const review = S.tasks.find((r) => r.prUrl);
  if (!blocked && !review) return "";
  return `<div class="banners" role="alert">
    ${blocked ? `<button type="button" class="banner bad" data-sel="${esc(blocked.id)}" aria-label="Blocked task: ${esc((blocked.title || "").slice(0, 70))}"><span class="pulse2" aria-hidden="true"></span><b>${esc((blocked.title || "").slice(0, 70))}</b><span class="mono">#${esc(blocked.id.slice(0, 6))} • Blocked</span></button>` : ""}
    ${review ? `<button type="button" class="banner review" data-sel="${esc(review.id)}" aria-label="Task awaiting review: ${esc((review.title || "").slice(0, 70))}"><span class="dot2" aria-hidden="true"></span><b>${esc((review.title || "").slice(0, 70))}</b><span class="mono">#${esc(review.id.slice(0, 6))} • PR review</span></button>` : ""}
  </div>`;
}

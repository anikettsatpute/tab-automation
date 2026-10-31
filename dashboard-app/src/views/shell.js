// Shell views: sidebar + topbar + attention banners + access gate.
import { S, esc, ago, statusBadge, displayTitle, failedLast24h } from "./state.js";
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
  const stats = [["Running", n((r) => r.status === "running"), "run", "loader"], ["Blocked", n((r) => r.status === "failed" || r.blockedReason), "bad", "octagon-alert"], ["Queued", n((r) => r.status === "queued"), "", "clock"], ["Done", n((r) => r.status === "done"), "ok", "check-circle-2"], ["Failed 24h", n((r) => failedLast24h(r)), "bad", "history"]];
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
  const offline = S.offline ? `<span class="pill paused" role="status">${icon("wifi-off")} Offline — showing last good data</span>` : "";
  const access = S.auth.required
    ? `<span class="pill paused" role="status">${icon("lock")} Access required</span>`
    : S.auth.via
      ? `<span class="pill ok" role="status" title="Authenticated via ${esc(S.auth.via)}">${icon("shield-check")} ${esc(S.auth.via)}</span>`
      : "";
  return `
  <header class="top">
    <button type="button" class="btn sm ghost menubtn" id="menu" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button>
    <span class="ws">${icon("server")} tab-automation</span>
    <label class="sr" for="fq">Filter tasks</label>
    <input id="fq" type="search" placeholder="Filter tasks ( / )" value="${esc(S.q)}" aria-label="Filter tasks" autocomplete="off">
    <button type="button" class="btn sm" id="cmds" aria-haspopup="dialog">${icon("command")} Commands <kbd aria-hidden="true">⌘K</kbd></button>
    <button type="button" class="btn sm ${S.auto ? "on" : ""}" id="autotoggle" aria-pressed="${S.auto}" title="Toggle automatic refresh">${icon("zap")} Auto</button>
    <button type="button" class="btn sm ${S.paused ? "" : "on"}" id="resume" aria-pressed="${S.paused}" title="Pause or resume live refresh">${S.paused ? `${icon("play")} Resume` : `${icon("pause")} Pause`}</button>
    <button type="button" class="btn sm ghost" id="refresh" aria-label="Refresh now">${icon("refresh-cw")} Refresh</button>
    <button type="button" class="btn sm ghost" id="theme" aria-label="Switch to ${S.theme === "dark" ? "light" : "dark"} theme" aria-pressed="${S.theme === "light"}">${icon("sun-moon")} Theme</button>
    ${S.auth.via ? `<button type="button" class="btn sm ghost" id="logout" title="End this browser session">${icon("log-out")} Log out</button>` : ""}
    <span class="spacer"></span>
    ${offline}
    ${access}
    <span class="pill ${S.paused ? "paused" : "ok"}" role="status">${S.paused ? `${icon("pause")} Paused` : `<span class="pulse" aria-hidden="true"></span>Live`}</span>
  </header>`;
}

/** Access-required gate: rendered instead of private views when the backend
 *  answers 401/403 { authRequired: true }. Local browsers get a one-click
 *  session mint (no token needed); remote browsers paste CONTROL_TOKEN once
 *  into the password form -> HttpOnly SameSite cookie. The token value is
 *  never displayed, never stored, never logged. */
export function accessGate() {
  const busy = S.auth.busy ? "disabled" : "";
  return `
  <div class="card" role="alert" aria-label="Access required">
    <h3>${icon("lock")} Access required</h3>
    <p class="hint">${esc(S.auth.error || "This Control Room needs a login before it shows runs, config, or memory.")}</p>
    ${S.auth.local
      ? `<p class="hint">You are on this machine — one click mints a session, no token needed.</p>
         <div class="row"><button type="button" class="btn primary" id="auth-local" ${busy}>${S.auth.busy ? "Signing in…" : "Sign in on this machine"}</button></div>`
      : `<p class="hint">Remote access: paste the <b>CONTROL_TOKEN</b> once. It is sent in the login POST body only, compared timing-safe server-side, and never shown again.</p>
         <div class="chatbox"><label class="sr" for="auth-token">Control token</label>
         <input id="auth-token" type="password" autocomplete="off" placeholder="CONTROL_TOKEN" value="">
         <button type="button" class="btn primary sm" id="auth-go" ${busy}>${S.auth.busy ? "Signing in…" : "Sign in"}</button></div>`}
    ${S.auth.error && !S.auth.local ? `<div class="status bad" role="alert">${esc(S.auth.error)}</div>` : ""}
    <p class="hint">No token configured on the server? Set <span class="kbd">CONTROL_TOKEN</span> env and restart — remote stays fail-closed until then.</p>
  </div>`;
}

export function attentionBanners() {
  const items = (S.tasks || []).filter((r) => r.status === "failed" || r.blockedReason || failedLast24h(r)).slice(0, 3);
  const blocked = items.find((r) => r.status === "failed" || r.blockedReason);
  const failed = items.find((r) => failedLast24h(r) && r !== blocked);
  if (!items.length) return "";
  // No aria-label on the buttons: the visible text (title + short id +
  // Blocked/Failed) already IS the accessible name. An aria-label that
  // rephrases it trips axe label-content-name-mismatch (serious).
  return `<div class="banners" role="alert" aria-label="Needs attention">
    ${blocked ? `<button type="button" class="banner bad" data-sel="${esc(blocked.id)}"><span class="pulse2" aria-hidden="true"></span>${icon("octagon-alert")}<b>${esc(displayTitle(blocked).slice(0, 70))}</b><span class="mono">#${esc(String(blocked.id).slice(0, 6))} • Blocked</span></button>` : ""}
    ${failed ? `<button type="button" class="banner bad" data-sel="${esc(failed.id)}"><span class="pulse2" aria-hidden="true"></span>${icon("history")}<b>${esc(displayTitle(failed).slice(0, 70))}</b><span class="mono">#${esc(String(failed.id).slice(0, 6))} • Failed &lt;24h</span></button>` : ""}
    ${items.length > 2 ? `<button type="button" class="banner" data-goto-attention><b>View all</b><span class="mono">${items.length} items</span></button>` : ""}
  </div>`;
}

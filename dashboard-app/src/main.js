// Rick Control Room — PRD-grade OrchestratorLoop board (docs/PRD_ORCHESTRATOR_LOOP.md).
// Sidebar + topbar + attention banners + board + drawer (Overview/Steps/Activity/Diagrams/Sessions)
// + Submit-request modal + Automations flows + Brain messages. Live via /api/control/*.
import "./style.css";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const S = {
  view: "board", boardTab: "tasks", detailTab: "overview", sel: null, detail: null,
  cfg: { enabled: true, refreshSec: 3 },
  ov: null, tasks: [], agents: [], tools: [], activity: [], logs: [],
  approvals: [], todos: [], reminders: [], feed: null, brain: null, flows: [],
  requests: [], outbox: [], retro: null,
  q: "", auto: true, timer: null, logLevel: "", showReq: false, reqMode: "request",
  reqType: "let_divider_choose", reqRepo: "tab-automation", reqBusy: false, reqMsg: "",
  expandedSteps: new Set(), expandedVariants: new Set(), rerunText: "",
  brainSel: null, brainTab: "details", flowSel: null,
  cmdOpen: false, cmdIdx: 0,
};
// PRD 4.5 task-type taxonomy (reference: TASK_TYPES_CONFIG in spec state-machine)
const TASK_TYPE_OPTS = [
  ["let_divider_choose", "Let the divider choose"], ["coding", "Coding"],
  ["pm_spec_design_coding", "PM spec, design and coding"], ["design_and_coding", "Design and coding"],
  ["live_site_investigation", "Live-site investigation"], ["live_site_triage", "Live-site triage"],
  ["live_site_fix", "Live-site fix"], ["icm_triage", "IcM triage"], ["ecs_flight", "ECS flight"],
  ["simple_coding", "Simple coding"], ["simple_coding_with_testing", "Simple coding with testing"],
  ["reviewed_coding", "Reviewed coding"], ["planning_only", "Planning only"],
  ["code_investigation", "Code investigation"], ["coding_with_declarative_scenario_tests", "Coding with declarative scenario tests"],
];
const PIPELINE_PREVIEW = {
  let_divider_choose: "Planner → Coder → Validator → Open PR", coding: "Planner → Coder → Validator → Open PR",
  pm_spec_design_coding: "PM Spec → Designer → Planner → Coder → Validator → Open PR",
  design_and_coding: "Designer → Coder → Validator → Open PR",
  live_site_investigation: "Investigator → Synthesizer", live_site_triage: "Triage Agent → Reporter",
  live_site_fix: "Root Cause Coder → Flight Validator → Hotfix PR", icm_triage: "IcM Investigator → Ticket Updater",
  ecs_flight: "Flight Configurator → Ring Validator", simple_coding: "Coder → Open PR",
  simple_coding_with_testing: "Coder → Validator → Open PR", reviewed_coding: "Planner (Review) → Coder (Review) → Validator (Review) → Open PR",
  planning_only: "Planner → Reviewer", code_investigation: "Code Investigator → Report Generator",
  coding_with_declarative_scenario_tests: "Scenario Planner → Coder → Scenario Validator → Open PR",
};

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, signal: ctrl.signal, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(t); }
}

const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 7 ? d + " days ago" : d < 30 ? Math.floor(d / 7) + "w ago" : iso.slice(0, 10);
};
// PRD TaskStatus -> badge (reference: TaskBoard card + TaskDrawer header)
const statusBadge = (st) => {
  const m = { done: ["Done", "ok"], failed: ["Blocked", "bad"], blocked: ["Blocked", "bad"], running: ["Running", "run"], pr_review: ["PR review", "review"], plan_review: ["Plan review", "review"], size_review: ["Size review", "review"], your_review: ["Your review", "review"], queued: ["Queued", ""] };
  const [label, cls] = m[st] || [st || "—", ""];
  return `<span class="tag ${cls}">${esc(label)}</span>`;
};

// ---------- sidebar (PRD 4.2) ----------
const NAV = [
  ["board", "Board"], ["assistant", "Assistant"], ["brain", "Brain messages"], ["todos", "TODOs"],
  ["automations", "Automations"], ["config", "Configuration"], ["ado", "ADO items"], ["requests", "Requests"],
  ["outbox", "Outbox"], ["activity", "Activity"], ["retro", "Retro"],
];
function sidebar() {
  const t = S.ov?.totals || {};
  return `
  <aside class="side">
    <div class="brand"><div class="logo">🤖</div><div><b>OrchestratorLoop</b><span>Task control plane</span></div></div>
    <button class="btn primary block" id="newtask">+ New task</button>
    <nav>${NAV.map(([v, l]) => `<button class="nav ${S.view === v ? "on" : ""}" data-view="${v}">${esc(l)}</button>`).join("")}</nav>
    <div class="sstat"><h4>STATUS</h4>
      <div><i class="dot"></i>Queued <b>${(t.runs || 0) - (t.running || 0) - (t.done || 0) - (t.failed || 0)}</b></div>
      <div><i class="dot run"></i>Running <b>${t.running ?? 0}</b></div>
      <div><i class="dot ok"></i>Done <b>${t.done ?? 0}</b></div>
      <div><i class="dot bad"></i>Blocked <b>${t.failed ?? 0}</b></div>
    </div>
  </aside>`;
}

// ---------- topbar (PRD 4.1) ----------
function topbar() {
  const t = S.ov?.totals || {};
  return `
  <header class="top">
    <div class="brand sm"><div class="logo">⚡</div><div><b>OrchestratorLoop</b><span>Task control plane</span></div></div>
    <input id="fq" placeholder="Filter tasks ( / )" value="${esc(S.q)}">
    <button class="btn sm" id="cmds">⌘ Commands</button>
    <button class="btn sm" id="sweep">🧹 Sweep PRs${t.failed ? ` (${t.failed})` : ""}</button>
    <button class="btn sm ${S.auto ? "on" : ""}" id="autobtn">⚡ Auto</button>
    <button class="btn sm" id="resume">${S.auto ? "⏸ Pause" : "▶ Resume"}</button>
    <button class="btn sm ghost" id="refresh">🔄</button>
    <span class="spacer"></span>
    <span class="pill ok"><span class="pulse"></span>Live</span>
  </header>`;
}

// ---------- board (PRD 4.3) ----------
function attentionBanners() {
  const blocked = S.tasks.find((r) => r.status === "failed" || r.blockedReason);
  const review = S.tasks.find((r) => r.prUrl);
  return `<div class="banners">
    ${blocked ? `<div class="banner bad" data-sel="${esc(blocked.id)}"><span class="pulse2"></span><b>${esc((blocked.title || "").slice(0, 70))}</b><span class="mono">#${esc(blocked.id.slice(0, 6))} • Blocked</span></div>` : ""}
    ${review ? `<div class="banner review" data-sel="${esc(review.id)}"><span class="dot2"></span><b>${esc((review.title || "").slice(0, 70))}</b><span class="mono">#${esc(review.id.slice(0, 6))} • PR review</span></div>` : ""}
  </div>`;
}

function boardView() {
  let list = (S.tasks || []).filter((r) =>
    !S.q || ((r.title || "") + " " + r.workflow + " " + (r.branch || "") + " " + r.id).toLowerCase().includes(S.q.toLowerCase()));
  if (S.boardTab === "runs") list = [...list].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  const sel = S.detail;
  return `
  ${attentionBanners()}
  <div class="bhead"><h2>Board <span class="hint">${list.length} of ${S.tasks.length} tasks</span></h2>
    <div class="btabs"><button class="tab ${S.boardTab === "tasks" ? "on" : ""}" data-btab="tasks">Tasks</button>
    <button class="tab ${S.boardTab === "runs" ? "on" : ""}" data-btab="runs">Automation runs</button></div></div>
  <div class="board2">
    <div class="blist">
      ${list.map((r) => `
      <div class="bcard ${S.sel === r.id ? "sel" : ""}" data-sel="${esc(r.id)}">
        <div class="btop">${statusBadge(r.status)} <span class="hint">#${esc(r.id.slice(0, 6))}</span><span class="spacer"></span><span class="hint">${ago(r.startedAt)}</span></div>
        <div class="btitle">${esc((r.title || r.workflow || "").slice(0, 100))}</div>
        <div class="bmeta"><span class="kbd">${esc(r.repository || "tab-automation")}</span> <span class="kbd">${esc(r.branch || "")}</span></div>
        <div class="bmeta"><span class="hint">${r.progress.completed}/${r.progress.total}</span>
          ${r.tokens ? `<span class="hint">🎟${Number(r.tokens).toLocaleString()}</span>` : ""} ${r.toolCalls ? `<span class="hint">🔧${r.toolCalls}</span>` : ""}
          ${r.commentsCount ? `<span class="hint">💬${r.commentsCount}</span>` : ""} ${r.prUrl ? `<span class="hint">🔀 PR</span>` : ""}</div>
      </div>`).join("") || `<div class="empty">No tasks match.</div>`}
    </div>
    <div class="bdetail">${sel ? detailPane(sel) : `<div class="empty">Select a task to inspect.</div>`}</div>
  </div>`;
}

// ---------- detail drawer (PRD 4.4) ----------
function detailPane(d) {
  const tabs = [["overview", "Overview"], ["steps", `Steps (${d.steps.length})`], ["activity", `Activity (${d.activity.length})`], ["diagrams", "Diagrams"], ["sessions", `Sessions (${d.sessions.length})`]];
  const pct = d.progress.total ? Math.round(d.progress.completed / d.progress.total * 100) : 0;
  let body = "";
  if (S.detailTab === "overview") body = `<div class="endgoal">${esc(d.endGoal?.slice(0, 1200) || "No description.")}</div>${d.error ? `<div class="status bad">${esc(d.error)}</div>` : ""}${d.blockedReason && d.status === "failed" ? `<div class="status bad">Blocked: ${esc(d.blockedReason.slice(0, 300))}</div>` : ""}`;
  else if (S.detailTab === "steps") body = d.steps.map((s, i) => `
    <div class="stepcard ${s.status === "failed" ? "bad" : ""}">
      <div class="shead"><span class="snum">${i + 1}</span><b>${esc(s.id)}</b> <span class="kbd">${esc(s.type)}</span> ${s.agent ? `<span class="kbd">${esc(s.agent)}</span>` : ""}<span class="spacer"></span>${statusBadge(s.status === "ok" ? "done" : s.status)}<button class="btn ghost sm" data-xstep="${i}">›</button></div>
      ${S.expandedSteps.has(i) ? `<div class="sbody"><p class="dim">${esc(s.text.slice(0, 800))}</p>
        <button class="btn sm ghost" data-xvar="${i}">▶ Full prompt sent to the agent — variant 1</button>
        ${S.expandedVariants.has(i) ? `<pre class="out">${esc(s.text.slice(0, 2000))}</pre>${s.output ? `<pre class="out">${esc(s.output.slice(0, 1000))}</pre>` : ""}` : ""}
        <label class="fld"><span>Re-run from this step</span><textarea id="rerun-${i}" rows="2" placeholder="- What should this step do differently? (optional)"></textarea></label>
        <p class="hint">Markdown — one '-' bullet per point. Earlier steps preserved; this step + downstream reset.</p>
        <button class="btn primary sm" data-rqstep="${i}">🔄 Re-queue from step ${i + 1}</button></div>` : ""}
    </div>`).join("") || `<p class="hint">No steps</p>`;
  else if (S.detailTab === "activity") body = `<div class="logbox">${d.activity.map((a) => `
    <div class="lrow ${a.status === "failed" ? "error" : "info"}"><span class="lt">${esc(String(a.at || "").slice(5, 16).replace("T", " "))}</span>
    <span class="ltag">${esc(a.action)}</span><span>${esc(String(a.detail || "").slice(0, 220))}</span></div>`).join("") || `<p class="hint">No activity</p>`}</div>`;
  else if (S.detailTab === "diagrams") body = `<div class="pipe">${d.diagram.map((n) => `
    <div class="pnode ${d.status === "failed" ? "bad" : "ok"}"><b>${esc(n.label)}</b><span>${esc(n.type)}</span></div>`).join("") || `<p class="hint">No diagram</p>`}</div>
    <p class="hint">Scroll to pan · Ctrl+scroll to zoom</p>`;
  else body = `<div class="sess">${d.sessions.map((s) => `
    <div class="srow"><b>${esc(s.agent)}</b><span class="kbd">${esc(s.model)}</span><span class="hint">${esc(s.workspace)} · ${esc(s.context)} · ${s.steps} steps</span></div>`).join("") || `<p class="hint">No sessions</p>`}</div>`;
  return `
  <div class="dhead"><span class="mono">#${esc(d.id.slice(0, 6))}</span> ${statusBadge(d.status)}<span class="spacer"></span><button class="btn ghost sm" id="dclose">✕</button></div>
  <div class="dtitle">${esc((d.title || "").slice(0, 120))}</div>
  <p class="hint">${d.prUrl ? `PR open — <a href="${esc(d.prUrl)}" target="_blank">review</a>` : d.status === "failed" ? "Blocked — needs attention." : d.status === "done" ? "Completed." : "In progress."}</p>
  <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div><div class="hint">${d.progress.completed}/${d.progress.total}</div>
  <div class="dact"><button class="btn sm primary" data-act="req-changes">Request changes</button><button class="btn sm" data-act="sweep">Sweep PR comments</button>
    <button class="btn sm" data-act="done">Mark done</button>${d.prUrl ? `<a class="btn sm" href="${esc(d.prUrl)}" target="_blank">Open PR ↗</a>` : ""}
    <button class="btn sm" data-rerun="${esc(d.workflow)}">Re-run</button><button class="btn sm danger" data-act="del">Delete</button></div>
  <nav class="tabs">${tabs.map(([v, l]) => `<button class="tab ${S.detailTab === v ? "on" : ""}" data-dtab="${v}">${esc(l)}</button>`).join("")}</nav>
  <div class="dbody">${body}</div>`;
}

// ---------- other views ----------
function agentsView() {
  return `<div class="agrid">${(S.agents || []).map((a) => `
    <div class="card"><h3>${esc(a.id)}</h3><p class="desc">${esc(a.description || "—")}</p>
    <p><span class="kbd">${esc(a.model || a.provider || "default")}</span></p>
    <div class="arow"><span>Runs</span><b>${a.runs ?? 0}</b></div>
    <div class="arow"><span>Tokens</span><b>${(a.tokens ?? 0).toLocaleString()}</b></div></div>`).join("") || `<div class="empty">No agents.</div>`}</div>`;
}
function toolsView() {
  return `<div class="card"><div class="tblwrap"><table class="tbl"><thead><tr><th>Tool</th><th>Kind</th><th>Auth</th><th>Calls</th><th>Avg ms</th></tr></thead><tbody>
  ${(S.tools || []).map((t) => `<tr><td><b>${esc(t.id)}</b></td><td>${esc(t.kind)}</td>
  <td>${t.auth === "needed" ? `<span class="tag bad">🔐 sign-in</span>` : `<span class="tag ok">✅</span>`}</td>
  <td>${t.calls ?? 0}</td><td>${t.avgMs ?? 0}</td></tr>`).join("")}</tbody></table></div></div>`;
}
function brainView() {
  const b = S.brain || { messages: [], poller: {} };
  const msgs = (b.messages || []).slice(0, 40);
  const sel = S.brainSel ? msgs.find((m) => m.id === S.brainSel) : null;
  return `<div class="card"><h3>Brain messages <span class="hint">Teams / Brain</span></h3>
  <p class="hint">Poller ${b.poller?.enabled ? "enabled" : "off"} · interval ${b.poller?.intervalMin || 2} min · Completion updates ${b.poller?.completionUpdates ? "on" : "off"} · Incoming ${msgs.length}</p>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>Received</th><th>Sender / source</th><th>Incoming message</th><th>Processing</th><th>Outbox</th></tr></thead><tbody>
  ${msgs.map((m) => `<tr data-brain="${esc(m.id)}" style="cursor:pointer;${S.brainSel === m.id ? "background:var(--acc-soft);" : ""}"><td class="dim">${esc(String(m.ts || "").slice(0, 16).replace("T", " "))}</td>
  <td>${esc(m.sender)}<br><span class="hint">${esc(m.channelId || "discord")} · ${esc(m.kind || "")}</span></td>
  <td class="dim">${esc(String(m.text || "").slice(0, 160))}</td><td>${esc(m.status)}</td><td class="hint">${m.status === "replied" ? "1 sent" : "—"}</td></tr>`).join("") || `<tr><td colspan="5" class="hint">No messages</td></tr>`}
  </tbody></table></div>
  ${sel ? `<div class="appr"><div class="row"><b>Brain message</b><span class="kbd">${esc(sel.id)}</span><span class="spacer"></span><button class="btn sm ghost" id="brainx">✕</button></div>
  <div class="row"><button class="tab ${S.brainTab === "details" ? "on" : ""}" data-btab2="details">Message details</button><button class="tab ${S.brainTab === "session" ? "on" : ""}" data-btab2="session">Session</button></div>
  ${S.brainTab === "details" ? `<p class="dim">From <b>${esc(sel.sender)}</b> at ${esc(String(sel.ts || "").slice(0, 19).replace("T", " "))} · status ${esc(sel.status)}</p><div class="endgoal">${esc(String(sel.text || "").slice(0, 2000))}</div>` : `<p class="dim">Runner: Discord poller · channel ${esc(sel.channelId || "—")} · kind ${esc(sel.kind || "—")}</p><pre class="out">${esc(String(sel.text || "").slice(0, 2000))}</pre>`}</div>` : ""}</div>`;
}
function requestsView() {
  return `<div class="card"><h3>Requests <span class="hint">${S.requests.length} intake</span></h3>
  <p class="hint">Raw goals awaiting / passed through the task-divider. Newest first.</p>
  ${S.requests.map((r) => `<div class="appr"><div class="row"><b>${esc(String(r.text || "").slice(0, 90))}</b><span class="spacer"></span><span class="tag ${r.status === "running" ? "run" : ""}">${esc(r.status || "queued")}</span></div>
  <p class="hint">mode ${esc(r.mode)} · repo ${esc(r.repo)} · type ${esc(r.task_type)} · pipeline ${(JSON.parse(r.pipeline || "[]") || []).map(esc).join(" → ") || "—"} · ${esc(String(r.created_at || "").slice(0, 16).replace("T", " "))}${r.run_id ? ` · run <span class="kbd">${esc(r.run_id)}</span>` : ""}</p></div>`).join("") || `<p class="hint">No requests yet — hit + New task.</p>`}</div>`;
}
function outboxView() {
  return `<div class="card"><h3>Outbox <span class="hint">${S.outbox.length} queued/sent</span></h3>
  <div class="chatbox"><input id="ob-in" placeholder="Queue a notification…"><button class="btn sm" id="ob-add">Queue</button></div>
  ${S.outbox.map((o) => `<div class="appr"><div class="row"><span class="tag ${o.status === "sent" ? "ok" : "run"}">${esc(o.status)}</span><b>${esc(String(o.text || "").slice(0, 120))}</b><span class="spacer"></span>${o.status !== "sent" ? `<button class="btn sm ghost" data-obsent="${esc(o.id)}">Mark sent</button>` : `<span class="hint">${esc(String(o.sent_at || "").slice(0, 16).replace("T", " "))}</span>`}</div>
  <p class="hint">${esc(o.channel || "default")} · ${esc(String(o.created_at || "").slice(0, 16).replace("T", " "))}${o.run_id ? ` · run ${esc(o.run_id)}` : ""}</p></div>`).join("") || `<p class="hint">Outbox empty.</p>`}</div>`;
}
function retroView() {
  const r = S.retro;
  if (!r) return `<div class="card"><h3>Retro</h3><p class="hint">Loading…</p></div>`;
  return `<div class="card"><h3>Retro <span class="hint">last ${esc(String(r.since || "").slice(0, 10))} → now</span></h3>
  <div class="agrid">
  <div class="card"><h3>Runs</h3><div class="arow"><span>Total</span><b>${r.runs?.c ?? 0}</b></div><div class="arow"><span>Avg duration</span><b>${Math.round(r.runs?.avgSec || 0)}s</b></div></div>
  <div class="card"><h3>Tokens / tools</h3><div class="arow"><span>Tokens</span><b>${Number(r.runs?.t || 0).toLocaleString()}</b></div><div class="arow"><span>Tool calls</span><b>${r.runs?.tc ?? 0}</b></div></div>
  <div class="card"><h3>By status</h3>${(r.byStatus || []).map((s) => `<div class="arow"><span>${esc(s.status)}</span><b>${s.c}</b></div>`).join("") || `<p class="hint">—</p>`}</div>
  <div class="card"><h3>Retries (workflow × runs)</h3>${(r.retries || []).map((s) => `<div class="arow"><span>${esc(s.workflow_id)}</span><b>${s.c}</b></div>`).join("") || `<p class="hint">No repeats — deterministic.</p>`}</div>
  </div>
  <h3>Delivery velocity</h3><div class="logbox">${(r.byDay || []).map((d) => `<div class="lrow info"><span class="lt">${esc(d.d)}</span><span class="ltag">${d.c} runs</span></div>`).join("")}</div></div>`;
}
function flowsView() {
  return `<div class="card"><h3>Automations</h3>
  ${(S.flows || []).map((f) => `<div class="appr"><b>${esc(f.id)}</b> <span class="kbd">${esc(f.trigger)}${f.cron ? " " + esc(f.cron) : ""}</span>
  <span class="hint">${(f.steps || []).length} steps · last: ${esc(f.lastStatus || "never")}</span>
  <div class="row"><button class="btn sm" data-runflow="${esc(f.id)}">Run</button><button class="btn sm ghost">Edit</button></div></div>`).join("") || `<p class="hint">No flows — add workflows in Setup Step 5.</p>`}</div>`;
}
function todosView() {
  return `<div class="card"><h3>TODOs (${S.todos.length})</h3>
  ${S.todos.slice(0, 20).map((t) => `<div class="appr"><span class="tag">${esc(t.priority)}</span> ${esc(t.text)} <span class="hint">${esc(t.id)}</span></div>`).join("") || `<p class="hint">No TODOs yet</p>`}
  <div class="chatbox"><input id="todo-in" placeholder="+ new todo…"><button class="btn sm" id="todo-add">Add</button></div></div>`;
}
function logsView() {
  return `<div class="card"><div class="tbar"><select id="loglevel"><option value="">All levels</option>
  ${["info", "error"].map((l) => `<option ${S.logLevel === l ? "selected" : ""}>${l}</option>`).join("")}</select>
  <button class="btn sm" id="logref">Refresh</button></div>
  <div class="logbox">${(S.logs || []).map((l) => `<div class="lrow ${esc(l.level)}"><span class="lt">${esc(String(l.created_at || "").slice(5, 19).replace("T", " "))}</span>
  <span class="ltag">${esc(l.level)}</span><span class="lsrc">${esc(l.source || "")}</span><span>${esc(l.message || "")}</span></div>`).join("") || `<p class="hint">No logs</p>`}</div></div>`;
}

// ---------- request modal (PRD 4.5) ----------
function reqModal() {
  if (!S.showReq) return "";
  return `<div class="modal"><div class="mbox"><div class="dhead"><b>Submit a request</b><span class="spacer"></span><button class="btn ghost sm" id="reqx">✕</button></div>
  <p class="hint">A raw goal. The task-divider grills it, decomposes it, and enqueues the tasks after you confirm.</p>
  <div class="row"><button class="btn sm ${S.reqMode === "request" ? "primary" : "ghost"}" id="reqm-req">Request</button><button class="btn sm ${S.reqMode === "direct" ? "primary" : "ghost"}" id="reqm-dir">Direct task</button></div>
  <label class="fld"><span>What should be built or fixed?</span><textarea id="req-text" rows="3" placeholder="Describe the outcome. Be concrete about done-ness."></textarea></label>
  <div class="row"><label class="fld"><span>Repo</span><select id="req-repo"><option ${S.reqRepo === "— unset —" ? "selected" : ""}>— unset —</option><option ${S.reqRepo === "tab-automation" ? "selected" : ""}>tab-automation</option></select></label>
  <label class="fld"><span>Task type</span><select id="req-type">${TASK_TYPE_OPTS.map(([v, l]) => `<option value="${v}" ${S.reqType === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label></div>
  <p class="hint">Pipeline: ${S.reqMode === "direct" ? esc(PIPELINE_PREVIEW[S.reqType] || "—") : "Pending divider selection"}</p>
  ${S.reqMsg ? `<p class="hint">${esc(S.reqMsg)}</p>` : ""}
  <div class="row"><button class="btn primary" id="req-go" ${S.reqBusy ? "disabled" : ""}>${S.reqBusy ? "Enqueuing…" : "Enqueue Task"}</button></div></div></div>`;
}

// ---------- render ----------
function render() {
  const v = S.view;
  const main = v === "board" ? boardView() : v === "assistant" ? `<div class="card"><h3>Assistant</h3><div class="chatbox"><input id="chat-in" placeholder='Ask Rick…'><button class="btn primary sm" id="chat-send">Send</button></div><div class="feed">${(S.feed?.messages || []).slice(-10).map((m) => `<div class="fmsg ${m.kind === "chat" ? "user" : "rick"}">${esc(m.text)}</div>`).join("")}</div></div>` :
    v === "brain" ? brainView() : v === "todos" ? todosView() : v === "automations" ? flowsView() :
    v === "requests" ? requestsView() : v === "outbox" ? outboxView() :
    v === "config" ? `<div class="card"><h3>Configuration</h3><p class="hint">Setup wizard (port 3000) me badlo. <a href="/" target="_blank">Open setup</a></p></div>` :
    v === "activity" ? `<div class="card"><h3>Activity</h3><div class="logbox">${(S.activity || []).map((a) => `<div class="lrow info"><span class="lt">${esc(String(a.created_at || "").slice(5, 16).replace("T", " "))}</span><span class="ltag">${esc(a.action)}</span><span>${esc(String(a.detail || "").slice(0, 160))}</span></div>`).join("")}</div></div>` :
    v === "retro" ? retroView() :
    v === "logs" ? logsView() : v === "tools" ? toolsView() : v === "agents" ? agentsView() :
    `<div class="card"><h3>${esc(v)}</h3><p class="hint">ADO items live in Azure DevOps — link PRs from task detail. Coming soon: inline ADO sync.</p></div>`;
  $("#app").innerHTML = `<div class="app">${sidebar()}<main class="main">${topbar()}${main}</main></div>${reqModal()}${cmdPalette()}`;
  $$("[data-view]").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; S.sel = null; S.detail = null; render(); }));
  $$("[data-btab]").forEach((b) => (b.onclick = () => { S.boardTab = b.dataset.btab; render(); }));
  $$("[data-dtab]").forEach((b) => (b.onclick = () => { S.detailTab = b.dataset.dtab; render(); }));
  $$("[data-sel]").forEach((b) => (b.onclick = async () => { S.sel = b.dataset.sel; S.detail = null; render(); loadDetail(S.sel); }));
  $$(".banner").forEach((b) => (b.onclick = async () => { S.sel = b.dataset.sel; S.detail = null; render(); loadDetail(S.sel); }));
  const dc = $("#dclose"); if (dc) dc.onclick = () => { S.sel = null; S.detail = null; render(); };
  $$("[data-rerun]").forEach((b) => (b.onclick = async () => { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.rerun, text: "" }) }); tick(true); }));
  $$("[data-runflow]").forEach((b) => (b.onclick = async () => { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.runflow, text: "" }) }); tick(true); }));
  $$("[data-xstep]").forEach((b) => (b.onclick = () => { const i = +b.dataset.xstep; S.expandedSteps.has(i) ? S.expandedSteps.delete(i) : S.expandedSteps.add(i); render(); }));
  $$("[data-xvar]").forEach((b) => (b.onclick = () => { const i = +b.dataset.xvar; S.expandedVariants.has(i) ? S.expandedVariants.delete(i) : S.expandedVariants.add(i); render(); }));
  $$("[data-rqstep]").forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.rqstep; const ta = $(`#rerun-${i}`); const guidance = ta ? ta.value : "";
    b.disabled = true; b.textContent = "⏳ Re-queuing…";
    try {
      await api(`/api/control/task/${S.sel}/requeue`, { method: "POST", body: JSON.stringify({ stepIndex: i, guidance }) });
      S.detail = null; tick(true);
    } catch (e) { b.disabled = false; b.textContent = `🔄 Re-queue from step ${i + 1}`; alert(e.message); }
  }));
  $$("[data-act]").forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act;
    if (a === "done" && S.sel) { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ text: `mark ${S.sel} done` }) }); }
    tick(true);
  }));
  const fq = $("#fq"); if (fq) { fq.oninput = () => { S.q = fq.value; if (S.cmdOpen) render(); }; fq.onchange = () => render(); }
  const nt = $("#newtask"); if (nt) nt.onclick = () => { S.showReq = true; render(); wireReq(); };
  const cmds = $("#cmds"); if (cmds) cmds.onclick = () => { S.cmdOpen = true; S.cmdIdx = 0; render(); };
  const cx = $("#cmdx"); if (cx) cx.onclick = () => { S.cmdOpen = false; render(); };
  $$("[data-cmd]").forEach((b) => (b.onclick = () => {
    const v = b.dataset.cmd; S.cmdOpen = false;
    if (v === "new") { S.showReq = true; render(); wireReq(); return; }
    if (v === "refresh") { tick(true); return; }
    S.view = v; S.sel = null; S.detail = null; render();
  }));
  const sw = $("#sweep"); if (sw) sw.onclick = async () => { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ text: "sweep PR comments on failed tasks" }) }).catch(() => {}); tick(true); };
  const ab = $("#autobtn"); if (ab) ab.onclick = () => { S.auto = !S.auto; render(); arm(); };
  const rs = $("#resume"); if (rs) rs.onclick = () => { S.auto = !S.auto; render(); arm(); };
  const rf = $("#refresh"); if (rf) rf.onclick = () => tick(true);
  $$("[data-brain]").forEach((b) => (b.onclick = () => { S.brainSel = b.dataset.brain; render(); }));
  const bx = $("#brainx"); if (bx) bx.onclick = () => { S.brainSel = null; render(); };
  $$("[data-btab2]").forEach((b) => (b.onclick = () => { S.brainTab = b.dataset.btab2; render(); }));
  const ob = $("#ob-add"); if (ob) ob.onclick = async () => { const i = $("#ob-in"); const t = i.value.trim(); if (!t) return; await api("/api/control/outbox", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  $$("[data-obsent]").forEach((b) => (b.onclick = async () => { await api("/api/control/outbox/sent", { method: "POST", body: JSON.stringify({ id: b.dataset.obsent }) }); tick(true); }));
  wireReq();
  const cs = $("#chat-send"); if (cs) cs.onclick = sendChat;
  const ta = $("#todo-add"); if (ta) ta.onclick = async () => { const i = $("#todo-in"); const t = i.value.trim(); if (!t) return; await api("/api/control/todos", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  const ll = $("#loglevel"); if (ll) ll.onchange = () => { S.logLevel = ll.value; tick(true); };
  const lr = $("#logref"); if (lr) lr.onclick = () => tick(true);
}
function cmdPalette() {
  if (!S.cmdOpen) return "";
  const cmds = [
    ["board", "Go to Board"], ["assistant", "Go to Assistant"], ["brain", "Go to Brain messages"],
    ["todos", "Go to TODOs"], ["automations", "Go to Automations"], ["requests", "Go to Requests"],
    ["outbox", "Go to Outbox"], ["activity", "Go to Activity"], ["retro", "Go to Retro"],
    ["new", "+ New task"], ["refresh", "Refresh now"],
  ].filter(([v, l]) => !S.q || l.toLowerCase().includes(S.q.toLowerCase()));
  return `<div class="modal"><div class="mbox"><div class="dhead"><b>Commands</b><span class="spacer"></span><button class="btn ghost sm" id="cmdx">✕</button></div>
  ${cmds.map(([v, l], i) => `<button class="nav ${i === S.cmdIdx ? "on" : ""}" data-cmd="${v}">${esc(l)}</button>`).join("") || `<p class="hint">No match</p>`}</div></div>`;
}
function wireReq() {
  const rx = $("#reqx"); if (rx) rx.onclick = () => { S.showReq = false; S.reqMsg = ""; render(); };
  const mr = $("#reqm-req"); if (mr) mr.onclick = () => { S.reqMode = "request"; render(); wireReq(); };
  const md = $("#reqm-dir"); if (md) md.onclick = () => { S.reqMode = "direct"; render(); wireReq(); };
  const rt = $("#req-type"); if (rt) rt.onchange = () => { S.reqType = rt.value; render(); wireReq(); };
  const rr = $("#req-repo"); if (rr) rr.onchange = () => { S.reqRepo = rr.value; render(); wireReq(); };
  const g = $("#req-go"); if (g) g.onclick = async () => {
    const t = $("#req-text").value.trim(); if (!t || S.reqBusy) return;
    S.reqBusy = true; S.reqMsg = "Divider working…"; render(); wireReq();
    try {
      const r = await api("/api/control/requests", { method: "POST", body: JSON.stringify({ text: t, mode: S.reqMode, repo: S.reqRepo === "— unset —" ? "tab-automation" : S.reqRepo, taskType: S.reqType }) });
      S.reqBusy = false; S.showReq = false; S.reqMsg = "";
      S.view = "board"; S.boardTab = "tasks"; S.sel = r.runId; S.detail = null;
      render(); if (r.runId) loadDetail(r.runId); else tick(true);
    } catch (e) { S.reqBusy = false; S.reqMsg = e.message; render(); wireReq(); }
  };
}
async function sendChat() {
  const i = $("#chat-in"); const t = i.value.trim(); if (!t) return; i.value = "";
  await api("/api/control/chat", { method: "POST", body: JSON.stringify({ text: t }) }).catch(() => {});
  setTimeout(() => tick(true), 1500);
}
async function loadDetail(id) {
  try { const r = await api(`/api/control/task/${id}`); S.detail = r.task; render(); } catch { /* keep list */ }
}
function arm() {
  if (S.timer) clearInterval(S.timer);
  if (S.auto && S.cfg.enabled) S.timer = setInterval(() => tick(), Math.max(2, Number(S.cfg.refreshSec) || 3) * 1000);
}
async function tick(force) {
  try {
    const [cfg, ov, tasks, agents, tools, activity, logs, appr, todos, feed, brain, flows, requests, outbox, retro] = await Promise.all([
      api("/api/dashboard/config").catch(() => S.cfg),
      api("/api/control/overview?days=7").catch(() => null),
      api("/api/control/tasks?limit=30").catch(() => ({ tasks: [] })),
      api("/api/control/agents").catch(() => ({ agents: [] })),
      api("/api/control/tools").catch(() => ({ tools: [] })),
      api("/api/control/activity?limit=60").catch(() => ({ activity: [] })),
      api(`/api/control/logs?limit=100${S.logLevel ? "&level=" + S.logLevel : ""}`).catch(() => ({ logs: [] })),
      api("/api/control/approvals").catch(() => ({ approvals: [] })),
      api("/api/control/todos").catch(() => ({ todos: [], reminders: [] })),
      api("/api/feed?limit=8").catch(() => null),
      api("/api/control/brain").catch(() => null),
      api("/api/control/automations").catch(() => ({ flows: [] })),
      api("/api/control/requests").catch(() => ({ requests: [] })),
      api("/api/control/outbox").catch(() => ({ outbox: [] })),
      api("/api/control/retro?days=30").catch(() => null),
    ]);
    if (cfg) S.cfg = cfg;
    if (ov) S.ov = ov;
    S.tasks = tasks.tasks || []; S.agents = agents.agents || []; S.tools = tools.tools || [];
    S.activity = activity.activity || []; S.logs = logs.logs || [];
    S.approvals = appr.approvals || []; S.todos = todos.todos || []; S.reminders = todos.reminders || [];
    if (feed) S.feed = feed; if (brain) S.brain = brain; S.flows = flows.flows || [];
    S.requests = requests.requests || []; S.outbox = outbox.outbox || [];
    if (retro) S.retro = retro;
    if (S.sel && !S.detail) { loadDetail(S.sel); return; }
    render(); arm();
  } catch (e) {
    $("#app").innerHTML = `<main class="shell"><div class="status bad">Control Room load nahi hua: ${esc(e.message)}</div></main>`;
  }
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); S.cmdOpen = !S.cmdOpen; render(); }
  else if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") { e.preventDefault(); $("#fq")?.focus(); }
  else if (e.key === "Escape" && S.cmdOpen) { S.cmdOpen = false; render(); }
});
tick();

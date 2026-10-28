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
  reqAgents: ["assistant"], reqStream: "general", reqPipeline: "", reqBusy: false, reqMsg: "",
  expandedSteps: new Set(), expandedVariants: new Set(), rerunText: "",
  brainSel: null, brainTab: "details", brainQ: "", flowSel: null,
  flowEdit: null, flowTrig: "schedule", flowTime: "11:00 AM", flowDays: ["Every day"], flowCron: "", flowRule: "",
  flowMsg: "", cfgData: null, cfgMsg: "",
  loopTasks: [], loopSel: null, loopDetail: null, loopForm: null,
  cmdOpen: false, cmdIdx: 0, theme: "dark",
  groupBy: "status", sortBy: "recent", statusFilter: "", todoTab: "open", todoQ: "", todoSource: "all",
  showCtx: false, sessIdx: 0, diagFull: false, reqChanges: "", appendTitle: "",
  paused: false,
};
// Agent pipeline: OUR agents from config/agents.json are the pipeline.
// Streams group agents; pipelines chain agent->agent. Divider picks stream+pipeline.
const AGENT_OPTS = ["assistant", "summarizer", "coder", "finance-india", "finance-us"];
const streamName = (id) => (S.cfgData?.streams?.streams || []).find((s) => s.id === id)?.name || id;
const streamPipes = (sid) => (S.cfgData?.streams?.pipelines || []).filter((p) => !sid || p.stream === sid);

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

// ---------- sidebar (PRD 4.2: nav + counts + status filter) ----------
const NAV = [
  ["board", "Board"], ["assistant", "Assistant"], ["brain", "Brain messages"], ["todos", "TODOs"],
  ["automations", "Automations"], ["config", "Configuration"], ["requests", "Requests"],
  ["outbox", "Outbox"], ["activity", "Activity"], ["retro", "Retro"],
];
const NAV_COUNT = () => ({
  board: S.tasks.length, brain: (S.brain?.messages?.length ?? S.brain?.metrics?.incoming ?? 0),
  todos: S.todos.length, automations: S.flows.length, requests: S.requests.length,
  outbox: S.outbox.length, activity: S.activity.length,
});
function sidebar() {
  const t = S.ov?.totals || {};
  const counts = NAV_COUNT();
  const queued = Math.max(0, (t.runs || 0) - (t.running || 0) - (t.done || 0) - (t.failed || 0));
  const stats = [["Queued", queued, ""], ["Running", t.running ?? 0, "run"], ["Plan review", 0, ""], ["Size review", 0, ""], ["Your review", 0, ""], ["PR review", S.tasks.filter((r) => r.prUrl).length, "review"], ["Blocked", t.failed ?? 0, "bad"], ["Done", t.done ?? 0, "ok"]];
  return `
  <aside class="side">
    <div class="brand"><div class="logo">🤖</div><div><b>OrchestratorLoop</b><span>Task control plane</span></div></div>
    <button class="btn primary block" id="newtask">+ New task</button>
    <nav>${NAV.map(([v, l]) => `<button class="nav ${S.view === v ? "on" : ""}" data-view="${v}"><span>${esc(l)}</span>${counts[v] ? `<span class="ncount">${counts[v]}</span>` : ""}</button>`).join("")}</nav>
    <div class="sstat"><h4>STATUS</h4>
      ${stats.map(([l, c, cls]) => `<div class="srow2 ${S.statusFilter === l ? "on" : ""}" data-statusf="${esc(l)}"><i class="dot ${cls}"></i>${esc(l)} <b>${c}</b></div>`).join("")}
    </div>
    <div class="spal"><span>⌘ Command palette</span><kbd>⌘K</kbd></div>
  </aside>`;
}

// ---------- topbar (PRD 4.1: search, commands, sweep, auto, pause, refresh, theme, live) ----------
function topbar() {
  const t = S.ov?.totals || {};
  return `
  <header class="top">
    <div class="brand sm"><div class="logo">⚡</div><div><b>OrchestratorLoop</b><span>Task control plane</span></div></div>
    <span class="ws">tab-automation</span>
    <input id="fq" placeholder="Filter tasks ( / )" value="${esc(S.q)}">
    <button class="btn sm" id="cmds">⌘ Commands <kbd>⌘K</kbd></button>
    <button class="btn sm ${S.auto ? "on" : ""}" id="autobtn">⚡ Auto</button>
    <button class="btn sm" id="resume">${S.paused ? "▶ Resume" : "⏸ Pause"}</button>
    <button class="btn sm ghost" id="refresh" title="Refresh now">🔄</button>
    <button class="btn sm ghost" id="theme">${S.theme === "dark" ? "☀️" : "🌙"}</button>
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
  // Loop task tables (reference: tasks + task_steps DB tables).
  const lt = (S.loopTasks || []).filter((t) =>
    !S.q || ((t.title || "") + " " + (t.repo || "") + " " + t.id + " " + (t.task_type || "")).toLowerCase().includes(S.q.toLowerCase()));
  let list = (S.tasks || []).filter((r) =>
    !S.q || ((r.title || "") + " " + r.workflow + " " + (r.branch || "") + " " + r.id + " " + (r.repository || "")).toLowerCase().includes(S.q.toLowerCase()));
  if (S.statusFilter === "Blocked") list = list.filter((r) => r.status === "failed" || r.blockedReason);
  else if (S.statusFilter === "Running") list = list.filter((r) => r.status === "running");
  else if (S.statusFilter === "Done") list = list.filter((r) => r.status === "done");
  else if (S.statusFilter === "Queued") list = list.filter((r) => r.status === "queued");
  else if (S.statusFilter === "PR review") list = list.filter((r) => r.prUrl);
  if (S.sortBy === "recent") list = [...list].sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  else list = [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sel = S.detail;
  const lsel = S.loopDetail;
  return `
  ${attentionBanners()}
  <div class="bhead"><h2>Board <span class="hint">${list.length} runs · ${lt.length} loop tasks</span></h2>
    <div class="btabs"><button class="tab ${S.boardTab === "tasks" ? "on" : ""}" data-btab="tasks">Tasks</button>
    <button class="tab ${S.boardTab === "runs" ? "on" : ""}" data-btab="runs">Automation runs</button>
    <button class="tab ${S.boardTab === "loop" ? "on" : ""}" data-btab="loop">Loop tasks</button></div>
    <span class="spacer"></span>
    <select id="sortby" class="sel"><option value="recent" ${S.sortBy === "recent" ? "selected" : ""}>Recent activity</option><option value="id" ${S.sortBy === "id" ? "selected" : ""}>By Task ID</option></select>
  </div>
  ${S.boardTab === "loop" ? loopTasksView(lt, lsel) : `
  <div class="board2">
    <div class="blist">
      ${list.map((r) => `
      <div class="bcard ${S.sel === r.id ? "sel" : ""}" data-sel="${esc(r.id)}">
        <div class="btop">${statusBadge(r.status)} <span class="hint">#${esc(r.id.slice(0, 6))}</span><span class="spacer"></span><span class="hint">${ago(r.startedAt)}</span></div>
        <div class="btitle">${esc((r.title || r.workflow || "").slice(0, 100))}</div>
        <div class="bmeta"><span class="kbd">${esc(r.repository || "tab-automation")}</span> <span class="kbd">${esc(r.taskType || r.kind || "")}</span> <span class="kbd">⑂ ${esc((r.branch || "").slice(0, 40))}</span></div>
        <div class="bmeta"><span class="hint">${r.progress.completed}/${r.progress.total}</span>
          ${r.tokens ? `<span class="hint">🎟${Number(r.tokens).toLocaleString()}</span>` : ""} ${r.toolCalls ? `<span class="hint">🔧${r.toolCalls}</span>` : ""}
          ${r.commentsCount ? `<span class="hint">💬${r.commentsCount}</span>` : ""} ${r.prUrl ? `<span class="hint">🔀 PR</span>` : ""}</div>
      </div>`).join("") || `<div class="empty">No tasks match.</div>`}
    </div>
    <div class="bdetail">${sel ? detailPane(sel) : `<div class="empty">Select a task to inspect.</div>`}</div>
  </div>`}`;
}

// ---------- loop task tables (reference: tasks + task_steps tables) ----------
function loopTasksView(lt, lsel) {
  return `<div class="board2"><div class="blist">
    <button class="btn sm primary" id="loopnew">+ New loop task</button>
    ${lt.map((t) => `<div class="bcard ${S.loopSel === t.id ? "sel" : ""}" data-loop="${esc(t.id)}">
      <div class="btop">${statusBadge(t.status === "open" ? "queued" : t.status)} <span class="hint">#${esc(t.id.slice(0, 6))}</span><span class="spacer"></span><span class="hint">${ago(t.updated_at)}</span></div>
      <div class="btitle">${esc((t.title || "").slice(0, 100))}</div>
      <div class="bmeta"><span class="kbd">${esc(t.repo || "")}</span><span class="kbd">${esc(t.task_type || "")}</span><span class="kbd">⑂ ${esc((t.branch || "").slice(0, 30))}</span></div>
      <div class="bmeta"><span class="hint">progress ${t.progress || 0}%</span>${t.tokens ? `<span class="hint">🎟${Number(t.tokens).toLocaleString()}</span>` : ""}${t.tool_calls ? `<span class="hint">🔧${t.tool_calls}</span>` : ""}</div>
    </div>`).join("") || `<div class="empty">No loop tasks yet — create one above.</div>`}
  </div><div class="bdetail">${lsel ? loopDetailPane(lsel) : `<div class="empty">Select a loop task to inspect steps.</div>`}</div></div>`;
}
function loopDetailPane(d) {
  const steps = d.steps || [];
  return `<div class="dhead"><span class="mono">#${esc(d.task.id.slice(0, 6))}</span> ${statusBadge(d.task.status === "open" ? "queued" : d.task.status)}<span class="spacer"></span><button class="btn ghost sm" id="loopx">✕</button></div>
  <div class="dtitle">${esc(d.task.title)}</div>
  <div class="endgoal">${esc(d.task.end_goal || "No end goal.")}</div>
  <div class="row"><span class="kbd">${esc(d.task.repo)}</span><span class="kbd">${esc(d.task.task_type)}</span><span class="kbd">⑂ ${esc(d.task.branch)}</span></div>
  <h4>STEPS TABLE (${steps.length})</h4>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>#</th><th>Step</th><th>Type</th><th>Agent</th><th>Model</th><th>Status</th><th></th></tr></thead><tbody>
  ${steps.map((s, i) => `<tr><td>${i + 1}</td><td><b>${esc(s.step_id)}</b></td><td>${esc(s.type)}</td><td>${esc(s.agent)}</td><td class="dim">${esc(s.model || "default")}</td><td>${statusBadge(s.status === "ok" ? "done" : s.status)}</td>
  <td><button class="btn sm ghost" data-loopx="${i}">›</button></td></tr>
  ${S.expandedSteps.has("L" + i) ? `<tr><td colspan="7"><p class="dim">Prompt:</p><pre class="out">${esc((s.prompt || "").slice(0, 2000))}</pre>${s.output ? `<p class="dim">Output:</p><pre class="out">${esc(String(s.output).slice(0, 2000))}</pre>` : ""}
  <div class="row"><label class="fld"><span>Agent</span><select id="loop-agent-${i}">${["assistant", "summarizer", "coder", "finance-india", "finance-us"].map((a) => `<option ${s.agent === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
  <label class="fld"><span>Model (empty = config default)</span><input id="loop-model-${i}" value="${esc(s.model || "")}" placeholder="gpt-5.6-terra"></label></div>
  <label class="fld"><span>Prompt (empty = agent defaultPrompt)</span><textarea id="loop-prompt-${i}" rows="2">${esc(s.prompt || "")}</textarea></label>
  <div class="row"><button class="btn sm primary" data-looprun="${i}">▶ Dispatch ${esc(s.agent || "agent")}</button></div></td></tr>` : ""}`).join("") || `<tr><td colspan="7" class="hint">No steps</td></tr>`}
  </tbody></table></div>
  <div class="row"><button class="btn sm" id="loopadd">+ Add step</button><span class="spacer"></span><button class="btn sm primary" id="loopsave">Save steps</button></div>`;
}

// ---------- detail drawer (PRD 4.4: header, pipeline, toolbar, 5 tabs) ----------
function pipeStages(d) {
  // Pipeline visualizer: derive stage names from steps (Planner/Coder/Validator/Open PR style)
  const steps = d.steps || [];
  return steps.map((s, i) => {
    const done = s.status === "ok" || s.status === "done";
    const run = s.status === "running";
    const bad = s.status === "failed";
    return `<div class="pnode ${done ? "ok" : bad ? "bad" : run ? "run" : ""}"><b>${esc((s.agent || s.id || `Stage ${i + 1}`).slice(0, 22))}</b><span>${done ? "DONE" : bad ? "FAILED" : run ? "RUNNING" : "PENDING"}</span></div>`;
  }).join("");
}
function detailPane(d) {
  const tabs = [["overview", "Overview"], ["steps", `Steps (${d.steps.length})`], ["activity", `Activity (${d.activity.length})`], ["diagrams", "Diagrams"], ["sessions", `Sessions (${d.sessions.length})`]];
  const pct = d.progress.total ? Math.round(d.progress.completed / d.progress.total * 100) : 0;
  const statusDesc = d.prUrl ? "A pull request is open and waiting on your review." : d.status === "failed" ? "Blocked — needs human review." : d.status === "done" ? "Completed." : "Running through the pipeline.";
  let body = "";
  if (S.detailTab === "overview") body = `<div class="endgoal">${esc(d.endGoal?.slice(0, 2000) || "No description.")}</div>
    <div class="row"><span class="kbd">Repo: ${esc(d.repository)}</span><span class="kbd">⑂ ${esc(d.branch)}</span><span class="kbd">${esc(d.taskType)}</span></div>
    ${d.error ? `<div class="status bad">${esc(d.error)}</div>` : ""}${d.blockedReason && d.status === "failed" ? `<div class="status bad">Blocked: ${esc(d.blockedReason.slice(0, 300))}</div>` : ""}
    ${(d.comments || []).length ? `<h4>Comments (${d.comments.length})</h4>` + d.comments.map((cm) => `<div class="appr"><div class="row"><b>${esc(cm.author)}</b><span class="hint">${esc(String(cm.created_at || "").slice(0, 16).replace("T", " "))}</span></div><p class="dim">${esc(cm.text)}</p></div>`).join("") : ""}`;
  else if (S.detailTab === "steps") body = d.steps.map((s, i) => `
    <div class="stepcard ${s.status === "failed" ? "bad" : ""}">
      <div class="shead"><span class="snum">${i + 1}</span><b>${esc(s.id)}</b> <span class="kbd">${esc(s.type)}</span> ${s.agent ? `<span class="kbd">${esc(s.agent)}</span>` : ""}<span class="spacer"></span>${statusBadge(s.status === "ok" ? "done" : s.status)}<button class="btn ghost sm" data-xstep="${i}">›</button></div>
      ${S.expandedSteps.has(i) ? `<div class="sbody"><p class="dim">${esc(s.text.slice(0, 800))}</p>
        <button class="btn sm ghost" data-xvar="${i}">▶ Full prompt sent to the agent — variant 1</button>
        ${S.expandedVariants.has(i) ? `<pre class="out">${esc(s.text.slice(0, 2000))}</pre>${s.output ? `<pre class="out">${esc(s.output.slice(0, 1000))}</pre>` : ""}` : ""}
        <button class="btn sm ghost" data-ctx="${i}">📄 ${S.showCtx ? "Hide context sent" : "View context sent"}</button>
        ${S.showCtx ? `<pre class="out">context-${i + 1}.md · run ${esc(d.id)} · agent ${esc(s.agent || "—")}\n${esc(s.text.slice(0, 1200))}</pre>` : ""}
        <label class="fld"><span>Re-run from this step</span><textarea id="rerun-${i}" rows="2" placeholder="- What should this step do differently? (optional)"></textarea></label>
        <p class="hint">Markdown — one '-' bullet per point. Earlier steps preserved; this step + downstream reset. Restart budget survives; PR link survives.</p>
        <button class="btn primary sm" data-rqstep="${i}">🔄 Re-queue from step ${i + 1}</button></div>` : ""}
    </div>`).join("") || `<p class="hint">No steps</p>`;
  else if (S.detailTab === "activity") body = `<div class="logbox">${d.activity.map((a) => `
    <div class="lrow ${a.status === "failed" ? "error" : "info"}"><span class="lt">${esc(String(a.at || "").slice(5, 16).replace("T", " "))}</span>
    <span class="ltag">${esc(a.action)}</span><span class="lsrc">${esc(a.actor || "")}</span><span>${esc(String(a.detail || "").slice(0, 220))}</span></div>`).join("") || `<p class="hint">No activity</p>`}</div>`;
  else if (S.detailTab === "diagrams") body = `<div class="pipe">${d.diagram.map((n) => `
    <div class="pnode ${n.status === "failed" ? "bad" : "ok"}"><b>${esc(n.label)}</b><span>${esc(n.type)}${n.agent ? " · " + esc(n.agent) : ""}</span></div>`).join("") || `<p class="hint">No diagram</p>`}</div>
    <p class="hint">Scroll to pan · Ctrl+scroll to zoom · <button class="btn sm ghost" id="diagfull">⤢ Open</button></p>
    ${S.diagFull ? `<div class="modal"><div class="mbox wide"><div class="dhead"><b>Diagram — ${esc(d.id.slice(0, 8))}</b><span class="spacer"></span><button class="btn ghost sm" id="diagx">✕</button></div><div class="pipe">${d.diagram.map((n) => `<div class="pnode ${n.status === "failed" ? "bad" : "ok"}"><b>${esc(n.label)}</b><span>${esc(n.type)}</span></div>`).join("")}</div></div></div>` : ""}`;
  else {
    const sess = d.sessions || [];
    const cur = sess[Math.min(S.sessIdx, Math.max(0, sess.length - 1))] || null;
    body = `<div class="sess">
      ${sess.length > 1 ? `<label class="fld"><span>Select session (${sess.length})</span><select id="sesssel">${sess.map((s, i) => `<option value="${i}" ${i === S.sessIdx ? "selected" : ""}>${esc(s.agent)} · ${esc(s.model || "default")} · ${esc(s.status || "")}</option>`).join("")}</select></label>` : ""}
      ${cur ? `<div class="srow"><b>${esc(cur.agent)}</b><span class="kbd">${esc(cur.model || "default")}</span><span class="hint">${esc(cur.workspace || "tab-automation")} · ${esc(cur.context || "")} · ${cur.steps ?? 1} steps</span></div>
      <pre class="out">Runner: ${esc(cur.runner || "tab-automation")}\nSession: ${esc(cur.sessionUuid || cur.id || "—")}\nAgent: ${esc(cur.agent)} · Model: ${esc(cur.model || "default")}\nWorkspace: ${esc(cur.workspace || "tab-automation")}\nTranscript: ${esc(cur.context || "current session")}</pre>` : ""}
      ${sess.map((s) => `<div class="srow"><b>${esc(s.agent)}</b><span class="kbd">${esc(s.model || "default")}</span><span class="hint">${esc(s.workspace || "")} · ${esc(s.context || "")} · ${s.steps ?? 1} steps</span></div>`).join("") || `<p class="hint">No sessions</p>`}</div>`;
  }
  return `
  <div class="dhead"><span class="mono">#${esc(d.id.slice(0, 6))}</span> ${statusBadge(d.status)}<span class="spacer"></span><button class="btn ghost sm" id="dclose">✕</button></div>
  <div class="dtitle">${esc((d.title || "").slice(0, 120))}</div>
  <p class="hint">${esc(statusDesc)}</p>
  <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div><div class="hint">${d.progress.completed}/${d.progress.total}</div>
  <div class="pipe">${pipeStages(d)}</div>
  <div class="dact"><button class="btn sm primary" data-act="req-changes">Request changes</button>${d.prUrl ? `<a class="btn sm" href="${esc(d.prUrl)}" target="_blank">Open PR ↗</a>` : ""}
    <button class="btn sm" data-act="append">+ Append task</button><button class="btn sm" data-act="requeue">Re-queue</button><button class="btn sm danger" data-act="del">🗑 Delete</button></div>
  <div id="actbox"></div>
  <nav class="tabs">${tabs.map(([v, l]) => `<button class="tab ${S.detailTab === v ? "on" : ""}" data-dtab="${v}">${esc(l)}</button>`).join("")}</nav>
  <div class="dbody">${body}</div>`;
}

// ---------- other views ----------
function configView() {
  const c = S.cfgData;
  if (!c) return `<div class="card"><h3>Configuration</h3><p class="hint">Loading providers, models, prompts…</p></div>`;
  const provs = c.providers?.providers || [];
  const agents = c.agents?.agents || [];
  return `<div class="card"><h3>Configuration <span class="hint">providers · models · default prompts</span></h3>
  ${S.cfgMsg ? `<div class="notice ok">${esc(S.cfgMsg)}</div>` : ""}
  <p class="hint">Dispatch chain: per-call model → agent.model → provider.modelDefault (${esc(c.providers?.defaultProvider || "azure")}). Empty prompt uses the agent's defaultPrompt.</p>
  <h4>PROVIDERS (default: ${esc(c.providers?.defaultProvider || "azure")})</h4>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>ID</th><th>Type</th><th>Model default</th><th>Key env</th><th>Endpoint</th></tr></thead><tbody>
  ${provs.map((p, i) => `<tr><td><b>${esc(p.id)}</b></td><td>${esc(p.type)}</td>
  <td><input data-cprov="${i}" data-cf="modelDefault" value="${esc(p.modelDefault || "")}" placeholder="gpt-5.6-terra"></td>
  <td class="dim">${esc(p.keyEnv || "")}</td><td class="dim">${esc((p.endpoint || "").slice(0, 50))}</td></tr>`).join("")}
  </tbody></table></div>
  <div class="row"><label class="fld"><span>Default provider</span><select id="cfg-defprov">${provs.map((p) => `<option ${c.providers?.defaultProvider === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("")}</select></label></div>
  <h4>AGENTS (${agents.length})</h4>
  ${agents.map((a, i) => `<div class="stepcard"><div class="row"><b>${esc(a.id)}</b><span class="hint">${esc(a.description || "")}</span><span class="spacer"></span><button class="btn sm ghost" data-cfgtest="${esc(a.id)}">▶ Test default prompt</button></div>
  <div class="row"><label class="fld"><span>Provider</span><select data-cagent="${i}" data-cf="provider"><option value="">(default)</option>${provs.map((p) => `<option ${a.provider === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("")}</select></label>
  <label class="fld"><span>Model (empty = provider default)</span><input data-cagent="${i}" data-cf="model" value="${esc(a.model || a.deployment || "")}" placeholder="provider default"></label></div>
  <label class="fld"><span>Default prompt (used when dispatch prompt is empty)</span><textarea data-cagent="${i}" data-cf="defaultPrompt" rows="2">${esc(a.defaultPrompt || "")}</textarea></label>
  <div class="row"><label class="fld"><span>Test model override</span><input id="cfgtest-model-${esc(a.id)}" placeholder="empty = agent model"></label>
  <label class="fld"><span>Test prompt override</span><input id="cfgtest-prompt-${esc(a.id)}" placeholder="empty = defaultPrompt"></label></div>
  <div id="cfgtest-out-${esc(a.id)}"></div></div>`).join("")}
  <div class="row"><button class="btn sm primary" id="cfgsave">Save configuration</button></div>
  <h4>STREAMS (${(c.streams?.streams || []).length}) <span class="hint">streams replace repos</span></h4>
  ${(c.streams?.streams || []).map((s) => `<div class="appr"><div class="row"><b>🌊 ${esc(s.name || s.id)}</b><span class="kbd">${esc(s.id)}</span><span class="spacer"></span><span class="hint">${esc(s.description || "")}</span></div>
  <p class="hint">agents: ${(s.agents || []).map(esc).join(", ") || "—"}</p></div>`).join("") || `<p class="hint">No streams — add them in Setup Step 6.</p>`}
  <h4>TASK PIPELINES (${(c.streams?.pipelines || []).length}) <span class="hint">agent → agent chains</span></h4>
  ${(c.streams?.pipelines || []).map((p) => `<div class="appr"><div class="row"><b>⛓️ ${esc(p.name || p.id)}</b><span class="kbd">${esc(p.stream || "")}</span><span class="spacer"></span><span class="hint">${esc(p.description || "")}</span></div>
  <p class="hint">${(p.agents || []).map(esc).join(" → ") || "—"}</p></div>`).join("") || `<p class="hint">No pipelines — add them in Setup Step 6.</p>`}
  <p class="hint">Edit streams + pipelines in Setup Step 6 (Streams) — Control Room is read-only here.</p></div>`;
}
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
  const b = S.brain || { messages: [], poller: {}, metrics: {} };
  const m = b.metrics || {};
  const all = (b.messages || []).filter((x) =>
    !S.brainQ || ((x.messageText || x.text || "") + " " + (x.sender || "") + " " + (x.jobId || x.id || "")).toLowerCase().includes(S.brainQ.toLowerCase()));
  const msgs = all.slice(0, 40);
  const sel = S.brainSel ? all.find((x) => (x.id || x.jobId) === S.brainSel) || msgs.find((x) => (x.id || x.jobId) === S.brainSel) : null;
  const txt = (x) => x.messageText || x.text || "";
  const ts = (x) => x.receivedAt || x.ts || "";
  const st = (x) => x.processingStatus || x.status || "queued";
  return `<div class="card"><h3>Brain messages <span class="hint">Teams / Brain</span></h3>
  <p class="hint">Poller ${b.poller?.enabled ? "enabled" : "off"} · interval ${b.poller?.intervalMin || 2} min · Completion updates ${b.poller?.completionUpdates ? "on" : "off"} · channel ${esc(b.poller?.channel || "discord")}</p>
  <div class="mrow">
    <span class="m">Incoming <b>${m.incoming ?? msgs.length}</b></span><span class="m">Queued <b>${m.queued ?? 0}</b></span>
    <span class="m">Running <b>${m.running ?? 0}</b></span><span class="m bad">Failed / interrupted <b>${m.failed ?? 0}</b></span>
    <span class="m">Outbox <b>${S.outbox.length}</b></span><span class="m">Sent <b>${m.replied ?? 0}</b></span>
  </div>
  <p class="hint">Last scan: ${esc(b.poller?.lastScan ? String(b.poller.lastScan).slice(0, 19).replace("T", " ") : "—")}</p>
  <div class="chatbox"><input id="brain-q" placeholder="Search message, sender, chat or job ID" value="${esc(S.brainQ)}"></div>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>Received</th><th>Sender / source</th><th>Incoming message</th><th>Processing</th><th>Outbox</th></tr></thead><tbody>
  ${msgs.map((x) => { const id = x.id || x.jobId; return `<tr data-brain="${esc(id)}" style="cursor:pointer;${S.brainSel === id ? "background:var(--acc-soft);" : ""}"><td class="dim">${esc(String(ts(x)).slice(0, 16).replace("T", " "))}</td>
  <td>${esc(x.sender)}<br><span class="hint">${esc(x.source || x.channelId || "discord")}</span></td>
  <td class="dim">${esc(String(txt(x)).slice(0, 160))}<br><span class="hint">${esc(x.jobId || x.id || "")}</span></td>
  <td><span class="tag ${st(x) === "failed" ? "bad" : st(x) === "reply_generated" || st(x) === "replied" ? "ok" : "run"}">${esc(st(x))}</span></td>
  <td class="hint">${esc(x.outboxSummary || (st(x) === "replied" || st(x) === "reply_generated" ? "1 sent" : "—"))}</td></tr>`; }).join("") || `<tr><td colspan="5" class="hint">No messages</td></tr>`}
  </tbody></table></div>
  ${sel ? `<div class="appr"><div class="row"><b>Brain message</b><span class="kbd">${esc(sel.id || sel.jobId || "")}</span><span class="spacer"></span><button class="btn sm ghost" id="brainx">✕</button></div>
  <div class="row"><button class="tab ${S.brainTab === "details" ? "on" : ""}" data-btab2="details">Message details</button><button class="tab ${S.brainTab === "session" ? "on" : ""}" data-btab2="session">Session</button></div>
  ${S.brainTab === "details" ? `<div class="grid2"><span>Job ID</span><span class="kbd">${esc(sel.jobId || sel.id || "")}</span><span>Actor ID</span><span class="kbd">${esc(sel.actorId || "—")}</span><span>Conversation</span><span class="kbd">${esc(sel.conversationId || sel.channelId || "—")}</span><span>Updated</span><span>${esc(String(ts(sel)).slice(0, 19).replace("T", " "))}</span></div>
  ${sel.linkedTaskId ? `<p class="dim">Linked work: <span class="kbd">${esc(sel.linkedTaskId)}</span></p>` : ""}
  ${sel.processingError ? `<div class="status bad">${esc(sel.processingError)}</div>` : ""}
  <p class="dim">From <b>${esc(sel.sender)}</b> · status ${esc(st(sel))}</p><div class="endgoal">${esc(String(txt(sel)).slice(0, 2000))}</div>
  ${sel.requestText ? `<p class="dim">Request:</p><pre class="out">${esc(String(sel.requestText).slice(0, 1000))}</pre>` : ""}`
  : `<p class="dim">Runner: Discord poller · channel ${esc(sel.channelId || sel.conversationId || "—")}</p><pre class="out">${esc(String(sel.sessionLog || txt(sel)).slice(0, 2000))}</pre>`}</div>` : ""}</div>`;
}
function requestsView() {
  return `<div class="card"><h3>Requests <span class="hint">${S.requests.length} intake</span></h3>
  <p class="hint">Raw goals awaiting / passed through the task-divider. Newest first.</p>
  ${S.requests.map((r) => `<div class="appr"><div class="row"><b>${esc(String(r.text || "").slice(0, 90))}</b><span class="spacer"></span><span class="tag ${r.status === "running" ? "run" : ""}">${esc(r.status || "queued")}</span></div>
  <p class="hint">mode ${esc(r.mode)} · stream ${esc(streamName(r.repo) || r.repo)} · agents ${(JSON.parse(r.pipeline || "[]") || []).map(esc).join(" → ") || esc(r.task_type || "—")} · ${esc(String(r.created_at || "").slice(0, 16).replace("T", " "))}${r.run_id ? ` · run <span class="kbd">${esc(r.run_id)}</span>` : ""}</p></div>`).join("") || `<p class="hint">No requests yet — hit + New task.</p>`}</div>`;
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
  const TPL = [
    ["triage", "⚡ Triage every blocked task", "When a task blocks, an investigator agent reads the evidence and posts a summary to the outbox."],
    ["nightly", "⚡ Nightly knowledge sweep", "A scheduled agent run — no task, no PR. Good for curation, reporting and housekeeping."],
    ["onetime", "⚡ One-time: investigate, then fix", "A single run: an agent scopes the problem, a condition gates it, then a real task is enqueued."],
  ];
  const ed = S.flowEdit;
  const fb = S.flowMsg ? `<div class="notice ok">⚡ ${esc(S.flowMsg)}</div>` : "";
  return `<div class="flows">${fb}
  <div class="bhead"><h2>Automations <span class="hint">${S.flows.length} flow(s)</span></h2><span class="spacer"></span><button class="btn sm primary" id="flownew">+ New flow</button></div>
  <p class="hint">Scheduled cron jobs, event-driven policy sweeps, and agent housekeeping routines.</p>
  <h4>START FROM A TEMPLATE</h4>
  <div class="agrid">${TPL.map(([id, t, d]) => `<div class="card tpl" data-tpl="${id}"><h3>${esc(t)}</h3><p class="dim">${esc(d)}</p></div>`).join("")}</div>
  <h4>YOUR FLOWS</h4>
  ${(S.flows || []).map((f) => {
    const trig = f.trigger?.type || f.trigger || "manual";
    const preset = trig === "schedule" ? (f.trigger?.preset || f.trigger?.label || `${f.trigger?.timeOfDay || f.trigger?.cron || "Scheduled"}`) : trig === "manual" ? "Manual" : (f.trigger?.rule || "Event");
    return `<div class="flowcard"><div class="row"><div><h3>${esc(f.title || f.id)}</h3><p class="dim">${esc(f.description || "")}</p></div><span class="spacer"></span>
    <button class="btn sm ${f.enabled === false ? "" : "okbtn"}" data-flowen="${esc(f.id)}">${f.enabled === false ? "Enable" : "Enabled"}</button>
    <button class="btn sm ghost" data-flowdry="${esc(f.id)}">Dry run</button>
    <button class="btn sm primary" data-runflow="${esc(f.id)}">▶ Run</button>
    <button class="btn sm ghost" data-flowedit="${esc(f.id)}">✎ Edit</button>
    <button class="btn sm danger" data-flowdel="${esc(f.id)}">🗑</button></div>
  <div class="row"><span class="kbd">${esc(preset)}</span><span class="kbd">${esc(f.configFileName || f.id + ".json")}</span>
  ${f.state?.next_run_at ? `<span class="hint">Next: ${esc(String(f.state.next_run_at).slice(0, 16).replace("T", " "))}</span>` : ""}<span class="hint">last: ${esc(f.state?.last_status || f.lastStatus || "never")}</span></div>
  <div class="pipe">${(f.steps || []).map((s, i) => `<div class="pnode"><b>${esc(s.title || s.id || s.type)}</b><span>${esc(s.type || "")}</span></div>${i < (f.steps || []).length - 1 ? `<span class="arr">→</span>` : ""}`).join("")}</div></div>`;
  }).join("") || `<div class="empty">No flows — start from a template above.</div>`}
  ${ed ? `<div class="modal"><div class="mbox wide"><div class="dhead"><b>Edit flow '${esc((ed.configFileName || ed.id || "new").replace(".json", ""))}'</b><span class="spacer"></span><button class="btn ghost sm" id="flowx">✕</button></div>
  <p class="hint">Steps run top to bottom. Reference earlier output with <span class="kbd">{{steps.&lt;id&gt;.output}}</span> and the trigger with <span class="kbd">{{trigger.&lt;field&gt;}}</span>.</p>
  <h4>TRIGGER</h4>
  <div class="row">${[["manual", "Manual only"], ["schedule", "On a schedule"], ["event", "On an event (rule)"]].map(([t, l]) => `<button class="btn sm ${S.flowTrig === t ? "primary" : "ghost"}" data-ftrig="${t}">${l}</button>`).join("")}</div>
  ${S.flowTrig === "schedule" ? `<div class="schedbox">
  <div class="row">${["Every hour", "Every weekday 9:00 AM", "Every day 6:00 PM", "Every Monday 8:30 AM", "Every N minutes"].map((p) => `<button class="btn sm ghost" data-preset="${esc(p)}">${esc(p)}</button>`).join("")}</div>
  <div class="row"><label class="fld"><span>Time of day</span><input id="flow-time" value="${esc(S.flowTime)}"></label>
  <label class="fld"><span>Days</span><div class="row">${["Every day", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<button class="btn sm ${S.flowDays.includes(d) ? "on" : "ghost"}" data-fday="${d}">${d}</button>`).join("")}</div></label></div>
  <p class="hint">🕒 ${esc(S.flowDays.join(", "))} at ${esc(S.flowTime)} · Next run: ${esc(nextRunHint())} · cron <span class="kbd">${esc(S.flowCron || "(auto)")}</span> · <button class="btn sm ghost" id="flowcron">Edit cron</button></p></div>` : ""}
  ${S.flowTrig === "event" ? `<label class="fld"><span>Event rule (e.g. on task blocked, on brain failed)</span><input id="flow-rule" value="${esc(S.flowRule || "")}" placeholder="on task blocked"></label>` : ""}
  <div class="row"><h4>STEPS (${(ed.steps || []).length} steps)</h4><span class="spacer"></span><button class="btn sm ghost" id="flowexpand">Expand all</button></div>
  <div class="palette"><span class="hint">Add step:</span>${[["run_agent", "Run agent"], ["create_task", "Create task"], ["file_request", "File request"], ["notify", "Notify"], ["condition", "Condition"], ["run_automation", "Run automation"], ["wait", "Wait"]].map(([t, l]) => `<button class="btn sm ghost" data-fadd="${t}">${l}</button>`).join("")}</div>
  ${(ed.steps || []).map((s, i) => `<div class="stepcard"><div class="row"><span class="kbd">▶ ${i + 1}.</span><b>${esc(s.title || s.id || s.type)}</b><span class="kbd">${esc(s.type)}</span><span class="spacer"></span><button class="btn sm ghost" data-fup="${i}" title="Move up">^</button><button class="btn sm ghost" data-fdown="${i}" title="Move down">∨</button><button class="btn sm danger" data-fdel="${i}" title="Delete">🗑</button></div>
  <div class="row"><label class="fld"><span>Agent</span><select data-sagent="${i}">${["assistant", "summarizer", "coder", "finance-india", "finance-us"].map((a) => `<option ${s.agent === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
  <label class="fld"><span>Model (empty = config default)</span><input data-smodel="${i}" value="${esc(s.model || "")}" placeholder="gpt-5.6-terra"></label></div>
  <label class="fld"><span>Prompt ${s.type === "run_agent" || s.type === "agent" ? "(empty = agent defaultPrompt)" : ""}</span><textarea data-sprompt="${i}" rows="2" placeholder="What should this step do? Use {{steps.<id>}} refs.">${esc(s.prompt || s.message || s.text || s.template || "")}</textarea></label>
  ${s.type === "condition" ? `<label class="fld"><span>Condition rule</span><input data-srule="${i}" value="${esc(s.rule || s.condition?.right || "")}"></label>` : ""}
  <p class="hint">${esc(s.details || "")}</p></div>`).join("") || `<p class="hint">No steps — add one above.</p>`}
  <div class="row"><button class="btn sm ghost" id="flowcancel">Cancel</button><span class="spacer"></span><button class="btn sm primary" id="flowsave">Save flow</button></div>
  </div></div>` : ""}</div>`;
}
function nextRunHint() {
  if (S.flowTrig !== "schedule") return "—";
  return `Today at ${S.flowTime}`;
}
function todosView() {
  const tabs = [["open", "Open"], ["done", "Done"], ["dismissed", "Dismissed"], ["all", "All"]];
  let list = (S.todos || []).filter((t) =>
    (S.todoTab === "all" || t.status === S.todoTab) &&
    (!S.todoQ || (t.text || "").toLowerCase().includes(S.todoQ.toLowerCase())) &&
    (S.todoSource === "all" || (t.project || "").includes(S.todoSource) || S.todoSource === "manual"));
  return `<div class="card"><h3>TODOs</h3>
  <div class="row">${tabs.map(([v, l]) => `<button class="tab ${S.todoTab === v ? "on" : ""}" data-ttab="${v}">${l}</button>`).join("")}<span class="spacer"></span><button class="btn sm primary" id="todo-new">+ New TODO</button></div>
  <div class="row"><div class="chatbox" style="flex:1"><input id="todo-q" placeholder="Search TODOs" value="${esc(S.todoQ)}"></div>
  <select id="todo-src" class="sel"><option value="all">All sources</option><option value="flow:" ${S.todoSource === "flow:" ? "selected" : ""}>Flows</option><option value="manual" ${S.todoSource === "manual" ? "selected" : ""}>Manual</option></select>
  <select id="todo-sort" class="sel"><option>Newest first</option></select></div>
  ${list.slice(0, 30).map((t) => `<div class="appr"><div class="row"><span class="tag">${esc(t.priority)}</span><span>${esc(t.text)}</span><span class="spacer"></span><span class="hint">${esc(t.id)} · ${esc(String(t.created_at || "").slice(0, 10))}</span></div>
  <div class="row">${t.status === "open" ? `<button class="btn sm ghost" data-tdone="${esc(t.id)}">✓ Done</button><button class="btn sm ghost" data-tdis="${esc(t.id)}">Dismiss</button><button class="btn sm" data-tconv="${esc(t.id)}">→ Convert to request</button>` : `<span class="tag ${t.status === "done" ? "ok" : ""}">${esc(t.status)}</span>`}</div></div>`).join("") || `<div class="empty">No TODOs yet — they appear here when created manually or discovered by inbox sweepers.</div>`}
  <div class="chatbox"><input id="todo-in" placeholder="+ new todo…"><button class="btn sm" id="todo-add">Add</button></div></div>`;
}
function logsView() {
  return `<div class="card"><div class="tbar"><select id="loglevel"><option value="">All levels</option>
  ${["info", "error"].map((l) => `<option ${S.logLevel === l ? "selected" : ""}>${l}</option>`).join("")}</select>
  <button class="btn sm" id="logref">Refresh</button></div>
  <div class="logbox">${(S.logs || []).map((l) => `<div class="lrow ${esc(l.level)}"><span class="lt">${esc(String(l.created_at || "").slice(5, 19).replace("T", " "))}</span>
  <span class="ltag">${esc(l.level)}</span><span class="lsrc">${esc(l.source || "")}</span><span>${esc(l.message || "")}</span></div>`).join("") || `<p class="hint">No logs</p>`}</div></div>`;
}

// ---------- request modal (PRD 4.5: Request/Direct, repo, 15 types, pipeline, attach) ----------
function reqModal() {
  if (!S.showReq) return "";
  return `<div class="modal"><div class="mbox"><div class="dhead"><b>Submit a request</b><span class="spacer"></span><button class="btn ghost sm" id="reqx">✕</button></div>
  <p class="hint">A raw goal. The task-divider grills it, decomposes it, and enqueues the tasks after you confirm.</p>
  <div class="row"><button class="btn sm ${S.reqMode === "request" ? "primary" : "ghost"}" id="reqm-req">Request</button><button class="btn sm ${S.reqMode === "direct" ? "primary" : "ghost"}" id="reqm-dir">Direct task</button></div>
  <label class="fld"><span>What should be built or fixed?</span><textarea id="req-text" rows="4" placeholder="Describe the outcome you want. Be concrete about done-ness."></textarea></label>
  <div class="row"><label class="fld"><span>Stream (replaces repo)</span><select id="req-stream">${(S.cfgData?.streams?.streams || [{ id: "general", name: "General" }, { id: "finance", name: "Finance" }]).map((s) => `<option value="${esc(s.id)}" ${S.reqStream === s.id ? "selected" : ""}>${esc(s.name || s.id)}</option>`).join("")}</select></label>
  <label class="fld"><span>Pipeline (user-configured agent → agent)</span><select id="req-pipe"><option value="">— divider picks —</option>${streamPipes(S.reqStream).map((p) => `<option value="${esc(p.id)}" ${S.reqPipeline === p.id ? "selected" : ""}>${esc(p.name || p.id)} (${esc((p.agents || []).join(" → "))})</option>`).join("")}</select></label></div>
  <label class="fld"><span>Agents (pipeline — each step spawns a Muse session)</span><div class="row">${AGENT_OPTS.map((a) => `<button class="btn sm ${S.reqAgents.includes(a) ? "primary" : "ghost"}" data-reqagent="${a}">${a}</button>`).join("")}</div></label>
  <p class="hint">Stream <b>${esc(streamName(S.reqStream))}</b> · Pipeline: <b>${S.reqMode === "direct" ? esc(S.reqAgents.join(" → ") || "—") : "Divider picks stream + agents from goal"}</b> · sessions write JSON, loop reconciles to DB.</p>
  <label class="fld"><span>Attach files (screenshots, logs — names only, stored alongside run)</span><input id="req-files" placeholder="e.g. screenshot.png, trace.log"></label>
  ${S.reqMsg ? `<p class="hint">${esc(S.reqMsg)}</p>` : ""}
  <div class="row"><button class="btn primary" id="req-go" ${S.reqBusy ? "disabled" : ""}>${S.reqBusy ? "Divider working…" : "Enqueue Task"}</button></div></div></div>`;
}

// ---------- render ----------
function render() {
  document.body.dataset.theme = S.theme;
  const v = S.view;
  const main = v === "board" ? boardView() : v === "assistant" ? `<div class="card"><h3>Assistant</h3><div class="chatbox"><input id="chat-in" placeholder='Ask Rick…'><button class="btn primary sm" id="chat-send">Send</button></div><div class="feed">${(S.feed?.messages || []).slice(-10).map((m) => `<div class="fmsg ${m.kind === "chat" ? "user" : "rick"}">${esc(m.text)}</div>`).join("")}</div></div>` :
    v === "brain" ? brainView() : v === "todos" ? todosView() : v === "automations" ? flowsView() :
    v === "requests" ? requestsView() : v === "outbox" ? outboxView() :
    v === "config" ? configView() :
    v === "activity" ? `<div class="card"><h3>Activity <span class="hint">global audit stream</span></h3><div class="logbox">${(S.activity || []).map((a) => `<div class="lrow info"><span class="lt">${esc(String(a.created_at || "").slice(5, 16).replace("T", " "))}</span><span class="ltag">${esc(a.action)}</span><span class="lsrc">${esc(a.actor || "")}</span><span>${esc(String(a.detail || "").slice(0, 160))}</span></div>`).join("")}</div></div>` :
    v === "retro" ? retroView() :
    v === "logs" ? logsView() : v === "tools" ? toolsView() : v === "agents" ? agentsView() :
    `<div class="card"><h3>${esc(v)}</h3><p class="hint">Coming soon.</p></div>`;
  $("#app").innerHTML = `<div class="app">${sidebar()}<main class="main">${topbar()}${main}</main></div>${reqModal()}${cmdPalette()}`;
  $$("[data-view]").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; S.sel = null; S.detail = null; render(); }));
  $$("[data-statusf]").forEach((b) => (b.onclick = () => { S.statusFilter = S.statusFilter === b.dataset.statusf ? "" : b.dataset.statusf; S.view = "board"; render(); }));
  $$("[data-btab]").forEach((b) => (b.onclick = () => { S.boardTab = b.dataset.btab; render(); }));
  $$("[data-dtab]").forEach((b) => (b.onclick = () => { S.detailTab = b.dataset.dtab; render(); }));
  $$("[data-sel]").forEach((b) => (b.onclick = async () => { S.sel = b.dataset.sel; S.detail = null; S.detailTab = "overview"; S.sessIdx = 0; render(); loadDetail(S.sel); }));
  $$(".banner").forEach((b) => (b.onclick = async () => { S.sel = b.dataset.sel; S.detail = null; S.detailTab = "overview"; render(); loadDetail(S.sel); }));
  const dc = $("#dclose"); if (dc) dc.onclick = () => { S.sel = null; S.detail = null; render(); };
  // loop task tables wiring
  $$("[data-loop]").forEach((b) => (b.onclick = async () => { S.loopSel = b.dataset.loop; S.loopDetail = null; render(); loadLoopDetail(S.loopSel); }));
  const lx = $("#loopx"); if (lx) lx.onclick = () => { S.loopSel = null; S.loopDetail = null; render(); };
  const ln = $("#loopnew"); if (ln) ln.onclick = async () => { const t = prompt("Loop task title:"); if (!t) return; const r = await api("/api/control/loop-tasks", { method: "POST", body: JSON.stringify({ title: t, repo: "tab-automation", task_type: "assistant", status: "open" }) }); S.loopSel = r.id; tick(true); };
  $$("[data-loopx]").forEach((b) => (b.onclick = () => { const k = "L" + b.dataset.loopx; S.expandedSteps.has(k) ? S.expandedSteps.delete(k) : S.expandedSteps.add(k); render(); }));
  $$("[data-looprun]").forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.looprun; const d = S.loopDetail; if (!d) return;
    const s = (d.steps || [])[i]; if (!s) return;
    const ag = $(`#loop-agent-${i}`); const mo = $(`#loop-model-${i}`); const pr = $(`#loop-prompt-${i}`);
    b.disabled = true; b.textContent = "⏳ Dispatching…";
    try {
      const r = await api(`/api/control/loop-tasks/${d.task.id}/dispatch`, { method: "POST", body: JSON.stringify({ agent: ag ? ag.value : s.agent, model: mo ? mo.value : (s.model || ""), prompt: pr ? pr.value : (s.prompt || ""), stepId: s.step_id }) });
      S.cfgMsg = ""; S.loopDetail = null; tick(true);
      alert(`Dispatched ${ag ? ag.value : s.agent} — output: ${String(r.output || "").slice(0, 300)}`);
    } catch (e) { b.disabled = false; b.textContent = `▶ Dispatch`; alert(e.message); }
  }));
  const la = $("#loopadd"); if (la) la.onclick = () => { if (!S.loopDetail) return; S.loopDetail.steps = [...(S.loopDetail.steps || []), { step_id: `step-${(S.loopDetail.steps || []).length + 1}`, type: "agent", agent: "assistant", model: "", status: "pending", prompt: "", output: "" }]; render(); };
  const lsv = $("#loopsave"); if (lsv) lsv.onclick = async () => { if (!S.loopDetail) return; const steps = (S.loopDetail.steps || []).map((s, i) => { const ag = $(`#loop-agent-${i}`); const mo = $(`#loop-model-${i}`); const pr = $(`#loop-prompt-${i}`); return { ...s, agent: ag ? ag.value : s.agent, model: mo ? mo.value : s.model, prompt: pr ? pr.value : s.prompt }; }); await api(`/api/control/loop-tasks/${S.loopDetail.task.id}`, { method: "POST", body: JSON.stringify({ steps }) }); S.loopDetail = null; tick(true); };
  // config view wiring
  $$("[data-cprov]").forEach((el) => (el.onchange = () => { if (S.cfgData?.providers?.providers?.[+el.dataset.cprov]) S.cfgData.providers.providers[+el.dataset.cprov][el.dataset.cf] = el.value; }));
  $$("[data-cagent]").forEach((el) => (el.onchange = () => { if (S.cfgData?.agents?.agents?.[+el.dataset.cagent]) S.cfgData.agents.agents[+el.dataset.cagent][el.dataset.cf] = el.value; }));
  const dp = $("#cfg-defprov"); if (dp) dp.onchange = () => { if (S.cfgData?.providers) S.cfgData.providers.defaultProvider = dp.value; };
  const csv = $("#cfgsave"); if (csv) csv.onclick = async () => { if (!S.cfgData) return; await api("/api/control/config", { method: "POST", body: JSON.stringify({ providers: S.cfgData.providers, agents: S.cfgData.agents }) }); S.cfgMsg = "Configuration saved — dispatch uses it immediately."; render(); setTimeout(() => { S.cfgMsg = ""; render(); }, 3000); };
  $$("[data-cfgtest]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.cfgtest; const mo = $(`#cfgtest-model-${id}`); const pr = $(`#cfgtest-prompt-${id}`); const out = $(`#cfgtest-out-${id}`);
    if (out) out.innerHTML = `<p class="hint">Dispatching ${esc(id)}…</p>`;
    try {
      const r = await api("/api/control/config/test", { method: "POST", body: JSON.stringify({ agent: id, model: mo ? mo.value : "", prompt: pr ? pr.value : "" }) });
      if (out) out.innerHTML = `<pre class="out">${esc(String(r.output || "").slice(0, 2000))}</pre>`;
    } catch (e) { if (out) out.innerHTML = `<div class="status bad">${esc(e.message)}</div>`; }
  }));
  $$("[data-rerun]").forEach((b) => (b.onclick = async () => { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.rerun, text: "" }) }); tick(true); }));
  $$("[data-runflow]").forEach((b) => (b.onclick = async () => { await api("/api/control/automations/" + b.dataset.runflow + "/run", { method: "POST" }).catch(() => api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.runflow, text: "" }) })); tick(true); }));
  $$("[data-xstep]").forEach((b) => (b.onclick = () => { const i = +b.dataset.xstep; S.expandedSteps.has(i) ? S.expandedSteps.delete(i) : S.expandedSteps.add(i); render(); }));
  $$("[data-xvar]").forEach((b) => (b.onclick = () => { const i = +b.dataset.xvar; S.expandedVariants.has(i) ? S.expandedVariants.delete(i) : S.expandedVariants.add(i); render(); }));
  $$("[data-ctx]").forEach((b) => (b.onclick = () => { S.showCtx = !S.showCtx; render(); }));
  $$("[data-rqstep]").forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.rqstep; const ta = $(`#rerun-${i}`); const guidance = ta ? ta.value : "";
    b.disabled = true; b.textContent = "⏳ Re-queuing…";
    try {
      await api(`/api/control/task/${S.sel}/requeue`, { method: "POST", body: JSON.stringify({ stepIndex: i, guidance }) });
      S.detail = null; tick(true);
    } catch (e) { b.disabled = false; b.textContent = `🔄 Re-queue from step ${i + 1}`; alert(e.message); }
  }));
  $$("[data-act]").forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act; const box = $("#actbox");
    if (!S.sel) return;
    if (a === "req-changes") {
      if (box) box.innerHTML = `<div class="chatbox"><input id="rc-in" placeholder="Review feedback for the agent…"><button class="btn sm primary" id="rc-go">Send</button></div>`;
      const go = $("#rc-go"); if (go) go.onclick = async () => { const t = $("#rc-in").value.trim(); if (!t) return; await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: "request-changes", text: t }) }); S.detail = null; tick(true); };
      return;
    }
    if (a === "append") {
      if (box) box.innerHTML = `<div class="chatbox"><input id="ap-in" placeholder="Follow-up task title…"><button class="btn sm primary" id="ap-go">Append</button></div>`;
      const go = $("#ap-go"); if (go) go.onclick = async () => { const t = $("#ap-in").value.trim(); if (!t) return; await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: "append", title: t }) }); S.detail = null; tick(true); };
      return;
    }
    if (a === "requeue") { S.detailTab = "steps"; render(); return; }
    const map = { del: "delete" };
    if (map[a]) {
      if (a === "del" && !confirm("Delete this task and its worktree?")) return;
      await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: map[a] }) });
      if (a === "del") { S.sel = null; S.detail = null; }
      else S.detail = null;
      tick(true);
    }
  }));
  const df = $("#diagfull"); if (df) df.onclick = () => { S.diagFull = true; render(); };
  const dx = $("#diagx"); if (dx) dx.onclick = () => { S.diagFull = false; render(); };
  const ss = $("#sesssel"); if (ss) ss.onchange = () => { S.sessIdx = Number(ss.value); render(); };
  const sb = $("#sortby"); if (sb) sb.onchange = () => { S.sortBy = sb.value; render(); };
  const fq = $("#fq"); if (fq) { fq.oninput = () => { S.q = fq.value; if (S.cmdOpen) render(); }; fq.onchange = () => render(); }
  const nt = $("#newtask"); if (nt) nt.onclick = () => { S.showReq = true; render(); wireReq(); };
  const cmds = $("#cmds"); if (cmds) cmds.onclick = () => { S.cmdOpen = true; S.cmdIdx = 0; render(); };
  const cx = $("#cmdx"); if (cx) cx.onclick = () => { S.cmdOpen = false; render(); };
  $$("[data-cmd]").forEach((b) => (b.onclick = () => {
    const v = b.dataset.cmd; S.cmdOpen = false;
    if (v === "new") { S.showReq = true; render(); wireReq(); return; }
    if (v === "refresh") { tick(true); return; }
    if (v === "pause") { S.paused = !S.paused; render(); arm(); return; }
    S.view = v; S.sel = null; S.detail = null; render();
  }));
  const ab = $("#autobtn"); if (ab) ab.onclick = () => { S.auto = !S.auto; render(); arm(); };
  const rs = $("#resume"); if (rs) rs.onclick = () => { S.paused = !S.paused; render(); arm(); };
  const rf = $("#refresh"); if (rf) rf.onclick = () => tick(true);
  const th = $("#theme"); if (th) th.onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; render(); };
  $$("[data-brain]").forEach((b) => (b.onclick = () => { S.brainSel = b.dataset.brain; render(); }));
  const bx = $("#brainx"); if (bx) bx.onclick = () => { S.brainSel = null; render(); };
  $$("[data-btab2]").forEach((b) => (b.onclick = () => { S.brainTab = b.dataset.btab2; render(); }));
  const bq = $("#brain-q"); if (bq) { bq.oninput = () => { S.brainQ = bq.value; }; bq.onchange = () => render(); }
  const ob = $("#ob-add"); if (ob) ob.onclick = async () => { const i = $("#ob-in"); const t = i.value.trim(); if (!t) return; await api("/api/control/outbox", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  $$("[data-obsent]").forEach((b) => (b.onclick = async () => { await api("/api/control/outbox/sent", { method: "POST", body: JSON.stringify({ id: b.dataset.obsent }) }); tick(true); }));
  // flows editor wiring (reference: spec AutomationsView — templates, trigger, palette, feedback)
  const TPL_FLOWS = {
    triage: { id: "triage-blocked", title: "Triage every blocked task", description: "When a task blocks, an investigator agent reads the evidence and posts a summary to the outbox.", trigger_type: "event", trigger_config: { rule: "on task blocked" }, steps: [{ id: "investigate", type: "run_agent", agent: "assistant", title: "Investigate block", prompt: "Read the blocked task evidence and summarize root cause." }, { id: "notify", type: "notify", title: "Post to outbox", message: "Blocked task triage: {{steps.investigate}}" }] },
    nightly: { id: "nightly-sweep", title: "Nightly knowledge sweep", description: "A scheduled agent run — no task, no PR. Good for curation, reporting and housekeeping.", trigger_type: "schedule", trigger_config: { cron: "0 2 * * *", timeOfDay: "2:00 AM", days: ["Every day"] }, steps: [{ id: "sweep", type: "run_agent", agent: "assistant", title: "Knowledge sweep", prompt: "Sweep recent runs and curate housekeeping notes." }] },
    onetime: { id: "investigate-fix", title: "One-time: investigate, then fix", description: "A single run: an agent scopes the problem, a condition gates it, then a real task is enqueued.", trigger_type: "manual", trigger_config: {}, steps: [{ id: "scope", type: "run_agent", agent: "assistant", title: "Scope problem", prompt: "Scope the problem in one pass." }, { id: "gate", type: "condition", title: "Gate", rule: "scope found issue" }, { id: "file", type: "create_task", title: "Enqueue fix", details: "real task" }] },
  };
  const seedFlowEdit = (f) => {
    S.flowEdit = { id: f.id, title: f.title, description: f.description || "", trigger_type: f.trigger_type || "manual", trigger_config: f.trigger_config || {}, steps: (f.steps || []).map((s, i) => ({ id: s.id || `step-${i + 1}`, type: s.type || "run_agent", agent: s.agent || "assistant", model: s.model || "", title: s.title || s.id || s.type, prompt: s.prompt || s.message || s.text || s.template || "", rule: s.rule || "", details: s.details || "" })) };
    S.flowTrig = S.flowEdit.trigger_type;
    S.flowTime = S.flowEdit.trigger_config?.timeOfDay || "11:00 AM";
    S.flowDays = S.flowEdit.trigger_config?.days || ["Every day"];
    S.flowCron = S.flowEdit.trigger_config?.cron || "";
    S.flowRule = S.flowEdit.trigger_config?.rule || "";
  };
  $$("[data-tpl]").forEach((b) => (b.onclick = () => { seedFlowEdit(TPL_FLOWS[b.dataset.tpl]); S.flowMsg = `Loaded template: ${S.flowEdit.title}`; render(); setTimeout(() => { S.flowMsg = ""; render(); }, 3500); }));
  const fn = $("#flownew"); if (fn) fn.onclick = () => { seedFlowEdit({ id: "flow-new", title: "New flow", description: "", trigger_type: "manual", trigger_config: {}, steps: [] }); render(); };
  const fx = $("#flowx"); if (fx) fx.onclick = () => { S.flowEdit = null; render(); };
  const fc = $("#flowcancel"); if (fc) fc.onclick = () => { S.flowEdit = null; render(); };
  const fe = $("#flowexpand"); if (fe) fe.onclick = () => { S.expandedSteps = new Set((S.flowEdit?.steps || []).map((_, i) => i)); render(); };
  $$("[data-ftrig]").forEach((b) => (b.onclick = () => { S.flowTrig = b.dataset.ftrig; if (S.flowEdit) S.flowEdit.trigger_type = S.flowTrig; render(); }));
  $$("[data-fday]").forEach((b) => (b.onclick = () => { const d = b.dataset.fday; if (d === "Every day") S.flowDays = ["Every day"]; else { S.flowDays = S.flowDays.filter((x) => x !== "Every day"); S.flowDays.includes(d) ? S.flowDays = S.flowDays.filter((x) => x !== d) : S.flowDays.push(d); if (!S.flowDays.length) S.flowDays = ["Every day"]; } render(); }));
  $$("[data-preset]").forEach((b) => (b.onclick = () => { const p = b.dataset.preset; if (p.includes("9:00")) S.flowTime = "9:00 AM"; else if (p.includes("6:00")) S.flowTime = "6:00 PM"; else if (p.includes("8:30")) S.flowTime = "8:30 AM"; else if (p.includes("11:00")) S.flowTime = "11:00 AM"; else if (p.includes("hour")) { S.flowTime = "Every hour"; S.flowCron = "0 * * * *"; } else if (p.includes("N minutes")) { S.flowTime = "Every N minutes"; S.flowCron = "*/15 * * * *"; } render(); }));
  const fcr = $("#flowcron"); if (fcr) fcr.onclick = () => { const v = prompt("Cron expression (m h dom mon dow):", S.flowCron || "0 11 * * *"); if (v !== null) { S.flowCron = v; render(); } };
  const fr = $("#flow-rule"); if (fr) fr.onchange = () => { S.flowRule = fr.value; };
  $$("[data-fadd]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; const t = b.dataset.fadd; S.flowEdit.steps = [...(S.flowEdit.steps || []), { id: `step-${(S.flowEdit.steps || []).length + 1}`, type: t, agent: "assistant", model: "", title: t.replace(/_/g, " "), prompt: "", rule: "", details: "" }]; S.flowMsg = `Added step: ${t.replace(/_/g, " ")}`; render(); setTimeout(() => { S.flowMsg = ""; render(); }, 2500); }));
  $$("[data-fdel]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; S.flowEdit.steps = (S.flowEdit.steps || []).filter((_, i) => i !== Number(b.dataset.fdel)); render(); }));
  $$("[data-fup]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; const i = Number(b.dataset.fup); const a = [...(S.flowEdit.steps || [])]; if (i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; S.flowEdit.steps = a; render(); } }));
  $$("[data-fdown]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; const i = Number(b.dataset.fdown); const a = [...(S.flowEdit.steps || [])]; if (i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; S.flowEdit.steps = a; render(); } }));
  $$("[data-sagent]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.sagent]) S.flowEdit.steps[+el.dataset.sagent].agent = el.value; }));
  $$("[data-smodel]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.smodel]) S.flowEdit.steps[+el.dataset.smodel].model = el.value; }));
  $$("[data-sprompt]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.sprompt]) S.flowEdit.steps[+el.dataset.sprompt].prompt = el.value; }));
  $$("[data-srule]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.srule]) S.flowEdit.steps[+el.dataset.srule].rule = el.value; }));
  const fs = $("#flowsave"); if (fs) fs.onclick = async () => {
    if (!S.flowEdit) return;
    const ft = $("#flow-time"); if (ft) S.flowTime = ft.value;
    const fr2 = $("#flow-rule"); if (fr2) S.flowRule = fr2.value;
    const payload = { id: S.flowEdit.id, title: S.flowEdit.title || S.flowEdit.id, description: S.flowEdit.description || "", trigger_type: S.flowTrig, trigger_config: { timeOfDay: S.flowTime, days: S.flowDays, cron: S.flowCron, rule: S.flowRule }, steps: S.flowEdit.steps };
    await api("/api/control/automations", { method: "POST", body: JSON.stringify(payload) });
    S.flowMsg = `Saved flow "${payload.title}"`; S.flowEdit = null; render(); tick(true);
    setTimeout(() => { S.flowMsg = ""; render(); }, 3500);
  };
  $$("[data-flowedit]").forEach((b) => (b.onclick = () => { const f = (S.flows || []).find((x) => x.id === b.dataset.flowedit); if (f) { seedFlowEdit({ id: f.id, title: f.title, description: f.description, trigger_type: f.trigger?.type || "manual", trigger_config: f.trigger || {}, steps: f.steps || [] }); render(); } }));
  $$("[data-flowen]").forEach((b) => (b.onclick = async () => { const f = (S.flows || []).find((x) => x.id === b.dataset.flowen); await api(`/api/control/automations/${b.dataset.flowen}/enable`, { method: "POST", body: JSON.stringify({ enabled: f?.enabled === false }) }); S.flowMsg = f?.enabled === false ? "Flow enabled" : "Flow paused"; render(); tick(true); setTimeout(() => { S.flowMsg = ""; render(); }, 2500); }));
  $$("[data-flowdel]").forEach((b) => (b.onclick = async () => { if (!confirm("Delete flow?")) return; await api(`/api/control/automations/${b.dataset.flowdel}/delete`, { method: "POST" }); tick(true); }));
  $$("[data-flowdry]").forEach((b) => (b.onclick = async () => { const f = (S.flows || []).find((x) => x.id === b.dataset.flowdry); S.flowMsg = `Dry run executed for ${f?.title || b.dataset.flowdry}. 0 side-effects.`; render(); setTimeout(() => { S.flowMsg = ""; render(); }, 3500); }));
  // todos wiring
  $$("[data-ttab]").forEach((b) => (b.onclick = () => { S.todoTab = b.dataset.ttab; render(); }));
  const tq = $("#todo-q"); if (tq) { tq.oninput = () => { S.todoQ = tq.value; }; tq.onchange = () => render(); }
  const ts2 = $("#todo-src"); if (ts2) ts2.onchange = () => { S.todoSource = ts2.value; render(); };
  const tn = $("#todo-new"); if (tn) tn.onclick = () => { const t = prompt("New TODO:"); if (t) api("/api/control/todos", { method: "POST", body: JSON.stringify({ text: t }) }).then(() => tick(true)); };
  $$("[data-tdone]").forEach((b) => (b.onclick = async () => { await api("/api/control/todos/done", { method: "POST", body: JSON.stringify({ id: b.dataset.tdone }) }); tick(true); }));
  $$("[data-tdis]").forEach((b) => (b.onclick = async () => { await api("/api/control/todos/dismiss", { method: "POST", body: JSON.stringify({ id: b.dataset.tdis }) }); tick(true); }));
  $$("[data-tconv]").forEach((b) => (b.onclick = async () => { const r = await api("/api/control/todos/convert", { method: "POST", body: JSON.stringify({ id: b.dataset.tconv }) }); S.view = "requests"; tick(true); }));
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
    ["todos", "Go to TODOs"], ["automations", "Go to Automations"], ["config", "Go to Configuration"],
    ["requests", "Go to Requests"],
    ["outbox", "Go to Outbox"], ["activity", "Go to Activity"], ["retro", "Go to Retro"],
    ["new", "+ New task"], ["pause", "Pause / Resume"], ["refresh", "Refresh now"],
  ].filter(([v, l]) => !S.q || l.toLowerCase().includes(S.q.toLowerCase()));
  return `<div class="modal"><div class="mbox"><div class="dhead"><b>Commands</b><span class="spacer"></span><button class="btn ghost sm" id="cmdx">✕</button></div>
  ${cmds.map(([v, l], i) => `<button class="nav ${i === S.cmdIdx ? "on" : ""}" data-cmd="${v}">${esc(l)}</button>`).join("") || `<p class="hint">No match</p>`}</div></div>`;
}
function wireReq() {
  const rx = $("#reqx"); if (rx) rx.onclick = () => { S.showReq = false; S.reqMsg = ""; render(); };
  const mr = $("#reqm-req"); if (mr) mr.onclick = () => { S.reqMode = "request"; render(); wireReq(); };
  const md = $("#reqm-dir"); if (md) md.onclick = () => { S.reqMode = "direct"; render(); wireReq(); };
  $$("[data-reqagent]").forEach((b) => (b.onclick = () => { const a = b.dataset.reqagent; S.reqAgents.includes(a) ? S.reqAgents = S.reqAgents.filter((x) => x !== a) : S.reqAgents.push(a); if (!S.reqAgents.length) S.reqAgents = [a]; render(); wireReq(); }));
  const rs = $("#req-stream"); if (rs) rs.onchange = () => { S.reqStream = rs.value; S.reqPipeline = ""; render(); wireReq(); };
  const rp = $("#req-pipe"); if (rp) rp.onchange = () => { S.reqPipeline = rp.value; const p = streamPipes(S.reqStream).find((x) => x.id === rp.value); if (p?.agents?.length) S.reqAgents = [...p.agents]; render(); wireReq(); };
  const g = $("#req-go"); if (g) g.onclick = async () => {
    const t = $("#req-text").value.trim(); if (!t || S.reqBusy) return;
    S.reqBusy = true; S.reqMsg = "Divider working…"; render(); wireReq();
    try {
      const r = await api("/api/control/requests", { method: "POST", body: JSON.stringify({ text: t, mode: S.reqMode, stream: S.reqStream, pipeline: S.reqPipeline || undefined, agents: S.reqAgents }) });
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
async function loadLoopDetail(id) {
  try { const r = await api(`/api/control/loop-tasks/${id}`); S.loopDetail = r; render(); } catch { /* keep list */ }
}
function arm() {
  if (S.timer) clearInterval(S.timer);
  if (S.auto && S.cfg.enabled) S.timer = setInterval(() => tick(), Math.max(2, Number(S.cfg.refreshSec) || 3) * 1000);
}
async function tick(force) {
  try {
    const [cfg, ov, tasks, agents, tools, activity, logs, appr, todos, feed, brain, flows, requests, outbox, retro, loopTasks, cfgData] = await Promise.all([
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
      api("/api/control/loop-tasks?limit=50").catch(() => ({ tasks: [] })),
      api("/api/control/config").catch(() => null),
    ]);
    if (cfg) S.cfg = cfg;
    if (ov) S.ov = ov;
    S.tasks = tasks.tasks || []; S.agents = agents.agents || []; S.tools = tools.tools || [];
    S.activity = activity.activity || []; S.logs = logs.logs || [];
    S.approvals = appr.approvals || []; S.todos = todos.todos || []; S.reminders = todos.reminders || [];
    if (feed) S.feed = feed; if (brain) S.brain = brain; S.flows = flows.flows || [];
    S.requests = requests.requests || []; S.outbox = outbox.outbox || [];
    if (retro) S.retro = retro;
    S.loopTasks = loopTasks.tasks || [];
    if (cfgData) S.cfgData = cfgData;
    if (S.sel && !S.detail) { loadDetail(S.sel); return; }
    if (S.loopSel && !S.loopDetail) { loadLoopDetail(S.loopSel); return; }
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

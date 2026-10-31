// Board shell: tab switcher + delegates to task / automation-runs / loop views.
// Pure render functions — state + events live in main.js.
import { S, esc, ago, statusBadge, AGENT_OPTS, displayTitle, kindLabel, isAutomationRun, needsAttention, failedLast24h, sessionProvenance } from "./state.js";
import { attentionBanners } from "./shell.js";
import { pageHead, statRow, emptyState, toolbar, searchBox, selectBox, icon } from "./ui.js";
import { tasksView, automationRunsView } from "./tasks.js";

const matchesQ = (r, q) => !q || ((r.title || "") + " " + (r.workflow || "") + " " + (r.branch || "") + " " + r.id + " " + (r.repository || "") + " " + (r.kind || "")).toLowerCase().includes(q);

const applyStatusFilter = (list) => {
  if (S.statusFilter === "Blocked") return list.filter((r) => r.status === "failed" || r.blockedReason);
  if (S.statusFilter === "Running") return list.filter((r) => r.status === "running");
  if (S.statusFilter === "Done") return list.filter((r) => r.status === "done");
  if (S.statusFilter === "Queued") return list.filter((r) => r.status === "queued");
  if (S.statusFilter === "Failed 24h") return list.filter((r) => failedLast24h(r));
  return list;
};

const sortRuns = (list) => {
  if (S.sortBy === "recent") return [...list].sort((a, b) => String(b.startedAt || b.created_at || "").localeCompare(String(a.startedAt || a.created_at || "")));
  return [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
};

export function boardView() {
  const q = (S.q || "").toLowerCase();
  const lt = (S.loopTasks || []).filter((t) =>
    !q || ((t.title || "") + " " + (t.repo || "") + " " + t.id + " " + (t.task_type || "")).toLowerCase().includes(q));
  const all = (S.tasks || []).filter((r) => matchesQ(r, q));
  const list = sortRuns(applyStatusFilter(all));
  const lsel = S.loopDetail;
  const stale = S.stale ? `<div class="notice" role="status">Bot is thinking (Muse session running) — showing last loaded data. Auto-refresh resumes when it responds.</div>` : "";
  const counts = {
    attention: all.filter(needsAttention).length,
    tasks: all.filter((r) => !isAutomationRun(r)).length,
    runs: all.filter(isAutomationRun).length,
  };
  const head = S.boardTab === "runs" ? [`Automation runs`, `${counts.runs} scheduled runs`]
    : S.boardTab === "loop" ? [`Loop tasks`, `${lt.length} tasks`]
    : S.boardTab === "attention" ? [`Needs attention`, `${counts.attention} items`]
    : [`Tasks`, `${counts.tasks} runs`];
  const tabs = [["attention", `Needs attention${counts.attention ? ` (${counts.attention})` : ""}`, "octagon-alert"], ["tasks", "Tasks", "list"], ["runs", "Automation runs", "workflow"], ["loop", "Loop tasks", "repeat"]];
  const tabBar = `<div class="btabs" role="tablist" aria-label="Board view">${tabs.map(([v, l, ic]) => `<button type="button" role="tab" aria-selected="${S.boardTab === v}" class="tab ${S.boardTab === v ? "on" : ""}" data-btab="${v}">${icon(ic)} ${l}</button>`).join("")}</div>`;
  const filters = (S.boardTab === "tasks" || S.boardTab === "attention") ? toolbar(
    searchBox("fq2", S.q, "Filter runs…") +
    selectBox("kindf", [["all", "All origins"], ["discord", "Discord"], ["automation", "Automation"], ["control room", "Control Room"], ["assistant", "Assistant"], ["manual", "Manual"]], S.kindFilter || "all", "Filter by origin") +
    selectBox("sortby", [["recent", "Recent activity"], ["id", "By Task ID"]], S.sortBy, "Sort tasks")) : "";
  return `
  ${attentionBanners()}
  ${stale}
  ${pageHead(head[0], head[1], S.boardTab === "tasks" || S.boardTab === "attention" ? `<button type="button" class="btn sm primary" id="newtask2">${icon("plus")} New task</button>` : "")}
  ${tabBar}
  ${filters}
  ${S.boardTab === "loop" ? loopTasksView(lt, lsel) : S.boardTab === "runs" && !S.sel ? automationRunsView() : tasksView(list, detailPane)}`;
}

export function loopTasksView(lt, lsel) {
  if (lsel) return loopDetailPane(lsel);
  // No aria-label on the card buttons: visible card text already IS the
  // accessible name (axe label-content-name-mismatch otherwise).
  return `<div class="blist single" role="group" aria-label="Loop tasks">
    <button type="button" class="btn sm primary" id="loopnew">+ New loop task</button>
    ${S.loopForm ? `<div class="appr" role="dialog" aria-label="New loop task"><label class="fld"><span>Loop task title</span><input id="loop-title" value="${esc(S.loopForm.title || "")}" placeholder="What should this loop do?"></label><div class="row"><button type="button" class="btn sm primary" id="loopcreate">Create</button><button type="button" class="btn sm ghost" id="loopcancel">Cancel</button></div></div>` : ""}
    ${lt.map((t) => `<button type="button" class="bcard ${S.loopSel === t.id ? "sel" : ""}" data-loop="${esc(t.id)}" aria-current="${S.loopSel === t.id}">
      <span class="btop">${statusBadge(t.status === "open" ? "queued" : t.status)} <span class="hint">#${esc(t.id.slice(0, 6))}</span><span class="spacer"></span><span class="hint">${ago(t.updated_at)}</span></span>
      <span class="btitle">${esc((t.title || "").slice(0, 100))}</span>
      <span class="bmeta"><span class="kbd">${esc(t.repo || "")}</span><span class="kbd">${esc(t.task_type || "")}</span><span class="kbd">branch ${esc((t.branch || "").slice(0, 30))}</span></span>
      <span class="bmeta"><span class="hint">progress ${t.progress || 0}%</span>${t.tokens ? `<span class="hint">${Number(t.tokens).toLocaleString()} tokens</span>` : ""}${t.tool_calls ? `<span class="hint">${t.tool_calls} tool calls</span>` : ""}</span>
    </button>`).join("") || `<div class="empty" role="status">No loop tasks yet — create one above.</div>`}
  </div>`;
}

export function loopDetailPane(d) {
  const steps = d.steps || [];
  const backBtn = `<button type="button" class="btn ghost sm" id="loopback" aria-label="Back to loop tasks">← Back</button>`;
  return `<div class="dhead">${backBtn}<span class="mono">#${esc(String(d.task.id).slice(0, 6))}</span> ${statusBadge(d.task.status === "open" ? "queued" : d.task.status)}<span class="spacer"></span><button type="button" class="btn ghost sm" id="loopx" aria-label="Close loop task">Close</button></div>
  <div class="dtitle">${esc(d.task.title)}</div>
  <div class="endgoal">${esc(d.task.end_goal || "No end goal.")}</div>
  <div class="row"><span class="kbd">${esc(d.task.repo)}</span><span class="kbd">${esc(d.task.task_type)}</span><span class="kbd">branch ${esc(d.task.branch)}</span></div>
  <h4>STEPS TABLE (${steps.length})</h4>
  <div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">#</th><th scope="col">Step</th><th scope="col">Type</th><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>
  ${steps.map((s, i) => `<tr><td>${i + 1}</td><td><b>${esc(s.step_id)}</b></td><td>${esc(s.type)}</td><td>${esc(s.agent)}</td><td class="dim">${esc(s.model || "default")}</td><td>${statusBadge(s.status === "ok" ? "done" : s.status)}</td>
  <td><button type="button" class="btn sm ghost" data-loopx="${i}" aria-expanded="${S.expandedSteps.has("L" + i)}" aria-label="${S.expandedSteps.has("L" + i) ? "Collapse" : "Expand"} step ${i + 1}">${S.expandedSteps.has("L" + i) ? "Collapse" : "Expand"}</button></td></tr>
  ${S.expandedSteps.has("L" + i) ? `<tr><td colspan="7"><p class="dim">Prompt:</p><pre class="out">${esc((s.prompt || "").slice(0, 2000))}</pre>${s.output ? `<p class="dim">Output:</p><pre class="out">${esc(String(s.output).slice(0, 2000))}</pre>` : ""}
  <div class="row"><label class="fld"><span>Agent</span><select id="loop-agent-${i}">${AGENT_OPTS.map((a) => `<option ${s.agent === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
  <label class="fld"><span>Model (empty = config default)</span><input id="loop-model-${i}" value="${esc(s.model || "")}" placeholder="gpt-5.6-terra"></label></div>
  <label class="fld"><span>Prompt (empty = agent defaultPrompt)</span><textarea id="loop-prompt-${i}" rows="2">${esc(s.prompt || "")}</textarea></label>
  <div class="row"><button type="button" class="btn sm primary" data-looprun="${i}">Dispatch ${esc(s.agent || "agent")}</button></div></td></tr>` : ""}`).join("") || `<tr><td colspan="7" class="hint">No steps</td></tr>`}
  </tbody></table></div>
  <div class="row"><button type="button" class="btn sm" id="loopadd">+ Add step</button><span class="spacer"></span><button type="button" class="btn sm primary" id="loopsave">Save steps</button></div>`;
}

export function pipeStages(d) {
  const steps = d.steps || [];
  if (!steps.length) return `<div class="track-empty">${icon("circle-dashed")} No pipeline steps recorded for this run yet.</div>`;
  return `<ol class="track" aria-label="Pipeline progress">` + steps.map((s, i) => {
    const done = s.status === "ok" || s.status === "done";
    const run = s.status === "running";
    const bad = s.status === "failed";
    const cls = done ? "done" : bad ? "failed" : run ? "run" : "todo";
    const ic = done ? "check-circle-2" : bad ? "x-circle" : run ? "loader" : "circle";
    const label = s.agent || s.id || `Stage ${i + 1}`;
    return `<li class="tstep ${cls}"><span class="tdot" aria-hidden="true">${icon(ic)}</span><div class="tbody"><div class="tname">${esc(String(label).slice(0, 40))}</div><div class="tsub">${esc(s.type || "")}${s.agent ? ` · ${esc(s.agent)}` : ""} · ${done ? "done" : bad ? "failed" : run ? "running" : "pending"}</div></div></li>`;
  }).join("") + `</ol>`;
}

// Diagrams tab: pannable SVG pipeline built from real step data (no fake graph).
// Nodes = steps in order; edges = sequence; color = status. Fullscreen overlay
// reuses the same SVG at larger scale. Empty state when no steps exist.
export function diagramTab(d) {
  const steps = d.steps || [];
  if (!steps.length) return `<div class="empty"><span class="eic">${icon("git-branch")}</span><b>No pipeline to diagram</b><p class="hint">This run has no recorded steps yet — the diagram appears once steps exist.</p></div>`;
  const W = 220, H = 64, GAP = 44;
  const width = steps.length * (W + GAP) + GAP;
  const height = H + 90;
  const color = (s) => (s.status === "ok" || s.status === "done") ? "var(--ok)" : s.status === "failed" ? "var(--bad)" : s.status === "running" ? "var(--acc)" : "var(--line)";
  const nodes = steps.map((s, i) => {
    const x = GAP + i * (W + GAP);
    const label = String(s.agent || s.id || `Stage ${i + 1}`).slice(0, 26);
    const sub = String(s.status === "ok" ? "done" : s.status || "pending").slice(0, 18);
    return `<g class="dnode" tabindex="0" role="img" aria-label="Stage ${i + 1}: ${esc(label)} — ${esc(sub)}">
      ${i > 0 ? `<line x1="${x - GAP}" y1="${H / 2 + 20}" x2="${x}" y2="${H / 2 + 20}" stroke="var(--line)" stroke-width="2" marker-end="url(#darrow)"/>` : ""}
      <rect x="${x}" y="20" width="${W}" height="${H}" rx="10" fill="var(--panel-2)" stroke="${color(s)}" stroke-width="2"/>
      <text x="${x + 12}" y="44" fill="var(--txt)" font-size="12" font-weight="700">${esc(label)}</text>
      <text x="${x + 12}" y="62" fill="var(--faint)" font-size="11">${esc(sub)}${s.agent ? ` · ${esc(String(s.type || "").slice(0, 14))}` : ""}</text>
      <text x="${x + 12}" y="78" fill="var(--faint)" font-size="10">#${i + 1}</text>
    </g>`;
  }).join("");
  const svg = `<svg class="dsvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Pipeline diagram: ${steps.length} stages" style="min-width:${Math.min(width, 720)}px;width:100%;height:auto;display:block">
    <defs><marker id="darrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--line)"/></marker></defs>${nodes}</svg>`;
  const full = S.diagFull ? `<div class="modal" role="dialog" aria-modal="true" aria-label="Pipeline diagram fullscreen"><div class="mbox wide"><div class="dhead"><b>Pipeline — ${steps.length} stages</b><span class="spacer"></span><button type="button" class="btn ghost sm" id="diagx" aria-label="Close fullscreen diagram">${icon("x")} Close</button></div><div class="dscroll" tabindex="0">${svg}</div></div></div>` : "";
  return `<div class="dwrap"><div class="row"><span class="hint">${steps.length} stages · built from recorded step data</span><span class="spacer"></span><button type="button" class="btn sm ghost" id="diagfull">${icon("maximize-2")} Fullscreen</button></div>
    <div class="dscroll" tabindex="0" aria-label="Scrollable pipeline diagram">${svg}</div>${full}</div>`;
}

export function runFailure(d) {
  const reasons = [...new Set([d.error, d.blockedReason].filter(Boolean).map((reason) => String(reason).trim()).filter(Boolean))];
  if (!reasons.length) return "";
  const missingToken = reasons.some((reason) => /expected token.*none was present|missing.*(?:muse|api).*key/i.test(reason));
  return `<section class="status bad" role="alert"><b>${missingToken ? "Muse authentication missing" : "Run needs attention"}</b><p>${missingToken ? "Muse did not receive a token, so this attempt stopped before execution. Check Muse credentials, then re-queue this run." : esc(reasons.join("\n"))}</p>${missingToken ? `<details><summary>Technical details</summary><pre class="out">${esc(reasons.join("\n"))}</pre></details>` : ""}</section>`;
}

export function detailPane(d) {
  try {
  const tabs = [["overview", "Overview", "file-text"], ["steps", `Steps (${(d.steps || []).length})`, "list-ordered"], ["activity", `Activity (${(d.activity || []).length})`, "activity"], ["diagrams", "Diagrams", "git-branch"], ["sessions", `Sessions (${(d.sessions || []).length})`, "terminal"]];
  const pg = d.progress || { completed: 0, total: 0 };
  const pct = pg.total ? Math.round(pg.completed / pg.total * 100) : 0;
  const statusDesc = d.status === "failed" || d.status === "blocked" ? "Stopped - needs attention." : d.status === "done" ? "Completed." : d.status === "running" ? "Running through the pipeline." : d.status === "queued" ? "Queued — waiting for a runner." : `Status: ${d.status || "unknown"}.`;
  let body = "";
  if (S.detailTab === "overview") body = `<div class="endgoal">${esc(d.endGoal?.slice(0, 2000) || "No description.")}</div>
    <div class="row"><span class="kbd">Stream: ${esc(d.repository)}</span><span class="kbd">branch ${esc(d.branch)}</span><span class="kbd">${esc(d.taskType)}</span></div>
    ${(d.comments || []).length ? `<h4>Comments (${d.comments.length})</h4>` + d.comments.map((cm) => `<div class="appr"><div class="row"><b>${esc(cm.author)}</b><span class="hint">${esc(String(cm.created_at || "").slice(0, 16).replace("T", " "))}</span></div><p class="dim">${esc(cm.text)}</p></div>`).join("") : ""}`;
  else if (S.detailTab === "steps") body = (d.steps || []).map((s, i) => `
    <div class="stepcard ${s.status === "failed" ? "bad" : ""}">
      <div class="shead"><span class="snum" aria-hidden="true">${i + 1}</span><b>${esc(s.id)}</b> <span class="kbd">${esc(s.type)}</span> ${s.agent ? `<span class="kbd">${esc(s.agent)}</span>` : ""}<span class="spacer"></span>${statusBadge(s.status === "ok" ? "done" : s.status)}<button type="button" class="btn ghost sm" data-xstep="${i}" aria-expanded="${S.expandedSteps.has(i)}" aria-label="${S.expandedSteps.has(i) ? "Collapse" : "Expand"} step ${i + 1}">${S.expandedSteps.has(i) ? "Collapse" : "Expand"}</button></div>
      ${S.expandedSteps.has(i) ? `<div class="sbody"><p class="dim">${esc(s.text.slice(0, 800))}</p>
        <button type="button" class="btn sm ghost" data-xvar="${i}" aria-expanded="${S.expandedVariants.has(i)}">Full prompt sent to the agent</button>
        ${S.expandedVariants.has(i) ? `<pre class="out">${esc(s.text.slice(0, 2000))}</pre>${s.output ? `<pre class="out">${esc(s.output.slice(0, 1000))}</pre>` : ""}` : ""}
        <button type="button" class="btn sm ghost" data-ctx="${i}" aria-expanded="${S.showCtx}">${S.showCtx ? "Hide context sent" : "View context sent"}</button>
        ${S.showCtx ? `<pre class="out">context-${i + 1}.md · run ${esc(d.id)} · agent ${esc(s.agent || "—")}\n${esc(s.text.slice(0, 1200))}</pre>` : ""}
        <label class="fld"><span>Re-run from this step</span><textarea id="rerun-${i}" rows="2" placeholder="- What should this step do differently? (optional)"></textarea></label>
        <p class="hint">Markdown — one '-' bullet per point. Earlier steps preserved; this step + downstream reset. Restart budget survives.</p>
        <button type="button" class="btn primary sm" data-rqstep="${i}">Re-queue from step ${i + 1}</button></div>` : ""}
    </div>`).join("") || `<p class="hint" role="status">No steps</p>`;
  else if (S.detailTab === "activity") body = `<div class="logbox" role="log" aria-label="Activity">${(d.activity || []).map((a) => `
    <div class="lrow ${a.status === "failed" ? "error" : "info"}"><span class="lt">${esc(String(a.at || "").slice(5, 16).replace("T", " "))}</span>
    <span class="ltag">${esc(a.action)}</span><span class="lsrc">${esc(a.actor || "")}</span><span>${esc(String(a.detail || "").slice(0, 220))}</span></div>`).join("") || `<p class="hint">No activity</p>`}</div>`;
  else if (S.detailTab === "diagrams") body = diagramTab(d);
  else {
    const sess = d.sessions || [];
    // Clamp: tick() may shrink the list while sessIdx points past the end.
    const cur = sess.length ? sess[Math.min(S.sessIdx, sess.length - 1)] : null;
    const curIdx = cur ? sess.indexOf(cur) : 0;
    const exp = S.sessExport || null;
    // Stale export guard: a transcript fetched for a different session index
    // must never render under the current one (async race on rapid Open clicks).
    const expForCur = exp && exp.idx === curIdx ? exp : null;
    const prov = sessionProvenance(cur);
    const toolKinds = [...new Set((expForCur?.turns || []).map((t) => String(t.kind || "event").split(".").pop()))].slice(0, 12);
    const toolFilter = S.sessToolFilter || "all";
    const turns = (expForCur?.turns || []).filter((t) => toolFilter === "all" || String(t.kind || "").includes(toolFilter));
    body = `<div class="sess">
      ${sess.length > 1 ? `<label class="fld"><span>Select session (${sess.length})</span><select id="sesssel" aria-label="Select session">${sess.map((s, i) => `<option value="${i}" ${i === curIdx ? "selected" : ""}>${esc(s.agent)} · ${esc(s.model || "default")} · ${esc(s.status || "")}</option>`).join("")}</select></label>` : ""}
      ${cur ? `<div class="srow sess-live"><b>${icon("bot")} ${esc(cur.agent)}</b><span class="kbd">${esc(cur.model || "resolving…")}</span><span class="tag ${prov.tone}" title="${esc(prov.hint)}">${esc(prov.label)}</span><span class="hint">${esc(cur.workspace || "")} · step ${cur.stepNumber ?? "?"} · ${esc(cur.status || "")}</span><span class="spacer"></span>
      <button type="button" class="btn sm ${expForCur?.loading ? "" : "primary"}" data-sessexp="${curIdx}" ${expForCur?.loading ? "disabled" : ""}>${icon("scroll-text")} ${expForCur?.loading ? "Loading transcript…" : expForCur ? "Reload transcript" : "View transcript"}</button></div>
      <div class="mono sess-id">${icon("fingerprint")} CLI session <span class="kbd">${esc(cur.sessionUuid || cur.id || "—")}</span> · runner ${esc(cur.runner || "muse-cli")} · <span class="hint">${esc(prov.hint)}</span></div>` : ""}
      ${expForCur && !expForCur.loading ? (expForCur.error ? `<div class="status bad" role="alert">${esc(expForCur.error)}</div>` : `
      <div class="transcript" role="log" aria-label="Session transcript">
        <div class="row"><span class="hint">${icon("messages-square")} ${expForCur.turns?.length ?? 0} turns${expForCur.turnCount ? ` · ${expForCur.turnCount} model turns` : ""}${expForCur.exitReason ? ` · exit: ${esc(expForCur.exitReason)}` : ""}${expForCur.cached ? " · cached" : " · live"}</span><span class="spacer"></span>
        ${toolKinds.length > 1 ? `<label class="fld" style="margin:0"><span class="sr">Filter transcript by message kind</span><select id="sesstool" aria-label="Filter transcript by message kind"><option value="all">All message kinds</option>${toolKinds.map((k) => `<option value="${esc(k)}" ${toolFilter === k ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></label>` : ""}</div>
        ${turns.map((t) => `<div class="tmsg ${esc((t.kind || "").slice(0, 20))}"><span class="tkind">${esc(t.kind || "event")}</span><p>${esc(String(t.text || "").slice(0, 2000))}</p></div>`).join("") || `<p class="hint">Transcript empty — session may still be running. Hit Reload.</p>`}
      </div>`) : ""}
      ${sess.map((s, i) => { const p = sessionProvenance(s); const openBusy = expForCur?.loading && expForCur.idx === i; return `<div class="srow ${i === curIdx ? "sel" : ""}"><b>${esc(s.agent)}</b><span class="kbd">${esc(s.model || "resolving…")}</span><span class="tag ${p.tone}" title="${esc(p.hint)}">${esc(p.label)}</span><span class="hint">step ${s.stepNumber ?? "?"} · ${esc(s.status || "")}</span><span class="spacer"></span><button type="button" class="btn sm ${i === curIdx && expForCur ? "" : "primary"}" data-sessopen="${i}" ${openBusy ? "disabled" : ""}>${openBusy ? "Opening…" : "Open"}</button></div>`; }).join("") || `<p class="hint">No sessions yet — dispatch a step to spawn a Muse CLI session.</p>`}</div>`;
  }
  return `
  <div class="detail">
  <div class="dhead"><button type="button" class="btn ghost sm" id="dback" aria-label="Back to list">${icon("arrow-left")} Back</button><span class="mono">#${esc(String(d.id).slice(0, 6))}</span> ${statusBadge(d.status)}<span class="spacer"></span><button type="button" class="btn ghost sm" id="dclose" aria-label="Close task detail">${icon("x")} Close</button></div>
  <div class="dtitle">${esc(displayTitle(d).slice(0, 120))}</div>
  <p class="hint">${esc(statusDesc)}</p>
  ${runFailure(d)}
  <div class="pbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Task progress"><div class="pfill" style="width:${pct}%"></div></div><div class="hint">${pg.completed}/${pg.total} steps complete</div>
  <h4>${icon("workflow")} PIPELINE</h4>
  <div class="pipe" aria-label="Pipeline stages">${pipeStages(d)}</div>
  <div class="dact"><button type="button" class="btn sm primary" data-act="req-changes">${icon("message-square-warning")} Request changes</button>
    <button type="button" class="btn sm" data-act="append">${icon("plus")} Append task</button><button type="button" class="btn sm" data-act="requeue">${icon("rotate-ccw")} Re-queue</button>${d.status !== "done" ? `<button type="button" class="btn sm okbtn" data-act="done">${icon("check")} Mark done</button>` : ""}${d.status !== "failed" ? `<button type="button" class="btn sm danger" data-act="block">${icon("octagon-pause")} Block</button>` : ""}<button type="button" class="btn sm danger" data-act="del">${icon("trash-2")} Delete${S.confirmDel ? " — press again to confirm" : ""}</button></div>
  <div id="actbox"></div>
  <nav class="tabs" role="tablist" aria-label="Task detail tabs">${tabs.map(([v, l, ic]) => `<button type="button" role="tab" aria-selected="${S.detailTab === v}" class="tab ${S.detailTab === v ? "on" : ""}" data-dtab="${v}">${icon(ic)} ${esc(l)}</button>`).join("")}</nav>
  <div class="dbody" role="tabpanel">${body}</div>
  </div>`;
  } catch (err) {
    return `<div class="status bad" role="alert">Couldn't render this run's detail (${esc(err.message)}). The list on the left is unaffected — pick another run or hit Refresh.</div>`;
  }
}

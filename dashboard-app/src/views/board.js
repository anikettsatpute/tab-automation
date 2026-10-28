// Board shell: tab switcher + delegates to task / automation-runs / loop views.
// Pure render functions — state + events live in main.js.
import { S, esc } from "./state.js";
import { attentionBanners } from "./shell.js";
import { tasksView, automationRunsView } from "./tasks.js";

export function boardView(detailPane) {
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
  const lsel = S.loopDetail;
  return `
  ${attentionBanners()}
  <div class="bhead"><h2>Board <span class="hint">${list.length} runs · ${lt.length} loop tasks</span></h2>
    <div class="btabs" role="tablist" aria-label="Board view">${[["tasks", "Tasks"], ["runs", "Automation runs"], ["loop", "Loop tasks"]].map(([v, l]) => `<button type="button" role="tab" aria-selected="${S.boardTab === v}" class="tab ${S.boardTab === v ? "on" : ""}" data-btab="${v}">${l}</button>`).join("")}</div>
    <span class="spacer"></span>
    ${S.boardTab === "tasks" ? `<label class="sr" for="sortby">Sort tasks</label>
    <select id="sortby" class="sel"><option value="recent" ${S.sortBy === "recent" ? "selected" : ""}>Recent activity</option><option value="id" ${S.sortBy === "id" ? "selected" : ""}>By Task ID</option></select>` : ""}
  </div>
  ${S.boardTab === "loop" ? loopTasksView(lt, lsel) : S.boardTab === "runs" ? automationRunsView() : tasksView(list, detailPane)}`;
}

export function loopTasksView(lt, lsel) {
  return `<div class="board2"><div class="blist" role="list" aria-label="Loop tasks">
    <button type="button" class="btn sm primary" id="loopnew">+ New loop task</button>
    ${S.loopForm ? `<div class="appr" role="dialog" aria-label="New loop task"><label class="fld"><span>Loop task title</span><input id="loop-title" value="${esc(S.loopForm.title || "")}" placeholder="What should this loop do?"></label><div class="row"><button type="button" class="btn sm primary" id="loopcreate">Create</button><button type="button" class="btn sm ghost" id="loopcancel">Cancel</button></div></div>` : ""}
    ${lt.map((t) => `<button type="button" role="listitem" class="bcard ${S.loopSel === t.id ? "sel" : ""}" data-loop="${esc(t.id)}" aria-current="${S.loopSel === t.id}" aria-label="${esc((t.title || "loop task").slice(0, 80))} — ${esc(t.status)}">
      <span class="btop">${statusBadge(t.status === "open" ? "queued" : t.status)} <span class="hint">#${esc(t.id.slice(0, 6))}</span><span class="spacer"></span><span class="hint">${ago(t.updated_at)}</span></span>
      <span class="btitle">${esc((t.title || "").slice(0, 100))}</span>
      <span class="bmeta"><span class="kbd">${esc(t.repo || "")}</span><span class="kbd">${esc(t.task_type || "")}</span><span class="kbd">branch ${esc((t.branch || "").slice(0, 30))}</span></span>
      <span class="bmeta"><span class="hint">progress ${t.progress || 0}%</span>${t.tokens ? `<span class="hint">${Number(t.tokens).toLocaleString()} tokens</span>` : ""}${t.tool_calls ? `<span class="hint">${t.tool_calls} tool calls</span>` : ""}</span>
    </button>`).join("") || `<div class="empty" role="status">No loop tasks yet — create one above.</div>`}
  </div><div class="bdetail">${lsel ? loopDetailPane(lsel) : `<div class="empty">Select a loop task to inspect steps.</div>`}</div></div>`;
}

export function loopDetailPane(d) {
  const steps = d.steps || [];
  return `<div class="dhead"><span class="mono">#${esc(d.task.id.slice(0, 6))}</span> ${statusBadge(d.task.status === "open" ? "queued" : d.task.status)}<span class="spacer"></span><button type="button" class="btn ghost sm" id="loopx" aria-label="Close loop task">Close</button></div>
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
  return steps.map((s, i) => {
    const done = s.status === "ok" || s.status === "done";
    const run = s.status === "running";
    const bad = s.status === "failed";
    return `<div class="pnode ${done ? "ok" : bad ? "bad" : run ? "run" : ""}"><b>${esc((s.agent || s.id || `Stage ${i + 1}`).slice(0, 22))}</b><span>${done ? "DONE" : bad ? "FAILED" : run ? "RUNNING" : "PENDING"}</span></div>`;
  }).join("");
}

export function detailPane(d) {
  const tabs = [["overview", "Overview"], ["steps", `Steps (${d.steps.length})`], ["activity", `Activity (${d.activity.length})`], ["diagrams", "Diagrams"], ["sessions", `Sessions (${d.sessions.length})`]];
  const pct = d.progress.total ? Math.round(d.progress.completed / d.progress.total * 100) : 0;
  const statusDesc = d.prUrl ? "A pull request is open and waiting on your review." : d.status === "failed" ? "Blocked — needs human review." : d.status === "done" ? "Completed." : "Running through the pipeline.";
  let body = "";
  if (S.detailTab === "overview") body = `<div class="endgoal">${esc(d.endGoal?.slice(0, 2000) || "No description.")}</div>
    <div class="row"><span class="kbd">Stream: ${esc(d.repository)}</span><span class="kbd">branch ${esc(d.branch)}</span><span class="kbd">${esc(d.taskType)}</span></div>
    ${d.error ? `<div class="status bad" role="alert">${esc(d.error)}</div>` : ""}${d.blockedReason && d.status === "failed" ? `<div class="status bad" role="alert">Blocked: ${esc(d.blockedReason.slice(0, 300))}</div>` : ""}
    ${(d.comments || []).length ? `<h4>Comments (${d.comments.length})</h4>` + d.comments.map((cm) => `<div class="appr"><div class="row"><b>${esc(cm.author)}</b><span class="hint">${esc(String(cm.created_at || "").slice(0, 16).replace("T", " "))}</span></div><p class="dim">${esc(cm.text)}</p></div>`).join("") : ""}`;
  else if (S.detailTab === "steps") body = d.steps.map((s, i) => `
    <div class="stepcard ${s.status === "failed" ? "bad" : ""}">
      <div class="shead"><span class="snum" aria-hidden="true">${i + 1}</span><b>${esc(s.id)}</b> <span class="kbd">${esc(s.type)}</span> ${s.agent ? `<span class="kbd">${esc(s.agent)}</span>` : ""}<span class="spacer"></span>${statusBadge(s.status === "ok" ? "done" : s.status)}<button type="button" class="btn ghost sm" data-xstep="${i}" aria-expanded="${S.expandedSteps.has(i)}" aria-label="${S.expandedSteps.has(i) ? "Collapse" : "Expand"} step ${i + 1}">${S.expandedSteps.has(i) ? "Collapse" : "Expand"}</button></div>
      ${S.expandedSteps.has(i) ? `<div class="sbody"><p class="dim">${esc(s.text.slice(0, 800))}</p>
        <button type="button" class="btn sm ghost" data-xvar="${i}" aria-expanded="${S.expandedVariants.has(i)}">Full prompt sent to the agent</button>
        ${S.expandedVariants.has(i) ? `<pre class="out">${esc(s.text.slice(0, 2000))}</pre>${s.output ? `<pre class="out">${esc(s.output.slice(0, 1000))}</pre>` : ""}` : ""}
        <button type="button" class="btn sm ghost" data-ctx="${i}" aria-expanded="${S.showCtx}">${S.showCtx ? "Hide context sent" : "View context sent"}</button>
        ${S.showCtx ? `<pre class="out">context-${i + 1}.md · run ${esc(d.id)} · agent ${esc(s.agent || "—")}\n${esc(s.text.slice(0, 1200))}</pre>` : ""}
        <label class="fld"><span>Re-run from this step</span><textarea id="rerun-${i}" rows="2" placeholder="- What should this step do differently? (optional)"></textarea></label>
        <p class="hint">Markdown — one '-' bullet per point. Earlier steps preserved; this step + downstream reset. Restart budget survives; PR link survives.</p>
        <button type="button" class="btn primary sm" data-rqstep="${i}">Re-queue from step ${i + 1}</button></div>` : ""}
    </div>`).join("") || `<p class="hint" role="status">No steps</p>`;
  else if (S.detailTab === "activity") body = `<div class="logbox" role="log" aria-label="Activity">${d.activity.map((a) => `
    <div class="lrow ${a.status === "failed" ? "error" : "info"}"><span class="lt">${esc(String(a.at || "").slice(5, 16).replace("T", " "))}</span>
    <span class="ltag">${esc(a.action)}</span><span class="lsrc">${esc(a.actor || "")}</span><span>${esc(String(a.detail || "").slice(0, 220))}</span></div>`).join("") || `<p class="hint">No activity</p>`}</div>`;
  else if (S.detailTab === "diagrams") body = `<div class="pipe">${d.diagram.map((n) => `
    <div class="pnode ${n.status === "failed" ? "bad" : "ok"}"><b>${esc(n.label)}</b><span>${esc(n.type)}${n.agent ? " · " + esc(n.agent) : ""}</span></div>`).join("") || `<p class="hint">No diagram</p>`}</div>
    <p class="hint">Scroll to pan · Ctrl+scroll to zoom · <button type="button" class="btn sm ghost" id="diagfull">Open fullscreen</button></p>
    ${S.diagFull ? `<div class="modal" role="dialog" aria-modal="true" aria-label="Diagram fullscreen"><div class="mbox wide"><div class="dhead"><b>Diagram — ${esc(d.id.slice(0, 8))}</b><span class="spacer"></span><button type="button" class="btn ghost sm" id="diagx">Close</button></div><div class="pipe">${d.diagram.map((n) => `<div class="pnode ${n.status === "failed" ? "bad" : "ok"}"><b>${esc(n.label)}</b><span>${esc(n.type)}</span></div>`).join("")}</div></div></div>` : ""}`;
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
  <div class="dhead"><span class="mono">#${esc(d.id.slice(0, 6))}</span> ${statusBadge(d.status)}<span class="spacer"></span><button type="button" class="btn ghost sm" id="dclose" aria-label="Close task detail">Close</button></div>
  <div class="dtitle">${esc((d.title || "").slice(0, 120))}</div>
  <p class="hint">${esc(statusDesc)}</p>
  <div class="pbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Task progress"><div class="pfill" style="width:${pct}%"></div></div><div class="hint">${d.progress.completed}/${d.progress.total} steps complete</div>
  <div class="pipe" aria-label="Pipeline stages">${pipeStages(d)}</div>
  <div class="dact"><button type="button" class="btn sm primary" data-act="req-changes">Request changes</button>${d.prUrl ? `<a class="btn sm" href="${esc(d.prUrl)}" target="_blank" rel="noopener">Open PR</a>` : ""}
    <button type="button" class="btn sm" data-act="append">Append task</button><button type="button" class="btn sm" data-act="requeue">Re-queue</button><button type="button" class="btn sm danger" data-act="del">Delete${S.confirmDel ? " — press again to confirm" : ""}</button></div>
  <div id="actbox"></div>
  <nav class="tabs" role="tablist" aria-label="Task detail tabs">${tabs.map(([v, l]) => `<button type="button" role="tab" aria-selected="${S.detailTab === v}" class="tab ${S.detailTab === v ? "on" : ""}" data-dtab="${v}">${esc(l)}</button>`).join("")}</nav>
  <div class="dbody" role="tabpanel">${body}</div>`;
}

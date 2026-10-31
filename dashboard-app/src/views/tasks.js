// Task view: runs board + task detail pane (single task focus).
// Split from board.js — Board owns the tab shell, this owns task rendering.
import { S, esc, ago, statusBadge, displayTitle, kindLabel, isAutomationRun, needsAttention } from "./state.js";
import { pill, originChip, progress, emptyState, icon } from "./ui.js";

export function taskTypesSection() {
  const types = S.taskTypes || [];
  if (!types.length) return "";
  return `<div class="card types-open"><div class="row"><h3 style="margin:0">Task pipelines <span class="hint">repeatable launches</span></h3><span class="spacer"></span><button type="button" class="btn sm ghost" data-types aria-expanded="true">Hide ▾</button></div>
  ${types.map((t) => `<div class="appr"><div class="row"><b>${esc(t.name || t.id)}</b><span class="kbd">${esc(t.stream || "")}</span><span class="spacer"></span><span class="hint">${esc(t.description || "")}</span></div>
  <p class="hint">pipeline: ${(t.agents || []).map(esc).join(" → ")}</p>
  <div class="row"><label class="fld" style="flex:1"><span>${esc(t.inputLabel || "Goal")}</span><input id="task-goal-${esc(t.id)}" placeholder="${esc(t.inputLabel || "Describe the goal…")}"></label>
  <button type="button" class="btn sm primary" data-tasklaunch="${esc(t.id)}">Launch ${esc(t.name || t.id)}</button></div>
  <div id="task-out-${esc(t.id)}"></div></div>`).join("")}</div>`;
}

export function tasksView(list, detailPane) {
  const sel = S.sel;
  const types = S.taskTypes || [];
  // Attention tab: blocked + failed<24h. Tasks tab: everything EXCEPT
  // scheduled automation runs (those live under Automation runs).
  let rows = S.boardTab === "attention" ? list.filter(needsAttention)
    : S.boardTab === "runs" ? list.filter(isAutomationRun)
    : list.filter((r) => !isAutomationRun(r));
  if (S.kindFilter && S.kindFilter !== "all") rows = rows.filter((r) => kindLabel(r) === S.kindFilter);
  if (sel) {
    const panel = S.detail ? detailPane(S.detail) : `<div class="detail" aria-busy="${!S.detailError}"><div class="dhead"><button type="button" class="btn ghost sm" id="dback">${icon("arrow-left")} Back</button><span class="spacer"></span><button type="button" class="btn ghost sm" id="dclose" aria-label="Close task detail">${icon("x")} Close</button></div>${S.detailError ? `<div class="status bad" role="alert">${esc(S.detailError)}</div><button type="button" class="btn sm" id="detail-retry">${icon("refresh-cw")} Retry</button>` : `<p class="dim" role="status">Loading task details...</p>`}</div>`;
    return `<div class="taskwrap"><div class="blist-col">${taskListOnly(rows, list)}</div><div class="tdrawer-backdrop" data-drawer-backdrop aria-hidden="true"></div><aside class="tdrawer" id="task-detail-drawer" role="dialog" aria-modal="true" aria-label="Task detail" tabindex="-1">${panel}</aside></div>`;
  }
  return `
  ${S.showTypes ? taskTypesSection() : `<button type="button" class="types-toggle" data-types aria-expanded="false"><span>⚙ Task pipelines</span><span class="hint">${types.length} repeatable launches</span><span class="chev" aria-hidden="true">▸</span></button>`}
  ${taskListOnly(rows, list)}
  </div>`;
}

export function taskListOnly(rows, list) {
  const loading = !list.length && !S.lastFetchOk;
  if (loading) return `<div class="blist single" aria-busy="true" aria-label="Loading tasks">${[0, 1, 2].map(() => `<div class="bcard"><div class="skel" style="height:14px;width:40%"></div><div class="skel" style="height:12px;width:90%"></div><div class="skel" style="height:8px;width:70%"></div></div>`).join("")}<p class="hint">Loading runs…</p></div>`;
  // No aria-label on the card buttons: the visible card text (title,
  // status pill, origin, id, time, progress) already IS the accessible name.
  // A shortened aria-label rephrasing it trips axe
  // label-content-name-mismatch (serious). Screen readers get the full card.
  return `<div class="blist single" role="group" aria-label="Tasks">
      ${rows.map((r) => {
        const pg = r.progress || { completed: 0, total: 0 };
        const pct = pg.total ? Math.round(pg.completed / pg.total * 100) : 0;
        return `
      <button type="button" class="bcard ${S.sel === r.id ? "sel" : ""}" data-sel="${esc(r.id)}" aria-current="${S.sel === r.id}">
        <span class="btop">${pill(r.status)} ${originChip(kindLabel(r))}<span class="hint">#${esc(String(r.id).slice(0, 6))}</span><span class="spacer"></span><span class="hint">${icon("clock")} ${ago(r.startedAt)}</span></span>
        <span class="btitle">${esc(displayTitle(r).slice(0, 100))}</span>
        <span class="bmeta"><span class="dim">${esc(r.taskType || r.kind || r.workflow || "")}</span>${r.stream || r.repository ? `<span class="hint">· ${esc(r.stream || r.repository)}</span>` : ""}${r.commentsCount ? `<span class="hint">· ${icon("message-square")} ${r.commentsCount}</span>` : ""}</span>
        ${progress(pg.completed, pg.total)}
        ${r.tokens ? `<span class="bmeta"><span class="hint">${icon("coins")} ${Number(r.tokens).toLocaleString()} tokens</span>${r.toolCalls ? `<span class="hint">· ${icon("wrench")} ${r.toolCalls} tools</span>` : ""}</span>` : ""}
      </button>`; }).join("") || emptyState("inbox", S.boardTab === "attention" ? "All clear" : "No tasks", S.boardTab === "attention" ? "Blocked runs and failures from the last 24h will land here." : "No tasks match the current filter.", `<button type="button" class="btn sm ghost" data-clearf>Clear filter</button>`)}
  </div>`;
}

// Automation runs view: every automation + its recent runs (not just the flow card).
// Each flow shows its last runs with status/time/steps so runs are visible here.
export function automationRunsView() {
  const flows = S.flows || [];
  const tasks = (S.tasks || []).filter(isAutomationRun);
  const runsByFlow = new Map();
  const unmatched = [];
  for (const t of tasks) {
    const k = t.workflow || t.taskType || "";
    if (flows.some((f) => f.id === k)) { if (!runsByFlow.has(k)) runsByFlow.set(k, []); runsByFlow.get(k).push(t); }
    else unmatched.push(t);
  }
  return `
  ${unmatched.length ? `<div class="flowcard"><div class="row"><div><h3>Scheduled runs without a flow</h3><p class="dim">Cron runs whose automation was deleted or renamed — safe to mark done.</p></div></div>
  <div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Pipeline</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Steps</th><th scope="col"></th></tr></thead><tbody>
  ${unmatched.slice(0, 10).map((r) => `<tr><td><span class="kbd">${esc(String(r.id).slice(0, 8))}</span></td><td class="dim">${esc((r.workflow || r.taskType || "").slice(0, 28))}</td><td>${statusBadge(r.status)}</td><td class="dim">${esc(String(r.startedAt || "").slice(0, 16).replace("T", " "))}</td><td class="dim">${(r.progress || {}).completed ?? 0}/${(r.progress || {}).total ?? 0}</td>
  <td><button type="button" class="btn sm ghost" data-sel="${esc(r.id)}">Open</button></td></tr>`).join("")}
  </tbody></table></div></div>` : ""}
  ${flows.map((f) => {
    const runs = (runsByFlow.get(f.id) || []).slice(0, 5);
    const trig = f.trigger?.type || f.trigger || "manual";
    return `<div class="flowcard"><div class="row"><div><h3>${esc(f.title || f.id)}</h3><p class="dim">${esc(f.description || "")}</p></div><span class="spacer"></span>
      <span class="kbd">${esc(trig === "schedule" ? (f.trigger?.cron || "scheduled") : trig)}</span>
      <button type="button" class="btn sm primary" data-runflow="${esc(f.id)}">Run</button>
      <button type="button" class="btn sm ghost" data-flowedit="${esc(f.id)}">Edit</button></div>
      ${runs.length ? `<h4>RECENT RUNS (${runs.length})</h4><div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Steps</th><th scope="col">Tokens</th><th scope="col"></th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td><span class="kbd">${esc(String(r.id).slice(0, 8))}</span></td><td>${statusBadge(r.status)}</td><td class="dim">${esc(String(r.startedAt || "").slice(0, 16).replace("T", " "))}</td><td class="dim">${(r.progress || {}).completed ?? 0}/${(r.progress || {}).total ?? 0}</td><td class="dim">${r.tokens ? Number(r.tokens).toLocaleString() : "—"}</td>
      <td><button type="button" class="btn sm ghost" data-sel="${esc(r.id)}">Open</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="hint" role="status">No runs yet for this flow — press Run.</p>`}
    </div>`;
  }).join("") || `<div class="empty" role="status">No automation flows — create one in the Automations view.</div>`}`;
}

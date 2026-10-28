// Task view: runs board + task detail pane (single task focus).
// Split from board.js — Board owns the tab shell, this owns task rendering.
import { S, esc, ago, statusBadge } from "./state.js";
import { attentionBanners } from "./shell.js";

export function tasksView(list, detailPane) {
  const sel = S.detail;
  return `
  ${attentionBanners()}
  <div class="bhead"><h2>Tasks <span class="hint">${list.length} runs</span></h2>
    <span class="spacer"></span>
    <label class="sr" for="sortby">Sort tasks</label>
    <select id="sortby" class="sel"><option value="recent" ${S.sortBy === "recent" ? "selected" : ""}>Recent activity</option><option value="id" ${S.sortBy === "id" ? "selected" : ""}>By Task ID</option></select>
  </div>
  <div class="board2">
    <div class="blist" role="list" aria-label="Tasks">
      ${list.map((r) => `
      <button type="button" role="listitem" class="bcard ${S.sel === r.id ? "sel" : ""}" data-sel="${esc(r.id)}" aria-current="${S.sel === r.id}" aria-label="${esc((r.title || r.workflow || "task").slice(0, 80))} — ${esc(r.status)}">
        <span class="btop">${statusBadge(r.status)} <span class="hint">#${esc(r.id.slice(0, 6))}</span><span class="spacer"></span><span class="hint">${ago(r.startedAt)}</span></span>
        <span class="btitle">${esc((r.title || r.workflow || "").slice(0, 100))}</span>
        <span class="bmeta"><span class="kbd">${esc(r.repository || "tab-automation")}</span> <span class="kbd">${esc(r.taskType || r.kind || "")}</span> <span class="kbd">branch ${esc((r.branch || "").slice(0, 40))}</span></span>
        <span class="bmeta"><span class="hint">${r.progress.completed}/${r.progress.total} steps</span>
          ${r.tokens ? `<span class="hint">${Number(r.tokens).toLocaleString()} tokens</span>` : ""} ${r.toolCalls ? `<span class="hint">${r.toolCalls} tool calls</span>` : ""}
          ${r.commentsCount ? `<span class="hint">${r.commentsCount} comments</span>` : ""} ${r.prUrl ? `<span class="hint">PR linked</span>` : ""}</span>
      </button>`).join("") || `<div class="empty" role="status">No tasks match the current filter. <button type="button" class="btn sm ghost" data-clearf>Clear filter</button></div>`}
    </div>
    <div class="bdetail">${sel ? detailPane(sel) : `<div class="empty">Select a task to inspect.</div>`}</div>
  </div>`;
}

// Automation runs view: every automation + its recent runs (not just the flow card).
// Each flow shows its last runs with status/time/steps so runs are visible here.
export function automationRunsView() {
  const flows = S.flows || [];
  const tasks = S.tasks || [];
  const runsByFlow = new Map();
  for (const t of tasks) {
    const k = t.workflow || t.taskType || "";
    if (!runsByFlow.has(k)) runsByFlow.set(k, []);
    runsByFlow.get(k).push(t);
  }
  return `
  <div class="bhead"><h2>Automation runs <span class="hint">${tasks.length} runs across ${flows.length} flows</span></h2></div>
  ${flows.map((f) => {
    const runs = (runsByFlow.get(f.id) || []).slice(0, 5);
    const trig = f.trigger?.type || f.trigger || "manual";
    return `<div class="flowcard"><div class="row"><div><h3>${esc(f.title || f.id)}</h3><p class="dim">${esc(f.description || "")}</p></div><span class="spacer"></span>
      <span class="kbd">${esc(trig === "schedule" ? (f.trigger?.cron || "scheduled") : trig)}</span>
      <button type="button" class="btn sm primary" data-runflow="${esc(f.id)}">Run</button>
      <button type="button" class="btn sm ghost" data-flowedit="${esc(f.id)}">Edit</button></div>
      ${runs.length ? `<h4>RECENT RUNS (${runs.length})</h4><div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Steps</th><th scope="col">Tokens</th><th scope="col"></th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td><span class="kbd">${esc(r.id.slice(0, 8))}</span></td><td>${statusBadge(r.status)}</td><td class="dim">${esc(String(r.startedAt || "").slice(0, 16).replace("T", " "))}</td><td class="dim">${r.progress.completed}/${r.progress.total}</td><td class="dim">${r.tokens ? Number(r.tokens).toLocaleString() : "—"}</td>
      <td><button type="button" class="btn sm ghost" data-sel="${esc(r.id)}">Open</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="hint" role="status">No runs yet for this flow — press Run.</p>`}
    </div>`;
  }).join("") || `<div class="empty" role="status">No automation flows — create one in the Automations view.</div>`}`;
}

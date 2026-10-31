// Automation runs view: every automation flow + its recent scheduled runs.
// Loop tasks live in loop.js; this tab is read-only history of cron/flow runs.
import { S, esc, statusBadge, isAutomationRun } from "./state.js";

const runRow = (r, withPipe) => `<tr><td><span class="kbd">${esc(String(r.id).slice(0, 8))}</span></td>${withPipe ? `<td class="dim">${esc((r.workflow || r.taskType || "").slice(0, 28))}</td>` : ""}<td>${statusBadge(r.status)}</td><td class="dim">${esc(String(r.startedAt || "").slice(0, 16).replace("T", " "))}</td><td class="dim">${(r.progress || {}).completed ?? 0}/${(r.progress || {}).total ?? 0}</td><td class="dim">${r.tokens ? Number(r.tokens).toLocaleString() : "—"}</td></tr>`;

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
  ${unmatched.length ? `<div class="flowcard"><div class="row"><div><h3>Scheduled runs without a flow</h3><p class="dim">Cron runs whose automation was deleted or renamed.</p></div></div>
  <div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Pipeline</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Steps</th><th scope="col">Tokens</th></tr></thead><tbody>
  ${unmatched.slice(0, 10).map((r) => runRow(r, true)).join("")}
  </tbody></table></div></div>` : ""}
  ${flows.map((f) => {
    const runs = (runsByFlow.get(f.id) || []).slice(0, 5);
    const trig = f.trigger?.type || f.trigger || "manual";
    return `<div class="flowcard"><div class="row"><div><h3>${esc(f.title || f.id)}</h3><p class="dim">${esc(f.description || "")}</p></div><span class="spacer"></span>
      <span class="kbd">${esc(trig === "schedule" ? (f.trigger?.cron || "scheduled") : trig)}</span>
      <button type="button" class="btn sm primary" data-runflow="${esc(f.id)}">Run</button>
      <button type="button" class="btn sm ghost" data-flowedit="${esc(f.id)}">Edit</button></div>
      ${runs.length ? `<h4>RECENT RUNS (${runs.length})</h4><div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Steps</th><th scope="col">Tokens</th></tr></thead><tbody>
      ${runs.map((r) => runRow(r, false)).join("")}
      </tbody></table></div>` : `<p class="hint" role="status">No runs yet for this flow — press Run.</p>`}
    </div>`;
  }).join("") || `<div class="empty" role="status">No automation flows — create one in the Automations view.</div>`}`;
}

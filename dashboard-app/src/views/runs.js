// Automation runs tab: each executed flow run as a pipeline (same look as loop tasks).
// Data comes from /api/control/tasks (S.tasks) — run + its steps; read-only.
import { S, esc, ago, kindLabel } from "./state.js";
import { icon, emptyState, pageHead, toolbar, searchBox } from "./ui.js";
import { md } from "./md.js";
import { ring, lpill } from "./loop.js";
import { chatView } from "./chat.js";

const STEP_ST = { ok: "done", done: "done", error: "failed", failed: "failed", running: "running", skipped: "skipped", pending: "pending", blocked: "blocked" };
const STEP_IC = { done: "check-circle-2", running: "loader", failed: "x-circle", blocked: "octagon-alert", pending: "circle", skipped: "circle-dashed" };
const RUN_ST = { ok: "done", error: "failed" };
const runStatus = (r) => RUN_ST[r.status] || r.status || "queued";
const stepStatus = (s) => STEP_ST[s.status] || s.status || "pending";
const stepName = (s) => s.agent || s.type || s.id;

// Legacy dashboard requests are superseded by loop tasks; everything else is a flow run.
const LEGACY = new Set(["dashboard-request", "dashboard-requeue"]);
export const automationRuns = () => (S.tasks || []).filter((r) => r && r.id && !LEGACY.has(r.kind));
const matches = (r, q) => !q || `${r.id} ${r.title} ${r.workflow}`.toLowerCase().includes(q);

function row(r) {
  const st = runStatus(r);
  const steps = r.steps || [];
  const done = steps.filter((s) => stepStatus(s) === "done").length;
  const chips = steps.map((s) => `<span class="rchip ${esc(stepStatus(s))}">${esc(stepName(s))}</span>`).join("");
  return `<button type="button" class="lrow ${S.runSel === r.id ? "sel" : ""}" data-rsel="${esc(r.id)}" aria-current="${S.runSel === r.id}">
    ${ring(done, steps.length || r.progress?.total || 0, st)}
    <span class="lmain"><span class="ltitle"><span class="lseq">${esc(String(r.id).slice(0, 8))}</span>${esc(r.title || r.workflow)}</span>
    <span class="lmeta">${chips}<span>${esc(kindLabel(r))}</span>${r.workflow ? `<span>· ${esc(r.workflow)}</span>` : ""}</span></span>
    <span class="lright">${lpill(st)}<span class="ltime">${ago(r.finishedAt || r.startedAt)}</span></span>
  </button>`;
}

export function runsHead() {
  const q = (S.q || "").toLowerCase().trim();
  const all = automationRuns();
  const shown = all.filter((r) => matches(r, q)).length;
  return `${pageHead("Board", `${shown} of ${all.length} automation runs`, "")}
  ${toolbar(searchBox("fq2", S.q, "Filter by flow, title or #id"))}`;
}

export function automationRunsView() {
  const q = (S.q || "").toLowerCase().trim();
  const list = automationRuns().filter((r) => matches(r, q) && (!S.statusFilter || runStatus(r) === S.statusFilter));
  const body = list.length
    ? `<div class="lboard runs" role="group" aria-label="Automation runs">${list.map(row).join("")}</div>`
    : emptyState("workflow", "No automation runs", "Runs appear here when a flow fires — from a schedule, Discord, or Run in Automations.");
  return `${body}${S.runSel ? runDrawer() : ""}`;
}

// Agent sessions recorded for the run (Muse CLI). Hide legacy synthetic ids when the real UUID row exists.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function runSessions() {
  const list = (S.runDetail?.id === S.runSel ? S.runDetail.sessions : null) || [];
  const withIdx = list.map((s, idx) => ({ ...s, idx })).filter((s) => s.sessionUuid);
  return withIdx.filter((s) => UUID.test(s.sessionUuid) || !withIdx.some((o) => o !== s && UUID.test(o.sessionUuid) && o.stepNumber === s.stepNumber && o.agent === s.agent));
}

function sessionsPane(r) {
  if (S.runDetail?.id !== r.id) return `<p class="hint" role="status">Loading sessions…</p>`;
  const list = runSessions();
  if (!list.length) return `<p class="hint">No agent sessions recorded for this run (only agent steps open a CLI session).</p>`;
  const cur = list.find((s) => s.idx === S.runSessIdx) || list[0];
  const key = `run:${r.id}:${cur.idx}`;
  return `<label class="fld"><span>Session</span><select id="rsess">${list.map((s) => `<option value="${s.idx}" ${s.idx === cur.idx ? "selected" : ""}>Step ${Number(s.stepNumber) + 1} · ${esc(s.agent || "agent")} · ${esc(s.model || "")}</option>`).join("")}</select></label>
  <div class="sessgrid"><span>Runner</span><span>${esc(s0(cur.runner))}</span><span>Session</span><span>${esc(cur.sessionUuid)}</span><span>Agent</span><span>${esc(cur.agent || "—")} · step ${Number(cur.stepNumber) + 1}</span><span>Model</span><span>${esc(cur.model || "default")}</span>${cur.workspace ? `<span>Workspace</span><span>${esc(cur.workspace)}</span>` : ""}</div>
  <div data-chatload="${esc(key)}">${chatView(S.chats?.[key] || { loading: true }, key)}</div>`;
}
const s0 = (runner) => (runner === "muse-cli" ? "Muse CLI" : runner || "Muse CLI");

function pipeline(steps) {
  if (!steps.length) return `<p class="hint">No steps recorded.</p>`;
  return `<div class="pnodes" aria-label="Pipeline">${steps.map((s, i) => {
    const st = stepStatus(s);
    return `${i ? `<span class="pn-arr" aria-hidden="true">→</span>` : ""}<div class="pnode2 ${esc(st)}"><span class="pn-ic">${icon(STEP_IC[st] || "circle")}</span><span><span class="pn-role">${esc(stepName(s))}</span><span class="pn-st">${esc(s.id)} · ${esc(st)}</span></span></div>`;
  }).join("")}</div>`;
}

function stepsList(steps) {
  return steps.map((s, i) => {
    const st = stepStatus(s);
    const open = S.openSteps.has(i);
    return `<div class="acc ${open ? "open" : ""}">
      <button type="button" class="acc-h" data-rstep="${i}" aria-expanded="${open}"><span class="acc-ic ${esc(st)}">${icon(STEP_IC[st] || "circle")}</span><span class="acc-n">${i + 1}</span><span class="acc-role">${esc(stepName(s))}</span><span class="acc-agent">${esc(s.type || "")} · ${esc(s.id)}</span><span class="spacer"></span>${lpill(st)}<span class="acc-chev">${icon("chevron-right")}</span></button>
      ${open ? `<div class="acc-b">${s.text ? `<div class="mdbox">${md(s.text)}</div>` : `<p class="hint">No output.</p>`}<p class="hint">${esc(String(s.at || "").slice(0, 19).replace("T", " "))}</p></div>` : ""}
    </div>`;
  }).join("");
}

export function runDrawer() {
  const r = automationRuns().find((x) => x.id === S.runSel);
  const close = `<button type="button" class="btn ghost sm" id="dclose" aria-label="Close run detail">${icon("x")} Close</button>`;
  let panel;
  if (!r) panel = `<div class="detail"><div class="dhead"><span class="spacer"></span>${close}</div><p class="dim" role="status">This run is no longer in the recent list.</p></div>`;
  else {
    const st = runStatus(r);
    const steps = r.steps || [];
    const done = steps.filter((s) => stepStatus(s) === "done").length;
    const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
    const dur = r.startedAt && r.finishedAt ? `${Math.max(0, Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000))}s` : "—";
    panel = `<div class="detail ldetail">
    <div class="dhead ldhead"><span class="mono">${esc(String(r.id).slice(0, 8))}</span>${lpill(st)}<span class="spacer"></span>${close}</div>
    <div class="ldtitle">${esc(r.title || r.workflow)}</div>
    <p class="ldesc">${esc(kindLabel(r))} · ${esc(r.workflow || "")}</p>
    <div class="lprog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Run progress"><span style="width:${pct}%"></span></div>
    <div class="lprog-l">${done}/${steps.length} steps</div>
    ${r.error ? `<div class="status bad" role="alert"><b>Error:</b> ${esc(r.error)}</div>` : ""}
    <nav class="tabs" role="tablist" aria-label="Run detail tabs">${[["overview", "Overview", "file-text"], ["sessions", `Sessions${S.runDetail?.id === r.id ? ` (${runSessions().length})` : ""}`, "terminal"]].map(([v, l, ic]) => `<button type="button" role="tab" aria-selected="${S.runTab === v}" class="tab ${S.runTab === v ? "on" : ""}" data-rtab="${v}">${icon(ic)} ${esc(l)}</button>`).join("")}</nav>
    <div class="dbody" role="tabpanel">${S.runTab === "sessions" ? sessionsPane(r) : `
    <div class="lsec-h">${icon("workflow")} Pipeline</div>${pipeline(steps)}
    <div class="lsec-h">Steps</div>${stepsList(steps)}
    ${r.trigger?.text ? `<div class="lsec-h">Trigger</div><div class="mdbox">${md(r.trigger.text)}</div>` : ""}
    <div class="lsec-h">Details</div>
    <div class="sessgrid"><span>Flow</span><span>${esc(r.workflow || "—")}</span><span>Origin</span><span>${esc(kindLabel(r))}</span><span>Started</span><span>${esc(String(r.startedAt || "").slice(0, 19).replace("T", " "))}</span><span>Duration</span><span>${dur}</span><span>Tokens</span><span>${r.tokens ? Number(r.tokens).toLocaleString() : "—"}</span></div>`}</div>
    </div>`;
  }
  return `<div class="tdrawer-backdrop" data-drawer-backdrop aria-hidden="true"></div><aside class="tdrawer" id="task-detail-drawer" role="dialog" aria-modal="true" aria-label="Run detail" tabindex="-1">${panel}</aside>`;
}

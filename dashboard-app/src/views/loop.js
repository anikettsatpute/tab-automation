// OrchestratorLoop board: task rows, attention banners, task detail drawer
// (Overview / Steps / Activity / Diagrams / Sessions). Pure render — events in main.js.
import { S, esc, ago } from "./state.js";
import { icon, pageHead, emptyState, toolbar, searchBox, selectBox } from "./ui.js";
import { md } from "./md.js";
import { chatView } from "./chat.js";

export const LOOP_STATUSES = ["queued", "running", "blocked", "failed", "done", "cancelled"];
const TONE = { queued: "", running: "run", blocked: "orange", failed: "bad", done: "ok", cancelled: "", pending: "", skipped: "" };
const STEP_IC = { done: "check-circle-2", running: "loader", failed: "x-circle", blocked: "octagon-alert", pending: "circle", skipped: "circle-dashed" };

export const lpill = (st) => `<span class="tag ${TONE[st] || ""}">${esc(String(st || "—").replace(/^\w/, (c) => c.toUpperCase()))}</span>`;

/** Inline n/m progress ring (svg). */
export function ring(done, total, status) {
  const r = 14, c = 2 * Math.PI * r;
  const pct = total ? Math.min(1, done / total) : 0;
  const cls = status === "blocked" ? "bad" : status === "failed" ? "fail" : status === "running" ? "run" : "";
  return `<svg class="ring ${cls}" viewBox="0 0 34 34" role="img" aria-label="${done} of ${total} steps"><circle class="trk" cx="17" cy="17" r="${r}"/><circle class="val" cx="17" cy="17" r="${r}" stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 17 17)"/><text x="17" y="17">${done}/${total}</text></svg>`;
}

const matches = (t, q) => !q || `#${t.seq} ${t.title} ${t.end_goal} ${t.task_type}`.toLowerCase().includes(q);
const sortTasks = (list) => S.sortBy === "seq"
  ? [...list].sort((a, b) => b.seq - a.seq)
  : [...list].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

export function filteredLoopTasks() {
  const q = (S.q || "").toLowerCase().trim();
  const all = (S.loopTasks || []).filter((t) => matches(t, q));
  return S.statusFilter ? all.filter((t) => t.status === S.statusFilter) : all;
}

export function loopBanners() {
  const blocked = (S.loopTasks || []).filter((t) => t.status === "blocked");
  const failed = (S.loopTasks || []).filter((t) => t.status === "failed");
  if (!blocked.length && !failed.length) return "";
  const b = (t, tone, ic, label) => `<button type="button" class="lbanner ${tone}" data-sel="${esc(t.id)}">${icon(ic)}<b>${esc(t.title.slice(0, 80))}</b><span class="mono">#${t.seq} · ${label}</span></button>`;
  return `<div class="lbanners" role="region" aria-label="Needs attention">${blocked.slice(0, 2).map((t) => b(t, "orange", "octagon-alert", "Blocked")).join("")}${failed.slice(0, 2).map((t) => b(t, "violet", "x-circle", "Failed")).join("")}</div>`;
}

function row(t) {
  const roles = (t.roles || []).map((r) => `<span class="rchip ${esc(r.status)}">${esc(r.role)}</span>`).join("");
  return `<button type="button" class="lrow ${S.sel === t.id ? "sel" : ""}" data-sel="${esc(t.id)}" aria-current="${S.sel === t.id}">
    ${ring(t.steps_done, t.steps_total, t.status)}
    <span class="lmain"><span class="ltitle"><span class="lseq">#${t.seq}</span>${esc(t.title)}</span>
    <span class="lmeta">${roles}<span>${esc(t.dispatcher === "copilot" ? "Copilot CLI" : "Muse CLI")}${t.model ? ` · ${esc(t.model)}` : ""}</span>${t.task_type ? `<span>· ${esc(t.task_type)}</span>` : ""}</span></span>
    <span class="lright">${lpill(t.status)}<span class="ltime">${ago(t.updated_at)}</span></span>
  </button>`;
}

export function loopBoard(list) {
  if (!list.length) {
    const total = (S.loopTasks || []).length;
    return emptyState("inbox", total ? "No tasks match" : "No tasks yet", total ? "Clear the filter to see everything." : "Submit a request — the divider breaks it into tasks and the loop runs them one at a time.", total ? `<button type="button" class="btn sm ghost" data-clearf>Clear filter</button>` : `<button type="button" class="btn sm primary" id="newtask3">${icon("plus")} New task</button>`);
  }
  const rows = sortTasks(list);
  if (S.groupBy !== "status") return `<div class="lboard" role="group" aria-label="Tasks">${rows.map(row).join("")}</div>`;
  return `<div class="lboard" role="group" aria-label="Tasks">${["running", "blocked", "failed", "queued", "done", "cancelled"].map((st) => {
    const g = rows.filter((t) => t.status === st);
    return g.length ? `<div class="lgroup-h">${esc(st)} · ${g.length}</div>${g.map(row).join("")}` : "";
  }).join("")}</div>`;
}

export function loopBoardHead(list) {
  return `${pageHead("Board", `${list.length} of ${(S.loopTasks || []).length} tasks`, `<button type="button" class="btn sm ${S.groupBy === "status" ? "on" : "ghost"}" id="lgroup" aria-pressed="${S.groupBy === "status"}">${icon("layers")} Group</button>${selectBox("sortby", [["recent", "Recent activity"], ["seq", "By task #"]], S.sortBy, "Sort tasks")}<button type="button" class="btn sm primary" id="newtask2">${icon("plus")} New task</button>`)}
  ${toolbar(searchBox("fq2", S.q, "Filter by title, goal or #id"))}`;
}

// ---------------- detail ----------------
const file = (attemptId, kind) => S.files?.[`${attemptId}:${kind}`];
const fileBox = (attemptId, kind) => {
  const f = file(attemptId, kind);
  if (!f) return "";
  if (f.loading) return `<p class="hint" role="status">Loading ${esc(kind)}…</p>`;
  if (f.error) return `<div class="status bad" role="alert">${esc(f.error)}</div>`;
  return `<pre class="filebox" tabindex="0" aria-label="${esc(kind)} file">${esc(f.text || "(empty)")}</pre>`;
};
const fileBtn = (attemptId, kind, label) => `<button type="button" class="btn sm ${file(attemptId, kind) ? "on" : "ghost"}" data-lfile="${esc(attemptId)}:${kind}" aria-expanded="${!!file(attemptId, kind)}">${esc(label)}</button>`;

function pipelineNodes(steps) {
  if (!steps.length) return `<p class="hint">No steps yet.</p>`;
  return `<div class="pnodes" aria-label="Pipeline">${steps.map((s, i) => `${i ? `<span class="pn-arr" aria-hidden="true">→</span>` : ""}<div class="pnode2 ${esc(s.status)}"><span class="pn-ic">${icon(STEP_IC[s.status] || "circle")}</span><span><span class="pn-role">${esc(s.role)}</span><span class="pn-st">${esc(s.status)}</span></span></div>`).join("")}</div>`;
}

function overviewTab(d) {
  const t = d.task;
  return `${t.blocked_reason ? `<div class="status bad" role="alert"><b>Blocked:</b> ${esc(t.blocked_reason)}</div>` : ""}
  <div class="lsec-h">${icon("workflow")} Pipeline</div>${pipelineNodes(d.steps)}
  <div class="lsec-h">End goal</div><div class="mdbox">${md(t.end_goal || t.title)}</div>
  ${d.request ? `<div class="lsec-h">Original request</div><div class="mdbox">${md(d.request.text)}</div><p class="hint">Request ${esc(d.request.id)} · ${esc(d.request.mode)} · ${esc(d.request.status)}</p>` : ""}
  <div class="lsec-h">handoff.md</div>
  <button type="button" class="btn sm ${S.handoff != null ? "on" : "ghost"}" id="lhandoff">${icon("file-text")} ${S.handoff != null ? "Hide handoff" : "View handoff"}</button>
  ${S.handoff != null ? `<div class="mdbox" style="margin-top:8px">${md(S.handoff || "_Empty — no step has written a handoff yet._")}</div>` : ""}
  <div class="lsec-h">Details</div>
  <div class="sessgrid"><span>Dispatcher</span><span>${esc(t.dispatcher)}</span><span>Model</span><span>${esc(t.model || "agent default")}</span><span>Repo</span><span>${esc(t.repo || "—")}</span><span>Workspace</span><span>${esc(t.workspace)}</span><span>Re-queues</span><span>${t.requeue_count}</span><span>Created</span><span>${esc(String(t.created_at).slice(0, 19).replace("T", " "))}</span></div>`;
}

function stepsTab(d) {
  return d.steps.map((s) => {
    const open = S.openSteps.has(s.pos);
    const atts = d.attempts.filter((a) => a.pos === s.pos);
    const last = atts[atts.length - 1];
    return `<div class="acc ${open ? "open" : ""}">
      <button type="button" class="acc-h" data-lstep="${s.pos}" aria-expanded="${open}"><span class="acc-ic ${esc(s.status)}">${icon(STEP_IC[s.status] || "circle")}</span><span class="acc-n">${s.pos + 1}</span><span class="acc-role">${esc(s.role)}</span><span class="acc-agent">${esc(last?.model || "")}</span><span class="spacer"></span>${lpill(s.status)}<span class="acc-chev">${icon("chevron-right")}</span></button>
      ${open ? `<div class="acc-b">
        <p class="hint"><b>Goal:</b> ${esc(s.goal)}</p>
        ${s.guidance ? `<p class="hint"><b>Operator guidance:</b> ${esc(s.guidance)}</p>` : ""}
        ${s.summary ? `<div class="lsec-h">Summary</div><div class="mdbox">${md(s.summary)}</div>` : ""}
        ${s.output ? `<div class="lsec-h">Output</div><div class="mdbox">${md(s.output)}</div>` : ""}
        ${!s.summary && !s.output ? `<p class="hint">No output yet.</p>` : ""}
        ${atts.length ? `<div class="vtoggles">${atts.map((a) => fileBtn(a.id, "prompt", `Full prompt sent to the agent — variant ${a.attempt}`)).join("")}${last ? fileBtn(last.id, "context", "View context sent") + fileBtn(last.id, "result", "Result JSON") : ""}</div>
        ${atts.map((a) => fileBox(a.id, "prompt")).join("")}${last ? fileBox(last.id, "context") + fileBox(last.id, "result") : ""}` : ""}
        <label class="fld"><span>Re-run from this step</span><textarea id="lrq-${s.pos}" rows="2" placeholder="- What should this step do differently? (optional)"></textarea></label>
        <p class="hint">Earlier steps keep their output; this step and everything after it reset.</p>
        <button type="button" class="btn sm primary" data-lrq="${s.pos}">${icon("rotate-ccw")} Re-queue from step ${s.pos + 1}</button>
      </div>` : ""}
    </div>`;
  }).join("") || `<p class="hint">No steps.</p>`;
}

function activityTab(d) {
  const ev = [...(d.events || [])].reverse();
  return ev.length ? `<ol class="tl" aria-label="Task activity">${ev.map((e) => `<li class="tl-i"><span class="tl-dot ${esc(e.kind)}" aria-hidden="true"></span><span><span class="tl-k">${esc(e.kind)}</span>${esc(e.message)}</span><span class="tl-at" title="${esc(e.created_at)}">${ago(e.created_at)}</span></li>`).join("")}</ol>` : `<p class="hint">No activity yet.</p>`;
}

/** Auto pipeline diagram from step data (labels are role ids + fixed words — mermaid-safe). */
export function pipelineMermaid(steps) {
  const safe = (s) => String(s).replace(/[^\w .-]/g, "");
  const lines = ["flowchart LR"];
  steps.forEach((s, i) => {
    lines.push(`  s${i}["${i + 1}. ${safe(s.role)}<br/>${safe(s.status)}"]`);
    if (i) lines.push(`  s${i - 1} --> s${i}`);
  });
  lines.push("  classDef done stroke:#3fb950,stroke-width:2px", "  classDef running stroke:#58a6ff,stroke-width:2px", "  classDef failed stroke:#f85149,stroke-width:2px", "  classDef blocked stroke:#f0883e,stroke-width:2px");
  steps.forEach((s, i) => { if (["done", "running", "failed", "blocked"].includes(s.status)) lines.push(`  class s${i} ${s.status}`); });
  return lines.join("\n");
}

export function diagramsList(d) {
  const auto = d.steps.length ? [{ id: "pipeline", title: "Task pipeline", body: pipelineMermaid(d.steps), meta: `${d.steps.length} steps · live` }] : [];
  return [...auto, ...d.artifacts.filter((a) => a.kind === "diagram" && a.body).map((a) => ({ id: a.id, title: a.title || "Diagram", body: a.body, meta: `step ${a.pos + 1} · attempt ${a.attempt} · ${String(a.created_at).slice(0, 16).replace("T", " ")}` }))];
}
const mmd = (body) => `<div data-mermaid data-src="${esc(body)}"><div class="mmd-out" aria-busy="true"><p class="hint">Rendering diagram…</p></div></div>`;

/** Link artifacts carry the URL in `body`. Only http(s) URLs become anchors. */
export const isSafeLinkUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || "").trim());

/** A link-kind artifact as a real clickable anchor (new tab, no opener). */
export function linkCard(a) {
  const url = String(a?.body || "").trim();
  const label = a?.title || url || "Link";
  if (!isSafeLinkUrl(url)) return `<div class="dgcard"><b>${esc(label)}</b> <span class="kbd">link</span>${url ? `<div class="mdbox" style="margin-top:6px">${md(url)}</div>` : ""}</div>`;
  return `<div class="dgcard"><b><a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a></b> <span class="kbd">link</span><div class="hint">${esc(url)}</div></div>`;
}

function diagramsTab(d) {
  const list = diagramsList(d);
  const files = d.artifacts.filter((a) => a.kind !== "diagram");
  return (list.map((g) => `<div class="dgcard"><div class="row"><b>${esc(g.title)}</b><span class="hint">${esc(g.meta)}</span><span class="spacer"></span><button type="button" class="btn sm ghost" data-dgopen="${esc(g.id)}">${icon("maximize-2")} Open</button></div>${mmd(g.body)}</div>`).join("") || `<p class="hint">No diagrams yet. Agents can emit <span class="kbd">artifacts[{kind:"diagram", body:"flowchart…"}]</span>.</p>`)
    + (files.length ? `<div class="lsec-h">Other artifacts</div>${files.map((a) => (a.kind === "link" ? linkCard(a) : `<div class="dgcard"><b>${esc(a.title)}</b> <span class="kbd">${esc(a.kind)}</span>${a.path ? ` <span class="hint">${esc(a.path)}</span>` : ""}${a.body ? `<div class="mdbox" style="margin-top:6px">${md(a.body)}</div>` : ""}</div>`)).join("")}` : "");
}

export function diagramFull(d) {
  if (!S.diagFull || !d) return "";
  const g = diagramsList(d).find((x) => x.id === S.diagFull);
  if (!g) return "";
  return `<div class="modal full" role="dialog" aria-modal="true" aria-label="${esc(g.title)}"><div class="mbox"><div class="dhead"><b>${esc(g.title)}</b><span class="hint">${esc(g.meta)}</span><span class="spacer"></span><span class="pz-hint">Scroll to pan · Ctrl+scroll to zoom</span><button type="button" class="btn ghost sm" id="diagx">${icon("x")} Close</button></div><div class="pzwrap" data-panzoom>${mmd(g.body)}</div></div></div>`;
}

function sessionsTab(d) {
  const atts = d.attempts;
  if (!atts.length) return `<p class="hint">No sessions yet — the loop dispatches one agent session per step attempt.</p>`;
  const i = Math.min(S.sessIdx, atts.length - 1);
  const a = atts[i];
  return `<label class="fld"><span>Session</span><select id="lsess">${atts.map((x, k) => `<option value="${k}" ${k === i ? "selected" : ""}>${k}. ${esc(x.role)} - ${esc(String(x.created_at).slice(0, 16).replace("T", " "))} - ${esc(x.context === "fresh" ? "Fresh" : x.context)}</option>`).join("")}</select></label>
  <div class="sessgrid"><span>Runner</span><span>${esc(a.dispatcher === "copilot" ? "GitHub Copilot CLI" : "Muse CLI")}</span><span>Session</span><span>${esc(a.session_id || "—")}</span><span>Agent</span><span>${esc(a.role)} · step ${a.pos + 1} · attempt ${a.attempt}</span><span>Model</span><span>${esc(a.model || "default")}</span><span>Workspace</span><span>${esc(a.workspace)}</span><span>Context</span><span>${esc(a.context)}</span><span>Status</span><span>${esc(a.status)}${a.exit_code != null ? ` · exit ${a.exit_code}` : ""}${a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(1)}s` : ""}</span>${a.error ? `<span>Error</span><span>${esc(a.error)}</span>` : ""}</div>
  <div class="vtoggles">${fileBtn(a.id, "transcript", "Raw transcript")}${fileBtn(a.id, "prompt", "Prompt")}${fileBtn(a.id, "result", "Result JSON")}</div>
  ${fileBox(a.id, "transcript")}${fileBox(a.id, "prompt")}${fileBox(a.id, "result")}
  <div class="lsec-h">${icon("terminal")} Session</div>
  <div data-chatload="loop:${esc(a.id)}">${chatView(S.chats?.[`loop:${a.id}`] || { loading: true }, `loop:${a.id}`)}</div>`;
}

export function loopDetailPane(d) {
  const t = d.task;
  const tabs = [["overview", "Overview", "file-text"], ["steps", `Steps (${d.steps.length})`, "list-ordered"], ["activity", `Activity (${(d.events || []).length})`, "activity"], ["diagrams", "Diagrams", "git-branch"], ["sessions", "Sessions", "terminal"]];
  const pct = t.steps_total ? Math.round((t.steps_done / t.steps_total) * 100) : 0;
  const tab = S.detailTab;
  const body = tab === "steps" ? stepsTab(d) : tab === "activity" ? activityTab(d) : tab === "diagrams" ? diagramsTab(d) : tab === "sessions" ? sessionsTab(d) : overviewTab(d);
  return `<div class="detail ldetail">
  <div class="dhead ldhead"><span class="mono">#${t.seq}</span>${lpill(t.status)}<span class="spacer"></span><button type="button" class="btn ghost sm" id="dclose" aria-label="Close task detail">${icon("x")} Close</button></div>
  <div class="ldtitle">${esc(t.title)}</div>
  <p class="ldesc">${esc(t.status_note || String(t.end_goal || "").split("\n")[0].slice(0, 200))}</p>
  <div class="lprog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Task progress"><span style="width:${pct}%"></span></div>
  <div class="lprog-l">${t.steps_done}/${t.steps_total} steps</div>
  <div class="lacts">
    ${t.status !== "done" ? `<button type="button" class="btn sm okbtn" data-lact="mark_done">${icon("check")} Mark done</button>` : ""}
    <button type="button" class="btn sm" data-lact="append">${icon("plus")} Append task</button>
    <button type="button" class="btn sm" data-lact="requeue">${icon("rotate-ccw")} Re-queue</button>
    <button type="button" class="btn sm danger" data-lact="delete">${icon("trash-2")} ${S.confirmDel ? "Press again to delete" : "Delete"}</button>
  </div>
  ${S.appendForm ? appendForm() : ""}
  <nav class="tabs" role="tablist" aria-label="Task detail tabs">${tabs.map(([v, l, ic]) => `<button type="button" role="tab" aria-selected="${tab === v}" class="tab ${tab === v ? "on" : ""}" data-dtab="${v}">${icon(ic)} ${esc(l)}</button>`).join("")}</nav>
  <div class="dbody" role="tabpanel">${body}</div>
  </div>`;
}

function appendForm() {
  const roles = (S.loopAgents || []).map((a) => a.id);
  return `<div class="appr" role="group" aria-label="Append task"><b>Append a follow-up task</b>
  <label class="fld"><span>Title</span><input id="ap-title" placeholder="Follow-up task title"></label>
  <div class="row"><label class="fld"><span>Agent</span><select id="ap-role">${roles.map((r) => `<option ${r === "coder" ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
  <label class="fld" style="flex:1"><span>Step goal</span><input id="ap-goal" placeholder="What should the agent do?"></label></div>
  <label class="row"><input type="checkbox" id="ap-after" checked> <span class="hint">Run after this task finishes</span></label>
  <div class="row"><button type="button" class="btn sm primary" id="ap-go">${icon("plus")} Append</button><button type="button" class="btn sm ghost" id="ap-cancel">Cancel</button></div></div>`;
}

export function loopDrawer() {
  const d = S.detail?.task ? S.detail : null;
  const panel = d ? loopDetailPane(d) : `<div class="detail" aria-busy="${!S.detailError}"><div class="dhead"><span class="spacer"></span><button type="button" class="btn ghost sm" id="dclose" aria-label="Close task detail">${icon("x")} Close</button></div>${S.detailError ? `<div class="status bad" role="alert">${esc(S.detailError)}</div><button type="button" class="btn sm" id="detail-retry">${icon("refresh-cw")} Retry</button>` : `<p class="dim" role="status">Loading task details...</p>`}</div>`;
  return `<div class="tdrawer-backdrop" data-drawer-backdrop aria-hidden="true"></div><aside class="tdrawer" id="task-detail-drawer" role="dialog" aria-modal="true" aria-label="Task detail" tabindex="-1">${panel}</aside>`;
}

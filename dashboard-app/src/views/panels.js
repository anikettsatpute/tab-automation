// Secondary views: config, agents, tools, brain, requests, outbox, retro,
// automations, todos, logs, request modal, command palette.
// Pure render functions — state + events live in main.js.
import { S, esc, agentIds } from "./state.js";
import { lpill } from "./loop.js";
import { chatView } from "./chat.js";
import { pageHead, statRow, emptyState, section, pill, toolbar, searchBox, selectBox, icon } from "./ui.js";
export function agentsView() {
  return `
  ${pageHead("Agents", `${(S.agents || []).length} configured`)}
  ${statRow([
    { icon: "bot", label: "Agents", value: (S.agents || []).length },
    { icon: "layers", label: "Runs (30d)", value: (S.agents || []).reduce((n, a) => n + (a.runs ?? 0), 0) },
    { icon: "coins", label: "Tokens (30d)", value: (S.agents || []).reduce((n, a) => n + (a.tokens ?? 0), 0).toLocaleString() },
  ])}
  <div class="agrid">${(S.agents || []).map((a) => `
    <div class="card agent"><h3>${icon("bot")} ${esc(a.id)}</h3><p class="desc">${esc(a.description || "—")}</p>
    <p><span class="kbd">${esc(a.model || a.provider || "default")}</span></p>
    <div class="arow"><span>${icon("layers")} Runs</span><b>${a.runs ?? 0}</b></div>
    <div class="arow"><span>${icon("coins")} Tokens</span><b>${(a.tokens ?? 0).toLocaleString()}</b></div></div>`).join("") || emptyState("bot", "No agents", "Add agents in config/agents.json.")}</div>`;
}

export function toolsView() {
  const ok = (S.tools || []).filter((t) => t.auth !== "needed").length;
  return `
  ${pageHead("Tools", `${(S.tools || []).length} tools · ${ok} authed`)}
  ${statRow([
    { icon: "wrench", label: "Tools", value: (S.tools || []).length },
    { icon: "check-circle-2", label: "Authed", value: ok, tone: "ok" },
    { icon: "key-round", label: "Need sign-in", value: (S.tools || []).length - ok, tone: (S.tools || []).length - ok ? "warn" : "" },
  ])}
  ${section("Tool registry", `<div class="tblwrap"><table class="tbl"><thead><tr><th>Tool</th><th>Kind</th><th>Auth</th><th>Calls</th><th>Avg ms</th></tr></thead><tbody>
  ${(S.tools || []).map((t) => `<tr><td><b>${esc(t.id)}</b></td><td>${esc(t.kind)}</td>
  <td>${t.auth === "needed" ? pill("failed") + ` <span class="hint">sign-in</span>` : pill("done")}</td>
  <td>${t.calls ?? 0}</td><td>${t.avgMs ?? 0}</td></tr>`).join("") || `<tr><td colspan="5">${emptyState("wrench", "No tools", "Connect MCP servers in config/tools.json.")}</td></tr>`}</tbody></table></div>`)}`;
}

export function brainView() {
  const b = S.brain || { messages: [], poller: {}, metrics: {} };
  const m = b.metrics || {};
  const all = (b.messages || []).filter((x) =>
    !S.brainQ || ((x.messageText || x.text || "") + " " + (x.sender || "") + " " + (x.jobId || x.id || "")).toLowerCase().includes(S.brainQ.toLowerCase()));
  const limit = S.brainLimit || 30;
  const msgs = all.slice(0, limit);
  const sel = S.brainSel ? all.find((x) => (x.id || x.jobId) === S.brainSel) || msgs.find((x) => (x.id || x.jobId) === S.brainSel) : null;
  const txt = (x) => x.messageText || x.text || "";
  const ts = (x) => x.receivedAt || x.ts || "";
  const st = (x) => x.processingStatus || x.status || "queued";
  return `
  ${pageHead("Messages", `${msgs.length} shown`, `<span class="hint">${icon("rss")} poller ${b.poller?.enabled ? "on" : "off"} · ${b.poller?.intervalMin || 2} min · #${esc(b.poller?.channel || "discord")}</span>`)}
  ${statRow([
    { icon: "inbox", label: "Incoming", value: m.incoming ?? msgs.length },
    { icon: "clock", label: "Queued", value: m.queued ?? 0 },
    { icon: "loader", label: "Running", value: m.running ?? 0, tone: "run" },
    { icon: "x-circle", label: "Failed", value: m.failed ?? 0, tone: "bad" },
    { icon: "send", label: "Outbox", value: S.outbox.length },
    { icon: "check-circle-2", label: "Sent", value: m.replied ?? 0, tone: "ok" },
  ])}
  <p class="hint">Last scan: ${esc(b.poller?.lastScan ? String(b.poller.lastScan).slice(0, 19).replace("T", " ") : "—")}</p>
  ${toolbar(searchBox("brain-q", S.brainQ, "Search message, sender, chat or job ID") + `<span class="hint">showing ${msgs.length} of ${all.length}</span>` + (all.length > limit ? `<button type="button" class="btn sm ghost" id="brain-more">Show more (${Math.min(30, all.length - limit)} more)</button>` : ""))}
  <div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Received</th><th scope="col">Sender / source</th><th scope="col">Incoming message</th><th scope="col">Processing</th><th scope="col">Outbox</th></tr></thead><tbody>
  ${msgs.map((x) => { const id = x.id || x.jobId; return `<tr data-brain="${esc(id)}" style="cursor:pointer;${S.brainSel === id ? "background:var(--acc-soft);" : ""}"><td class="dim">${esc(String(ts(x)).slice(0, 16).replace("T", " "))}</td>
  <td>${esc(x.sender)}<br><span class="hint">${esc(x.source || x.channelId || "discord")}</span></td>
  <td class="dim">${esc(String(txt(x)).slice(0, 160))}<br><span class="hint">${esc(x.jobId || x.id || "")}</span></td>
  <td>${pill(st(x) === "failed" ? "failed" : st(x) === "reply_generated" || st(x) === "replied" ? "done" : "running")}<br><span class="hint">${esc(st(x))}</span></td>
  <td class="hint">${esc(x.outboxSummary || (st(x) === "replied" || st(x) === "reply_generated" ? "1 sent" : "—"))}</td></tr>`; }).join("") || `<tr><td colspan="5">${emptyState("brain", "No messages", "Discord mentions will land here.")}</td></tr>`}
  </tbody></table></div>
  ${sel ? `<div class="appr" role="dialog" aria-modal="false" aria-label="Message details" id="brain-drawer"><div class="row"><b>Message</b><span class="kbd">${esc(sel.id || sel.jobId || "")}</span><span class="spacer"></span><button class="btn sm ghost" id="brainx" aria-label="Close message details">${icon("x")}</button></div>
  <div class="row"><button class="tab ${S.brainTab === "details" ? "on" : ""}" data-btab2="details">${icon("file-text")} Message details</button><button class="tab ${S.brainTab === "session" ? "on" : ""}" data-btab2="session">${icon("terminal")} Session</button></div>
  ${S.brainTab === "details" ? `<div class="grid2"><span>Job ID</span><span class="kbd">${esc(sel.jobId || sel.id || "")}</span><span>Actor ID</span><span class="kbd">${esc(sel.actorId || "—")}</span><span>Conversation</span><span class="kbd">${esc(sel.conversationId || sel.channelId || "—")}</span><span>Updated</span><span>${esc(String(ts(sel)).slice(0, 19).replace("T", " "))}</span></div>
  ${sel.linkedTaskId ? `<p class="dim">Linked work: <span class="kbd">${esc(sel.linkedTaskId)}</span></p>` : ""}
  ${sel.processingError ? `<div class="status bad">${esc(sel.processingError)}</div>` : ""}
  <p class="dim">From <b>${esc(sel.sender)}</b> · status ${esc(st(sel))}</p><div class="endgoal">${esc(String(txt(sel)).slice(0, 2000))}</div>
  ${sel.requestText ? `<p class="dim">Request:</p><pre class="out">${esc(String(sel.requestText).slice(0, 1000))}</pre>` : ""}`
  : brainSession(sel)}</div>` : ""}</div>`;
}

function brainSession(sel) {
  const key = `brain:${sel.id}`;
  const s = S.chats?.[key];
  const r = s?.router || null;
  const d = r?.decision || null;
  const head = `<div class="sessgrid"><span>Runner</span><span>${esc(r?.dispatcher === "copilot" ? "GitHub Copilot CLI" : r?.dispatcher === "muse" ? "Muse CLI" : "Keyword router (no AI session)")}</span>
  ${r?.sessionId ? `<span>Session</span><span class="kbd">${esc(r.sessionId)}</span>` : ""}
  ${d ? `<span>Decision</span><span><b>${esc(d.action)}</b>${d.automationId ? ` · ${esc(d.automationId)}` : ""}${d.taskType ? ` · ${esc(d.taskType)}` : ""}</span><span>Why</span><span>${esc(d.reason || "—")}</span>` : ""}
  ${d?.goal ? `<span>Goal</span><span>${esc(d.goal)}</span>` : ""}
  ${d?.question ? `<span>Asked</span><span>${esc(d.question)}</span>` : ""}
  ${r?.durationMs ? `<span>Duration</span><span>${(r.durationMs / 1000).toFixed(1)}s${r.exitCode != null ? ` · exit ${r.exitCode}` : ""}</span>` : ""}
  ${r?.error ? `<span>Error</span><span>${esc(r.error)}</span>` : ""}
  ${sel.linkedTaskId ? `<span>Linked work</span><span class="kbd">${esc(sel.linkedTaskId)}</span>` : ""}</div>`;
  const tasks = (s?.tasks || []).length ? `<div class="lsec-h">${icon("list-ordered")} Pipeline tasks</div><ul class="plain">${s.tasks.map((t) => `<li><button type="button" class="btn sm ghost" data-gotask="${esc(t.id)}">#${esc(t.seq)} ${esc(t.title)}</button> ${lpill(t.status)}</li>`).join("")}</ul>` : "";
  // Full pipeline detail (steps, attempts, artifacts, events) when the
  // backend provides it — same shape as the Board task drawer.
  const steps = (s?.steps || []).length ? `<div class="lsec-h">${icon("list-ordered")} Steps</div>${s.steps.map((x) => `<div class="row"><span class="kbd">${x.pos + 1}</span><b>${esc(x.role)}</b><span class="hint">${esc(String(x.goal || "").slice(0, 80))}</span><span class="spacer"></span>${lpill(x.status)}</div>${x.summary ? `<div class="mdbox" style="margin:4px 0">${esc(String(x.summary).slice(0, 500))}</div>` : ""}`).join("")}` : "";
  const taskId = (s?.tasks || [])[0]?.id || "";
  const attempts = (s?.attempts || []).length ? `<div class="lsec-h">${icon("terminal")} Agent sessions (${s.attempts.length})</div>${s.attempts.map((a) => `<div class="row"><span class="kbd">${esc(a.role)}</span><span class="hint">step ${a.pos + 1} · attempt ${a.attempt} · ${esc(a.dispatcher === "copilot" ? "Copilot" : "Muse")}${a.model ? ` · ${esc(a.model)}` : ""}${a.duration_ms ? ` · ${(a.duration_ms / 1000).toFixed(0)}s` : ""}</span><span class="spacer"></span>${lpill(a.status)}</div><div data-chatload="loop:${esc(a.id)}" data-task="${esc(taskId)}">${chatView(S.chats?.[`loop:${a.id}`] || { loading: a.status === "running" }, `loop:${a.id}`)}</div>`).join("")}` : "";
  const artifacts = (s?.artifacts || []).length ? `<div class="lsec-h">${icon("file-plus")} Artifacts (${s.artifacts.length})</div>${s.artifacts.map((a) => `<div class="dgcard"><b>${esc(a.title || a.kind)}</b> <span class="kbd">${esc(a.kind)}</span>${a.path ? ` <span class="hint">${esc(a.path)}</span>` : ""}${a.kind === "link" && a.body ? ` <a href="${esc(a.body)}" target="_blank" rel="noopener">${esc(a.body.slice(0, 80))}</a>` : ""}${a.kind !== "link" && a.body ? `<div class="mdbox" style="margin-top:6px">${esc(String(a.body).slice(0, 500))}</div>` : ""}</div>`).join("")}` : "";
  return `<div data-chatload="${esc(key)}">${!s || s.loading ? `<p class="hint" role="status">Loading session…</p>` : s.error ? `<div class="status bad" role="alert">${esc(s.error)}</div>` : `${head}${tasks}${steps}${attempts}${artifacts}
  ${s.prompt ? `<details><summary class="hint">Router prompt</summary><pre class="out">${esc(s.prompt)}</pre></details>` : ""}
  <div class="lsec-h">${icon("terminal")} Router session</div>${s.chat ? chatView(s.chat, key) : `<p class="hint">No CLI session for this message.</p>`}`}</div>`;
}

export function requestsView() {
  const reqs = S.loopRequests || [];
  return `
  ${pageHead("Requests", `${reqs.length} filed`, `<button type="button" class="btn sm primary" id="newtask2">${icon("plus")} New task</button>`)}
  <p class="hint">Raw goals. The divider breaks each request into tasks; the loop runs them one at a time. Newest first.</p>
  ${reqs.map((r) => `<div class="appr"><div class="row">${icon("inbox")}<b>${esc(String(r.text || "").slice(0, 90))}</b><span class="spacer"></span>${lpill(r.status)}</div>
  <p class="hint">${esc(r.mode)} · ${esc(r.dispatcher === "copilot" ? "Copilot CLI" : "Muse CLI")}${r.model ? ` · ${esc(r.model)}` : ""}${r.task_type ? ` · type ${esc(r.task_type)}` : ""} · ${esc(String(r.created_at || "").slice(0, 16).replace("T", " "))}${r.error ? ` · <span class="bad">${esc(r.error)}</span>` : ""}</p>
  ${(r.tasks || []).length ? `<div class="row">${r.tasks.map((t) => `<button type="button" class="btn sm ghost" data-gotask="${esc(t.id)}">#${t.seq} ${esc(String(t.title).slice(0, 40))} · ${esc(t.status)}</button>`).join("")}</div>` : ""}</div>`).join("") || emptyState("inbox", "No requests yet", "Hit + New task to file your first goal.")}</div>`;
}


export function retroView() {
  const r = S.retro;
  if (!r) return `<div class="card" aria-busy="true"><h3>Retro</h3><div class="skel" style="height:18px;width:50%"></div><div class="skel" style="height:12px;width:85%"></div><p class="hint">Loading retrospective…</p></div>`;
  const byStatus = (r.byStatus || []).map((s) => ({ icon: s.status === "done" ? "check-circle-2" : s.status === "failed" ? "x-circle" : "loader", label: s.status, value: s.c, tone: s.status === "done" ? "ok" : s.status === "failed" ? "bad" : "run" }));
  return `
  ${pageHead("Retro", `last ${esc(String(r.since || "").slice(0, 10))} → now`)}
  ${statRow([
    { icon: "layers", label: "Total runs", value: (r.total || r.runs)?.c ?? 0 },
    { icon: "timer", label: "Avg duration", value: `${Math.round((r.total || r.runs)?.avgSec || 0)}s` },
    { icon: "coins", label: "Tokens", value: Number((r.total || r.runs)?.t || 0).toLocaleString() },
    { icon: "wrench", label: "Tool calls", value: (r.total || r.runs)?.tc ?? 0 },
  ])}
  ${r.pipelines ? section("By source", `<table class="tbl"><thead><tr><th>Source</th><th>Runs</th><th>Tokens</th><th>Tool calls</th><th>Avg</th></tr></thead><tbody>
    ${[["Automations", r.automations], ["Agent pipelines", r.pipelines]].map(([l, x]) => `<tr><td>${l}</td><td>${x?.c ?? 0}</td><td>${Number(x?.t || 0).toLocaleString()}</td><td>${x?.tc ?? 0}</td><td>${Math.round(x?.avgSec || 0)}s</td></tr>`).join("")}
  </tbody></table><p class="hint">Pipeline tokens come from the Muse CLI usage stream (Copilot CLI reports premium requests, not tokens). Automation tokens and tool calls are agent self-reports and undercount.</p>`) : ""}
  ${section("Runs by status", byStatus.length ? `<div class="mrow">${byStatus.map((s) => `<span class="m ${s.tone}">${icon(s.icon)} ${esc(s.label)} <b>${s.value}</b></span>`).join("")}</div>` : `<p class="hint">—</p>`)}
  ${section("Delivery velocity", `<div class="chartbox"><canvas id="retro-chart" height="120"></canvas></div>`, `<span class="hint">${(r.byDay || []).length} days</span>`)}
  ${section("Retries", (r.retries || []).length ? (r.retries || []).map((s) => `<div class="arow"><span>${esc(s.workflow_id)}</span><b>${s.c}</b></div>`).join("") : `<p class="hint">No repeats — deterministic.</p>`)}`;
}

export function paintRetroChart() {
  try {
    const cv = document.getElementById("retro-chart");
    if (!cv) return;
    const days = (S.retro?.byDay || []).slice(-14);
    // Offline-first: pure-CSS bar fallback always renders (no Chart.js needed).
    // If a bundled Chart.js build is present, enhance to a canvas chart.
    const host = cv.parentElement;
    if (host && !host.querySelector(".fbars")) {
      const max = Math.max(1, ...days.map((d) => Number(d.c) || 0));
      const fb = document.createElement("div");
      fb.className = "fbars";
      fb.setAttribute("role", "img");
      fb.setAttribute("aria-label", `Delivery velocity: ${days.length} days`);
      fb.innerHTML = days.map((d) => `<div class="fbar"><span style="height:${Math.max(3, Math.round((Number(d.c) || 0) / max * 72))}px"></span><i>${esc(String(d.d).slice(5))}</i></div>`).join("") || `<p class="hint">No data</p>`;
      host.appendChild(fb);
    }
    if (!window.Chart) return;
    if (host) { const fb = host.querySelector(".fbars"); if (fb) fb.remove(); }
    if (window._retroChart) window._retroChart.destroy();
    window._retroChart = new window.Chart(cv, {
      type: "bar",
      data: { labels: days.map((d) => String(d.d).slice(5)), datasets: [{ data: days.map((d) => d.c), borderRadius: 5, backgroundColor: "rgba(91,157,255,.65)" }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#8b98ad", font: { size: 10 } }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: "#8b98ad", precision: 0 }, grid: { color: "rgba(42,53,71,.5)" } } } },
    });
  } catch { /* chart lib missing — stat cards still carry the numbers */ }
}

export function flowsView() {
  const TPL = [
    ["triage", "Triage every blocked task", "When a task blocks, an investigator agent reads the evidence and posts a summary to the outbox.", "siren"],
    ["nightly", "Nightly knowledge sweep", "A scheduled agent run — no task, no PR. Good for curation, reporting and housekeeping.", "moon"],
    ["onetime", "One-time: investigate, then fix", "A single run: an agent scopes the problem, a condition gates it, then a real task is enqueued.", "zap"],
  ];
  const ed = S.flowEdit;
  const fb = S.flowMsg ? `<div class="notice ok">${icon("zap")} ${esc(S.flowMsg)}</div>` : "";
  const enabled = (S.flows || []).filter((f) => f.enabled !== false).length;
  return `<div class="flows">${fb}
  ${pageHead("Automations", `${S.flows.length} flow(s) · ${enabled} enabled`, `<button class="btn sm primary" id="flownew">${icon("plus")} New flow</button>`)}
  <p class="hint">Scheduled cron jobs, event-driven policy sweeps, and agent housekeeping routines.</p>
  ${section("Start from a template", `<div class="agrid">${TPL.map(([id, t, d, ic]) => `<button type="button" class="card tpl" data-tpl="${id}"><h3>${icon(ic)} ${esc(t)}</h3><p class="dim">${esc(d)}</p></button>`).join("")}</div>`)}
  ${section("Your flows", (S.flows || []).map((f) => {
    const trig = f.trigger?.type || f.trigger || "manual";
    const preset = trig === "schedule" ? (f.trigger?.preset || f.trigger?.label || `${f.trigger?.timeOfDay || f.trigger?.cron || "Scheduled"}`) : trig === "manual" ? "Manual" : (f.trigger?.rule || "Event");
    const nextRun = f.state?.next_run_at || f.nextRun || f.next_run_at || null;
    const dry = S.flowDryResult?.flowId === f.id ? S.flowDryResult : null;
    return `<div class="flowcard"><div class="row"><div><h3>${esc(f.title || f.id)}</h3><p class="dim">${esc(f.description || "")}</p></div><span class="spacer"></span>
    <button class="btn sm ${f.enabled === false ? "" : "okbtn"}" data-flowen="${esc(f.id)}" aria-pressed="${f.enabled !== false}">${f.enabled === false ? "Enable" : "Enabled"}</button>
    <button class="btn sm ghost" data-flowdry="${esc(f.id)}" ${S.flowDryBusy ? "disabled" : ""}>${S.flowDryBusy && S.flowDryResult?.flowId === f.id ? "Simulating…" : "Dry run"}</button>
    <button class="btn sm primary" data-runflow="${esc(f.id)}">▶ Run</button>
    <button class="btn sm ghost" data-flowedit="${esc(f.id)}">✎ Edit</button>
    <button class="btn sm danger" data-flowdel="${esc(f.id)}">🗑</button></div>
  <div class="row"><span class="kbd">${esc(preset)}</span><span class="kbd">${esc(f.configFileName || f.id + ".json")}</span>
  ${nextRun ? `<span class="hint">Next: ${esc(String(nextRun).slice(0, 16).replace("T", " "))} (backend-computed)</span>` : trig === "schedule" ? `<span class="hint">Next: not reported by backend yet</span>` : ""}<span class="hint">last: ${esc(f.state?.last_status || f.lastStatus || "never")}</span></div>
  ${dry ? (dry.error ? `<div class="status bad" role="alert">Dry run failed: ${esc(dry.error)}</div>` : `<div class="notice ok" role="status">Dry run trace (${esc(String(dry.steps?.length ?? 0))} steps, no side-effects): ${(dry.steps || []).map((s) => esc(typeof s === "string" ? s : (s.wouldDo || s.title || s.step || s.id || s.type))).join(" → ") || "empty"}${dry.note ? ` · ${esc(dry.note)}` : ""}</div>`) : ""}
  <div class="pipe">${(f.steps || []).map((s, i) => `<div class="pnode"><b>${esc(s.title || s.id || s.type)}</b><span>${esc(s.type || "")}</span></div>${i < (f.steps || []).length - 1 ? `<span class="arr">→</span>` : ""}`).join("")}</div></div>`;
  }).join("") || emptyState("workflow", "No flows", "Start from a template above."))}
  ${ed ? `<div class="modal"><div class="mbox wide"><div class="dhead"><b>Edit flow '${esc((ed.configFileName || ed.id || "new").replace(".json", ""))}'</b><span class="spacer"></span><button class="btn ghost sm" id="flowx">✕</button></div>
  <p class="hint">Steps run top to bottom. Reference earlier output with <span class="kbd">{{steps.&lt;id&gt;.output}}</span> and the trigger with <span class="kbd">{{trigger.&lt;field&gt;}}</span>.</p>
  <h4>TRIGGER</h4>
  <div class="row">${[["manual", "Manual only"], ["schedule", "On a schedule"], ["event", "On an event (rule)"]].map(([t, l]) => `<button class="btn sm ${S.flowTrig === t ? "primary" : "ghost"}" data-ftrig="${t}">${l}</button>`).join("")}</div>
  ${S.flowTrig === "schedule" ? `<div class="schedbox">
  <div class="row">${["Every hour", "Every weekday 9:00 AM", "Every day 6:00 PM", "Every Monday 8:30 AM", "Every N minutes"].map((p) => `<button class="btn sm ghost" data-preset="${esc(p)}">${esc(p)}</button>`).join("")}</div>
  <div class="row"><label class="fld"><span>Time of day</span><input id="flow-time" value="${esc(S.flowTime)}"></label>
  <label class="fld"><span>Days</span><div class="row">${["Every day", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<button class="btn sm ${S.flowDays.includes(d) ? "on" : "ghost"}" data-fday="${d}">${d}</button>`).join("")}</div></label></div>
  <p class="hint">🕒 ${esc(S.flowDays.join(", "))} at ${esc(S.flowTime)} · Next run: ${esc(nextRunHint())} · cron <span class="kbd">${esc(S.flowCron || "(auto)")}</span> · <button class="btn sm ghost" id="flowcron">Edit cron</button></p></div>` : ""}
  ${S.flowTrig === "event" ? `<label class="fld"><span>Event rule (e.g. on task blocked, on brain failed)</span><input id="flow-rule" value="${esc(S.flowRule || "")}" placeholder="on task blocked"></label><p class="hint">Event triggers fire only if the backend implements a matching event contract — otherwise the flow stays manual. No silent success.</p>` : ""}
  <div class="row"><h4>STEPS (${(ed.steps || []).length} steps)</h4><span class="spacer"></span><button class="btn sm ghost" id="flowexpand">Expand all</button></div>
  <div class="palette"><span class="hint">Add step:</span>${[["run_agent", "Run agent"], ["create_task", "Create task"], ["file_request", "File request"], ["notify", "Notify"], ["condition", "Condition"], ["run_automation", "Run automation"], ["wait", "Wait"]].map(([t, l]) => `<button class="btn sm ghost" data-fadd="${t}">${l}</button>`).join("")}</div>
  ${(ed.steps || []).map((s, i) => `<div class="stepcard"><div class="row"><span class="kbd">▶ ${i + 1}.</span><b>${esc(s.title || s.id || s.type)}</b><span class="kbd">${esc(s.type)}</span><span class="spacer"></span><button class="btn sm ghost" data-fup="${i}" title="Move up">^</button><button class="btn sm ghost" data-fdown="${i}" title="Move down">∨</button><button class="btn sm danger" data-fdel="${i}" title="Delete">🗑</button></div>
  <div class="row"><label class="fld"><span>Agent</span><select data-sagent="${i}">${agentIds().map((a) => `<option ${s.agent === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
  <label class="fld"><span>Model (empty = config default)</span><input data-smodel="${i}" value="${esc(s.model || "")}" placeholder="gpt-5.6-terra"></label></div>
  <label class="fld"><span>Prompt ${s.type === "run_agent" || s.type === "agent" ? "(empty = agent defaultPrompt)" : ""}</span><textarea data-sprompt="${i}" rows="2" placeholder="What should this step do? Use {{steps.<id>}} refs.">${esc(s.prompt || s.message || s.text || s.template || "")}</textarea></label>
  ${s.type === "condition" ? `<label class="fld"><span>Condition rule</span><input data-srule="${i}" value="${esc(s.rule || s.condition?.right || "")}"></label>` : ""}
  <p class="hint">${esc(s.details || "")}</p></div>`).join("") || `<p class="hint">No steps — add one above.</p>`}
  <div class="row"><button class="btn sm ghost" id="flowcancel">Cancel</button><span class="spacer"></span><button class="btn sm primary" id="flowsave">Save flow</button></div>
  </div></div>` : ""}</div>`;
}

export function nextRunHint() {
  if (S.flowTrig !== "schedule") return "—";
  return `Today at ${S.flowTime}`;
}

export function todosView() {
  const tabs = [["open", "Open", "circle"], ["done", "Done", "check-circle-2"], ["dismissed", "Dismissed", "archive"], ["all", "All", "list"]];
  let list = (S.todos || []).filter((t) =>
    (S.todoTab === "all" || t.status === S.todoTab) &&
    (!S.todoQ || (t.text || "").toLowerCase().includes(S.todoQ.toLowerCase())) &&
    (S.todoSource === "all" || (t.project || "").includes(S.todoSource) || S.todoSource === "manual"));
  const open = (S.todos || []).filter((t) => t.status === "open").length;
  return `
  ${pageHead("TODOs", `${open} open`, `<button type="button" class="btn sm primary" id="todo-new">${icon("plus")} New TODO</button>`)}
  ${statRow([
    { icon: "circle", label: "Open", value: open },
    { icon: "check-circle-2", label: "Done", value: (S.todos || []).filter((t) => t.status === "done").length, tone: "ok" },
    { icon: "archive", label: "Dismissed", value: (S.todos || []).filter((t) => t.status === "dismissed").length },
  ])}
  <div class="btabs" role="tablist" aria-label="TODO status">${tabs.map(([v, l, ic]) => `<button type="button" role="tab" aria-selected="${S.todoTab === v}" class="tab ${S.todoTab === v ? "on" : ""}" data-ttab="${v}">${icon(ic)} ${l}</button>`).join("")}</div>
  ${S.todoForm ? `<div class="appr" role="dialog" aria-label="New TODO"><label class="fld"><span>TODO text</span><input id="todo-title" placeholder="What needs to be done?"></label><div class="row"><button type="button" class="btn sm primary" id="todocreate">${icon("plus")} Add TODO</button><button type="button" class="btn sm ghost" id="todocancel">Cancel</button></div></div>` : ""}
  ${toolbar(searchBox("todo-q", S.todoQ, "Search TODOs") + selectBox("todo-src", [["all", "All sources"], ["flow:", "Flows"], ["manual", "Manual"]], S.todoSource, "Filter by source"))}
  ${list.slice(0, 30).map((t) => `<div class="appr"><div class="row">${pill(t.status === "open" ? "queued" : t.status)}<span class="tag">${esc(t.priority)}</span><span>${esc(t.text)}</span><span class="spacer"></span><span class="hint">${esc(t.id)} · ${esc(String(t.created_at || "").slice(0, 10))}</span></div>
  ${t.requestId || t.request_id ? `<p class="hint">Converted → request <button type="button" class="kbd" data-goto-req="${esc(t.requestId || t.request_id)}">${esc(t.requestId || t.request_id)}</button></p>` : ""}
  <div class="row">${t.status === "open" ? `<button type="button" class="btn sm ghost" data-tdone="${esc(t.id)}">${icon("check")} Done</button><button type="button" class="btn sm ghost" data-tdis="${esc(t.id)}">${icon("archive")} Dismiss</button><button type="button" class="btn sm" data-tconv="${esc(t.id)}">${icon("arrow-right")} Convert to request</button>` : pill(t.status)}</div></div>`).join("") || emptyState("list-checks", "No TODOs", "They appear here when created manually or discovered by inbox sweepers.")}
  <div class="chatbox"><label class="sr" for="todo-in">Quick add TODO</label><input id="todo-in" placeholder="+ new todo…"><button type="button" class="btn sm primary" id="todo-add">${icon("plus")} Add</button></div></div>`;
}

export function logsView() {
  return `
  ${pageHead("Logs", `${(S.logs || []).length} entries`, `<button class="btn sm" id="logref">${icon("refresh-cw")} Refresh</button>`)}
  ${toolbar(selectBox("loglevel", [["", "All levels"], ["info", "Info"], ["error", "Errors"]], S.logLevel || "", "Log level"))}
  <div class="logbox">${(S.logs || []).map((l) => `<div class="logline ${esc(l.level)}"><span class="lt">${esc(String(l.created_at || "").slice(5, 19).replace("T", " "))}</span>
  <span class="ltag">${esc(l.level)}</span><span class="lsrc">${esc(l.source || "")}</span><span>${esc(l.message || "")}</span></div>`).join("") || emptyState("scroll-text", "No logs", "Logs stream here as the bot works.")}</div></div>`;
}

// ---------- request modal: Request/Direct, dispatcher (Muse/Copilot), model, task type, repo, attachments ----------

function reqPipelinePreview() {
  const tt = (S.loopTypes || []).find((t) => t.id === S.reqTaskType);
  if (tt) return `<div class="pnodes">${tt.steps.map((s, i) => `${i ? `<span class="pn-arr" aria-hidden="true">→</span>` : ""}<div class="pnode2"><span><span class="pn-role">${esc(s.role)}</span><span class="pn-st">${esc(String(s.goal).slice(0, 40))}</span></span></div>`).join("")}</div>`;
  return `<p class="hint" style="margin:4px 0 0">${S.reqMode === "direct" ? "Direct: one task, generic code → test steps unless you pick a type." : "The divider picks task boundaries and step roles from the goal."}</p>`;
}

export function reqModal() {
  if (!S.showReq) return "";
  const disps = S.dispatchers?.length ? S.dispatchers : [{ id: "muse", label: "Muse CLI", ok: true }, { id: "copilot", label: "GitHub Copilot CLI", ok: false, error: "status unknown" }];
  return `<div class="modal"><div class="mbox" role="dialog" aria-modal="true" aria-label="Submit a request"><div class="dhead"><b>Submit a request</b><span class="spacer"></span><button type="button" class="btn ghost sm" id="reqx" aria-label="Close">${icon("x")}</button></div>
  <div class="seg" role="group" aria-label="Request mode"><button type="button" class="${S.reqMode === "request" ? "on" : ""}" id="reqm-req" aria-pressed="${S.reqMode === "request"}">Request</button><button type="button" class="${S.reqMode === "direct" ? "on" : ""}" id="reqm-dir" aria-pressed="${S.reqMode === "direct"}">Direct task</button></div>
  <label class="fld"><span>What should be built or fixed?</span><textarea id="req-text" rows="5" placeholder="Describe the outcome you want. Be concrete about done-ness."></textarea></label>
  <div class="row"><label class="fld" style="flex:2"><span>Repo / working dir (absolute path, optional)</span><input id="req-repo" value="${esc(S.reqRepo)}" placeholder="/home/you/Projects/app"></label>
  <label class="fld" style="flex:1"><span>Task type</span><select id="req-type"><option value="">Let the divider choose</option>${(S.loopTypes || []).map((t) => `<option value="${esc(t.id)}" ${S.reqTaskType === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label></div>
  <div class="fld"><span>Dispatcher</span><div class="disps" role="radiogroup" aria-label="Dispatcher">${disps.map((d) => `<button type="button" role="radio" class="dispopt ${S.reqDispatcher === d.id ? "on" : ""}" data-reqdisp="${esc(d.id)}" aria-checked="${S.reqDispatcher === d.id}" ${d.ok ? "" : "disabled"}><b>${esc(d.label)}</b><small>${esc(d.ok ? (d.version || "available") : (d.error || "unavailable"))}</small></button>`).join("")}</div></div>
  <label class="fld"><span>Model (optional — blank uses each agent's default)</span><input id="req-model" value="${esc(S.reqModel)}" placeholder="${S.reqDispatcher === "copilot" ? "e.g. gpt-5" : "e.g. muse-spark-1.3"}"></label>
  <div class="appr" aria-label="Pipeline preview"><b>${icon("git-branch")} Pipeline preview</b>${reqPipelinePreview()}</div>
  <div class="appr" aria-label="Attachments (text-only)"><b>${icon("paperclip")} Attachments (text-only).</b>
  <p class="hint" style="margin:4px 0 0">${esc(S.reqAttachNote)}</p>
  <div class="row" style="margin-top:6px"><label class="btn sm ghost" for="req-file">Choose file</label>
  <input id="req-file" type="file" class="sr" accept=".txt,.md,.json,.csv,text/plain,text/markdown,text/csv,application/json" ${S.reqAttachBusy ? "disabled" : ""}>
  <span class="hint" id="req-attach-status" role="status">${S.reqAttachBusy ? "Uploading…" : S.reqAttachErr ? esc(S.reqAttachErr) : `${(S.reqAttachments || []).length} file(s) staged`}</span></div>
  <div id="req-attach-list">${(S.reqAttachments || []).map((a) => `<div class="row"><span class="kbd">${esc(a.name)}</span><span class="hint">${a.size} bytes</span><span class="spacer"></span><button type="button" class="btn sm ghost" data-reqdel="${esc(a.id)}" ${S.reqAttachBusy ? "disabled" : ""}>Remove</button></div>`).join("") || `<p class="hint">No files staged. Uploads stay in this browser session until you enqueue.</p>`}</div></div>
  <p class="hint" id="req-msg" role="status">${esc(S.reqMsg || "")}</p>
  <div class="row"><button type="button" class="btn primary" id="req-go" ${(S.reqBusy || S.reqAttachBusy || S.reqAttachErr) ? "disabled" : ""}>${S.reqBusy ? "Submitting…" : S.reqAttachBusy ? "Uploading…" : "Enqueue Task"}</button><span class="hint">Runs in auto mode — one step at a time.</span></div></div></div>`;
}

export function cmdPalette() {
  if (!S.cmdOpen) return "";
  const cmds = [
    ["board", "Go to Board"], ["brain", "Go to Messages"],
    ["todos", "Go to TODOs"], ["automations", "Go to Automations"], ["config", "Go to Configuration"],
    ["requests", "Go to Requests"],
    ["activity", "Go to Activity"], ["retro", "Go to Retro"],
    ["new", "+ New task"], ["pause", "Pause / Resume loop"], ["refresh", "Refresh now"],
  ].filter(([v, l]) => !S.q || l.toLowerCase().includes(S.q.toLowerCase()));
  return `<div class="modal"><div class="mbox"><div class="dhead"><b>Commands</b><span class="spacer"></span><button type="button" class="btn ghost sm" id="cmdx" aria-label="Close">${icon("x")}</button></div>
  ${cmds.map(([v, l], i) => `<button type="button" class="nav ${i === S.cmdIdx ? "on" : ""}" data-cmd="${v}">${esc(l)}</button>`).join("") || `<p class="hint">No match</p>`}</div></div>`;
}

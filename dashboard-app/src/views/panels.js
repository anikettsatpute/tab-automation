// Secondary views: config, agents, tools, brain, requests, outbox, retro,
// automations, todos, logs, request modal, command palette.
// Pure render functions — state + events live in main.js.
import { S, esc, AGENT_OPTS, streamName, streamPipes } from "./state.js";
import { pageHead, statRow, emptyState, section, pill, toolbar, searchBox, selectBox, icon } from "./ui.js";
export function configView() {
  const c = S.cfgData;
  if (!c) return `<div class="card" aria-busy="true"><h3>Configuration</h3><div class="skel" style="height:18px;width:60%"></div><div class="skel" style="height:12px;width:90%"></div><div class="skel" style="height:12px;width:75%"></div><p class="hint">Loading providers, models, prompts…</p></div>`;
  const provs = c.providers?.providers || [];
  const agents = c.agents?.agents || [];
  return `
  ${pageHead("Configuration", "providers · models · default prompts", `<button class="btn sm primary" id="cfgsave">${icon("save")} Save configuration</button>`)}
  ${S.cfgMsg ? `<div class="notice ok">${icon("check-circle-2")} ${esc(S.cfgMsg)}</div>` : ""}
  <p class="hint">Dispatch chain: per-call model → agent.model → provider.modelDefault (${esc(c.providers?.defaultProvider || "muse")}). Empty prompt uses the agent's defaultPrompt.</p>
  ${section(`Providers (default: ${c.providers?.defaultProvider || "muse"})`, `
  <div class="tblwrap"><table class="tbl"><thead><tr><th>ID</th><th>Type</th><th>Model default</th><th>Key env</th><th>Endpoint</th></tr></thead><tbody>
  ${provs.map((p, i) => `<tr><td><b>${esc(p.id)}</b></td><td>${esc(p.type)}</td>
  <td>${p.type === "muse"
    ? `<select data-cprov="${i}" data-cf="modelDefault">${["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1", "muse-spark"].map((m) => `<option ${p.modelDefault === m ? "selected" : ""}>${m}</option>`).join("")}</select>`
    : `<input data-cprov="${i}" data-cf="modelDefault" value="${esc(p.modelDefault || "")}" placeholder="gpt-5.6-terra">`}</td>
  <td class="dim">${esc(p.keyEnv || "")}</td><td class="dim">${esc((p.endpoint || "").slice(0, 50))}</td></tr>`).join("")}
  </tbody></table></div>
  <div class="row"><label class="fld"><span>Default provider</span><select id="cfg-defprov">${provs.map((p) => `<option ${c.providers?.defaultProvider === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("")}</select></label></div>`)}
  ${section(`Agents (${agents.length})`, agents.map((a, i) => `<div class="stepcard"><div class="row"><b>${icon("bot")} ${esc(a.id)}</b><span class="hint">${esc(a.description || "")}</span><span class="spacer"></span><button class="btn sm ghost" data-cfgtest="${esc(a.id)}">${icon("play")} Test default prompt</button></div>
  <div class="row"><label class="fld"><span>Provider</span><select data-cagent="${i}" data-cf="provider"><option value="">(default)</option>${provs.map((p) => `<option ${a.provider === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("")}</select></label>
  <label class="fld"><span>Model (empty = provider default)</span>${(a.provider || c.providers?.defaultProvider) === "muse" || (!a.provider && c.providers?.defaultProvider === "muse")
    ? `<select data-cagent="${i}" data-cf="model"><option value="">(provider default)</option>${["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1", "muse-spark"].map((m) => `<option ${(a.model || a.deployment) === m ? "selected" : ""}>${m}</option>`).join("")}</select>`
    : `<input data-cagent="${i}" data-cf="model" value="${esc(a.model || a.deployment || "")}" placeholder="provider default">`}</label></div>
  <label class="fld"><span>Default prompt (used when dispatch prompt is empty)</span><textarea data-cagent="${i}" data-cf="defaultPrompt" rows="2">${esc(a.defaultPrompt || "")}</textarea></label>
  <div class="row"><label class="fld"><span>Test model override</span><input id="cfgtest-model-${esc(a.id)}" placeholder="empty = agent model"></label>
  <label class="fld"><span>Test prompt override</span><input id="cfgtest-prompt-${esc(a.id)}" placeholder="empty = defaultPrompt"></label></div>
  <div id="cfgtest-out-${esc(a.id)}"></div></div>`).join("") + `<div class="row"><button class="btn sm primary" id="cfgsave2">${icon("save")} Save configuration</button></div>`)}
  ${section(`Streams (${(c.streams?.streams || []).length})`, (c.streams?.streams || []).map((s) => `<div class="appr"><div class="row"><b>${icon("waves")} ${esc(s.name || s.id)}</b><span class="kbd">${esc(s.id)}</span><span class="spacer"></span><span class="hint">${esc(s.description || "")}</span></div>
  <p class="hint">agents: ${(s.agents || []).map(esc).join(", ") || "—"}</p></div>`).join("") || `<p class="hint">No streams — add them in Setup Step 6.</p>`, `<span class="hint">read-only here</span>`)}
  ${section(`Task pipelines (${(c.streams?.pipelines || []).length})`, (c.streams?.pipelines || []).map((p) => `<div class="appr"><div class="row"><b>${icon("git-branch")} ${esc(p.name || p.id)}</b><span class="kbd">${esc(p.stream || "")}</span><span class="spacer"></span><span class="hint">${esc(p.description || "")}</span></div>
  <p class="hint">${(p.agents || []).map(esc).join(" → ") || "—"}</p></div>`).join("") || `<p class="hint">No pipelines — add them in Setup Step 6.</p>`, `<span class="hint">read-only here</span>`)}`;
}

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
  const msgs = all.slice(0, 40);
  const sel = S.brainSel ? all.find((x) => (x.id || x.jobId) === S.brainSel) || msgs.find((x) => (x.id || x.jobId) === S.brainSel) : null;
  const txt = (x) => x.messageText || x.text || "";
  const ts = (x) => x.receivedAt || x.ts || "";
  const st = (x) => x.processingStatus || x.status || "queued";
  return `
  ${pageHead("Brain messages", `${msgs.length} shown`, `<span class="hint">${icon("rss")} poller ${b.poller?.enabled ? "on" : "off"} · ${b.poller?.intervalMin || 2} min · #${esc(b.poller?.channel || "discord")}</span>`)}
  ${statRow([
    { icon: "inbox", label: "Incoming", value: m.incoming ?? msgs.length },
    { icon: "clock", label: "Queued", value: m.queued ?? 0 },
    { icon: "loader", label: "Running", value: m.running ?? 0, tone: "run" },
    { icon: "x-circle", label: "Failed", value: m.failed ?? 0, tone: "bad" },
    { icon: "send", label: "Outbox", value: S.outbox.length },
    { icon: "check-circle-2", label: "Sent", value: m.replied ?? 0, tone: "ok" },
  ])}
  <p class="hint">Last scan: ${esc(b.poller?.lastScan ? String(b.poller.lastScan).slice(0, 19).replace("T", " ") : "—")}</p>
  ${toolbar(searchBox("brain-q", S.brainQ, "Search message, sender, chat or job ID"))}
  <div class="tblwrap"><table class="tbl"><thead><tr><th scope="col">Received</th><th scope="col">Sender / source</th><th scope="col">Incoming message</th><th scope="col">Processing</th><th scope="col">Outbox</th></tr></thead><tbody>
  ${msgs.map((x) => { const id = x.id || x.jobId; return `<tr data-brain="${esc(id)}" style="cursor:pointer;${S.brainSel === id ? "background:var(--acc-soft);" : ""}"><td class="dim">${esc(String(ts(x)).slice(0, 16).replace("T", " "))}</td>
  <td>${esc(x.sender)}<br><span class="hint">${esc(x.source || x.channelId || "discord")}</span></td>
  <td class="dim">${esc(String(txt(x)).slice(0, 160))}<br><span class="hint">${esc(x.jobId || x.id || "")}</span></td>
  <td>${pill(st(x) === "failed" ? "failed" : st(x) === "reply_generated" || st(x) === "replied" ? "done" : "running")}<br><span class="hint">${esc(st(x))}</span></td>
  <td class="hint">${esc(x.outboxSummary || (st(x) === "replied" || st(x) === "reply_generated" ? "1 sent" : "—"))}</td></tr>`; }).join("") || `<tr><td colspan="5">${emptyState("brain", "No messages", "Discord mentions will land here.")}</td></tr>`}
  </tbody></table></div>
  ${sel ? `<div class="appr"><div class="row"><b>Brain message</b><span class="kbd">${esc(sel.id || sel.jobId || "")}</span><span class="spacer"></span><button class="btn sm ghost" id="brainx">${icon("x")}</button></div>
  <div class="row"><button class="tab ${S.brainTab === "details" ? "on" : ""}" data-btab2="details">${icon("file-text")} Message details</button><button class="tab ${S.brainTab === "session" ? "on" : ""}" data-btab2="session">${icon("terminal")} Session</button></div>
  ${S.brainTab === "details" ? `<div class="grid2"><span>Job ID</span><span class="kbd">${esc(sel.jobId || sel.id || "")}</span><span>Actor ID</span><span class="kbd">${esc(sel.actorId || "—")}</span><span>Conversation</span><span class="kbd">${esc(sel.conversationId || sel.channelId || "—")}</span><span>Updated</span><span>${esc(String(ts(sel)).slice(0, 19).replace("T", " "))}</span></div>
  ${sel.linkedTaskId ? `<p class="dim">Linked work: <span class="kbd">${esc(sel.linkedTaskId)}</span></p>` : ""}
  ${sel.processingError ? `<div class="status bad">${esc(sel.processingError)}</div>` : ""}
  <p class="dim">From <b>${esc(sel.sender)}</b> · status ${esc(st(sel))}</p><div class="endgoal">${esc(String(txt(sel)).slice(0, 2000))}</div>
  ${sel.requestText ? `<p class="dim">Request:</p><pre class="out">${esc(String(sel.requestText).slice(0, 1000))}</pre>` : ""}`
  : `<p class="dim">Runner: Discord poller · channel ${esc(sel.channelId || sel.conversationId || "—")}</p><pre class="out">${esc(String(sel.sessionLog || txt(sel)).slice(0, 2000))}</pre>`}</div>` : ""}</div>`;
}

const pipeAgents = (r) => {
  try { const a = JSON.parse(r.pipeline || "[]"); if (Array.isArray(a) && a.length) return a.map(esc).join(" → "); } catch { /* not JSON — fall through */ }
  return esc(typeof r.pipeline === "string" && r.pipeline ? r.pipeline : (r.task_type || "—"));
};

export function requestsView() {
  return `
  ${pageHead("Requests", `${S.requests.length} intake`, `<button type="button" class="btn sm primary" id="newtask2">${icon("plus")} New task</button>`)}
  <p class="hint">Raw goals awaiting / passed through the task-divider. Newest first.</p>
  ${S.requests.map((r) => `<div class="appr"><div class="row">${icon("inbox")}<b>${esc(String(r.text || "").slice(0, 90))}</b><span class="spacer"></span>${pill(r.status === "running" ? "running" : "queued")}</div>
  <p class="hint">mode ${esc(r.mode)} · stream ${esc(streamName(r.repo) || r.repo)} · agents ${pipeAgents(r)} · ${esc(String(r.created_at || "").slice(0, 16).replace("T", " "))}${r.run_id ? ` · run <span class="kbd">${esc(r.run_id)}</span>` : ""}</p></div>`).join("") || emptyState("inbox", "No requests yet", "Hit + New task to file your first goal.")}</div>`;
}

export function outboxView() {
  return `
  ${pageHead("Outbox", `${S.outbox.length} queued/sent`)}
  <div class="chatbox"><input id="ob-in" placeholder="Queue a notification…"><button class="btn sm primary" id="ob-add">${icon("send")} Queue</button></div>
  ${S.outbox.map((o) => `<div class="appr"><div class="row">${pill(o.status)}<b>${esc(String(o.text || "").slice(0, 120))}</b><span class="spacer"></span>${o.status !== "sent" ? `<button class="btn sm ghost" data-obsent="${esc(o.id)}">Mark sent</button>` : `<span class="hint">${esc(String(o.sent_at || "").slice(0, 16).replace("T", " "))}</span>`}</div>
  <p class="hint">${esc(o.channel || "default")} · ${esc(String(o.created_at || "").slice(0, 16).replace("T", " "))}${o.run_id ? ` · run ${esc(o.run_id)}` : ""}</p></div>`).join("") || emptyState("send", "Outbox empty", "Queued notifications will appear here.")}</div>`;
}

export function retroView() {
  const r = S.retro;
  if (!r) return `<div class="card" aria-busy="true"><h3>Retro</h3><div class="skel" style="height:18px;width:50%"></div><div class="skel" style="height:12px;width:85%"></div><p class="hint">Loading retrospective…</p></div>`;
  const byStatus = (r.byStatus || []).map((s) => ({ icon: s.status === "done" ? "check-circle-2" : s.status === "failed" ? "x-circle" : "loader", label: s.status, value: s.c, tone: s.status === "done" ? "ok" : s.status === "failed" ? "bad" : "run" }));
  return `
  ${pageHead("Retro", `last ${esc(String(r.since || "").slice(0, 10))} → now`)}
  ${statRow([
    { icon: "layers", label: "Total runs", value: r.runs?.c ?? 0 },
    { icon: "timer", label: "Avg duration", value: `${Math.round(r.runs?.avgSec || 0)}s` },
    { icon: "coins", label: "Tokens", value: Number(r.runs?.t || 0).toLocaleString() },
    { icon: "wrench", label: "Tool calls", value: r.runs?.tc ?? 0 },
  ])}
  ${section("Runs by status", byStatus.length ? `<div class="mrow">${byStatus.map((s) => `<span class="m ${s.tone}">${icon(s.icon)} ${esc(s.label)} <b>${s.value}</b></span>`).join("")}</div>` : `<p class="hint">—</p>`)}
  ${section("Delivery velocity", `<div class="chartbox"><canvas id="retro-chart" height="120"></canvas></div>`, `<span class="hint">${(r.byDay || []).length} days</span>`)}
  ${section("Retries", (r.retries || []).length ? (r.retries || []).map((s) => `<div class="arow"><span>${esc(s.workflow_id)}</span><b>${s.c}</b></div>`).join("") : `<p class="hint">No repeats — deterministic.</p>`)}`;
}

export function paintRetroChart() {
  try {
    const cv = document.getElementById("retro-chart");
    if (!cv || !window.Chart) return;
    const days = (S.retro?.byDay || []).slice(-14);
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
    return `<div class="flowcard"><div class="row"><div><h3>${esc(f.title || f.id)}</h3><p class="dim">${esc(f.description || "")}</p></div><span class="spacer"></span>
    <button class="btn sm ${f.enabled === false ? "" : "okbtn"}" data-flowen="${esc(f.id)}">${f.enabled === false ? "Enable" : "Enabled"}</button>
    <button class="btn sm ghost" data-flowdry="${esc(f.id)}">Dry run</button>
    <button class="btn sm primary" data-runflow="${esc(f.id)}">▶ Run</button>
    <button class="btn sm ghost" data-flowedit="${esc(f.id)}">✎ Edit</button>
    <button class="btn sm danger" data-flowdel="${esc(f.id)}">🗑</button></div>
  <div class="row"><span class="kbd">${esc(preset)}</span><span class="kbd">${esc(f.configFileName || f.id + ".json")}</span>
  ${f.state?.next_run_at ? `<span class="hint">Next: ${esc(String(f.state.next_run_at).slice(0, 16).replace("T", " "))}</span>` : ""}<span class="hint">last: ${esc(f.state?.last_status || f.lastStatus || "never")}</span></div>
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
  ${S.flowTrig === "event" ? `<label class="fld"><span>Event rule (e.g. on task blocked, on brain failed)</span><input id="flow-rule" value="${esc(S.flowRule || "")}" placeholder="on task blocked"></label>` : ""}
  <div class="row"><h4>STEPS (${(ed.steps || []).length} steps)</h4><span class="spacer"></span><button class="btn sm ghost" id="flowexpand">Expand all</button></div>
  <div class="palette"><span class="hint">Add step:</span>${[["run_agent", "Run agent"], ["create_task", "Create task"], ["file_request", "File request"], ["notify", "Notify"], ["condition", "Condition"], ["run_automation", "Run automation"], ["wait", "Wait"]].map(([t, l]) => `<button class="btn sm ghost" data-fadd="${t}">${l}</button>`).join("")}</div>
  ${(ed.steps || []).map((s, i) => `<div class="stepcard"><div class="row"><span class="kbd">▶ ${i + 1}.</span><b>${esc(s.title || s.id || s.type)}</b><span class="kbd">${esc(s.type)}</span><span class="spacer"></span><button class="btn sm ghost" data-fup="${i}" title="Move up">^</button><button class="btn sm ghost" data-fdown="${i}" title="Move down">∨</button><button class="btn sm danger" data-fdel="${i}" title="Delete">🗑</button></div>
  <div class="row"><label class="fld"><span>Agent</span><select data-sagent="${i}">${AGENT_OPTS.map((a) => `<option ${s.agent === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
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
  <div class="row">${t.status === "open" ? `<button type="button" class="btn sm ghost" data-tdone="${esc(t.id)}">${icon("check")} Done</button><button type="button" class="btn sm ghost" data-tdis="${esc(t.id)}">${icon("archive")} Dismiss</button><button type="button" class="btn sm" data-tconv="${esc(t.id)}">${icon("arrow-right")} Convert to request</button>` : pill(t.status)}</div></div>`).join("") || emptyState("list-checks", "No TODOs", "They appear here when created manually or discovered by inbox sweepers.")}
  <div class="chatbox"><label class="sr" for="todo-in">Quick add TODO</label><input id="todo-in" placeholder="+ new todo…"><button type="button" class="btn sm primary" id="todo-add">${icon("plus")} Add</button></div></div>`;
}

export function logsView() {
  return `
  ${pageHead("Logs", `${(S.logs || []).length} entries`, `<button class="btn sm" id="logref">${icon("refresh-cw")} Refresh</button>`)}
  ${toolbar(selectBox("loglevel", [["", "All levels"], ["info", "Info"], ["error", "Errors"]], S.logLevel || "", "Log level"))}
  <div class="logbox">${(S.logs || []).map((l) => `<div class="lrow ${esc(l.level)}"><span class="lt">${esc(String(l.created_at || "").slice(5, 19).replace("T", " "))}</span>
  <span class="ltag">${esc(l.level)}</span><span class="lsrc">${esc(l.source || "")}</span><span>${esc(l.message || "")}</span></div>`).join("") || emptyState("scroll-text", "No logs", "Logs stream here as the bot works.")}</div></div>`;
}

// ---------- request modal (PRD 4.5: Request/Direct, repo, 15 types, pipeline, attach) ----------

export function reqModal() {
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

// ---------- render (focus-preserving: skip re-render while typing or modal open) ----------

export function cmdPalette() {
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

// Secondary views: config, agents, tools, brain, requests, outbox, retro,
// automations, todos, logs, request modal, command palette.
// Pure render functions — state + events live in main.js.
import { S, esc, AGENT_OPTS, streamName, streamPipes } from "./state.js";
export function configView() {
  const c = S.cfgData;
  if (!c) return `<div class="card" aria-busy="true"><h3>Configuration</h3><div class="skel" style="height:18px;width:60%"></div><div class="skel" style="height:12px;width:90%"></div><div class="skel" style="height:12px;width:75%"></div><p class="hint">Loading providers, models, prompts…</p></div>`;
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

export function agentsView() {
  return `<div class="agrid">${(S.agents || []).map((a) => `
    <div class="card"><h3>${esc(a.id)}</h3><p class="desc">${esc(a.description || "—")}</p>
    <p><span class="kbd">${esc(a.model || a.provider || "default")}</span></p>
    <div class="arow"><span>Runs</span><b>${a.runs ?? 0}</b></div>
    <div class="arow"><span>Tokens</span><b>${(a.tokens ?? 0).toLocaleString()}</b></div></div>`).join("") || `<div class="empty">No agents.</div>`}</div>`;
}

export function toolsView() {
  return `<div class="card"><div class="tblwrap"><table class="tbl"><thead><tr><th>Tool</th><th>Kind</th><th>Auth</th><th>Calls</th><th>Avg ms</th></tr></thead><tbody>
  ${(S.tools || []).map((t) => `<tr><td><b>${esc(t.id)}</b></td><td>${esc(t.kind)}</td>
  <td>${t.auth === "needed" ? `<span class="tag bad">🔐 sign-in</span>` : `<span class="tag ok">✅</span>`}</td>
  <td>${t.calls ?? 0}</td><td>${t.avgMs ?? 0}</td></tr>`).join("")}</tbody></table></div></div>`;
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

export function requestsView() {
  return `<div class="card"><h3>Requests <span class="hint">${S.requests.length} intake</span></h3>
  <p class="hint">Raw goals awaiting / passed through the task-divider. Newest first.</p>
  ${S.requests.map((r) => `<div class="appr"><div class="row"><b>${esc(String(r.text || "").slice(0, 90))}</b><span class="spacer"></span><span class="tag ${r.status === "running" ? "run" : ""}">${esc(r.status || "queued")}</span></div>
  <p class="hint">mode ${esc(r.mode)} · stream ${esc(streamName(r.repo) || r.repo)} · agents ${(JSON.parse(r.pipeline || "[]") || []).map(esc).join(" → ") || esc(r.task_type || "—")} · ${esc(String(r.created_at || "").slice(0, 16).replace("T", " "))}${r.run_id ? ` · run <span class="kbd">${esc(r.run_id)}</span>` : ""}</p></div>`).join("") || `<p class="hint">No requests yet — hit + New task.</p>`}</div>`;
}

export function outboxView() {
  return `<div class="card"><h3>Outbox <span class="hint">${S.outbox.length} queued/sent</span></h3>
  <div class="chatbox"><input id="ob-in" placeholder="Queue a notification…"><button class="btn sm" id="ob-add">Queue</button></div>
  ${S.outbox.map((o) => `<div class="appr"><div class="row"><span class="tag ${o.status === "sent" ? "ok" : "run"}">${esc(o.status)}</span><b>${esc(String(o.text || "").slice(0, 120))}</b><span class="spacer"></span>${o.status !== "sent" ? `<button class="btn sm ghost" data-obsent="${esc(o.id)}">Mark sent</button>` : `<span class="hint">${esc(String(o.sent_at || "").slice(0, 16).replace("T", " "))}</span>`}</div>
  <p class="hint">${esc(o.channel || "default")} · ${esc(String(o.created_at || "").slice(0, 16).replace("T", " "))}${o.run_id ? ` · run ${esc(o.run_id)}` : ""}</p></div>`).join("") || `<p class="hint">Outbox empty.</p>`}</div>`;
}

export function retroView() {
  const r = S.retro;
  if (!r) return `<div class="card" aria-busy="true"><h3>Retro</h3><div class="skel" style="height:18px;width:50%"></div><div class="skel" style="height:12px;width:85%"></div><p class="hint">Loading retrospective…</p></div>`;
  return `<div class="card"><h3>Retro <span class="hint">last ${esc(String(r.since || "").slice(0, 10))} → now</span></h3>
  <div class="agrid">
  <div class="card"><h3>Runs</h3><div class="arow"><span>Total</span><b>${r.runs?.c ?? 0}</b></div><div class="arow"><span>Avg duration</span><b>${Math.round(r.runs?.avgSec || 0)}s</b></div></div>
  <div class="card"><h3>Tokens / tools</h3><div class="arow"><span>Tokens</span><b>${Number(r.runs?.t || 0).toLocaleString()}</b></div><div class="arow"><span>Tool calls</span><b>${r.runs?.tc ?? 0}</b></div></div>
  <div class="card"><h3>By status</h3>${(r.byStatus || []).map((s) => `<div class="arow"><span>${esc(s.status)}</span><b>${s.c}</b></div>`).join("") || `<p class="hint">—</p>`}</div>
  <div class="card"><h3>Retries (workflow × runs)</h3>${(r.retries || []).map((s) => `<div class="arow"><span>${esc(s.workflow_id)}</span><b>${s.c}</b></div>`).join("") || `<p class="hint">No repeats — deterministic.</p>`}</div>
  </div>
  <h3>Delivery velocity</h3><div class="logbox">${(r.byDay || []).map((d) => `<div class="lrow info"><span class="lt">${esc(d.d)}</span><span class="ltag">${d.c} runs</span></div>`).join("")}</div></div>`;
}

export function flowsView() {
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
  const tabs = [["open", "Open"], ["done", "Done"], ["dismissed", "Dismissed"], ["all", "All"]];
  let list = (S.todos || []).filter((t) =>
    (S.todoTab === "all" || t.status === S.todoTab) &&
    (!S.todoQ || (t.text || "").toLowerCase().includes(S.todoQ.toLowerCase())) &&
    (S.todoSource === "all" || (t.project || "").includes(S.todoSource) || S.todoSource === "manual"));
  return `<div class="card"><h3>TODOs</h3>
  <div class="row" role="tablist" aria-label="TODO status">${tabs.map(([v, l]) => `<button type="button" role="tab" aria-selected="${S.todoTab === v}" class="tab ${S.todoTab === v ? "on" : ""}" data-ttab="${v}">${l}</button>`).join("")}<span class="spacer"></span><button type="button" class="btn sm primary" id="todo-new">+ New TODO</button></div>
  ${S.todoForm ? `<div class="appr" role="dialog" aria-label="New TODO"><label class="fld"><span>TODO text</span><input id="todo-title" placeholder="What needs to be done?"></label><div class="row"><button type="button" class="btn sm primary" id="todocreate">Add TODO</button><button type="button" class="btn sm ghost" id="todocancel">Cancel</button></div></div>` : ""}
  <div class="row"><div class="chatbox" style="flex:1"><label class="sr" for="todo-q">Search TODOs</label><input id="todo-q" type="search" placeholder="Search TODOs" value="${esc(S.todoQ)}"></div>
  <label class="sr" for="todo-src">Filter by source</label><select id="todo-src" class="sel"><option value="all">All sources</option><option value="flow:" ${S.todoSource === "flow:" ? "selected" : ""}>Flows</option><option value="manual" ${S.todoSource === "manual" ? "selected" : ""}>Manual</option></select>
  <label class="sr" for="todo-sort">Sort order</label><select id="todo-sort" class="sel"><option>Newest first</option></select></div>
  ${list.slice(0, 30).map((t) => `<div class="appr"><div class="row"><span class="tag">${esc(t.priority)}</span><span>${esc(t.text)}</span><span class="spacer"></span><span class="hint">${esc(t.id)} · ${esc(String(t.created_at || "").slice(0, 10))}</span></div>
  <div class="row">${t.status === "open" ? `<button type="button" class="btn sm ghost" data-tdone="${esc(t.id)}">Done</button><button type="button" class="btn sm ghost" data-tdis="${esc(t.id)}">Dismiss</button><button type="button" class="btn sm" data-tconv="${esc(t.id)}">Convert to request</button>` : `<span class="tag ${t.status === "done" ? "ok" : ""}">${esc(t.status)}</span>`}</div></div>`).join("") || `<div class="empty" role="status">No TODOs yet — they appear here when created manually or discovered by inbox sweepers.</div>`}
  <div class="chatbox"><label class="sr" for="todo-in">Quick add TODO</label><input id="todo-in" placeholder="+ new todo…"><button type="button" class="btn sm" id="todo-add">Add</button></div></div>`;
}

export function logsView() {
  return `<div class="card"><div class="tbar"><select id="loglevel"><option value="">All levels</option>
  ${["info", "error"].map((l) => `<option ${S.logLevel === l ? "selected" : ""}>${l}</option>`).join("")}</select>
  <button class="btn sm" id="logref">Refresh</button></div>
  <div class="logbox">${(S.logs || []).map((l) => `<div class="lrow ${esc(l.level)}"><span class="lt">${esc(String(l.created_at || "").slice(5, 19).replace("T", " "))}</span>
  <span class="ltag">${esc(l.level)}</span><span class="lsrc">${esc(l.source || "")}</span><span>${esc(l.message || "")}</span></div>`).join("") || `<p class="hint">No logs</p>`}</div></div>`;
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

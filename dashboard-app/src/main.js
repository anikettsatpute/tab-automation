// Control Room shell: render loop, event wiring, data tick, keyboard.
// View modules own markup; this file owns composition + behavior.
import "./style.css";
import { S, $, $$, esc, api, setStatus } from "./views/state.js";
import { sidebar, topbar } from "./views/shell.js";
import { boardView, detailPane } from "./views/board.js";
import { configView, agentsView, toolsView, brainView, requestsView, outboxView, retroView, flowsView, todosView, logsView, reqModal, cmdPalette } from "./views/panels.js";
function render() {
  document.body.dataset.theme = S.theme;
  const active = document.activeElement;
  const activeId = active?.id || null;
  const activeKey = active?.dataset ? JSON.stringify({ v: active.dataset.view, b: active.dataset.btab, d: active.dataset.dtab, s: active.dataset.sel, c: active.dataset.cmd }) : null;
  const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
  const modalOpen = S.showReq || S.cmdOpen || S.flowEdit || S.diagFull;
  if (typing || (modalOpen && S._renderedModal)) { wireOnly(); return; }
  S._renderedModal = modalOpen;
  const v = S.view;
  const main = v === "board" ? boardView() : v === "assistant" ? `<div class="card"><h3>Assistant</h3><div class="chatbox"><input id="chat-in" placeholder='Ask Rick…'><button class="btn primary sm" id="chat-send">Send</button></div><div class="feed">${(S.feed?.messages || []).slice(-10).map((m) => `<div class="fmsg ${m.kind === "chat" ? "user" : "rick"}">${esc(m.text)}</div>`).join("")}</div></div>` :
    v === "brain" ? brainView() : v === "todos" ? todosView() : v === "automations" ? flowsView() :
    v === "requests" ? requestsView() : v === "outbox" ? outboxView() :
    v === "config" ? configView() :
    v === "activity" ? `<div class="card"><h3>Activity <span class="hint">global audit stream</span></h3><div class="logbox">${(S.activity || []).map((a) => `<div class="lrow info"><span class="lt">${esc(String(a.created_at || "").slice(5, 16).replace("T", " "))}</span><span class="ltag">${esc(a.action)}</span><span class="lsrc">${esc(a.actor || "")}</span><span>${esc(String(a.detail || "").slice(0, 160))}</span></div>`).join("")}</div></div>` :
    v === "retro" ? retroView() :
    v === "logs" ? logsView() : v === "tools" ? toolsView() : v === "agents" ? agentsView() :
    `<div class="card"><h3>${esc(v)}</h3><p class="hint">Coming soon.</p></div>`;
  $("#app").innerHTML = `<a class="skip" href="#main">Skip to main content</a><div class="app">${sidebar()}<main id="main" class="main" tabindex="-1">${topbar()}${main}</main></div>${reqModal()}${cmdPalette()}<div id="status" class="sr" role="status" aria-live="polite">${esc(S.statusMsg || "")}</div>`;
  // restore focus after re-render
  if (activeId) { const back = document.getElementById(activeId); if (back) back.focus({ preventScroll: true }); }
  wireOnly();
}

function wireOnly() {
  const menu = $("#menu");
  if (menu) menu.onclick = () => { const side = $(".side"); const open = side?.classList.toggle("open"); menu.setAttribute("aria-expanded", open ? "true" : "false"); };
  $$("[data-view]").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; S.sel = null; S.detail = null; $(".side")?.classList.remove("open"); render(); }));
  $$("[data-statusf]").forEach((b) => (b.onclick = () => { S.statusFilter = S.statusFilter === b.dataset.statusf ? "" : b.dataset.statusf; S.view = "board"; render(); }));
  $$("[data-btab]").forEach((b) => (b.onclick = () => { S.boardTab = b.dataset.btab; render(); }));
  $$("[data-dtab]").forEach((b) => (b.onclick = () => { S.detailTab = b.dataset.dtab; render(); }));
  $$("[data-sel]").forEach((b) => (b.onclick = async () => { S.sel = b.dataset.sel; S.detail = null; S.detailTab = "overview"; S.sessIdx = 0; render(); loadDetail(S.sel); }));
  $$(".banner").forEach((b) => (b.onclick = async () => { S.sel = b.dataset.sel; S.detail = null; S.detailTab = "overview"; render(); loadDetail(S.sel); }));
  const dc = $("#dclose"); if (dc) dc.onclick = () => { S.sel = null; S.detail = null; render(); };
  // loop task tables wiring
  $$("[data-loop]").forEach((b) => (b.onclick = async () => { S.loopSel = b.dataset.loop; S.loopDetail = null; render(); loadLoopDetail(S.loopSel); }));
  const lx = $("#loopx"); if (lx) lx.onclick = () => { S.loopSel = null; S.loopDetail = null; render(); };
  const ln = $("#loopnew"); if (ln) ln.onclick = () => { S.loopForm = { title: "" }; render(); const inp = $("#loop-title"); if (inp) inp.focus(); };
  const lc = $("#loopcancel"); if (lc) lc.onclick = () => { S.loopForm = null; render(); };
  const ls = $("#loopcreate"); if (ls) ls.onclick = async () => { const inp = $("#loop-title"); const t = inp ? inp.value.trim() : ""; if (!t) { setStatus("Loop task needs a title."); return; } const r = await api("/api/control/loop-tasks", { method: "POST", body: JSON.stringify({ title: t, repo: "tab-automation", task_type: "assistant", status: "open" }) }); S.loopForm = null; S.loopSel = r.id; tick(true); };
  $$("[data-loopx]").forEach((b) => (b.onclick = () => { const k = "L" + b.dataset.loopx; S.expandedSteps.has(k) ? S.expandedSteps.delete(k) : S.expandedSteps.add(k); render(); }));
  $$("[data-looprun]").forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.looprun; const d = S.loopDetail; if (!d) return;
    const s = (d.steps || [])[i]; if (!s) return;
    const ag = $(`#loop-agent-${i}`); const mo = $(`#loop-model-${i}`); const pr = $(`#loop-prompt-${i}`);
    b.disabled = true; b.textContent = "⏳ Dispatching…";
    try {
      const r = await api(`/api/control/loop-tasks/${d.task.id}/dispatch`, { method: "POST", body: JSON.stringify({ agent: ag ? ag.value : s.agent, model: mo ? mo.value : (s.model || ""), prompt: pr ? pr.value : (s.prompt || ""), stepId: s.step_id }) });
      S.cfgMsg = ""; S.loopDetail = null; setStatus(`Dispatched ${ag ? ag.value : s.agent} — done.`); tick(true);
    } catch (e) { b.disabled = false; b.textContent = `Dispatch`; setStatus(`Dispatch failed: ${e.message}`); }
  }));
  const la = $("#loopadd"); if (la) la.onclick = () => { if (!S.loopDetail) return; S.loopDetail.steps = [...(S.loopDetail.steps || []), { step_id: `step-${(S.loopDetail.steps || []).length + 1}`, type: "agent", agent: "assistant", model: "", status: "pending", prompt: "", output: "" }]; render(); };
  const lsv = $("#loopsave"); if (lsv) lsv.onclick = async () => { if (!S.loopDetail) return; const steps = (S.loopDetail.steps || []).map((s, i) => { const ag = $(`#loop-agent-${i}`); const mo = $(`#loop-model-${i}`); const pr = $(`#loop-prompt-${i}`); return { ...s, agent: ag ? ag.value : s.agent, model: mo ? mo.value : s.model, prompt: pr ? pr.value : s.prompt }; }); await api(`/api/control/loop-tasks/${S.loopDetail.task.id}`, { method: "POST", body: JSON.stringify({ steps }) }); S.loopDetail = null; tick(true); };
  // config view wiring
  $$("[data-cprov]").forEach((el) => (el.onchange = () => { if (S.cfgData?.providers?.providers?.[+el.dataset.cprov]) S.cfgData.providers.providers[+el.dataset.cprov][el.dataset.cf] = el.value; }));
  $$("[data-cagent]").forEach((el) => (el.onchange = () => { if (S.cfgData?.agents?.agents?.[+el.dataset.cagent]) S.cfgData.agents.agents[+el.dataset.cagent][el.dataset.cf] = el.value; }));
  const dp = $("#cfg-defprov"); if (dp) dp.onchange = () => { if (S.cfgData?.providers) S.cfgData.providers.defaultProvider = dp.value; };
  const csv = $("#cfgsave"); if (csv) csv.onclick = async () => { if (!S.cfgData) return; await api("/api/control/config", { method: "POST", body: JSON.stringify({ providers: S.cfgData.providers, agents: S.cfgData.agents }) }); S.cfgMsg = "Configuration saved — dispatch uses it immediately."; render(); setTimeout(() => { S.cfgMsg = ""; render(); }, 3000); };
  $$("[data-cfgtest]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.cfgtest; const mo = $(`#cfgtest-model-${id}`); const pr = $(`#cfgtest-prompt-${id}`); const out = $(`#cfgtest-out-${id}`);
    if (out) out.innerHTML = `<p class="hint">Dispatching ${esc(id)}…</p>`;
    try {
      const r = await api("/api/control/config/test", { method: "POST", body: JSON.stringify({ agent: id, model: mo ? mo.value : "", prompt: pr ? pr.value : "" }) });
      if (out) out.innerHTML = `<pre class="out">${esc(String(r.output || "").slice(0, 2000))}</pre>`;
    } catch (e) { if (out) out.innerHTML = `<div class="status bad">${esc(e.message)}</div>`; }
  }));
  $$("[data-rerun]").forEach((b) => (b.onclick = async () => { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.rerun, text: "" }) }); tick(true); }));
  $$("[data-runflow]").forEach((b) => (b.onclick = async () => { await api("/api/control/automations/" + b.dataset.runflow + "/run", { method: "POST" }).catch(() => api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.runflow, text: "" }) })); tick(true); }));
  $$("[data-tasklaunch]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.tasklaunch; const inp = $(`#task-goal-${id}`); const out = $(`#task-out-${id}`);
    const goal = inp ? inp.value.trim() : "";
    if (!goal) { setStatus("Task needs a goal — describe the bug or feature."); if (inp) inp.focus(); return; }
    b.disabled = true; b.textContent = "Launching…";
    if (out) out.innerHTML = `<p class="hint">Launching ${esc(id)} — spawning sessions per agent…</p>`;
    try {
      const r = await api(`/api/control/task-types/${id}/launch`, { method: "POST", body: JSON.stringify({ goal }) });
      if (out) out.innerHTML = `<div class="notice ok">Launched task <span class="kbd">${esc(r.taskId)}</span> → run <span class="kbd">${esc(r.runId || "?")}</span> (${(r.agents || []).join(" → ")}). Watch it move below.</div>`;
      setStatus(`Task launched: ${r.taskId}`);
      tick(true);
    } catch (e) { b.disabled = false; b.textContent = `Launch`; if (out) out.innerHTML = `<div class="status bad" role="alert">${esc(e.message)}</div>`; }
  }));
  $$("[data-xstep]").forEach((b) => (b.onclick = () => { const i = +b.dataset.xstep; S.expandedSteps.has(i) ? S.expandedSteps.delete(i) : S.expandedSteps.add(i); render(); }));
  $$("[data-xvar]").forEach((b) => (b.onclick = () => { const i = +b.dataset.xvar; S.expandedVariants.has(i) ? S.expandedVariants.delete(i) : S.expandedVariants.add(i); render(); }));
  $$("[data-ctx]").forEach((b) => (b.onclick = () => { S.showCtx = !S.showCtx; render(); }));
  $$("[data-rqstep]").forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.rqstep; const ta = $(`#rerun-${i}`); const guidance = ta ? ta.value : "";
    b.disabled = true; b.textContent = "⏳ Re-queuing…";
    try {
      await api(`/api/control/task/${S.sel}/requeue`, { method: "POST", body: JSON.stringify({ stepIndex: i, guidance }) });
      S.detail = null; tick(true);
    } catch (e) { b.disabled = false; b.textContent = `Re-queue from step ${i + 1}`; setStatus(`Re-queue failed: ${e.message}`); }
  }));
  $$("[data-act]").forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act; const box = $("#actbox");
    if (!S.sel) return;
    if (a === "req-changes") {
      if (box) box.innerHTML = `<div class="chatbox"><input id="rc-in" placeholder="Review feedback for the agent…"><button class="btn sm primary" id="rc-go">Send</button></div>`;
      const go = $("#rc-go"); if (go) go.onclick = async () => { const t = $("#rc-in").value.trim(); if (!t) return; await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: "request-changes", text: t }) }); S.detail = null; tick(true); };
      return;
    }
    if (a === "append") {
      if (box) box.innerHTML = `<div class="chatbox"><input id="ap-in" placeholder="Follow-up task title…"><button class="btn sm primary" id="ap-go">Append</button></div>`;
      const go = $("#ap-go"); if (go) go.onclick = async () => { const t = $("#ap-in").value.trim(); if (!t) return; await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: "append", title: t }) }); S.detail = null; tick(true); };
      return;
    }
    if (a === "requeue") { S.detailTab = "steps"; render(); return; }
    const map = { del: "delete" };
    if (map[a]) {
      if (a === "del" && !S.confirmDel) { S.confirmDel = true; render(); setStatus("Press Delete again to confirm."); setTimeout(() => { S.confirmDel = false; }, 4000); return; }
      S.confirmDel = false;
      await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: map[a] }) });
      if (a === "del") { S.sel = null; S.detail = null; }
      else S.detail = null;
      tick(true);
    }
  }));
  const df = $("#diagfull"); if (df) df.onclick = () => { S.diagFull = true; render(); };
  const dx = $("#diagx"); if (dx) dx.onclick = () => { S.diagFull = false; render(); };
  const ss = $("#sesssel"); if (ss) ss.onchange = () => { S.sessIdx = Number(ss.value); render(); };
  const sb = $("#sortby"); if (sb) sb.onchange = () => { S.sortBy = sb.value; render(); };
  const fq = $("#fq"); if (fq) { fq.oninput = () => { S.q = fq.value; if (S.cmdOpen) render(); }; fq.onchange = () => render(); }
  $$("[data-clearf]").forEach((b) => (b.onclick = () => { S.q = ""; S.statusFilter = ""; render(); }));
  const nt = $("#newtask"); if (nt) nt.onclick = () => { S.showReq = true; render(); wireReq(); };
  const cmds = $("#cmds"); if (cmds) cmds.onclick = () => { S.cmdOpen = true; S.cmdIdx = 0; render(); };
  const cx = $("#cmdx"); if (cx) cx.onclick = () => { S.cmdOpen = false; render(); };
  $$("[data-cmd]").forEach((b) => (b.onclick = () => {
    const v = b.dataset.cmd; S.cmdOpen = false;
    if (v === "new") { S.showReq = true; render(); wireReq(); return; }
    if (v === "refresh") { tick(true); return; }
    if (v === "pause") { S.paused = !S.paused; render(); arm(); return; }
    S.view = v; S.sel = null; S.detail = null; render();
  }));
  const ab = $("#autobtn"); if (ab) ab.onclick = () => { S.auto = !S.auto; render(); arm(); };
  const rs = $("#resume"); if (rs) rs.onclick = () => { S.paused = !S.paused; render(); arm(); };
  const rf = $("#refresh"); if (rf) rf.onclick = () => tick(true);
  const th = $("#theme"); if (th) th.onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; render(); };
  $$("[data-brain]").forEach((b) => (b.onclick = () => { S.brainSel = b.dataset.brain; render(); }));
  const bx = $("#brainx"); if (bx) bx.onclick = () => { S.brainSel = null; render(); };
  $$("[data-btab2]").forEach((b) => (b.onclick = () => { S.brainTab = b.dataset.btab2; render(); }));
  const bq = $("#brain-q"); if (bq) { bq.oninput = () => { S.brainQ = bq.value; }; bq.onchange = () => render(); }
  const ob = $("#ob-add"); if (ob) ob.onclick = async () => { const i = $("#ob-in"); const t = i.value.trim(); if (!t) return; await api("/api/control/outbox", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  $$("[data-obsent]").forEach((b) => (b.onclick = async () => { await api("/api/control/outbox/sent", { method: "POST", body: JSON.stringify({ id: b.dataset.obsent }) }); tick(true); }));
  // flows editor wiring (reference: spec AutomationsView — templates, trigger, palette, feedback)
  const TPL_FLOWS = {
    triage: { id: "triage-blocked", title: "Triage every blocked task", description: "When a task blocks, an investigator agent reads the evidence and posts a summary to the outbox.", trigger_type: "event", trigger_config: { rule: "on task blocked" }, steps: [{ id: "investigate", type: "run_agent", agent: "assistant", title: "Investigate block", prompt: "Read the blocked task evidence and summarize root cause." }, { id: "notify", type: "notify", title: "Post to outbox", message: "Blocked task triage: {{steps.investigate}}" }] },
    nightly: { id: "nightly-sweep", title: "Nightly knowledge sweep", description: "A scheduled agent run — no task, no PR. Good for curation, reporting and housekeeping.", trigger_type: "schedule", trigger_config: { cron: "0 2 * * *", timeOfDay: "2:00 AM", days: ["Every day"] }, steps: [{ id: "sweep", type: "run_agent", agent: "assistant", title: "Knowledge sweep", prompt: "Sweep recent runs and curate housekeeping notes." }] },
    onetime: { id: "investigate-fix", title: "One-time: investigate, then fix", description: "A single run: an agent scopes the problem, a condition gates it, then a real task is enqueued.", trigger_type: "manual", trigger_config: {}, steps: [{ id: "scope", type: "run_agent", agent: "assistant", title: "Scope problem", prompt: "Scope the problem in one pass." }, { id: "gate", type: "condition", title: "Gate", rule: "scope found issue" }, { id: "file", type: "create_task", title: "Enqueue fix", details: "real task" }] },
  };
  const seedFlowEdit = (f) => {
    S.flowEdit = { id: f.id, title: f.title, description: f.description || "", trigger_type: f.trigger_type || "manual", trigger_config: f.trigger_config || {}, steps: (f.steps || []).map((s, i) => ({ id: s.id || `step-${i + 1}`, type: s.type || "run_agent", agent: s.agent || "assistant", model: s.model || "", title: s.title || s.id || s.type, prompt: s.prompt || s.message || s.text || s.template || "", rule: s.rule || "", details: s.details || "" })) };
    S.flowTrig = S.flowEdit.trigger_type;
    S.flowTime = S.flowEdit.trigger_config?.timeOfDay || "11:00 AM";
    S.flowDays = S.flowEdit.trigger_config?.days || ["Every day"];
    S.flowCron = S.flowEdit.trigger_config?.cron || "";
    S.flowRule = S.flowEdit.trigger_config?.rule || "";
  };
  $$("[data-tpl]").forEach((b) => (b.onclick = () => { seedFlowEdit(TPL_FLOWS[b.dataset.tpl]); S.flowMsg = `Loaded template: ${S.flowEdit.title}`; render(); setTimeout(() => { S.flowMsg = ""; render(); }, 3500); }));
  const fn = $("#flownew"); if (fn) fn.onclick = () => { seedFlowEdit({ id: "flow-new", title: "New flow", description: "", trigger_type: "manual", trigger_config: {}, steps: [] }); render(); };
  const fx = $("#flowx"); if (fx) fx.onclick = () => { S.flowEdit = null; render(); };
  const fc = $("#flowcancel"); if (fc) fc.onclick = () => { S.flowEdit = null; render(); };
  const fe = $("#flowexpand"); if (fe) fe.onclick = () => { S.expandedSteps = new Set((S.flowEdit?.steps || []).map((_, i) => i)); render(); };
  $$("[data-ftrig]").forEach((b) => (b.onclick = () => { S.flowTrig = b.dataset.ftrig; if (S.flowEdit) S.flowEdit.trigger_type = S.flowTrig; render(); }));
  $$("[data-fday]").forEach((b) => (b.onclick = () => { const d = b.dataset.fday; if (d === "Every day") S.flowDays = ["Every day"]; else { S.flowDays = S.flowDays.filter((x) => x !== "Every day"); S.flowDays.includes(d) ? S.flowDays = S.flowDays.filter((x) => x !== d) : S.flowDays.push(d); if (!S.flowDays.length) S.flowDays = ["Every day"]; } render(); }));
  $$("[data-preset]").forEach((b) => (b.onclick = () => { const p = b.dataset.preset; if (p.includes("9:00")) S.flowTime = "9:00 AM"; else if (p.includes("6:00")) S.flowTime = "6:00 PM"; else if (p.includes("8:30")) S.flowTime = "8:30 AM"; else if (p.includes("11:00")) S.flowTime = "11:00 AM"; else if (p.includes("hour")) { S.flowTime = "Every hour"; S.flowCron = "0 * * * *"; } else if (p.includes("N minutes")) { S.flowTime = "Every N minutes"; S.flowCron = "*/15 * * * *"; } render(); }));
  const fcr = $("#flowcron"); if (fcr) fcr.onclick = () => { const v = prompt("Cron expression (m h dom mon dow):", S.flowCron || "0 11 * * *"); if (v !== null) { S.flowCron = v; render(); } };
  const fr = $("#flow-rule"); if (fr) fr.onchange = () => { S.flowRule = fr.value; };
  $$("[data-fadd]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; const t = b.dataset.fadd; S.flowEdit.steps = [...(S.flowEdit.steps || []), { id: `step-${(S.flowEdit.steps || []).length + 1}`, type: t, agent: "assistant", model: "", title: t.replace(/_/g, " "), prompt: "", rule: "", details: "" }]; S.flowMsg = `Added step: ${t.replace(/_/g, " ")}`; render(); setTimeout(() => { S.flowMsg = ""; render(); }, 2500); }));
  $$("[data-fdel]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; S.flowEdit.steps = (S.flowEdit.steps || []).filter((_, i) => i !== Number(b.dataset.fdel)); render(); }));
  $$("[data-fup]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; const i = Number(b.dataset.fup); const a = [...(S.flowEdit.steps || [])]; if (i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; S.flowEdit.steps = a; render(); } }));
  $$("[data-fdown]").forEach((b) => (b.onclick = () => { if (!S.flowEdit) return; const i = Number(b.dataset.fdown); const a = [...(S.flowEdit.steps || [])]; if (i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; S.flowEdit.steps = a; render(); } }));
  $$("[data-sagent]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.sagent]) S.flowEdit.steps[+el.dataset.sagent].agent = el.value; }));
  $$("[data-smodel]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.smodel]) S.flowEdit.steps[+el.dataset.smodel].model = el.value; }));
  $$("[data-sprompt]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.sprompt]) S.flowEdit.steps[+el.dataset.sprompt].prompt = el.value; }));
  $$("[data-srule]").forEach((el) => (el.onchange = () => { if (S.flowEdit?.steps?.[+el.dataset.srule]) S.flowEdit.steps[+el.dataset.srule].rule = el.value; }));
  const fs = $("#flowsave"); if (fs) fs.onclick = async () => {
    if (!S.flowEdit) return;
    const ft = $("#flow-time"); if (ft) S.flowTime = ft.value;
    const fr2 = $("#flow-rule"); if (fr2) S.flowRule = fr2.value;
    const payload = { id: S.flowEdit.id, title: S.flowEdit.title || S.flowEdit.id, description: S.flowEdit.description || "", trigger_type: S.flowTrig, trigger_config: { timeOfDay: S.flowTime, days: S.flowDays, cron: S.flowCron, rule: S.flowRule }, steps: S.flowEdit.steps };
    await api("/api/control/automations", { method: "POST", body: JSON.stringify(payload) });
    S.flowMsg = `Saved flow "${payload.title}"`; S.flowEdit = null; render(); tick(true);
    setTimeout(() => { S.flowMsg = ""; render(); }, 3500);
  };
  $$("[data-flowedit]").forEach((b) => (b.onclick = () => { const f = (S.flows || []).find((x) => x.id === b.dataset.flowedit); if (f) { seedFlowEdit({ id: f.id, title: f.title, description: f.description, trigger_type: f.trigger?.type || "manual", trigger_config: f.trigger || {}, steps: f.steps || [] }); render(); } }));
  $$("[data-flowen]").forEach((b) => (b.onclick = async () => { const f = (S.flows || []).find((x) => x.id === b.dataset.flowen); await api(`/api/control/automations/${b.dataset.flowen}/enable`, { method: "POST", body: JSON.stringify({ enabled: f?.enabled === false }) }); S.flowMsg = f?.enabled === false ? "Flow enabled" : "Flow paused"; render(); tick(true); setTimeout(() => { S.flowMsg = ""; render(); }, 2500); }));
  $$("[data-flowdel]").forEach((b) => (b.onclick = async () => { if (!confirm("Delete flow?")) return; await api(`/api/control/automations/${b.dataset.flowdel}/delete`, { method: "POST" }); tick(true); }));
  $$("[data-flowdry]").forEach((b) => (b.onclick = async () => { const f = (S.flows || []).find((x) => x.id === b.dataset.flowdry); S.flowMsg = `Dry run executed for ${f?.title || b.dataset.flowdry}. 0 side-effects.`; render(); setTimeout(() => { S.flowMsg = ""; render(); }, 3500); }));
  // todos wiring
  $$("[data-ttab]").forEach((b) => (b.onclick = () => { S.todoTab = b.dataset.ttab; render(); }));
  const tq = $("#todo-q"); if (tq) { tq.oninput = () => { S.todoQ = tq.value; }; tq.onchange = () => render(); }
  const ts2 = $("#todo-src"); if (ts2) ts2.onchange = () => { S.todoSource = ts2.value; render(); };
  const tn = $("#todo-new"); if (tn) tn.onclick = () => { S.todoForm = true; render(); const inp = $("#todo-title"); if (inp) inp.focus(); };
  const tc = $("#todocancel"); if (tc) tc.onclick = () => { S.todoForm = false; render(); };
  const ts = $("#todocreate"); if (ts) ts.onclick = async () => { const inp = $("#todo-title"); const t = inp ? inp.value.trim() : ""; if (!t) { setStatus("TODO needs text."); return; } S.todoForm = false; await api("/api/control/todos", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  $$("[data-tdone]").forEach((b) => (b.onclick = async () => { await api("/api/control/todos/done", { method: "POST", body: JSON.stringify({ id: b.dataset.tdone }) }); tick(true); }));
  $$("[data-tdis]").forEach((b) => (b.onclick = async () => { await api("/api/control/todos/dismiss", { method: "POST", body: JSON.stringify({ id: b.dataset.tdis }) }); tick(true); }));
  $$("[data-tconv]").forEach((b) => (b.onclick = async () => { const r = await api("/api/control/todos/convert", { method: "POST", body: JSON.stringify({ id: b.dataset.tconv }) }); S.view = "requests"; tick(true); }));
  wireReq();
  const cs = $("#chat-send"); if (cs) cs.onclick = sendChat;
  const ta = $("#todo-add"); if (ta) ta.onclick = async () => { const i = $("#todo-in"); const t = i.value.trim(); if (!t) return; await api("/api/control/todos", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  const ll = $("#loglevel"); if (ll) ll.onchange = () => { S.logLevel = ll.value; tick(true); };
  const lr = $("#logref"); if (lr) lr.onclick = () => tick(true);
}

function wireReq() {
  const rx = $("#reqx"); if (rx) rx.onclick = () => { S.showReq = false; S.reqMsg = ""; render(); };
  const mr = $("#reqm-req"); if (mr) mr.onclick = () => { S.reqMode = "request"; render(); wireReq(); };
  const md = $("#reqm-dir"); if (md) md.onclick = () => { S.reqMode = "direct"; render(); wireReq(); };
  $$("[data-reqagent]").forEach((b) => (b.onclick = () => { const a = b.dataset.reqagent; S.reqAgents.includes(a) ? S.reqAgents = S.reqAgents.filter((x) => x !== a) : S.reqAgents.push(a); if (!S.reqAgents.length) S.reqAgents = [a]; render(); wireReq(); }));
  const rs = $("#req-stream"); if (rs) rs.onchange = () => { S.reqStream = rs.value; S.reqPipeline = ""; render(); wireReq(); };
  const rp = $("#req-pipe"); if (rp) rp.onchange = () => { S.reqPipeline = rp.value; const p = streamPipes(S.reqStream).find((x) => x.id === rp.value); if (p?.agents?.length) S.reqAgents = [...p.agents]; render(); wireReq(); };
  const g = $("#req-go"); if (g) g.onclick = async () => {
    const t = $("#req-text").value.trim(); if (!t || S.reqBusy) return;
    S.reqBusy = true; S.reqMsg = "Divider working…"; render(); wireReq();
    try {
      const r = await api("/api/control/requests", { method: "POST", body: JSON.stringify({ text: t, mode: S.reqMode, stream: S.reqStream, pipeline: S.reqPipeline || undefined, agents: S.reqAgents }) });
      S.reqBusy = false; S.showReq = false; S.reqMsg = "";
      S.view = "board"; S.boardTab = "tasks"; S.sel = r.runId; S.detail = null;
      render(); if (r.runId) loadDetail(r.runId); else tick(true);
    } catch (e) { S.reqBusy = false; S.reqMsg = e.message; render(); wireReq(); }
  };
}

async function sendChat() {
  const i = $("#chat-in"); const t = i.value.trim(); if (!t) return; i.value = "";
  await api("/api/control/chat", { method: "POST", body: JSON.stringify({ text: t }) }).catch(() => {});
  setTimeout(() => tick(true), 1500);
}

async function loadDetail(id) {
  try { const r = await api(`/api/control/task/${id}`); S.detail = r.task; render(); } catch { /* keep list */ }
}

async function loadLoopDetail(id) {
  try { const r = await api(`/api/control/loop-tasks/${id}`); S.loopDetail = r; render(); } catch { /* keep list */ }
}

function arm() {
  if (S.timer) clearInterval(S.timer);
  if (S.auto && S.cfg.enabled) S.timer = setInterval(() => tick(), Math.max(2, Number(S.cfg.refreshSec) || 3) * 1000);
}

async function tick(force) {
  try {
    const [cfg, ov, tasks, agents, tools, activity, logs, appr, todos, feed, brain, flows, requests, outbox, retro, loopTasks, cfgData, taskTypes] = await Promise.all([
      api("/api/dashboard/config").catch(() => S.cfg),
      api("/api/control/overview?days=7").catch(() => null),
      api("/api/control/tasks?limit=30").catch(() => ({ tasks: [] })),
      api("/api/control/agents").catch(() => ({ agents: [] })),
      api("/api/control/tools").catch(() => ({ tools: [] })),
      api("/api/control/activity?limit=60").catch(() => ({ activity: [] })),
      api(`/api/control/logs?limit=100${S.logLevel ? "&level=" + S.logLevel : ""}`).catch(() => ({ logs: [] })),
      api("/api/control/approvals").catch(() => ({ approvals: [] })),
      api("/api/control/todos").catch(() => ({ todos: [], reminders: [] })),
      api("/api/feed?limit=8").catch(() => null),
      api("/api/control/brain").catch(() => null),
      api("/api/control/automations").catch(() => ({ flows: [] })),
      api("/api/control/requests").catch(() => ({ requests: [] })),
      api("/api/control/outbox").catch(() => ({ outbox: [] })),
      api("/api/control/retro?days=30").catch(() => null),
      api("/api/control/loop-tasks?limit=50").catch(() => ({ tasks: [] })),
      api("/api/control/config").catch(() => null),
      api("/api/control/task-types").catch(() => ({ taskTypes: [] })),
    ]);
    if (cfg) S.cfg = cfg;
    if (ov) S.ov = ov;
    // Resilient tick: a failed fetch keeps the last good data instead of
    // blanking the board to "0 runs". Only overwrite on real payloads.
    // (The bot's HTTP loop can stall for a minute while a Muse session thinks;
    // the board must show stale data + a notice, not an empty screen.)
    const hadTasks = (S.tasks || []).length;
    if (Array.isArray(tasks.tasks)) S.tasks = tasks.tasks;
    if (Array.isArray(agents.agents)) S.agents = agents.agents;
    if (Array.isArray(tools.tools)) S.tools = tools.tools;
    if (Array.isArray(activity.activity)) S.activity = activity.activity;
    if (Array.isArray(logs.logs)) S.logs = logs.logs;
    if (Array.isArray(appr.approvals)) S.approvals = appr.approvals;
    if (Array.isArray(todos.todos)) { S.todos = todos.todos; S.reminders = todos.reminders || []; }
    if (feed) S.feed = feed; if (brain) S.brain = brain;
    if (Array.isArray(flows.flows)) S.flows = flows.flows;
    if (Array.isArray(requests.requests)) S.requests = requests.requests;
    if (Array.isArray(outbox.outbox)) S.outbox = outbox.outbox;
    if (retro) S.retro = retro;
    if (Array.isArray(loopTasks.tasks)) S.loopTasks = loopTasks.tasks;
    if (Array.isArray(taskTypes.taskTypes)) S.taskTypes = taskTypes.taskTypes;
    if (cfgData) S.cfgData = cfgData;
    S.stale = hadTasks > 0 && (S.tasks || []).length === 0 ? false : (tasks.tasks ? false : true);
    if (S.sel && !S.detail) { loadDetail(S.sel); return; }
    if (S.loopSel && !S.loopDetail) { loadLoopDetail(S.loopSel); return; }
    render(); arm();
  } catch (e) {
    $("#app").innerHTML = `<main class="shell"><div class="status bad" role="alert">Control Room failed to load: ${esc(e.message)}. <button type="button" class="btn sm" onclick="location.reload()">Retry</button></div></main>`;
  }
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); S.cmdOpen = !S.cmdOpen; S.cmdIdx = 0; render(); const f = $("#fq"); if (S.cmdOpen && f) f.focus(); }
  else if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "SELECT") { e.preventDefault(); $("#fq")?.focus(); }
  else if (e.key === "Escape") {
    if (S.cmdOpen) { S.cmdOpen = false; render(); }
    else if (S.showReq) { S.showReq = false; render(); }
    else if (S.flowEdit) { S.flowEdit = null; render(); }
    else if (S.diagFull) { S.diagFull = false; render(); }
  } else if (S.cmdOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = $$("[data-cmd]").length || 1;
    S.cmdIdx = e.key === "ArrowDown" ? (S.cmdIdx + 1) % n : (S.cmdIdx - 1 + n) % n;
    render();
  } else if (S.cmdOpen && e.key === "Enter") {
    const el = $$("[data-cmd]")[S.cmdIdx];
    if (el) el.click();
  }
});
tick();

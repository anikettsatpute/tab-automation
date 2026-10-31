// Control Room shell: render loop, event wiring, data tick, keyboard.
// View modules own markup; this file owns composition + behavior.
import "./style.css";
import { createFocusTrap } from "focus-trap";
import { S, $, $$, esc, api, postJob, jobRunId, regionHash, streamPipes, setStatus, refreshAuthStatus, loginWithToken, logoutSession, saveReqDraft, restoreReqDraft, clearReqDraft } from "./views/state.js";
import { sidebar, topbar, accessGate } from "./views/shell.js";
import { refreshIcons, pageHead, emptyState } from "./views/ui.js";
import { boardView, detailPane } from "./views/board.js";
import { configView, agentsView, toolsView, brainView, requestsView, outboxView, retroView, paintRetroChart, flowsView, todosView, logsView, reqModal, cmdPalette } from "./views/panels.js";
let taskTrap = null;
let taskTrapSel = null;

function mountTaskDrawer() {
  const drawer = $("#task-detail-drawer");
  if (!drawer) {
    if (taskTrap) { try { taskTrap.deactivate({ returnFocus: false }); } catch {} taskTrap = null; }
    if (taskTrapSel) {
      const id = taskTrapSel; taskTrapSel = null;
      const card = document.querySelector(`[data-sel="${id}"]`);
      if (card) card.focus({ preventScroll: true });
    }
    return;
  }
  if (taskTrap && taskTrapSel === S.sel) {
    try { taskTrap.updateContainerElements(drawer); } catch {}
    return;
  }
  if (taskTrap) { try { taskTrap.deactivate({ returnFocus: false }); } catch {} taskTrap = null; }
  taskTrapSel = S.sel;
  try {
    taskTrap = createFocusTrap(drawer, {
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: (event) => !!event.target.closest?.("[data-drawer-backdrop]"),
      returnFocusOnDeactivate: false,
      fallbackFocus: drawer,
      initialFocus: () => drawer.querySelector("#dclose") || drawer,
    });
    taskTrap.activate();
  } catch { taskTrap = null; }
}

function closeTaskDetail() {
  if (S.fromTab) S.boardTab = S.fromTab;
  S.fromTab = null; S.sel = null; S.detail = null;
  render();
}
// Keyed, focus-preserving render: sidebar/topbar/main/modals update independently.
// Typing in any input/textarea/select never triggers a full re-render — only
// event rewiring — so focus, caret, and scroll survive the 3s tick.
function renderRegion(sel, html) {
  const el = $(sel);
  if (!el) return false;
  // Full-string hash: the old length+first-64-chars prefix could skip real
  // updates when two payloads shared a prefix (stale region, lost state).
  const h = regionHash(html);
  if (el.dataset.hash === h) return true;
  el.dataset.hash = h;
  el.innerHTML = html;
  return true;
}
function mainHtml() {
  // Access gate replaces private views until the browser holds a session.
  // The login form itself is the only thing rendered (no data leaks).
  if (S.auth.required) return accessGate();
  const v = S.view;
  if (v === "board") return boardView();
  if (v === "assistant") return `<div class="card"><h3>Assistant</h3><div class="chatbox"><input id="chat-in" placeholder='Ask Rick…'><button class="btn primary sm" id="chat-send">Send</button></div><div class="feed">${(S.feed?.messages || []).slice(-10).map((m) => `<div class="fmsg ${m.kind === "chat" ? "user" : "rick"}">${esc(m.text)}</div>`).join("")}</div></div>`;
  if (v === "brain") return brainView();
  if (v === "todos") return todosView();
  if (v === "automations") return flowsView();
  if (v === "requests") return requestsView();
  if (v === "outbox") return outboxView();
  if (v === "config") return configView();
  if (v === "activity") return `<div>${pageHead("Activity", "global audit stream")}<div class="card"><div class="logbox">${(S.activity || []).map((a) => `<div class="lrow info"><span class="lt">${esc(String(a.created_at || "").slice(5, 16).replace("T", " "))}</span><span class="ltag">${esc(a.action)}</span><span class="lsrc">${esc(a.actor || "")}</span><span>${esc(String(a.detail || "").slice(0, 160))}</span></div>`).join("") || emptyState("activity", "No activity", "Runs and agent actions stream here.")}</div></div></div>`;
  if (v === "retro") return retroView();
  if (v === "logs") return logsView();
  if (v === "tools") return toolsView();
  if (v === "agents") return agentsView();
  return `<div class="card"><h3>${esc(v)}</h3><p class="hint">Coming soon.</p></div>`;
}
function render(background = false) {
  document.body.dataset.theme = S.theme;
  const active = document.activeElement;
  const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
  const modalOpen = S.showReq || S.cmdOpen || S.flowEdit || S.diagFull;
  const app = $("#app");
  if (!app || !app.dataset.booted) {
    if (app) app.dataset.booted = "1";
    else return;
    app.innerHTML = `<a class="skip" href="#main">Skip to main content</a><div class="app"><div id="rg-side"></div><main id="main" class="main" tabindex="-1"><div id="rg-top"></div><div id="rg-main"></div></main></div><div id="rg-modals"></div><div id="status" class="sr" role="status" aria-live="polite"></div><div id="alerts" class="sr" role="alert"></div>`;
  }
  // Preserve scroll per scrollable region by key.
  const scrolls = new Map([...document.querySelectorAll(".blist, .bdetail, .tdrawer, .blist-col, .logbox, .dscroll, .transcript")].map((el, i) => [el.className + i, el.scrollTop]));
  const activeId = active?.id || null;
  const selStart = active && "selectionStart" in active ? active.selectionStart : null;
  const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;
  if (background && (typing || modalOpen)) { wireOnly(); return; }
  S._renderedModal = modalOpen;
  renderRegion("#rg-side", sidebar());
  renderRegion("#rg-top", topbar());
  renderRegion("#rg-main", mainHtml());
  renderRegion("#rg-modals", `${reqModal()}${cmdPalette()}${brainDrawerLive()}`);
  mountTaskDrawer();
  const st = $("#status"); if (st && st.textContent !== (S.statusMsg || "")) st.textContent = S.statusMsg || "";
  [...document.querySelectorAll(".blist, .bdetail, .tdrawer, .blist-col, .logbox, .dscroll, .transcript")].forEach((el, i) => { const k = el.className + i; if (scrolls.has(k)) el.scrollTop = scrolls.get(k); });
  refreshIcons();
  if (S.view === "retro") paintRetroChart();
  if (activeId) { const back = document.getElementById(activeId); if (back) { back.focus({ preventScroll: true }); try { if (selStart != null && back.setSelectionRange) back.setSelectionRange(selStart, selEnd); } catch {} } }
  wireOnly();
}
// Brain drawer live region mount (focus-trapped dialog content lives in panels.js).
function brainDrawerLive() { return ""; }

function wireOnly() {
  const menu = $("#menu");
  if (menu) menu.onclick = () => { const side = $(".side"); const open = side?.classList.toggle("open"); menu.setAttribute("aria-expanded", open ? "true" : "false"); };
  // Access gate wiring: login form + local one-click + logout.
  const ago = $("#auth-go");
  if (ago) ago.onclick = async () => {
    const inp = $("#auth-token");
    const token = inp ? inp.value : "";
    if (inp) inp.value = ""; // never keep the token in the DOM
    if (!token) { S.auth.error = "Paste the CONTROL_TOKEN to sign in."; render(); return; }
    try { await loginWithToken(token); render(); connectFeedStream(); tick(true); }
    catch { render(); }
  };
  const atok = $("#auth-token");
  if (atok) atok.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#auth-go")?.click(); } };
  const aloc = $("#auth-local");
  if (aloc) aloc.onclick = async () => {
    try { await loginWithToken(""); render(); connectFeedStream(); tick(true); }
    catch { render(); }
  };
  const lo = $("#logout");
  if (lo) lo.onclick = async () => { closeFeedStream(); await logoutSession(); render(); };
  $$("[data-view]").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; S.sel = null; S.detail = null; S.fromTab = null; $(".side")?.classList.remove("open"); render(); }));
  $$("[data-statusf]").forEach((b) => (b.onclick = () => { S.statusFilter = S.statusFilter === b.dataset.statusf ? "" : b.dataset.statusf; S.view = "board"; S.sel = null; S.detail = null; render(); }));
  $$("[data-btab]").forEach((b) => (b.onclick = () => { S.boardTab = b.dataset.btab; S.sel = null; S.detail = null; S.loopSel = null; S.loopDetail = null; render(); }));
  $$("[data-types]").forEach((b) => (b.onclick = () => { S.showTypes = !S.showTypes; render(); }));
  $$("[data-dtab]").forEach((b) => (b.onclick = () => { S.detailTab = b.dataset.dtab; render(); }));
  $$("[data-sel]").forEach((b) => (b.onclick = async () => { S.fromTab = S.boardTab; S.sel = b.dataset.sel; S.detail = null; S.detailError = ""; S.detailTab = "overview"; S.sessIdx = 0; S.sessExport = null; render(); loadDetail(S.sel); }));
  const retryDetail = $("#detail-retry"); if (retryDetail) retryDetail.onclick = () => loadDetail(S.sel);
  const back = $("#dback"); if (back) back.onclick = () => closeTaskDetail();
  const dc = $("#dclose"); if (dc) dc.onclick = () => closeTaskDetail();
  const backdrop = $("[data-drawer-backdrop]"); if (backdrop) backdrop.onclick = () => closeTaskDetail();
  // loop task tables wiring
  $$("[data-loop]").forEach((b) => (b.onclick = async () => { S.loopSel = b.dataset.loop; S.loopDetail = null; render(); loadLoopDetail(S.loopSel); }));
  const lb = $("#loopback"); if (lb) lb.onclick = () => { S.loopSel = null; S.loopDetail = null; render(); };
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
      // Backend returns 202 { jobId } (async) — poll the job, then reload steps.
      const { sync, final } = await postJob(`/api/control/loop-tasks/${d.task.id}/dispatch`, { agent: ag ? ag.value : s.agent, model: mo ? mo.value : (s.model || ""), prompt: pr ? pr.value : (s.prompt || ""), stepId: s.step_id });
      const jobId = sync?.jobId || final?.job?.id || null;
      S.cfgMsg = ""; S.loopDetail = null;
      setStatus(jobId ? `Dispatched ${ag ? ag.value : s.agent} → job ${String(jobId).slice(0, 8)}.` : `Dispatched ${ag ? ag.value : s.agent} — done.`);
      tick(true);
    } catch (e) { b.disabled = false; b.textContent = `Dispatch`; setStatus(`Dispatch failed: ${e.message}`); }
  }));
  const la = $("#loopadd"); if (la) la.onclick = () => { if (!S.loopDetail) return; S.loopDetail.steps = [...(S.loopDetail.steps || []), { step_id: `step-${(S.loopDetail.steps || []).length + 1}`, type: "agent", agent: "assistant", model: "", status: "pending", prompt: "", output: "" }]; render(); };
  const lsv = $("#loopsave"); if (lsv) lsv.onclick = async () => { if (!S.loopDetail) return; const steps = (S.loopDetail.steps || []).map((s, i) => { const ag = $(`#loop-agent-${i}`); const mo = $(`#loop-model-${i}`); const pr = $(`#loop-prompt-${i}`); return { ...s, agent: ag ? ag.value : s.agent, model: mo ? mo.value : s.model, prompt: pr ? pr.value : s.prompt }; }); await api(`/api/control/loop-tasks/${S.loopDetail.task.id}`, { method: "POST", body: JSON.stringify({ steps }) }); S.loopDetail = null; tick(true); };
  // config view wiring
  $$("[data-cprov]").forEach((el) => (el.onchange = () => { if (S.cfgData?.providers?.providers?.[+el.dataset.cprov]) S.cfgData.providers.providers[+el.dataset.cprov][el.dataset.cf] = el.value; }));
  $$("[data-cagent]").forEach((el) => (el.onchange = () => { if (S.cfgData?.agents?.agents?.[+el.dataset.cagent]) S.cfgData.agents.agents[+el.dataset.cagent][el.dataset.cf] = el.value; }));
  const dp = $("#cfg-defprov"); if (dp) dp.onchange = () => { if (S.cfgData?.providers) S.cfgData.providers.defaultProvider = dp.value; };
  const csv = $("#cfgsave"); if (csv) csv.onclick = saveCfg;
  const csv2 = $("#cfgsave2"); if (csv2) csv2.onclick = saveCfg;
  async function saveCfg() { if (!S.cfgData) return; await api("/api/control/config", { method: "POST", body: JSON.stringify({ providers: S.cfgData.providers, agents: S.cfgData.agents }) }); S.cfgMsg = "Configuration saved — dispatch uses it immediately."; render(); setTimeout(() => { S.cfgMsg = ""; render(); }, 3000); }
  $$("[data-cfgtest]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.cfgtest; const mo = $(`#cfgtest-model-${id}`); const pr = $(`#cfgtest-prompt-${id}`); const out = $(`#cfgtest-out-${id}`);
    if (out) out.innerHTML = `<p class="hint">Dispatching ${esc(id)}…</p>`;
    try {
      const r = await api("/api/control/config/test", { method: "POST", body: JSON.stringify({ agent: id, model: mo ? mo.value : "", prompt: pr ? pr.value : "" }) });
      if (out) out.innerHTML = `<pre class="out">${esc(String(r.output || "").slice(0, 2000))}</pre>`;
    } catch (e) { if (out) out.innerHTML = `<div class="status bad">${esc(e.message)}</div>`; }
  }));
  $$("[data-rerun]").forEach((b) => (b.onclick = async () => { await api("/api/control/chat", { method: "POST", body: JSON.stringify({ workflow: b.dataset.rerun, text: "" }) }); tick(true); }));
  $$("[data-runflow]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; const label = b.textContent; b.textContent = "Starting…";
    try {
      const { sync, final } = await postJob("/api/control/automations/" + b.dataset.runflow + "/run", {});
      // Backend job rows use snake_case run_id; sync replies may use runId.
      const runId = jobRunId(final, sync);
      setStatus(runId ? `Flow started → run ${String(runId).slice(0, 8)}.` : "Flow started.");
      tick(true);
    } catch (e) { setStatus(`Flow run failed: ${e.message}`); }
    finally { b.disabled = false; b.textContent = label; }
  }));
  $$("[data-tasklaunch]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.tasklaunch; const inp = $(`#task-goal-${id}`); const out = $(`#task-out-${id}`);
    const goal = inp ? inp.value.trim() : "";
    if (!goal) { setStatus("Task needs a goal — describe the bug or feature."); if (inp) inp.focus(); return; }
    b.disabled = true; b.textContent = "Launching…";
    if (out) out.innerHTML = `<p class="hint">Launching ${esc(id)} — spawning sessions per agent…</p>`;
    try {
      // Backend returns 202 { jobId } (async) — poll the job for the run id.
      const { sync, final } = await postJob(`/api/control/task-types/${id}/launch`, { goal });
      const taskId = sync?.taskId || final?.taskId || null;
      const runId = jobRunId(final, sync);
      if (out) out.innerHTML = `<div class="notice ok">Launched task <span class="kbd">${esc(taskId || "?")}</span>${runId ? ` → run <span class="kbd">${esc(runId)}</span>` : " — run starts when the worker claims the job."} (${((sync?.agents || final?.agents) || []).join(" → ")}). Watch it move below.</div>`;
      setStatus(taskId ? `Task launched: ${taskId}` : "Task launched.");
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
      // Backend returns 202 { jobId } (async) — poll the job for the run id.
      const { sync, final } = await postJob(`/api/control/task/${S.sel}/requeue`, { stepIndex: i, guidance });
      const runId = jobRunId(final, sync);
      if (runId) { S.sel = runId; }
      S.detail = null; setStatus(runId ? `Re-queued → run ${String(runId).slice(0, 8)}.` : "Re-queued."); tick(true);
    } catch (e) {
      b.disabled = false; b.textContent = `Re-queue from step ${i + 1}`;
      if (e?.status === 429) setStatus(`Re-queue denied: restart budget exceeded — task blocked. ${e.message}`);
      else setStatus(`Re-queue failed: ${e.message}`);
    }
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
    if (a === "done" || a === "block") {
      const label = a === "done" ? "Mark done" : "Block";
      if (box) box.innerHTML = `<div class="chatbox"><input id="ab-in" placeholder="${a === "done" ? "Resolution note (optional)…" : "Why is this blocked? (goes to outbox)…"}"><button type="button" class="btn sm primary" id="ab-go">${label}</button></div>`;
      const go = $("#ab-go"); if (go) go.onclick = async () => {
        const t = $("#ab-in").value.trim();
        go.disabled = true; go.textContent = "Saving…";
        try {
          await api(`/api/control/task/${S.sel}/action`, { method: "POST", body: JSON.stringify({ action: a, text: t }) });
          S.detail = null; tick(true);
        } catch (e) { go.disabled = false; go.textContent = label; setStatus(`${label} failed: ${e.message}`); }
      };
      return;
    }
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
  const ss = $("#sesssel"); if (ss) ss.onchange = () => { S.sessIdx = Number(ss.value); S.sessExport = null; render(); };
  const st2 = $("#sesstool"); if (st2) st2.onchange = () => { S.sessToolFilter = st2.value; render(); };
  $$("[data-sesspick]").forEach((b) => (b.onclick = () => { S.sessIdx = Number(b.dataset.sesspick); S.sessExport = null; render(); }));
  // Open = select + honestly load the real transcript via the export endpoint.
  // Never spawns a model or falls back to another provider — read-only `muse export`.
  async function openSession(idx) {
    S.sessIdx = idx; S.sessExport = { idx, loading: true };
    render();
    try {
      const r = await api(`/api/control/task/${S.sel}/sessions/${idx}/export`);
      S.sessExport = { idx, loading: false, ...r };
    } catch (e) { S.sessExport = { idx, loading: false, error: e.message }; }
    render();
  }
  $$("[data-sessopen]").forEach((b) => (b.onclick = () => openSession(Number(b.dataset.sessopen))));
  $$("[data-sessexp]").forEach((b) => (b.onclick = () => openSession(Number(b.dataset.sessexp))));
  const sb = $("#sortby"); if (sb) sb.onchange = () => { S.sortBy = sb.value; render(); };
  const kf = $("#kindf"); if (kf) kf.onchange = () => { S.kindFilter = kf.value; render(); };
  const fq = $("#fq"); if (fq) { fq.oninput = () => { S.q = fq.value; const f2 = $("#fq2"); if (f2 && f2.value !== fq.value) { f2.value = fq.value; } if (S.cmdOpen) render(); }; fq.onchange = () => render(); }
  const fq2 = $("#fq2"); if (fq2) { fq2.oninput = () => { S.q = fq2.value; if (fq) fq.value = fq2.value; }; fq2.onchange = () => render(); }
  $$("[data-clearf]").forEach((b) => (b.onclick = () => { S.q = ""; S.statusFilter = ""; S.kindFilter = "all"; render(); }));
  const nt = $("#newtask"); if (nt) nt.onclick = () => { S.showReq = true; restoreReqDraft(); render(); wireReq(); };
  const nt2 = $("#newtask2"); if (nt2) nt2.onclick = () => { S.showReq = true; restoreReqDraft(); render(); wireReq(); };
  const cmds = $("#cmds"); if (cmds) cmds.onclick = () => { S.cmdOpen = true; S.cmdIdx = 0; render(); };
  const cx = $("#cmdx"); if (cx) cx.onclick = () => { S.cmdOpen = false; render(); };
  $$("[data-cmd]").forEach((b) => (b.onclick = () => {
    const v = b.dataset.cmd; S.cmdOpen = false;
    if (v === "new") { S.showReq = true; restoreReqDraft(); render(); wireReq(); return; }
    if (v === "refresh") { tick(true); return; }
    if (v === "pause") { S.paused = !S.paused; render(); arm(); return; }
    S.view = v; S.sel = null; S.detail = null; render();
  }));
  const rs = $("#resume"); if (rs) rs.onclick = () => { S.paused = !S.paused; render(); arm(); };
  const at = $("#autotoggle"); if (at) at.onclick = () => { S.auto = !S.auto; render(); arm(); };
  const rf = $("#refresh"); if (rf) rf.onclick = () => tick(true);
  const th = $("#theme"); if (th) th.onclick = () => { S.theme = S.theme === "dark" ? "light" : "dark"; render(); };
  $$("[data-brain]").forEach((b) => (b.onclick = () => { S.brainFocusReturn = document.activeElement?.id || null; S.brainSel = b.dataset.brain; render(); const x = $("#brainx"); if (x) x.focus({ preventScroll: true }); }));
  const bx = $("#brainx"); if (bx) bx.onclick = () => { S.brainSel = null; render(); if (S.brainFocusReturn) { const back = document.getElementById(S.brainFocusReturn); if (back) back.focus({ preventScroll: true }); } };
  const bm = $("#brain-more"); if (bm) bm.onclick = () => { S.brainLimit = (S.brainLimit || 30) + 30; render(); };
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
  $$("[data-flowdry]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.flowdry;
    S.flowDryBusy = true; S.flowDryResult = { flowId: id }; render();
    try {
      // Honest dry-run: real backend simulation endpoint only. No fake success.
      // Backend shape (src/services/triggers.js, read-only): { ok, trace, note }.
      const r = await api(`/api/control/automations/${id}/dry-run`, { method: "POST", body: JSON.stringify({}) });
      S.flowDryResult = { flowId: id, steps: r.trace || r.steps || [], ok: r.ok !== false, note: r.note || "" };
      S.flowMsg = "";
    } catch (e) {
      S.flowDryResult = { flowId: id, error: e?.status === 404 ? "Backend has no dry-run endpoint yet — not simulated (no fake success)." : e.message };
    } finally { S.flowDryBusy = false; render(); }
  }));
  // todos wiring
  $$("[data-ttab]").forEach((b) => (b.onclick = () => { S.todoTab = b.dataset.ttab; render(); }));
  const tq = $("#todo-q"); if (tq) { tq.oninput = () => { S.todoQ = tq.value; }; tq.onchange = () => render(); }
  const ts2 = $("#todo-src"); if (ts2) ts2.onchange = () => { S.todoSource = ts2.value; render(); };
  const tn = $("#todo-new"); if (tn) tn.onclick = () => { S.todoForm = true; render(); const inp = $("#todo-title"); if (inp) inp.focus(); };
  const tc = $("#todocancel"); if (tc) tc.onclick = () => { S.todoForm = false; render(); };
  const ts = $("#todocreate"); if (ts) ts.onclick = async () => { const inp = $("#todo-title"); const t = inp ? inp.value.trim() : ""; if (!t) { setStatus("TODO needs text."); return; } S.todoForm = false; await api("/api/control/todos", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  $$("[data-tdone]").forEach((b) => (b.onclick = async () => { await api("/api/control/todos/done", { method: "POST", body: JSON.stringify({ id: b.dataset.tdone }) }); tick(true); }));
  $$("[data-tdis]").forEach((b) => (b.onclick = async () => { await api("/api/control/todos/dismiss", { method: "POST", body: JSON.stringify({ id: b.dataset.tdis }) }); tick(true); }));
  $$("[data-tconv]").forEach((b) => (b.onclick = async () => {
    try {
      const r = await api("/api/control/todos/convert", { method: "POST", body: JSON.stringify({ id: b.dataset.tconv }) });
      const rid = r.requestId || r.request_id || r.id;
      const t = (S.todos || []).find((x) => String(x.id) === String(b.dataset.tconv));
      if (t && rid) t.requestId = rid;
      S.view = "requests"; setStatus(rid ? `TODO converted → request ${rid}.` : "TODO converted."); tick(true);
    } catch (e) { setStatus(`Convert failed: ${e.message}`); }
  }));
  $$("[data-goto-req]").forEach((b) => (b.onclick = () => { S.view = "requests"; S.q = ""; render(); }));
  $$("[data-goto-attention]").forEach((b) => (b.onclick = () => { S.view = "board"; S.boardTab = "attention"; render(); }));
  wireReq();
  const cs = $("#chat-send"); if (cs) cs.onclick = sendChat;
  const ta = $("#todo-add"); if (ta) ta.onclick = async () => { const i = $("#todo-in"); const t = i.value.trim(); if (!t) return; await api("/api/control/todos", { method: "POST", body: JSON.stringify({ text: t }) }); tick(true); };
  const ll = $("#loglevel"); if (ll) ll.onchange = () => { S.logLevel = ll.value; tick(true); };
  const lr = $("#logref"); if (lr) lr.onclick = () => tick(true);
}

function wireReq() {
  const rx = $("#reqx"); if (rx) rx.onclick = () => { S.showReq = false; S.reqMsg = ""; S.reqAttachErr = ""; render(); };
  const mr = $("#reqm-req"); if (mr) mr.onclick = () => { S.reqMode = "request"; saveReqDraft(); render(); wireReq(); };
  const md = $("#reqm-dir"); if (md) md.onclick = () => { S.reqMode = "direct"; saveReqDraft(); render(); wireReq(); };
  $$("[data-reqagent]").forEach((b) => (b.onclick = () => { const a = b.dataset.reqagent; S.reqAgents.includes(a) ? S.reqAgents = S.reqAgents.filter((x) => x !== a) : S.reqAgents.push(a); if (!S.reqAgents.length) S.reqAgents = [a]; saveReqDraft(); render(); wireReq(); }));
  const rs = $("#req-stream"); if (rs) rs.onchange = () => { S.reqStream = rs.value; S.reqPipeline = ""; saveReqDraft(); render(); wireReq(); };
  const rp = $("#req-pipe"); if (rp) rp.onchange = () => { S.reqPipeline = rp.value; const p = streamPipes(S.reqStream).find((x) => x.id === rp.value); if (p?.agents?.length) S.reqAgents = [...p.agents]; saveReqDraft(); render(); wireReq(); };
  // Draft restore: non-secret text/preferences only (never uploaded content).
  const rt = $("#req-text");
  if (rt) {
    if (S._draftText && !rt.value) { rt.value = S._draftText; S._draftText = ""; }
    rt.oninput = () => saveReqDraft();
  }
  // Text-only upload: file input -> read as UTF-8 text -> JSON POST.
  // Binary/executable/html rejected client-side fast AND server-side.
  // Keyed targeted refresh: the modal stays mounted (render() returns early
  // while it is open to preserve focus/caret), so upload staged list,
  // status, errors, and submit state update in place via paintReqAttach().
  const paintReqAttach = () => {
    const st = $("#req-attach-status");
    if (st) st.textContent = S.reqAttachBusy ? "Uploading…" : S.reqAttachErr ? S.reqAttachErr : `${(S.reqAttachments || []).length} file(s) staged`;
    const list = $("#req-attach-list");
    if (list) list.innerHTML = (S.reqAttachments || []).map((a) => `<div class="row"><span class="kbd">${esc(a.name)}</span><span class="hint">${a.size} bytes</span><span class="spacer"></span><button type="button" class="btn sm ghost" data-reqdel="${esc(a.id)}" ${S.reqAttachBusy ? "disabled" : ""}>Remove</button>`).join("") || `<p class="hint">No files staged. Uploads stay in this browser session until you enqueue.</p>`;
    const go = $("#req-go");
    if (go) {
      const blocked = S.reqBusy || S.reqAttachBusy || !!S.reqAttachErr;
      go.disabled = blocked;
      go.textContent = S.reqBusy ? "Divider working…" : S.reqAttachBusy ? "Uploading…" : "Enqueue Task";
    }
    const msg = $("#req-msg");
    if (msg && (msg.textContent || "") !== (S.reqMsg || "")) msg.textContent = S.reqMsg || "";
    // Rebind remove buttons inside the repainted list (no full render).
    $$("[data-reqdel]").forEach((b) => {
      if (b.dataset.bound) return;
      b.dataset.bound = "1";
      b.onclick = async () => {
        const id = b.dataset.reqdel;
        b.disabled = true;
        try {
          await api("/api/control/requests/attachments/delete", { method: "POST", body: JSON.stringify({ id }) });
          S.reqAttachments = (S.reqAttachments || []).filter((a) => a.id !== id);
          S.reqAttachErr = "";
        } catch (e) { S.reqAttachErr = e.message; }
        paintReqAttach();
      };
    });
  };
  const rf = $("#req-file");
  if (rf) rf.onchange = async () => {
    const f = rf.files?.[0];
    rf.value = "";
    if (!f || S.reqAttachBusy) return;
    S.reqAttachErr = "";
    const okExt = /\.(txt|md|json|csv)$/i.test(f.name || "");
    if (!okExt) { S.reqAttachErr = `Refused '${f.name || "file"}': text-only (.txt/.md/.json/.csv).`; paintReqAttach(); return; }
    if (f.size > 4096) { S.reqAttachErr = `Refused '${f.name}': ${f.size} bytes > 4096 max per file.`; paintReqAttach(); return; }
    S.reqAttachBusy = true; paintReqAttach();
    try {
      const text = await f.text();
      const r = await api("/api/control/requests/attachments", { method: "POST", body: JSON.stringify({ filename: f.name, content: text, mime: f.type || "" }) });
      S.reqAttachments = [...(S.reqAttachments || []), { id: r.id, name: r.name, size: r.size }];
      S.reqAttachErr = "";
    } catch (e) { S.reqAttachErr = e.message; }
    S.reqAttachBusy = false; paintReqAttach();
  };
  paintReqAttach();
  const g = $("#req-go"); if (g) g.onclick = async () => {
    const t = $("#req-text").value.trim(); if (!t || S.reqBusy || S.reqAttachBusy || S.reqAttachErr) return;
    S.reqBusy = true; S.reqMsg = "Divider working… (polling job until completion)"; paintReqAttach();
    try {
      const { sync, final } = await postJob("/api/control/requests", { text: t, mode: S.reqMode, stream: S.reqStream, pipeline: S.reqPipeline || undefined, agents: S.reqAgents, attachments: (S.reqAttachments || []).map((a) => a.id) }, { onTick: (j) => { S.reqMsg = `Divider working… job ${j.status || "queued"}`; const m = $("#req-msg"); if (m) m.textContent = S.reqMsg; } });
      // Backend returns 202 { jobId } (async) — poll the job for the run id.
      const runId = jobRunId(final, sync);
      S.reqBusy = false; S.showReq = false; S.reqMsg = "";
      S.reqAttachments = []; S.reqAttachErr = "";
      clearReqDraft(); // server acked — draft consumed, never replayed
      S.view = "board"; S.boardTab = "tasks"; S.sel = runId; S.detail = null;
      render(); if (runId) loadDetail(runId); else tick(true);
    } catch (e) { S.reqBusy = false; S.reqMsg = e.message; paintReqAttach(); }
  };
  // Focus trap for modal dialogs: keep Tab inside, return focus on close.
  wireModalFocus();
}

async function sendChat() {
  const i = $("#chat-in"); const t = i.value.trim(); if (!t) return; i.value = "";
  await api("/api/control/chat", { method: "POST", body: JSON.stringify({ text: t }) }).catch(() => {});
  setTimeout(() => tick(true), 1500);
}

function wireModalFocus() {
  const modal = $(".modal .mbox");
  if (!modal || modal.dataset.trapped) return;
  modal.dataset.trapped = "1";
  const prev = document.activeElement;
  modal.dataset.returnTo = prev?.id || "";
  const focusables = () => [...modal.querySelectorAll("button, input, select, textarea, [tabindex]")].filter((el) => !el.disabled && el.offsetParent !== null);
  const first = focusables()[0]; if (first) first.focus({ preventScroll: true });
  modal.onkeydown = (e) => {
    if (e.key !== "Tab") return;
    const f = focusables(); if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  };
}
// Versioned, abortable detail fetch: rapid clicks never show a stale record.
async function loadDetail(id) {
  if (!id) return;
  const ver = ++S.detailVer;
  if (S.detailAbort) { try { S.detailAbort.abort(); } catch {} }
  const ctrl = new AbortController(); S.detailAbort = ctrl;
  S.detailError = ""; render(true);
  try {
    const r = await api(`/api/control/task/${id}`, {}, { signal: ctrl.signal });
    if (ver !== S.detailVer || S.sel !== id) return; // superseded
    if (!r.task) throw new Error("Task details were not returned by the server.");
    S.detail = r.task; render(true);
  } catch (error) {
    if (ver !== S.detailVer || S.sel !== id) return;
    S.detailError = error.message || "Unable to load task details."; render(true);
  } finally {
    if (S.detailAbort === ctrl) S.detailAbort = null;
  }
}

async function loadLoopDetail(id) {
  try { const r = await api(`/api/control/loop-tasks/${id}`); S.loopDetail = r; render(); } catch { /* keep list */ }
}

function arm() {
  if (S.timer) clearInterval(S.timer);
  if (S.auto && !S.paused && S.cfg.enabled) S.timer = setInterval(() => tick(), Math.max(2, Number(S.cfg.refreshSec) || 3) * 1000);
}

// SSE live feed: same-origin HttpOnly session auth, no token query.
// Backend GET /api/feed/stream emits snapshot {version,at,feed}, heartbeat,
// reset baseline replay. Native EventSource auto-sends Last-Event-ID on
// reconnect; single source only (no loops, no leaks).
let feedEs = null;
function isValidFeed(feed) {
  return !!feed && typeof feed === "object" && Array.isArray(feed.runs) && Array.isArray(feed.messages) && !!feed.stats && typeof feed.stats === "object";
}
function applyFeedSnapshot(version, feed) {
  if (typeof version !== "string" || !version) return false;
  if (!isValidFeed(feed)) return false;
  S.feed = feed;
  S.feedVersion = version;
  S.offline = false;
  S.lastFetchOk = Date.now();
  return true;
}
function closeFeedStream() {
  try { feedEs?.close(); } catch {}
  feedEs = null;
  S.sseConnected = false;
}
function connectFeedStream() {
  if (typeof EventSource === "undefined") return null;
  if (feedEs) return feedEs;
  if (S.auth.required) return null;
  try {
    const es = new EventSource("/api/feed/stream");
    feedEs = es;
    es.addEventListener("snapshot", (ev) => {
      try {
        const d = JSON.parse(ev.data || "{}");
        if (applyFeedSnapshot(d.version, d.feed)) render(true);
      } catch {}
    });
    es.addEventListener("reset", (ev) => {
      try {
        const d = JSON.parse(ev.data || "{}");
        const latest = d.latest;
        if (latest && applyFeedSnapshot(latest.version, latest.feed)) render(true);
      } catch {}
    });
    es.addEventListener("heartbeat", () => { S.lastFetchOk = Date.now(); });
    es.onerror = () => {
      S.sseConnected = false;
      // Stream error (proxy/NAT drop, backend stall): mark the stream down
      // so the /api/feed poll fallback covers the gap until EventSource
      // reconnects. Do NOT touch S.offline here — the 30s zero-success rule
      // in tick() owns the offline banner.
      // Unauthorized (session expired/revoked): close explicitly — no silent
      // retry loop against a dead session. Re-auth reconnects via login.
      if (S.auth.required) closeFeedStream();
    };
    es.onopen = () => { S.sseConnected = true; S.offline = false; S.lastFetchOk = Date.now(); };
    return es;
  } catch {
    feedEs = null;
    return null;
  }
}

async function tick(force) {
  try {
    // Auth first: 401/403 { authRequired } flips the access gate; authed
    // browsers proceed to the data fan-out below with same-origin cookies.
    if (!S.auth.checked || S.auth.required) {
      try { await refreshAuthStatus(); } catch { /* offline — keep last state */ }
      if (S.auth.required) { render(); arm(); return; }
    }
    const [cfg, ov, tasks, agents, tools, activity, logs, appr, todos, feed, brain, flows, requests, outbox, retro, loopTasks, cfgData, taskTypes] = await Promise.all([
      api("/api/dashboard/config").catch(() => S.cfg),
      api("/api/control/overview?days=7").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/tasks?limit=30").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/agents").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/tools").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/activity?limit=60").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api(`/api/control/logs?limit=100${S.logLevel ? "&level=" + S.logLevel : ""}`).catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/approvals").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/todos").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/feed?limit=8").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/brain").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/automations").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/requests").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/outbox").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/retro?days=30").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/loop-tasks?limit=50").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/config").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
      api("/api/control/task-types").catch((e) => (e?.status === 401 || e?.status === 403 ? "denied" : null)),
    ]);
    if (cfg) S.cfg = cfg;
    // Access-denied fan-out: any private read answering 401/403 flips the gate.
    // (The api() client already sets S.auth.required on authRequired bodies.)
    // SSE lifecycle: unauthorized -> close the stream; re-auth -> reconnect.
    if ([ov, tasks, agents, tools, activity, logs, appr, todos, feed, brain, flows, requests, outbox, retro, loopTasks, cfgData, taskTypes].some((r) => r === "denied")) {
      S.auth.required = true;
      closeFeedStream();
      render(); arm(); return;
    }
    if (ov) S.ov = ov;
    // Resilient tick: a failed fetch keeps the last good data instead of
    // blanking the board to "0 runs". Only overwrite on real payloads.
    // (The bot's HTTP loop can stall for a minute while a Muse session thinks;
    // the board must show stale data + a notice, not an empty screen.)
    // Offline: zero actual successes -> offline banner after 30s, keep data.
    // Transport-failure fallbacks ({tasks:[]}, null) must NOT count as success:
    // they are catch() placeholders, not fulfilled valid fetches. Only a
    // payload with a real shape (ok !== false + expected array/object field)
    // marks the tick successful, so a full outage sets S.offline = true while
    // preserving every existing row, selection, and focus.
    const isValid = (r, key) => !!r && typeof r === "object" && r.ok !== false && (key in r) && (Array.isArray(r[key]) || (r[key] && typeof r[key] === "object"));
    const anyOk = isValid(tasks, "tasks") || isValid(agents, "agents") || isValid(tools, "tools")
      || isValid(activity, "activity") || isValid(logs, "logs") || isValid(appr, "approvals")
      || isValid(todos, "todos") || isValidFeed(feed) || isValid(brain, "messages")
      || isValid(flows, "flows") || isValid(requests, "requests") || isValid(outbox, "outbox")
      || !!retro || !!loopTasks?.tasks || !!cfgData;
    if (anyOk) { S.offline = false; S.lastFetchOk = Date.now(); }
    else if (Date.now() - (S.lastFetchOk || 0) > 30000) { S.offline = true; }
    const hadTasks = (S.tasks || []).length;
    const prevBlocked = new Set((S.tasks || []).filter((r) => r.status === "failed" || r.blockedReason).map((r) => r.id));
    if (Array.isArray(tasks?.tasks)) S.tasks = tasks.tasks;
    if (Array.isArray(agents?.agents)) S.agents = agents.agents;
    if (Array.isArray(tools?.tools)) S.tools = tools.tools;
    if (Array.isArray(activity?.activity)) S.activity = activity.activity;
    if (Array.isArray(logs?.logs)) S.logs = logs.logs;
    if (Array.isArray(appr?.approvals)) S.approvals = appr.approvals;
    if (Array.isArray(todos?.todos)) { S.todos = todos.todos; S.reminders = todos.reminders || []; }
    // Poll fallback covers the SSE gap: when the stream is down (error or
    // never connected), a valid poll feed keeps the board fresh and counts
    // as success. When the stream is live, SSE owns the feed — the poll is
    // ignored so it never clobbers a newer snapshot.
    if (!S.sseConnected && isValidFeed(feed)) { S.feed = feed; S.lastFetchOk = Date.now(); }
    if (brain) S.brain = brain;
    if (Array.isArray(flows?.flows)) S.flows = flows.flows;
    if (Array.isArray(requests?.requests)) S.requests = requests.requests;
    if (Array.isArray(outbox?.outbox)) S.outbox = outbox.outbox;
    if (retro) S.retro = retro;
    if (Array.isArray(loopTasks?.tasks)) S.loopTasks = loopTasks.tasks;
    if (Array.isArray(taskTypes?.taskTypes)) S.taskTypes = taskTypes.taskTypes;
    if (cfgData) S.cfgData = cfgData;
    S.stale = hadTasks > 0 && (!tasks || !Array.isArray(tasks.tasks));
    // Assertive announcement only for newly blocked items (polite for the rest).
    try {
      const nowBlocked = (S.tasks || []).filter((r) => (r.status === "failed" || r.blockedReason) && !prevBlocked.has(r.id));
      if (nowBlocked.length && !S.lastBlockedIds.has(nowBlocked[0].id)) {
        S.lastBlockedIds.add(nowBlocked[0].id);
        const al = $("#alerts"); if (al) al.textContent = `Blocked: ${nowBlocked[0].title || nowBlocked[0].id}`;
      }
    } catch {}
    if (S.sel && !S.detail && !S.detailAbort && !S.detailError) loadDetail(S.sel);
    if (S.loopSel && !S.loopDetail) loadLoopDetail(S.loopSel);
    render(true); arm();
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
    else if (S.sel) { closeTaskDetail(); }
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
// Single boot: one poll tick + one SSE stream. No loops, no duplicate sources.
connectFeedStream();
tick();

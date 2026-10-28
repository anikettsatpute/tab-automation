// Setup step: runs + verify. Render + save logic for one wizard step.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
export function panelRuns(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Runs</h2><p>Ye machine ka local preview hai. Asli runs <b>headless bot</b> pe hote hain — uska Control Room dekho Step 8 Deploy me.</p></div>
    <div class="row">
      <label class="field"><span>source</span><select id="r-src">
        <option value="local" ${runSource === "local" ? "selected" : ""}>💻 This machine (default)</option>
        <option value="tablet" ${runSource === "tablet" ? "selected" : ""}>📱 Tablet (adb pull)</option>
      </select></label>
      <button class="btn" id="r-sync">Sync tablet</button>
      <span id="r-tabstat" class="hint"></span>
    </div>
    <div class="row">
      <label class="field" style="min-width:200px"><span>workflow filter</span><select id="r-wf"><option value="">all</option>${S.workflows.map((w) => `<option>${esc(w.id)}</option>`).join("")}</select></label>
      <button class="btn" id="r-load">Refresh</button>
      <button class="btn danger" id="r-prune">Prune 90d+ (local)</button>
    </div>
    <div id="r-list"><div class="empty">Pick a source, sync, then Refresh.</div></div>
    <div id="r-detail"></div>`;
  const qs = () => `?source=${runSource}`;
  const syncStat = async () => {
    try {
      const t = await api("/api/tablet");
      $("#r-tabstat").textContent = t.connected
        ? `tablet ${t.device} · ${t.cached ? "cache ready" : "no cache yet"}`
        : `tablet: ${t.hint}`;
    } catch { /* ignore */ }
  };
  syncStat();
  $("#r-src").onchange = (e) => { runSource = e.target.value; };
  $("#r-sync").onclick = async () => {
    try {
      toast("Pulling tablet DB over adb…");
      const r = await api("/api/tablet/pull", { method: "POST" });
      if (r.ok) { toast("Tablet DB synced."); runSource = "tablet"; $("#r-src").value = "tablet"; }
      else toast("Sync failed: " + r.hint, "bad");
      syncStat();
    } catch (e) { toast(e.message, "bad"); }
  };
  const load = async () => {
    try {
      const wf = $("#r-wf").value;
      const r = await api(`/api/runs${qs()}${wf ? `&workflow=${encodeURIComponent(wf)}` : ""}`);
      if (r.hint) { $("#r-list").innerHTML = `<div class="empty">${esc(r.hint)}</div>`; return; }
      if (!r.runs.length) { $("#r-list").innerHTML = `<div class="empty">No runs on ${esc(r.source)}. Runs appear here after the tablet executes workflows.</div>`; return; }
      $("#r-list").innerHTML = r.runs.map((run) => `
        <div class="card" data-run="${esc(run.id)}">
          <h3><span class="tag ${run.status === "done" ? "ok" : run.status === "failed" ? "bad" : ""}">${esc(run.status)}</span> ${esc(run.workflow_id)} <span class="hint">${esc(run.id)} · ${esc(run.kind)} · ${esc(run.started_at)}</span></h3>
          ${run.error ? `<div class="status bad">${esc(run.error)}</div>` : ""}
          <div class="row"><button class="btn sm" data-view>View steps</button></div>
        </div>`).join("");
      $$("#r-list [data-view]").forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.closest("[data-run]").dataset.run;
          try {
            const d = await api(`/api/runs/${id}${qs()}`);
            $("#r-detail").innerHTML = `
              <div class="card"><h3>Run ${esc(d.run.id)} — ${esc(d.run.workflow_id)}</h3>
              ${d.run.steps.map((s) => `<div class="ministep"><span class="tag">${esc(s.type)}</span> <b>${esc(s.step_id)}</b> <span class="tag ${s.status === "ok" ? "ok" : "bad"}">${esc(s.status)}</span><br><span class="hint">${esc(String(s.raw_text).slice(0, 300))}</span>${s.output_json ? `<br><code>${esc(String(s.output_json).slice(0, 300))}</code>` : ""}</div>`).join("") || `<p class="hint">No steps recorded.</p>`}
              </div>`;
            $("#r-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
          } catch (e) { toast(e.message, "bad"); }
        };
      });
      markDone("runs");
    } catch (e) { toast(e.message, "bad"); }
  };
  $("#r-load").onclick = load;
  $("#r-prune").onclick = async () => {
    try {
      const r = await api("/api/runs/prune", { method: "POST", body: JSON.stringify({ days: 90 }) });
      toast(`Pruned ${r.pruned.runs} runs, ${r.pruned.steps} steps (local DB).`);
      load();
    } catch (e) { toast(e.message, "bad"); }
  };
}

// ---------- verify ----------

export function panelVerify(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Verify</h2><p>Runs <span class="kbd">node src/validate.js</span> — config cross-refs + SQLite check.</p></div>
    <div class="row"><button class="btn primary" id="v-run">Run validate</button></div>
    <pre class="out" id="v-out">Not run yet.</pre>
    <div class="status info">When green: <span class="kbd">node src/index.js</span> for the full run.</div>`;
  $("#v-run").onclick = async () => {
    try {
      const r = await api("/api/validate", { method: "POST" });
      $("#v-out").textContent = r.output;
      if (r.ok) { markDone("verify"); toast("Validate passed ✅"); }
      else toast("Validate failed ❌", "bad");
    } catch (e) { toast(e.message, "bad"); }
  };
}


// Setup step: deploy. Factory summary + headless deploy + tunnel + dashboard settings.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
export function renderPanel() {
  const el = $("#panel");
  ({ providers: panelProviders, agents: panelAgents, tools: panelTools, discord: panelDiscord, automations: panelAutomations, streams: panelStreams, runs: panelRuns, verify: panelVerify, deploy: panelDeploy })[S.tab](el);
}

// ---------- deploy (setup factory -> headless home) ----------
export function panelDeploy(el) {
  // Setup sirf factory hai: .env + config banata hai. Asli kaam headless bot karta hai.
  // Ye step: kya bana, kahan deploy karna hai, headless dashboard kahan milega.
  el.innerHTML = `
    <div class="section-head"><h2>Deploy — setup se headless tak</h2><p>Setup ne factory ka kaam kiya. Ab isko headless bot pe deploy karo — wahi Discord pe chalega, wahi DB me tasks honge.</p></div>
    <div class="card">
      <h3>📦 Setup ne kya banaya (is machine pe)</h3>
      <div id="dep-summary"><span class="hint">Loading…</span></div>
    </div>
    <div class="card">
      <h3>🚀 Headless pe deploy karo</h3>
      <pre class="out"># tablet (Termux) pe code bhejo — data/ safe rahega:
bash scripts/deploy-tab.sh

# tablet pe bot + Control Room start karo:
# HEADLESS_PORT=3000 node src/index.js
# ya: bash termux/run.sh</pre>
      <div class="row">
        <button class="btn primary" id="dep-push">Deploy to tablet (adb)</button>
        <span class="hint" id="dep-out"></span>
      </div>
      <p class="hint">Deploy ke baad headless bot khud <code>/dashboard</code> serve karega — wahi uska UX hai. Setup me koi preview nahi hai.</p>
    </div>
    <div class="card">
      <h3>🌐 Tunnel (dashboard on hai tabhi)</h3>
      <p class="desc">Deploy ke baad bhi wahi URL rahega — tunnel alag persistent process hai.</p>
      <div class="row"><span class="hint" id="dep-tunnel">Checking…</span></div>
    </div>
    <div class="card">
      <h3>🖥️ Control Room (deploy ke baad headless pe)</h3>
      <p class="desc">Deploy ke baad headless bot pe khulega — yaha sirf on/off setting hai, preview nahi:</p>
      <div class="row">
        <span class="hint" id="dep-dash">Deploy ke baad yaha URL aayega.</span>
      </div>
      <div class="grid" style="margin-top:12px">
        <label class="field"><span>Control Room on/off</span><select id="dash-enabled"><option value="1">On</option><option value="0">Off</option></select></label>
        <label class="field"><span>Auto-refresh (sec)</span><input id="dash-refresh" type="number" min="2" max="60" value="3"></label>
      </div>
      <div class="row"><button class="btn primary" id="dash-save">Save dashboard setting</button></div>
    </div>`;
  (async () => {
    try {
      const [st, cfg] = await Promise.all([api("/api/state"), api("/api/dashboard/config").catch(() => ({}))]);
      $("#dep-summary").innerHTML = `
        <p class="desc">.env keys: <span class="kbd">${esc(Object.keys(st.envKeys || {}).filter((k) => st.envKeys[k]).join(", ") || "—")}</span></p>
        <p class="desc">Agents: <b>${(st.agents?.agents || []).length}</b> · Tools: <b>${(st.tools?.servers || []).length}</b> · Workflows: <b>${(st.workflows?.workflows || []).length}</b> · Discord channel: <span class="kbd">${esc(st.discord?.mainChannelId || "—")}</span></p>`;
      $("#dash-enabled").value = cfg.enabled === false ? "0" : "1";
      $("#dash-refresh").value = cfg.refreshSec ?? 3;
      try {
        const t = await api("/api/deploy/tunnel");
        $("#dep-tunnel").innerHTML = t.running
          ? `✅ Live: <a href="${esc(t.url)}/dashboard" target="_blank" rel="noopener">${esc(t.url)}</a> <span class="hint">(deploy ke baad bhi yahi)</span>`
          : `❌ Tunnel band hai. <span class="hint">${esc(t.url ? "last: " + t.url : "Deploy dabao — dashboard on hai to tunnel khud chalega.")}</span>`;
      } catch { $("#dep-tunnel").textContent = "Tunnel status nahi mila."; }
      try {
        const t2 = await api("/api/deploy/tunnel");
        $("#dep-dash").textContent = t2.running && t2.url ? `Deploy ke baad: ${t2.url}/dashboard` : "Deploy ke baad headless pe khulega.";
      } catch { /* tunnel optional */ }
    } catch (e) { $("#dep-summary").innerHTML = `<span class="hint">❌ ${esc(e.message)}</span>`; }
  })();
  $("#dep-push").onclick = async () => {
    $("#dep-out").textContent = "Deploying…";
    try {
      const r = await api("/api/deploy/push", { method: "POST", timeoutMs: 120000 });
      $("#dep-out").textContent = r.ok ? "✅ " + (r.hint || "Deployed.") : "❌ " + (r.hint || r.error);
      if (r.ok) markDone("deploy");
    } catch (e) { $("#dep-out").textContent = "❌ " + e.message; }
  };
  $("#dash-save").onclick = async () => {
    try {
      await api("/api/dashboard/config", { method: "POST", body: JSON.stringify({ enabled: $("#dash-enabled").value === "1", refreshSec: Number($("#dash-refresh").value) || 3 }) });
      markDone("deploy");
      toast("Dashboard setting saved.");
    } catch (e) { toast(e.message, "bad"); }
  };
}

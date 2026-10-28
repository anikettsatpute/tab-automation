// Rick setup app — thin shell. Step modules own each wizard panel.
// State + shell live here; panels in src/steps/*.js.
import "./style.css";
import { S, STEPS, $, $$, esc, api } from "./steps/state.js";
import { panelProviders } from "./steps/providers.js";
import { panelAgents } from "./steps/agents.js";
import { panelTools, panelDiscord } from "./steps/tools-discord.js";
import { panelAutomations } from "./steps/automations.js";
import { panelStreams } from "./steps/streams.js";
import { panelRuns, panelVerify } from "./steps/runs-verify.js";
import { renderPanel, panelDeploy } from "./steps/deploy.js";

function render() {
  const doneCount = S.done.size;
  const pct = Math.round((doneCount / STEPS.length) * 100);
  $("#app").innerHTML = `
    <a class="skip" href="#panel">Skip to setup panel</a>
    <div class="shell">
      <header class="topbar">
        <div class="logo" aria-hidden="true">🤖</div>
        <div>
          <h1>Rick Setup</h1>
          <p class="sub">Clone → <span class="kbd">npm install</span> → <span class="kbd">npm run setup</span> → you're live.</p>
        </div>
        <div class="spacer"></div>
        ${S.node ? `<span class="pill ${S.node.ok ? "ok" : "bad"}" role="status">Node ${esc(S.node.version)} ${S.node.ok ? "OK" : "needs 22+"}</span>` : ""}
      </header>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Setup progress"><div style="width:${pct}%"></div></div>
      <nav class="stepper" aria-label="Setup steps">
        ${STEPS.map((s) => `<button type="button" class="step ${S.tab === s.id ? "active" : ""} ${S.done.has(s.id) ? "done" : ""}" data-tab="${s.id}" ${S.tab === s.id ? 'aria-current="step"' : ""}><span class="n">${s.n}</span><span class="t">${s.t}</span></button>`).join("")}
      </nav>
      <main id="panel" tabindex="-1"></main>
      <div class="footer-nav">
        <button type="button" class="btn ghost" id="prev">Back</button>
        <button type="button" class="btn primary" id="next">Continue</button>
      </div>
    </div>
    <div id="status" class="sr" role="status" aria-live="polite"></div>`;
  $$(".step").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); }));
  $("#prev").onclick = () => step(-1);
  $("#next").onclick = () => step(1);
  renderPanel();
}

function step(dir) {
  const i = STEPS.findIndex((s) => s.id === S.tab);
  const j = Math.min(STEPS.length - 1, Math.max(0, i + dir));
  S.tab = STEPS[j].id;
  render();
}

// ---------- init ----------
(async () => {
  try {
    const s = await api("/api/state");
    S.node = s.node;
    S.providers = s.providers.providers || [];
    S.defaultProvider = s.providers.defaultProvider || "azure";
    S.agents = s.agents.agents || [];
    S.servers = s.tools.servers || [];
    S.customTools = s.tools.customTools || [];
    S.discord = s.discord || {};
    S.workflows = s.workflows.workflows || [];
    S.streams = s.streams?.streams || [];
    S.pipelines = s.streams?.pipelines || [];
    render();
  } catch (e) {
    $("#app").innerHTML = `<div class="shell"><div class="status bad" role="alert">Failed to load setup state: ${esc(e.message)}. Is the setup server running?</div></div>`;
  }
})();

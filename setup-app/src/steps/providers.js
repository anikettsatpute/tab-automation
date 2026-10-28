// Setup step: providers. Render + save logic for one wizard step.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
function providerCard(p, i) {
  return `
  <div class="card" data-i="${i}">
    <h3>${esc(p.id || "new provider")} <span class="tag">${esc(p.type)}</span></h3>
    <div class="grid">
      <label class="field"><span>id</span><input data-f="id" value="${esc(p.id)}"></label>
      <label class="field"><span>type</span><select data-f="type">
        ${["azure-foundry", "openrouter", "meta"].map((t) => `<option ${p.type === t ? "selected" : ""}>${t}</option>`).join("")}
      </select></label>
      <label class="field"><span>endpoint</span><input data-f="endpoint" value="${esc(p.endpoint)}" placeholder="https://…"></label>
      <label class="field"><span>default model</span><input data-f="modelDefault" value="${esc(p.modelDefault)}"></label>
      <label class="field"><span>key env var</span><input data-f="keyEnv" value="${esc(p.keyEnv)}"></label>
      <label class="field"><span>api key <span class="hint">(→ .env, never shown back)</span></span><input data-f="_key" type="password" placeholder="blank = keep existing"></label>
    </div>
    <div class="row"><button class="btn danger rm">Remove</button><span class="hint" data-test></span></div>
  </div>`;
}

export function panelProviders(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Providers</h2><p>Keys → <span class="kbd">.env</span> · rest → <span class="kbd">config/providers.json</span></p></div>
    <div id="plist">${S.providers.map(providerCard).join("") || `<div class="empty">No providers yet.</div>`}</div>
    <div class="row">
      <button class="btn" id="add-p">+ Add provider</button>
      <label class="field" style="min-width:180px"><span>default provider</span><select id="def-p">${S.providers.map((p) => `<option ${S.defaultProvider === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("")}</select></label>
      <button class="btn primary" id="save-p">Save + live test</button>
    </div>
    <div id="ptest"></div>`;
  $("#add-p").onclick = () => {
    S.providers.push({ id: "openrouter", type: "openrouter", endpoint: "https://openrouter.ai/api/v1", modelDefault: "openai/gpt-4o-mini", keyEnv: "OPENROUTER_API_KEY" });
    render();
  };
  $$("#plist .card").forEach((card) => {
    $(".rm", card).onclick = () => { S.providers.splice(+card.dataset.i, 1); render(); };
  });
  $("#save-p").onclick = async () => {
    if (S.busy) return;
    S.busy = true;
    try {
      const keys = {};
      $$("#plist .card").forEach((card, i) => {
        $$("[data-f]", card).forEach((inp) => {
          if (inp.dataset.f === "_key") { if (inp.value) keys[S.providers[i].keyEnv] = inp.value; }
          else S.providers[i][inp.dataset.f] = inp.value;
        });
      });
      S.defaultProvider = $("#def-p").value;
      const r = await api("/api/providers", { method: "POST", body: JSON.stringify({ providers: S.providers, defaultProvider: S.defaultProvider, keys }) });
      $("#ptest").innerHTML = r.tests.map((t) => `<div class="status ${t.ok ? "ok" : "bad"}">${esc(t.id)}: ${t.ok ? "✅ live test passed" : "❌ " + esc(t.hint || t.status)}</div>`).join("");
      markDone("providers");
      toast("Providers saved.");
    } catch (e) { toast(e.message, "bad"); }
    S.busy = false;
  };
}

// ---------- agents ----------


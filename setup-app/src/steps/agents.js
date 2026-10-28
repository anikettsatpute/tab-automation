// Setup step: agents. Render + save logic for one wizard step.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
function agentCard(a, i) {
  const provOpts = S.providers.map((p) => `<option ${a.provider === p.id ? "selected" : ""}>${esc(p.id)}</option>`).join("");
  const schemaStr = Object.entries(a.outputSchema || {}).map(([k, v]) => `${k}:${v}`).join(", ");
  return `
  <div class="card" data-i="${i}">
    <h3>${esc(a.id)} <span class="tag">${esc(a.provider || "")}</span> ${a.output === "json" ? `<span class="tag ok">json</span>` : `<span class="tag">text</span>`}</h3>
    <p class="desc">${esc(a.description || "")}</p>
    <div class="grid">
      <label class="field"><span>id</span><input data-f="id" value="${esc(a.id)}"></label>
      <label class="field"><span>provider</span><select data-f="provider">${provOpts}</select></label>
      <label class="field"><span>model <span class="hint">(blank = provider default)</span></span><input data-f="model" value="${esc(a.model || a.deployment || "")}"></label>
      <label class="field"><span>tools allowlist <span class="hint">(only editable here)</span></span><input data-f="tools" value="${esc((a.tools || ["*"]).join(", "))}"></label>
    </div>
    <label class="field" style="margin-top:8px"><span>description</span><input data-f="description" value="${esc(a.description || "")}"></label>
    <label class="field" style="margin-top:8px"><span>system prompt</span><textarea data-f="systemPrompt">${esc(a.systemPrompt)}</textarea></label>
    <div class="grid" style="margin-top:8px">
      <label class="field"><span>output mode</span><select data-f="output"><option value="text">text</option><option value="json" ${a.output === "json" ? "selected" : ""}>json</option></select></label>
      <label class="field"><span>json schema <span class="hint">max 8 · name:bool|int|string</span></span><input data-f="outputSchema" value="${esc(schemaStr)}" placeholder="done:bool, count:int, note:string"></label>
    </div>
    <div class="row"><button class="btn danger rm">Remove</button></div>
  </div>`;
}

export function panelAgents(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Agents</h2><p>Provider + model + prompt + tools. JSON mode forces structured output.</p></div>
    <div id="alist">${S.agents.map(agentCard).join("") || `<div class="empty">No agents yet.</div>`}</div>
    <div class="row"><button class="btn" id="add-a">+ Add agent</button><button class="btn primary" id="save-a">Save agents</button></div>`;
  $("#add-a").onclick = () => {
    S.agents.push({ id: "new-agent", description: "", provider: S.defaultProvider, model: "", systemPrompt: "You are Rick, a helpful assistant.", tools: ["*"], output: "text" });
    render();
  };
  $$("#alist .card").forEach((card) => {
    $(".rm", card).onclick = () => { S.agents.splice(+card.dataset.i, 1); render(); };
  });
  $("#save-a").onclick = async () => {
    try {
      $$("#alist .card").forEach((card, i) => {
        $$("[data-f]", card).forEach((inp) => {
          const f = inp.dataset.f;
          if (f === "tools") S.agents[i].tools = inp.value.split(",").map((s) => s.trim()).filter(Boolean);
          else if (f === "outputSchema") {
            const schema = {};
            for (const part of inp.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8)) {
              const [k, t] = part.split(":").map((s) => (s || "").trim());
              if (k && ["bool", "int", "string"].includes(t)) schema[k] = t;
            }
            S.agents[i].outputSchema = schema;
            if (S.agents[i].output !== "json") delete S.agents[i].outputSchema;
          } else S.agents[i][f] = inp.value;
        });
      });
      const r = await api("/api/agents", { method: "POST", body: JSON.stringify({ agents: S.agents }) });
      markDone("agents");
      toast(`Saved ${r.count} agents.`);
      render();
    } catch (e) { toast(e.message, "bad"); }
  };
}

// ---------- tools ----------
// One-flow UX: user types what they want ("reddit", "gmail") or pastes an
// install snippet / URL. The wizard searches GitHub, proposes a server,
// probes it, and if auth is needed shows ONE sign-in button. No env/URL jargon.


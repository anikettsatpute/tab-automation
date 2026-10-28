// Setup step: streams. Render + save logic for one wizard step.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
function streamCard(s, i) {
  const agentBoxes = S.agents.map((a) => `<label class="hint"><input type="checkbox" data-sagent="${esc(a.id)}" ${(s.agents || []).includes(a.id) ? "checked" : ""}> ${esc(a.id)}</label>`).join(" ");
  return `
  <div class="card" data-i="${i}">
    <h3>🌊 ${esc(s.id || "new stream")}</h3>
    <div class="grid">
      <label class="field"><span>id</span><input data-sf="id" value="${esc(s.id || "")}" placeholder="finance"></label>
      <label class="field"><span>name</span><input data-sf="name" value="${esc(s.name || "")}" placeholder="Finance"></label>
    </div>
    <label class="field" style="margin-top:8px"><span>description</span><input data-sf="description" value="${esc(s.description || "")}"></label>
    <div class="field" style="margin-top:8px"><span>agents in this stream</span><div class="row">${agentBoxes || `<span class="hint">Add agents in Step 2 first.</span>`}</div></div>
    <div class="row"><button class="btn danger rm-stream">Remove stream</button></div>
  </div>`;
}

function pipelineCard(p, i) {
  const streamOpts = S.streams.map((s) => `<option value="${esc(s.id)}" ${p.stream === s.id ? "selected" : ""}>${esc(s.id)}</option>`).join("");
  const chain = (p.agents || []).map((a, ai) => `
    <span class="row" style="margin:0">
      <select data-pagent="${ai}">${S.agents.map((ag) => `<option ${a === ag.id ? "selected" : ""}>${esc(ag.id)}</option>`).join("")}</select>
      ${ai < (p.agents || []).length - 1 ? `<span class="hint">→</span>` : ""}
      <button type="button" class="btn danger rm-pagent" data-ai="${ai}">✕</button>
    </span>`).join("");
  return `
  <div class="card" data-i="${i}">
    <h3>⛓️ ${esc(p.id || "new pipeline")} <span class="tag">${esc(p.stream || "")}</span></h3>
    <p class="desc">${esc(p.description || "")}</p>
    <div class="grid">
      <label class="field"><span>id</span><input data-pf="id" value="${esc(p.id || "")}" placeholder="finance-brief"></label>
      <label class="field"><span>stream</span><select data-pf="stream">${streamOpts || `<option value="">(add a stream first)</option>`}</select></label>
    </div>
    <label class="field" style="margin-top:8px"><span>name</span><input data-pf="name" value="${esc(p.name || "")}"></label>
    <label class="field" style="margin-top:8px"><span>description</span><input data-pf="description" value="${esc(p.description || "")}"></label>
    <div class="field" style="margin-top:8px"><span>agent chain (agent → agent — each step spawns a Muse session)</span>
      <div class="row">${chain || `<span class="hint">No agents yet.</span>`}</div>
      <div class="row" style="margin-top:6px"><button type="button" class="btn add-pagent">+ Add agent step</button></div>
    </div>
    <div class="row"><button class="btn danger rm-pipe">Remove pipeline</button></div>
  </div>`;
}

export function panelStreams(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Streams</h2><p>Streams replace repos — group agents (e.g. <span class="kbd">finance</span>). Pipelines chain agent → agent per stream; each step spawns a Muse session that writes JSON.</p></div>
    <h3>Streams</h3>
    <div id="slist">${S.streams.map(streamCard).join("") || `<div class="empty">No streams yet.</div>`}</div>
    <div class="row"><button class="btn" id="add-s">+ Add stream</button></div>
    <h3 style="margin-top:16px">Task pipelines (agent → agent)</h3>
    <div id="plist">${S.pipelines.map(pipelineCard).join("") || `<div class="empty">No pipelines yet.</div>`}</div>
    <div class="row"><button class="btn" id="add-p2">+ Add pipeline</button><button class="btn primary" id="save-s">Save streams + pipelines</button></div>`;
  $("#add-s").onclick = () => { S.streams.push({ id: "new-stream", name: "", description: "", agents: S.agents.map((a) => a.id).slice(0, 1) }); render(); };
  $("#add-p2").onclick = () => { S.pipelines.push({ id: "new-pipeline", name: "", description: "", stream: S.streams[0]?.id || "", agents: S.agents.map((a) => a.id).slice(0, 1) }); render(); };
  $$("#slist .card").forEach((card) => {
    const i = +card.dataset.i;
    $$("[data-sf]", card).forEach((inp) => { inp.onchange = () => { S.streams[i][inp.dataset.sf] = inp.value; }; });
    $$("[data-sagent]", card).forEach((cb) => { cb.onchange = () => {
      const set = new Set(S.streams[i].agents || []);
      cb.checked ? set.add(cb.dataset.sagent) : set.delete(cb.dataset.sagent);
      S.streams[i].agents = [...set];
    }; });
    $(".rm-stream", card).onclick = () => { S.streams.splice(i, 1); render(); };
  });
  $$("#plist .card").forEach((card) => {
    const i = +card.dataset.i;
    $$("[data-pf]", card).forEach((inp) => { inp.onchange = () => { S.pipelines[i][inp.dataset.pf] = inp.value; }; });
    $$("[data-pagent]", card).forEach((sel) => { sel.onchange = () => { S.pipelines[i].agents[+sel.dataset.pagent] = sel.value; }; });
    $$(".rm-pagent", card).forEach((b) => { b.onclick = () => { S.pipelines[i].agents.splice(+b.dataset.ai, 1); render(); }; });
    $(".add-pagent", card).onclick = () => { S.pipelines[i].agents.push(S.agents[0]?.id || "assistant"); render(); };
    $(".rm-pipe", card).onclick = () => { S.pipelines.splice(i, 1); render(); };
  });
  $("#save-s").onclick = async () => {
    try {
      const r = await api("/api/streams", { method: "POST", body: JSON.stringify({ streams: S.streams, pipelines: S.pipelines }) });
      markDone("streams");
      toast(`Saved ${r.streams} streams, ${r.pipelines} pipelines.`);
    } catch (e) { toast(e.message, "bad"); }
  };
}

// ---------- runs (SQLite — LOCAL by default; headless bot owns its own DB) ----------
let runSource = "local";


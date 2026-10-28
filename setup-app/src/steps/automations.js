// Setup step: automations. Render + save logic for one wizard step.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
function availableVars(w, uptoIdx) {
  const vars = ["{{trigger.text}}", "{{now}}", "{{date}}"];
  for (let i = 0; i < uptoIdx; i++) {
    const s = w.steps[i];
    if (!s) continue;
    vars.push(`{{steps.${s.id}}}`);
    const schema = s.outputSchema || S.agents.find((a) => a.id === s.agent)?.outputSchema;
    if ((s.output === "json" || schema) && schema) {
      for (const k of Object.keys(schema)) vars.push(`{{steps.${s.id}.${k}}}`);
    }
  }
  return vars;
}

function varPickerHTML(w, idx) {
  const vars = availableVars(w, idx);
  if (!vars.length) return "";
  return `<div class="varpick">${vars.map((v) => `<button type="button" class="kbd var" data-var="${esc(v)}">${esc(v)}</button>`).join("")}</div>`;
}

function stepFieldsHTML(w, wi, s, idx) {
  const agents = S.agents.map((a) => `<option value="${esc(a.id)}" ${s.agent === a.id ? "selected" : ""}>${esc(a.id)}</option>`).join("");
  const wflows = S.workflows.map((x, j) => j === wi ? "" : `<option value="${esc(x.id)}" ${s.workflow === x.id ? "selected" : ""}>${esc(x.id)}</option>`).join("");
  const schemaStr = Object.entries(s.outputSchema || {}).map(([k, v]) => `${k}:${v}`).join(", ");
  // Reference palette aliases render with their canonical editors; s.type is preserved on save.
  const t = ({ run_agent: "agent", notify: "discord_send", run_automation: "subflow", wait: "delay", create_task: "task" })[s.type] || s.type;
  switch (t) {
    case "task": return `
      <label class="field"><span>title / text <span class="hint">templates allowed</span></span><input data-sf="title" value="${esc(s.title || s.text || "")}" placeholder="What should be done?"></label>
      ${varPickerHTML(w, idx)}
      <div class="grid" style="margin-top:8px">
        <label class="field"><span>from agent step <span class="hint">(JSON tasks)</span></span><input data-sf="from" value="${esc(s.from || "")}" placeholder="sweep"></label>
        <label class="field"><span>priority</span><select data-sf="priority">${["P1", "P2", "P3", "P4"].map((p) => `<option ${(s.priority || "P3") === p ? "selected" : ""}>${p}</option>`).join("")}</select></label>
      </div>`;
    case "file_request": return `
      <label class="field"><span>what should be built or fixed?</span><textarea data-sf="what" rows="2">${esc(s.what || s.text || "")}</textarea></label>
      ${varPickerHTML(w, idx)}
      <label class="field" style="margin-top:8px"><span>remind at <span class="hint">(blank = plain request)</span></span><input data-sf="at" value="${esc(s.at || "")}" placeholder="2026-10-29T09:00"></label>`;
    case "agent": return `
      <div class="grid">
        <label class="field"><span>agent</span><select data-sf="agent">${agents}</select></label>
        <label class="field"><span>output</span><select data-sf="output"><option value="text">text</option><option value="json" ${s.output === "json" ? "selected" : ""}>json vars</option></select></label>
      </div>
      <label class="field" style="margin-top:8px"><span>prompt <span class="hint">click a variable to insert</span></span><textarea data-sf="prompt" rows="3">${esc(s.prompt || "")}</textarea></label>
      ${varPickerHTML(w, idx)}
      <label class="field" style="margin-top:8px"><span>json schema <span class="hint">max 8 · name:bool|int|string</span></span><input data-sf="outputSchema" value="${esc(schemaStr)}" placeholder="done:bool, summary:string"></label>
      <div class="grid" style="margin-top:8px">
        <label class="field"><span>save as <span class="hint">(alias)</span></span><input data-sf="saveAs" value="${esc(s.saveAs || "")}" placeholder="optional"></label>
        <label class="field"><span>tools / memory</span><span class="row" style="margin:0"><label class="hint"><input type="checkbox" data-sf="tools" ${s.tools === false ? "" : "checked"}> tools</label><label class="hint"><input type="checkbox" data-sf="memory" ${s.memory === false ? "" : "checked"}> memory</label></span></label>
      </div>`;
    case "discord_send": return `
      <label class="field"><span>message <span class="hint">click a variable to insert</span></span><textarea data-sf="message" rows="3">${esc(s.message || "")}</textarea></label>
      ${varPickerHTML(w, idx)}
      <label class="field" style="margin-top:8px"><span>channel override <span class="hint">(blank = main)</span></span><input data-sf="channel" value="${esc(s.channel || "")}"></label>`;
    case "condition": return `
      <div class="grid">
        <label class="field"><span>left <span class="hint">usually a {{steps.*}} var</span></span><input data-sf="condition.left" value="${esc(s.condition?.left || "")}"></label>
        <label class="field"><span>operator</span><select data-sf="condition.operator">
          ${["is_true", "is_false", "equals", "not_equals", "contains", "not_contains", "matches", "longer_than"].map((o) => `<option ${s.condition?.operator === o ? "selected" : ""}>${o}</option>`).join("")}
        </select></label>
        <label class="field"><span>right <span class="hint">(blank for is_true/is_false)</span></span><input data-sf="condition.right" value="${esc(s.condition?.right || "")}"></label>
      </div>
      ${varPickerHTML(w, idx)}
      <div class="branch">
        <div class="branch-col yes"><div class="branch-head">✅ Yes branch</div><div data-branch="then">${(s.then || []).map((b, bi) => miniStepHTML(w, wi, b, `then.${bi}`, idx)).join("") || `<p class="hint">No steps — runs nothing on yes.</p>`}<button type="button" class="btn" data-add-branch="then">+ Add step</button></div></div>
        <div class="branch-col no"><div class="branch-head">❌ No branch</div><div data-branch="else">${(s.else || []).map((b, bi) => miniStepHTML(w, wi, b, `else.${bi}`, idx)).join("") || `<p class="hint">No steps — runs nothing on no.</p>`}<button type="button" class="btn" data-add-branch="else">+ Add step</button></div></div>
      </div>`;
    case "subflow": return `
      <div class="grid">
        <label class="field"><span>workflow</span><select data-sf="workflow">${wflows}</select></label>
        <label class="field"><span>prefix <span class="hint">(vars land as prefix.step)</span></span><input data-sf="prefix" value="${esc(s.prefix || "")}" placeholder="defaults to workflow id"></label>
      </div>`;
    case "transform": return `
      <label class="field"><span>template <span class="hint">click a variable to insert</span></span><textarea data-sf="template" rows="2">${esc(s.template || "")}</textarea></label>
      ${varPickerHTML(w, idx)}`;
    case "delay": return `
      <label class="field"><span>wait (ms)</span><input data-sf="ms" type="number" value="${esc(s.ms ?? 1000)}"></label>`;
    case "http": return `
      <div class="grid">
        <label class="field"><span>url</span><input data-sf="url" value="${esc(s.url || "")}" placeholder="https://…"></label>
        <label class="field"><span>method</span><select data-sf="method">${["GET", "POST", "PUT", "DELETE"].map((m) => `<option ${(s.method || "GET") === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
      </div>
      <label class="field" style="margin-top:8px"><span>body <span class="hint">(POST/PUT, templates allowed)</span></span><textarea data-sf="body" rows="2">${esc(s.body || "")}</textarea></label>
      ${varPickerHTML(w, idx)}`;
    case "web": return `
      <div class="grid">
        <label class="field"><span>action</span><select data-sf="action">${["search", "news", "fetch"].map((a) => `<option ${(s.action || "search") === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
        <label class="field"><span>query / url / topic</span><input data-sf="query" value="${esc(s.query || s.url || s.topic || "")}"></label>
      </div>
      ${varPickerHTML(w, idx)}`;
    case "finance": return `
      <div class="grid">
        <label class="field"><span>market</span><select data-sf="market"><option value="india" ${(s.market || "india") === "india" ? "selected" : ""}>india</option><option value="us" ${s.market === "us" ? "selected" : ""}>us</option></select></label>
        <label class="field"><span>post to Discord</span><select data-sf="post"><option value="1" ${s.post !== false ? "selected" : ""}>yes</option><option value="0" ${s.post === false ? "selected" : ""}>no</option></select></label>
      </div>`;
    case "remember": return `
      <label class="field"><span>text</span><textarea data-sf="text" rows="2">${esc(s.text || "")}</textarea></label>${varPickerHTML(w, idx)}`;
    case "recall": return `
      <label class="field"><span>query</span><input data-sf="query" value="${esc(s.query || "")}"></label>${varPickerHTML(w, idx)}`;
    default: return `
      <label class="field"><span>text</span><input data-sf="text" value="${esc(s.text || "")}"></label>`;
  }
}

function miniStepHTML(w, wi, s, path, parentIdx) {
  return `<div class="ministep" data-path="${path}"><span class="tag">${stepLabel(s.type)}</span> <b>${esc(s.id)}</b>
    <button type="button" class="btn ghost sm" data-edit-mini>edit</button>
    <button type="button" class="btn danger sm" data-del-mini>✕</button></div>`;
}

function stepCardHTML(w, wi, s, idx) {
  return `
  <div class="stepcard" data-si="${idx}">
    <div class="stepcard-head">
      <span class="stepnum">${idx + 1}</span>
      <span class="tag">${stepLabel(s.type)}</span>
      <input class="stepid" data-sf="id" value="${esc(s.id)}" title="step id — referenced as {{steps.${esc(s.id)}}}">
      <span class="spacer"></span>
      <button type="button" class="btn ghost sm" data-move-up ${idx === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="btn ghost sm" data-move-down ${idx === w.steps.length - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="btn danger sm" data-del-step>✕</button>
    </div>
    <div class="stepcard-type">
      <label class="field"><span>type</span><select data-sf="type">${STEP_TYPES.map((t) => `<option value="${t.id}" ${s.type === t.id ? "selected" : ""}>${t.label} — ${t.desc}</option>`).join("")}</select></label>
    </div>
    <div class="stepcard-body">${stepFieldsHTML(w, wi, s, idx)}</div>
  </div>`;
}

const CRON_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every weekday 9:00 AM", cron: "0 9 * * 1-5" },
  { label: "Every day 6:00 PM", cron: "0 18 * * *" },
  { label: "Every Monday 8:30 AM", cron: "30 8 * * 1" },
  { label: "Every 30 min", cron: "*/30 * * * *", everyMinutes: 30 },
];

function stepChainHTML(w) {
  if (!w.steps?.length) return "";
  return `<div class="row" style="margin:8px 0 0">${w.steps.map((s) => `<span class="tag">${esc(stepLabel(s.type))}: ${esc((s.prompt || s.message || s.title || s.what || s.id || "").slice(0, 42))}</span>`).join('<span class="hint">→</span>')}</div>`;
}

function wfCard(w, i) {
  const trig = w.trigger?.type || "manual";
  const trigPill = (v, label) => `<button type="button" class="btn sm ${trig === v ? "primary" : "ghost"}" data-trig="${v}">${label}</button>`;
  return `
  <div class="card wf" data-i="${i}">
    <div class="grid">
      <label class="field"><span>workflow id</span><input data-wf="id" value="${esc(w.id)}"></label>
      <label class="field"><span>name</span><input data-wf="name" value="${esc(w.name || "")}" placeholder="Daily inbox → TODOs"></label>
    </div>
    <div class="row" style="margin-top:10px">
      <span class="hint">Trigger</span>
      ${trigPill("manual", "Manual only")}
      ${trigPill("schedule", "On a schedule")}
      ${trigPill("discord", "On !command")}
      ${trigPill("event", "On an event (rule)")}
    </div>
    ${trig === "schedule" ? `<div class="row">${CRON_PRESETS.map((p) => `<button type="button" class="btn ghost sm" data-preset="${esc(p.cron)}" data-everymin="${p.everyMinutes || ""}">${esc(p.label)}</button>`).join("")}</div>
      <div class="grid">
        <label class="field"><span>cron <span class="hint">m h dom mon dow</span></span><input data-wf="trigger.cron" value="${esc(w.trigger?.cron || "30 8 * * *")}"></label>
        <label class="field"><span>every N minutes <span class="hint">(blank = cron only)</span></span><input data-wf="trigger.everyMinutes" type="number" value="${esc(w.trigger?.everyMinutes || "")}" placeholder=""></label>
      </div>` : ""}
    ${trig === "discord" ? `<label class="field" style="margin-top:8px"><span>!command</span><input data-wf="trigger.command" value="${esc(w.trigger?.command || "")}" placeholder="review"></label>` : ""}
    ${trig === "event" ? `<label class="field" style="margin-top:8px"><span>event rule <span class="hint">matched against trigger payload</span></span><input data-wf="trigger.rule" value="${esc(w.trigger?.rule || "")}" placeholder="kind == inbox"></label>` : ""}
    ${stepChainHTML(w)}
    <div class="pipeline">
      <div class="pipeline-head">Steps — ${w.steps?.length || 0} step(s) <span class="hint">run top to bottom · reference earlier output with {{steps.id}} or {{steps.id.field}} and the trigger with {{trigger.field}}</span></div>
      ${(w.steps || []).map((s, si) => stepCardHTML(w, i, s, si)).join("") || `<div class="empty">No steps yet — add one below.</div>`}
      <div class="row">
        <select id="add-type-${i}">${STEP_TYPES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}</select>
        <button type="button" class="btn" data-add-step>+ Add step</button>
      </div>
    </div>
    <div class="row"><button class="btn danger rm-wf">Remove workflow</button></div>
  </div>`;
}

function readStepCard(card, w, wi, idx) {
  const s = w.steps[idx];
  $$("[data-sf]", card).forEach((inp) => {
    const f = inp.dataset.sf;
    if (f === "tools" || f === "memory") { s[f] = inp.checked; return; }
    if (f === "outputSchema") {
      const schema = {};
      for (const part of inp.value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8)) {
        const [k, t] = part.split(":").map((x) => (x || "").trim());
        if (k && ["bool", "int", "string"].includes(t)) schema[k] = t;
      }
      s.outputSchema = schema;
      return;
    }
    if (f === "post") { s.post = inp.value !== "0"; return; }
    if (f === "ms") { s.ms = Number(inp.value) || 1000; return; }
    if (f.startsWith("condition.")) {
      s.condition = s.condition || {};
      s.condition[f.slice("condition.".length)] = inp.value;
      return;
    }
    if (f === "query" && s.type === "web") {
      if (s.action === "fetch") { s.url = inp.value; delete s.query; delete s.topic; }
      else if (s.action === "news") { s.topic = inp.value; delete s.query; delete s.url; }
      else { s.query = inp.value; delete s.url; delete s.topic; }
      return;
    }
    s[f] = inp.type === "checkbox" ? inp.checked : inp.value;
  });
  // clean type-specific leftovers
  if (s.type !== "agent" && s.type !== "run_agent") { delete s.agent; delete s.prompt; delete s.output; delete s.outputSchema; }
  if (s.type !== "condition") { /* keep branches in state */ }
  return s;
}

export function panelAutomations(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Automations</h2><p>Multi-step pipelines — agent → JSON vars → yes/no branch → notify.</p></div>
    <div id="wlist">${S.workflows.map(wfCard).join("") || `<div class="empty">No workflows yet.</div>`}</div>
    <div class="row"><button class="btn" id="add-w">+ Add workflow</button><button class="btn primary" id="save-w">Save workflows</button></div>`;
  $("#add-w").onclick = () => {
    S.workflows.push({ id: "my-flow", trigger: { type: "schedule", cron: "30 8 * * *" }, steps: [
      { id: "step1", type: "agent", agent: S.agents[0]?.id || "assistant", prompt: "Hello" },
      { id: "notify", type: "discord_send", message: "{{steps.step1}}" },
    ] });
    render();
  };
  $$("#wlist .wf").forEach((card) => {
    const wi = +card.dataset.i;
    const w = S.workflows[wi];
    // workflow-level fields
    $$("[data-wf]", card).forEach((inp) => {
      inp.onchange = () => {
        const f = inp.dataset.wf;
        if (f === "id") w.id = inp.value;
        else if (f === "name") w.name = inp.value;
        else if (f === "trigger.cron") w.trigger.cron = inp.value;
        else if (f === "trigger.everyMinutes") {
          if (inp.value === "") delete w.trigger.everyMinutes;
          else w.trigger.everyMinutes = Number(inp.value) || 0;
        }
        else if (f === "trigger.command") w.trigger.command = inp.value;
        else if (f === "trigger.rule") w.trigger.rule = inp.value;
      };
    });
    $$("[data-trig]", card).forEach((btn) => {
      btn.onclick = () => {
        $$(".stepcard", card).forEach((sc) => readStepCard(sc, w, wi, +sc.dataset.si));
        w.trigger = { type: btn.dataset.trig };
        render();
      };
    });
    $$("[data-preset]", card).forEach((btn) => {
      btn.onclick = () => {
        $$(".stepcard", card).forEach((sc) => readStepCard(sc, w, wi, +sc.dataset.si));
        w.trigger.cron = btn.dataset.preset;
        if (btn.dataset.everymin) w.trigger.everyMinutes = Number(btn.dataset.everymin);
        render();
      };
    });
    $(".rm-wf", card).onclick = () => { S.workflows.splice(wi, 1); render(); };
    // step cards
    $$(".stepcard", card).forEach((sc) => {
      const si = +sc.dataset.si;
      // var picker inserts at cursor
      $$(".var", sc).forEach((btn) => {
        btn.onclick = () => {
          const ta = sc.querySelector("textarea[data-sf]");
          if (!ta) return;
          const { selectionStart = ta.value.length } = ta;
          ta.value = ta.value.slice(0, selectionStart) + btn.dataset.var + ta.value.slice(ta.selectionEnd ?? selectionStart);
          ta.focus();
        };
      });
      $("[data-sf='type']", sc).onchange = (e) => {
        readStepCard(sc, w, wi, si);
        w.steps[si].type = e.target.value;
        // sensible defaults per type (reference palette + legacy types)
        const d = { id: w.steps[si].id || `step${si + 1}` };
        if (e.target.value === "agent" || e.target.value === "run_agent") Object.assign(d, { type: e.target.value, agent: S.agents[0]?.id || "assistant", prompt: "" });
        else if (e.target.value === "discord_send" || e.target.value === "notify") Object.assign(d, { type: e.target.value, message: "" });
        else if (e.target.value === "create_task") Object.assign(d, { type: "create_task", title: "" });
        else if (e.target.value === "file_request") Object.assign(d, { type: "file_request", what: "" });
        else if (e.target.value === "wait") Object.assign(d, { type: "wait", ms: 1000 });
        else if (e.target.value === "condition") Object.assign(d, { type: "condition", condition: { left: "", operator: "is_true", right: "" }, then: [], else: [] });
        else if (e.target.value === "subflow" || e.target.value === "run_automation") Object.assign(d, { type: e.target.value, workflow: S.workflows.find((x, j) => j !== wi)?.id || "" });
        else if (e.target.value === "transform") Object.assign(d, { type: "transform", template: "" });
        else if (e.target.value === "delay") Object.assign(d, { type: "delay", ms: 1000 });
        else if (e.target.value === "http") Object.assign(d, { type: "http", url: "", method: "GET" });
        else if (e.target.value === "web") Object.assign(d, { type: "web", action: "search", query: "" });
        else if (e.target.value === "finance") Object.assign(d, { type: "finance", market: "india" });
        else if (e.target.value === "remember") Object.assign(d, { type: "remember", text: "" });
        else if (e.target.value === "recall") Object.assign(d, { type: "recall", query: "" });
        else Object.assign(d, { type: "log", text: "" });
        w.steps[si] = d;
        render();
      };
      const del = $("[data-del-step]", sc);
      if (del) del.onclick = () => { w.steps.splice(si, 1); render(); };
      const up = $("[data-move-up]", sc);
      if (up) up.onclick = () => { [w.steps[si - 1], w.steps[si]] = [w.steps[si], w.steps[si - 1]]; render(); };
      const down = $("[data-move-down]", sc);
      if (down) down.onclick = () => { [w.steps[si + 1], w.steps[si]] = [w.steps[si], w.steps[si + 1]]; render(); };
      // branch mini-steps
      $$("[data-add-branch]", sc).forEach((btn) => {
        btn.onclick = () => {
          readStepCard(sc, w, wi, si);
          const branch = btn.dataset.addBranch;
          w.steps[si][branch] = w.steps[si][branch] || [];
          w.steps[si][branch].push({ id: `b${w.steps[si][branch].length + 1}`, type: "discord_send", message: "" });
          render();
        };
      });
      $$("[data-del-mini]", sc).forEach((btn) => {
        btn.onclick = () => {
          readStepCard(sc, w, wi, si);
          const [branch, bi] = btn.closest(".ministep").dataset.path.split(".");
          w.steps[si][branch].splice(+bi, 1);
          render();
        };
      });
      $$("[data-edit-mini]", sc).forEach((btn) => {
        btn.onclick = () => {
          readStepCard(sc, w, wi, si);
          const [branch, bi] = btn.closest(".ministep").dataset.path.split(".");
          const mini = w.steps[si][branch][+bi];
          // promote mini-step to a full step after the condition for editing
          w.steps.splice(si + 1, 0, mini);
          w.steps[si][branch].splice(+bi, 1);
          render();
          toast("Branch step moved below the condition for editing.");
        };
      });
    });
    $("[data-add-step]", card).onclick = () => {
      // flush current card state first
      $$(".stepcard", card).forEach((sc) => readStepCard(sc, w, wi, +sc.dataset.si));
      const type = $(`#add-type-${wi}`).value;
      const n = w.steps.length + 1;
      const base = { id: `step${n}`, type };
      if (type === "agent" || type === "run_agent") Object.assign(base, { agent: S.agents[0]?.id || "assistant", prompt: "" });
      else if (type === "discord_send" || type === "notify") Object.assign(base, { message: "" });
      else if (type === "create_task") Object.assign(base, { title: "" });
      else if (type === "file_request") Object.assign(base, { what: "" });
      else if (type === "wait") Object.assign(base, { ms: 1000 });
      else if (type === "condition") Object.assign(base, { condition: { left: "", operator: "is_true", right: "" }, then: [], else: [] });
      else if (type === "subflow" || type === "run_automation") Object.assign(base, { workflow: "" });
      else if (type === "transform") Object.assign(base, { template: "" });
      else if (type === "delay") Object.assign(base, { ms: 1000 });
      else if (type === "http") Object.assign(base, { url: "", method: "GET" });
      else if (type === "web") Object.assign(base, { action: "search", query: "" });
      else if (type === "finance") Object.assign(base, { market: "india" });
      else if (type === "remember") Object.assign(base, { text: "" });
      else if (type === "recall") Object.assign(base, { query: "" });
      else Object.assign(base, { text: "" });
      w.steps.push(base);
      render();
    };
  });
  $("#save-w").onclick = async () => {
    try {
      $$("#wlist .wf").forEach((card) => {
        const wi = +card.dataset.i;
        const w = S.workflows[wi];
        $$(".stepcard", card).forEach((sc) => readStepCard(sc, w, wi, +sc.dataset.si));
      });
      const r = await api("/api/workflows", { method: "POST", body: JSON.stringify({ workflows: S.workflows }) });
      // Mirror every flow into SQLite so the 30s loop + dashboard see the same truth.
      let synced = 0;
      for (const w of S.workflows) {
        try {
          await api("/api/automations", { method: "POST", body: JSON.stringify({
            id: w.id, name: w.name || w.id, description: w.description || "",
            trigger_type: w.trigger?.type || "manual",
            trigger_config: { cron: w.trigger?.cron, everyMinutes: w.trigger?.everyMinutes, command: w.trigger?.command, rule: w.trigger?.rule },
            steps: w.steps || [], enabled: true,
          }) });
          synced++;
        } catch { /* workflows.json is source of truth; automations sync is best-effort */ }
      }
      markDone("automations");
      toast(`Saved ${r.count} workflows, ${synced} synced to loop DB.`);
    } catch (e) { toast(e.message, "bad"); }
  };
}

// ---------- streams (reference: repo replacement — streams group agents, pipelines chain agent->agent) ----------


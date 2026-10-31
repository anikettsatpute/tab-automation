// Configuration: sectioned editor for providers & models, Discord routing,
// agents, agent pipelines (loop task types) and Discord/manual automations.
// Pure render — wiring lives in main.js (wireConfig).
import { S, esc } from "./state.js";
import { pageHead, section, emptyState, icon } from "./ui.js";

export const MUSE_MODELS = ["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1", "muse-spark"];
export const PROVIDER_TYPES = ["muse", "azure-foundry", "openrouter", "meta"];
export const CFG_TABS = [
  ["providers", "Providers & models", "server"],
  ["discord", "Discord", "message-circle"],
  ["agents", "Agents", "bot"],
  ["pipelines", "Pipelines", "git-branch"],
  ["automations", "Automations", "workflow"],
];
const BUILTIN_CMDS = ["!remember <text>", "!recall <q>", "!todo <text>", "!todos", "!history", "!automations", "!pipelines", "!pipeline <id> <goal>"];

/** Models offered for a provider: explicit list, else known muse models, else its default. */
export const modelsFor = (p) => (p?.models?.length ? p.models : p?.type === "muse" ? MUSE_MODELS : p?.modelDefault ? [p.modelDefault] : []);

const tabBar = () => `<div class="btabs" role="tablist" aria-label="Configuration sections">${CFG_TABS.map(([v, l, ic]) =>
  `<button type="button" role="tab" aria-selected="${S.cfgTab === v}" class="tab ${S.cfgTab === v ? "on" : ""}" data-cfgtab="${v}">${icon(ic)} ${esc(l)}</button>`).join("")}</div>`;

const fld = (label, inner, cls = "") => `<label class="fld ${cls}"><span>${esc(label)}</span>${inner}</label>`;
const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(label)}</option>`;

function providersTab(c) {
  const provs = c.providers?.providers || [];
  const ks = c.providers?.keyStatus || {};
  return section(`Providers (${provs.length})`, `
  <p class="hint">A provider is where model calls go. <b>Key env</b> is the <i>name</i> of the env var in <span class="kbd">.env</span> holding the API key — keys never pass through the dashboard. <b>Models</b> populate the per-agent model picker.</p>
  ${provs.map((p, i) => `<div class="stepcard">
    <div class="row"><b>${icon("server")} ${esc(p.id || "new provider")}</b>
      ${p.keyEnv ? `<span class="tag ${ks[p.id] ? "ok" : "bad"}">${ks[p.id] ? "key set" : "key missing"}</span>` : ""}
      ${c.providers?.defaultProvider === p.id ? `<span class="tag ok">default</span>` : ""}
      <span class="spacer"></span><button type="button" class="btn sm danger" data-pdel="${i}" aria-label="Remove provider ${esc(p.id)}">${icon("trash-2")}</button></div>
    <div class="row">
      ${fld("ID", `<input data-pi="${i}" data-pf="id" value="${esc(p.id || "")}" ${p._new ? "" : "readonly"} placeholder="openrouter">`)}
      ${fld("Type", `<select data-pi="${i}" data-pf="type">${PROVIDER_TYPES.map((t) => opt(t, p.type)).join("")}</select>`)}
      ${fld("Key env var", `<input data-pi="${i}" data-pf="keyEnv" value="${esc(p.keyEnv || "")}" placeholder="OPENROUTER_API_KEY">`)}
    </div>
    <div class="row">
      ${fld("Endpoint (https)", `<input data-pi="${i}" data-pf="endpoint" value="${esc(p.endpoint || "")}" placeholder="${p.type === "muse" ? "(CLI — none)" : "https://…"}">`, "grow")}
      ${fld("Default model", `<input data-pi="${i}" data-pf="modelDefault" value="${esc(p.modelDefault || "")}" list="models-${i}" placeholder="model id"><datalist id="models-${i}">${modelsFor(p).map((m) => `<option value="${esc(m)}">`).join("")}</datalist>`)}
    </div>
    ${fld("Models (comma separated — shown in agent pickers)", `<input data-pi="${i}" data-pf="models" value="${esc((p.models || []).join(", "))}" placeholder="${esc(modelsFor(p).join(", ") || "gpt-5.6-terra, gpt-5.6-mini")}">`)}
  </div>`).join("") || emptyState("server", "No providers", "Add one below.")}
  <div class="row"><button type="button" class="btn sm" id="cfg-addprov">${icon("plus")} Add provider</button>
  ${fld("Default provider", `<select id="cfg-defprov">${provs.map((p) => opt(p.id, c.providers?.defaultProvider)).join("")}</select>`)}
  <span class="spacer"></span><button type="button" class="btn sm primary" id="cfgsave2">${icon("save")} Save providers</button></div>`);
}

function discordTab(c) {
  const d = c.discord || {};
  const flows = (S.flows || []).filter((f) => (f.trigger?.type || f.trigger) === "discord" && f.trigger?.command);
  return section("Discord routing", `
  <p class="hint">Where the bot posts and who it trusts. The bot token stays in <span class="kbd">.env</span> (<span class="kbd">DISCORD_BOT_TOKEN</span>) — status:
  <span class="tag ${d.tokenSet ? "ok" : "bad"}">${d.tokenSet ? "token set" : "token missing"}</span>. Enable Developer Mode in Discord → right-click → Copy ID.</p>
  <div class="row">
    ${fld("Main channel ID", `<input id="dc-main" inputmode="numeric" value="${esc(d.mainChannelId || "")}" placeholder="1546…">`)}
    ${fld("Guild (server) ID", `<input id="dc-guild" inputmode="numeric" value="${esc(d.guildId || "")}">`)}
    ${fld("Owner user ID", `<input id="dc-owner" inputmode="numeric" value="${esc(d.ownerUserId || "")}">`)}
  </div>
  ${fld("Extra channels (comma separated IDs)", `<input id="dc-extra" value="${esc((d.extraChannels || []).join(", "))}">`)}
  ${Object.values(d.envOverrides || {}).some(Boolean) ? `<p class="hint">${icon("info")} Some values are overridden by env vars (${Object.entries(d.envOverrides).filter(([, v]) => v).map(([k]) => esc(k)).join(", ")}); the env value wins at runtime.</p>` : ""}
  <div class="row"><span class="hint">Effective post channel: <span class="kbd">${esc(d.effective?.channelId || "—")}</span></span><span class="spacer"></span><button type="button" class="btn sm primary" id="dc-save">${icon("save")} Save Discord</button></div>`)
  + section("Discord commands", `
  <p class="hint">Type these in any channel the bot can read.</p>
  <div class="tblwrap"><table class="tbl"><thead><tr><th>Command</th><th>Runs</th><th>Kind</th></tr></thead><tbody>
  ${flows.map((f) => `<tr><td><span class="kbd">!${esc(f.trigger.command)} &lt;text&gt;</span></td><td>${esc(f.title || f.id)}<br><span class="hint">${esc(f.description || "")}</span></td><td>automation</td></tr>`).join("")}
  ${(S.loopTypes || []).map((t) => `<tr><td><span class="kbd">!pipeline ${esc(t.id)} &lt;goal&gt;</span></td><td>${esc(t.name)}<br><span class="hint">${(t.steps || []).map((s) => esc(s.role)).join(" → ")}</span></td><td>pipeline</td></tr>`).join("")}
  <tr><td colspan="3" class="hint">Built-ins: ${BUILTIN_CMDS.map((b) => `<span class="kbd">${esc(b)}</span>`).join(" ")} · or just @mention the bot.</td></tr>
  </tbody></table></div>`);
}

function agentsTab(c) {
  const provs = c.providers?.providers || [];
  const agents = c.agents?.agents || [];
  const defProv = c.providers?.defaultProvider || "";
  return section(`Agents (${agents.length})`, `
  <p class="hint">An agent = system prompt + provider/model. Agents are the building blocks for pipelines and automations. Dispatch chain: per-call model → agent model → provider default.</p>
  <div class="row"><button type="button" class="btn sm" id="cfg-addagent">${icon("plus")} New agent</button><span class="spacer"></span><button type="button" class="btn sm primary" id="cfgsave3">${icon("save")} Save agents</button></div>
  ${agents.map((a, i) => {
    const open = a._new || S.cfgOpenAgent === a.id;
    const prov = provs.find((p) => p.id === (a.provider || defProv));
    const models = modelsFor(prov);
    return `<div class="stepcard">
    <div class="row"><button type="button" class="btn sm ghost" data-aopen="${esc(a.id)}" aria-expanded="${!!open}">${icon(open ? "chevron-down" : "chevron-right")}</button>
      <b>${icon("bot")} ${esc(a.id || "new agent")}</b><span class="hint">${esc(a.description || "")}</span><span class="spacer"></span>
      <span class="kbd">${esc(a.provider || defProv || "default")}${a.model ? ` · ${esc(a.model)}` : ""}</span>
      <button type="button" class="btn sm ghost" data-cfgtest="${esc(a.id)}" ${a._new ? "disabled" : ""}>${icon("play")} Test</button>
      <button type="button" class="btn sm danger" data-adel="${i}" aria-label="Delete agent ${esc(a.id)}">${icon("trash-2")}</button></div>
    ${open ? `<div class="row">
      ${fld("ID", `<input data-ai="${i}" data-af="id" value="${esc(a.id || "")}" ${a._new ? "" : "readonly"} placeholder="haiku-poet">`)}
      ${fld("Description", `<input data-ai="${i}" data-af="description" value="${esc(a.description || "")}" placeholder="One line: what it does">`, "grow")}
    </div>
    ${fld("System prompt (role, rules, output format)", `<textarea data-ai="${i}" data-af="systemPrompt" rows="4">${esc(a.systemPrompt || "")}</textarea>`)}
    <div class="row">
      ${fld("Provider", `<select data-ai="${i}" data-af="provider">${opt("", a.provider || "", `(default: ${defProv})`)}${provs.map((p) => opt(p.id, a.provider)).join("")}</select>`)}
      ${fld("Model", `<select data-ai="${i}" data-af="model">${opt("", a.model || "", "(provider default)")}${models.map((m) => opt(m, a.model)).join("")}${a.model && !models.includes(a.model) ? opt(a.model, a.model) : ""}</select>`)}
      ${fld("Temperature", `<input data-ai="${i}" data-af="temperature" type="number" min="0" max="2" step="0.1" value="${esc(a.temperature ?? "")}" placeholder="0.7">`)}
    </div>
    ${fld("Default prompt (used when a step/test prompt is empty)", `<textarea data-ai="${i}" data-af="defaultPrompt" rows="2">${esc(a.defaultPrompt || "")}</textarea>`)}
    <div class="row">${fld("Test prompt", `<input id="cfgtest-prompt-${esc(a.id)}" placeholder="empty = default prompt">`, "grow")}${fld("Test model", `<input id="cfgtest-model-${esc(a.id)}" placeholder="empty = agent model">`)}</div>` : ""}
    <div id="cfgtest-out-${esc(a.id)}"></div></div>`;
  }).join("") || emptyState("bot", "No agents", "Create one above.")}`);
}

function pipelinesTab() {
  const ed = S.pipeEdit;
  const roles = (S.cfgData?.agents?.agents || []).filter((a) => !a._new).map((a) => a.id);
  return section(`Agent pipelines (${(S.loopTypes || []).length})`, `
  <p class="hint">A pipeline is an ordered chain of agents. Each step gets the goal + the previous steps' handoff. Run one from here, from <b>New task</b>, or from Discord with <span class="kbd">!pipeline &lt;id&gt; &lt;goal&gt;</span>.</p>
  <div class="row"><button type="button" class="btn sm" id="pp-new">${icon("plus")} New pipeline</button></div>
  ${ed ? `<div class="appr" role="group" aria-label="Pipeline editor">
    <div class="row">${fld("ID", `<input id="pp-id" value="${esc(ed.id)}" ${ed._new ? "" : "readonly"} placeholder="quick-answer">`)}${fld("Name", `<input id="pp-name" value="${esc(ed.name)}">`, "grow")}</div>
    ${fld("Description", `<input id="pp-desc" value="${esc(ed.description || "")}">`)}
    <h4>Steps</h4>
    ${(ed.steps || []).map((s, i) => `<div class="row"><span class="kbd">${i + 1}</span>
      ${fld("Agent", `<select data-pps="${i}" data-ppf="role">${roles.map((r) => opt(r, s.role)).join("")}</select>`)}
      ${fld("Goal for this step", `<input data-pps="${i}" data-ppf="goal" value="${esc(s.goal)}">`, "grow")}
      <button type="button" class="btn sm ghost" data-ppup="${i}" aria-label="Move step ${i + 1} up">${icon("arrow-up")}</button>
      <button type="button" class="btn sm danger" data-ppsdel="${i}" aria-label="Remove step ${i + 1}">${icon("trash-2")}</button></div>`).join("") || `<p class="hint">No steps yet.</p>`}
    <div class="row"><button type="button" class="btn sm ghost" id="pp-addstep">${icon("plus")} Add step</button><span class="spacer"></span>
      <button type="button" class="btn sm ghost" id="pp-cancel">Cancel</button><button type="button" class="btn sm primary" id="pp-save">${icon("save")} Save pipeline</button></div>
  </div>` : ""}
  ${(S.loopTypes || []).map((t) => `<div class="appr"><div class="row"><b>${icon("git-branch")} ${esc(t.name)}</b><span class="kbd">${esc(t.id)}</span><span class="spacer"></span>
    <button type="button" class="btn sm ghost" data-ppedit="${esc(t.id)}">${icon("pencil")} Edit</button>
    <button type="button" class="btn sm danger" data-ppdel="${esc(t.id)}" aria-label="Delete pipeline ${esc(t.id)}">${icon("trash-2")}</button></div>
    <p class="hint">${esc(t.description || "")}</p>
    <div class="pipe">${(t.steps || []).map((s, i) => `<div class="pnode" title="${esc(s.goal)}"><b>${esc(s.role)}</b><span>${esc(String(s.goal).slice(0, 48))}</span></div>${i < t.steps.length - 1 ? `<span class="arr">→</span>` : ""}`).join("")}</div>
    <div class="row">${fld("Goal", `<input id="pprun-goal-${esc(t.id)}" placeholder="What should this pipeline do?">`, "grow")}<button type="button" class="btn sm primary" data-pprun="${esc(t.id)}">${icon("play")} Run</button></div>
  </div>`).join("") || emptyState("git-branch", "No pipelines", "Create one above.")}`);
}

function automationsTab() {
  const ab = S.autoEdit;
  const agents = (S.cfgData?.agents?.agents || []).filter((a) => !a._new).map((a) => a.id);
  const mine = (S.flows || []).filter((f) => ["discord", "manual"].includes(f.trigger?.type || f.trigger));
  return section("Automation builder", `
  <p class="hint">Chain agents behind a Discord command (or a Run button). Step prompts can use <span class="kbd">{{trigger.text}}</span> (what the user typed after the command) and <span class="kbd">{{steps.&lt;id&gt;}}</span> (an earlier step's output). The last step's output is posted back to the channel.</p>
  ${ab ? `<div class="appr" role="group" aria-label="Automation editor">
    <div class="row">${fld("ID", `<input id="ab-id" value="${esc(ab.id)}" placeholder="haiku">`)}${fld("Title", `<input id="ab-title" value="${esc(ab.title)}">`, "grow")}</div>
    ${fld("Description", `<input id="ab-desc" value="${esc(ab.description)}">`)}
    <div class="row">${fld("Trigger", `<select id="ab-trig">${opt("discord", ab.trigger, "Discord command")}${opt("manual", ab.trigger, "Manual (Run button)")}</select>`)}
    ${ab.trigger === "discord" ? fld("Command (without !)", `<input id="ab-cmd" value="${esc(ab.command)}" placeholder="haiku">`) : ""}</div>
    <h4>Agent steps</h4>
    ${ab.steps.map((s, i) => `<div class="stepcard"><div class="row"><span class="kbd">${esc(s.id)}</span>
      ${fld("Agent", `<select data-abs="${i}" data-abf="agent">${agents.map((a) => opt(a, s.agent)).join("")}</select>`)}<span class="spacer"></span>
      <button type="button" class="btn sm danger" data-absdel="${i}" aria-label="Remove step ${i + 1}">${icon("trash-2")}</button></div>
      ${fld("Prompt", `<textarea data-abs="${i}" data-abf="prompt" rows="2" placeholder="${i === 0 ? "{{trigger.text}}" : `Improve this:\n{{steps.${esc(ab.steps[i - 1]?.id || "s1")}}}`}">${esc(s.prompt)}</textarea>`)}</div>`).join("")}
    <div class="row"><button type="button" class="btn sm ghost" id="ab-addstep">${icon("plus")} Add agent step</button><span class="spacer"></span>
      <button type="button" class="btn sm ghost" id="ab-cancel">Cancel</button><button type="button" class="btn sm primary" id="ab-save">${icon("save")} Save automation</button></div>
  </div>` : `<div class="row"><button type="button" class="btn sm" id="ab-new">${icon("plus")} New automation</button></div>`}`)
  + section(`Discord & manual automations (${mine.length})`, mine.map((f) => `<div class="appr"><div class="row"><b>${icon("workflow")} ${esc(f.title || f.id)}</b>
    ${f.trigger?.command ? `<span class="kbd">!${esc(f.trigger.command)}</span>` : `<span class="kbd">manual</span>`}<span class="spacer"></span>
    <button type="button" class="btn sm primary" data-runflow="${esc(f.id)}">${icon("play")} Run</button>
    <button type="button" class="btn sm danger" data-flowdel="${esc(f.id)}" aria-label="Delete automation ${esc(f.id)}">${icon("trash-2")}</button></div>
    <p class="hint">${esc(f.description || "")}</p>
    <div class="pipe">${(f.steps || []).map((s, i) => `<div class="pnode"><b>${esc(s.agent || s.id)}</b><span>${esc(s.type)}</span></div>${i < f.steps.length - 1 ? `<span class="arr">→</span>` : ""}`).join("")}</div></div>`).join("")
    || emptyState("workflow", "No automations", "Build one above."), `<span class="hint">schedules live in Automations</span>`);
}

export function configView() {
  const c = S.cfgData;
  if (!c) return `<div class="card" aria-busy="true"><h3>Configuration</h3><div class="skel" style="height:18px;width:60%"></div><div class="skel" style="height:12px;width:90%"></div><p class="hint">Loading providers, models, prompts…</p></div>`;
  const tab = CFG_TABS.some(([v]) => v === S.cfgTab) ? S.cfgTab : "providers";
  const body = tab === "discord" ? discordTab(c) : tab === "agents" ? agentsTab(c) : tab === "pipelines" ? pipelinesTab() : tab === "automations" ? automationsTab() : providersTab(c);
  return `
  ${pageHead("Configuration", "providers · discord · agents · pipelines · automations", S.cfgDirty ? `<span class="tag warn">unsaved changes</span><button type="button" class="btn sm primary" id="cfgsave">${icon("save")} Save</button>` : "")}
  ${S.cfgMsg ? `<div class="notice ${S.cfgErr ? "bad" : "ok"}" role="status">${icon(S.cfgErr ? "alert-triangle" : "check-circle-2")} ${esc(S.cfgMsg)}</div>` : ""}
  ${tabBar()}
  ${body}`;
}

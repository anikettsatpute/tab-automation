// Configuration: sectioned editor for providers & models, Discord routing,
// agents, agent pipelines (loop task types) and .env secrets.
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
  ["mcp", "MCP servers", "wrench"],
  ["secrets", "Secrets (.env)", "key-round"],
];
const MCP_STATUS = { ready: "ok", disabled: "", "needs-secret": "warn", "needs-auth": "warn", error: "bad" };
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
      ${(a.mcp || []).map((m) => `<span class="tag" title="MCP server (manage in the MCP servers tab)">${icon("wrench")} ${esc(m)}</span>`).join("")}
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

const kvText = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join("\n");

function mcpForm(ed, nextNum) {
  const num = ed.num || nextNum;
  const http = ed.transport === "http";
  return `<div class="appr" role="group" aria-label="MCP server editor">
    <div class="row">${fld("ID", `<input id="mcp-id" value="${esc(ed.id || "")}" ${ed._new ? "" : "readonly"} placeholder="github">`)}
      ${fld("Name", `<input id="mcp-name" value="${esc(ed.name || "")}" placeholder="GitHub">`, "grow")}
      ${fld("Transport", `<select id="mcp-transport">${opt("stdio", ed.transport || "stdio", "stdio (local command)")}${opt("http", ed.transport, "http (remote URL)")}</select>`)}
      <span class="kbd" title="Secrets for this server are stored in .env as MCP_${num}_&lt;SLOT&gt;">#${num}</span></div>
    ${http
      ? fld("URL (https; http only for localhost)", `<input id="mcp-url" value="${esc(ed.url || "")}" placeholder="https://api.example.com/mcp">`)
      : `<div class="row">${fld("Command", `<input id="mcp-command" value="${esc(ed.command || "")}" placeholder="npx">`)}${fld("Args (one per line)", `<textarea id="mcp-args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github">${esc((ed.args || []).join("\n"))}</textarea>`, "grow")}</div>`}
    ${fld("Secret slots (one per line: SLOT or SLOT: label) — stored as MCP_" + num + "_<SLOT>", `<textarea id="mcp-secrets" rows="2" placeholder="TOKEN: GitHub PAT">${esc((ed.secrets || []).map((s) => (s.label ? `${s.slot}: ${s.label}` : s.slot)).join("\n"))}</textarea>`)}
    ${http ? "" : fld("Env passed to the server (KEY=VALUE per line; use ${SLOT} for a secret)", `<textarea id="mcp-env" rows="2" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=\${TOKEN}">${esc(kvText(ed.env))}</textarea>`)}
    ${http ? fld("Headers (KEY=VALUE per line; whole value must be ${SLOT})", `<textarea id="mcp-headers" rows="2" placeholder="X-Api-Key=\${API_KEY}">${esc(kvText(ed.headers))}</textarea>`) : ""}
    ${fld("Note", `<input id="mcp-note" value="${esc(ed.note || "")}">`)}
    <div class="row"><span class="spacer"></span><button type="button" class="btn sm ghost" id="mcp-cancel">Cancel</button>
      <button type="button" class="btn sm primary" id="mcp-save">${icon("save")} Save server</button></div>
  </div>`;
}

const redirectUri = () => `${location.origin}/api/control/mcp/oauth/callback`;

function signInBlock(s) {
  const si = s.signIn || {};
  const o = s.oauth;
  const id = esc(s.id);
  const waiting = S.mcpAuthWait === s.id;
  const needClient = S.mcpNeedClient === s.id || (si.kind !== "discover" && !si.clientSet);
  const what = si.kind === "provider" ? `Sign in with ${esc(si.label)}` : "Sign in";
  const steps = si.provider === "google" ? `<ol class="hint">
      <li><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Enable the Gmail API</a> in a Google Cloud project.</li>
      <li><a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener noreferrer">OAuth consent screen</a>: User type <b>External</b>, and add your Google address under <b>Test users</b> (otherwise Google says "access blocked").</li>
      <li><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Credentials</a> → Create credentials → OAuth client ID → <b>Web application</b> → Authorized redirect URI: <span class="kbd">${esc(redirectUri())}</span> <button type="button" class="btn sm ghost" data-copy="${esc(redirectUri())}">Copy</button></li>
      <li>Paste the Client ID and secret below, press Sign in. On "Google hasn't verified this app" choose <b>Advanced → Continue</b>.</li></ol>`
    : `<p class="hint">${si.clientHint ? `${esc(si.clientHint)} ` : ""}Redirect URI: <span class="kbd">${esc(redirectUri())}</span> <button type="button" class="btn sm ghost" data-copy="${esc(redirectUri())}">Copy</button>${si.helpUrl ? ` · <a href="${esc(si.helpUrl)}" target="_blank" rel="noopener noreferrer">open console</a>` : ""}</p>`;
  const clientFields = `${si.clientSet ? "" : steps}<div class="row">
      ${fld("OAuth client ID", `<input id="mcp-cid-${id}" autocomplete="off" spellcheck="false" placeholder="${si.clientSet ? "saved — type to replace" : "…apps.googleusercontent.com"}">`, "grow")}
      ${fld("Client secret", `<input id="mcp-csec-${id}" type="password" autocomplete="off" placeholder="${si.clientSet ? "saved — type to replace" : "if the app has one"}">`, "grow")}</div>`;
  const advanced = `
    ${si.kind === "custom" ? `<div class="row">
      ${fld("Authorization endpoint (https)", `<input id="mcp-authep-${id}" value="${esc(si.authorizationEndpoint)}" placeholder="https://provider.com/oauth/authorize">`, "grow")}
      ${fld("Token endpoint (https)", `<input id="mcp-tokep-${id}" value="${esc(si.tokenEndpoint)}" placeholder="https://provider.com/oauth/token">`, "grow")}</div>` : ""}
    <div class="row">${fld("Scopes (space separated)", `<input id="mcp-scope-${id}" value="${esc(si.scope)}">`, "grow")}
      ${s.transport !== "http" ? fld("Server reads token from env var", `<input id="mcp-tokenv-${id}" value="${esc(si.tokenEnv)}" placeholder="GOOGLE_ACCESS_TOKEN">`) : ""}</div>`;
  const status = o
    ? `<span class="tag ${o.signedIn ? "ok" : "warn"}">${o.signedIn ? "signed in" : "not signed in"}</span>
       ${o.signedIn && o.expiresAt ? `<span class="hint">token ${o.expiresAt > Date.now() ? "expires" : "expired"} ${esc(new Date(o.expiresAt).toLocaleString())}${o.canRefresh ? " · auto-refresh on" : ""}</span>` : ""}`
    : `<span class="hint">${si.kind === "custom" ? "Optional: sign in with OAuth instead of pasting a token." : "Not connected."}</span>`;
  const body = `
    <div class="row">${icon("key-round")} <b>Sign-in</b> ${status}<span class="spacer"></span>
      ${waiting ? `<span class="hint" aria-live="polite">${icon("loader")} Waiting for you to finish in the other tab…</span><button type="button" class="btn sm ghost" data-mcpauthcancel="${id}">Stop waiting</button>` : ""}
      ${o?.canRefresh ? `<button type="button" class="btn sm ghost" data-mcprefresh="${id}">${icon("refresh-cw")} Refresh</button>` : ""}
      ${o?.signedIn ? `<button type="button" class="btn sm ghost" data-mcpsignout="${id}">${icon("log-out")} Sign out</button>` : ""}
      <button type="button" class="btn sm ${o?.signedIn ? "" : "primary"}" data-mcpauth="${id}" ${waiting ? "disabled" : ""}>${icon("key-round")} ${o?.signedIn ? "Sign in again" : what}</button></div>
    ${S.mcpAuthErr?.id === s.id ? `<div class="notice bad" role="alert">${icon("alert-triangle")} ${esc(S.mcpAuthErr.msg)}</div>` : ""}
    ${needClient ? clientFields : ""}
    <details><summary class="hint">Advanced${si.kind === "discover" && !needClient ? " (own OAuth app, scopes)" : " (scopes)"}</summary>
      ${si.kind === "discover" && !needClient ? clientFields : ""}${advanced}</details>`;
  if (si.kind === "custom" && !o) return `<details class="appr"><summary class="hint">${icon("key-round")} Set up OAuth sign-in (custom provider)</summary>${clientFields}${advanced}
    <div class="row"><span class="spacer"></span><button type="button" class="btn sm" data-mcpauth="${id}">${icon("key-round")} Sign in</button></div></details>`;
  return `<div class="appr" role="group" aria-label="Sign-in for ${id}">${body}</div>`;
}

function mcpTab() {
  const m = S.mcp;
  if (!m) return section("MCP servers", `<p class="hint" aria-busy="true">Loading…</p>`);
  const agents = m.agents || [];
  return section(`MCP servers (${m.servers.length})`, `
  <p class="hint">${icon("shield-check")} Each server gets a number; its secrets live in <span class="kbd">.env</span> as <span class="kbd">MCP_&lt;num&gt;_&lt;SLOT&gt;</span> and are write-only here. Agents get <b>no</b> MCP servers unless ticked below; only <b>ready</b> servers are attached to a run.</p>
  <div class="row"><button type="button" class="btn sm" id="mcp-new">${icon("plus")} Add MCP server</button></div>
  ${S.mcpEdit ? mcpForm(S.mcpEdit, m.nextNum) : ""}
  ${m.servers.map((s) => `<div class="stepcard">
    <div class="row"><span class="kbd">#${s.num}</span><b>${icon("wrench")} ${esc(s.name || s.id)}</b><span class="hint">${esc(s.id)} · ${esc(s.transport)}</span>
      <span class="tag ${MCP_STATUS[s.status] || ""}">${esc(s.status)}</span>${s.tools?.length ? `<span class="hint">${s.tools.length} tools</span>` : ""}
      <span class="spacer"></span>
      <button type="button" class="btn sm ghost" data-mcptest="${esc(s.id)}">${icon("play")} Test</button>
      <button type="button" class="btn sm ghost" data-mcpedit="${esc(s.id)}">${icon("pencil")} Edit</button>
      <button type="button" class="btn sm danger" data-mcpdel="${esc(s.id)}" aria-label="Delete MCP server ${esc(s.id)}">${icon("trash-2")}</button></div>
    <p class="hint">${esc(s.transport === "http" ? s.url : [s.command, ...(s.args || [])].join(" "))}${s.note ? ` — ${esc(s.note)}` : ""}</p>
    ${s.missing?.length ? `<p class="hint">${icon("alert-triangle")} Missing: ${s.missing.map((k) => `<span class="kbd">${esc(k)}</span>`).join(" ")}</p>` : ""}
    ${s.authHint ? `<p class="hint">${icon("info")} ${esc(s.authHint)}</p>` : ""}
    ${s.secrets.map((k) => `<div class="row">${fld(`${k.slot}${k.label ? ` — ${k.label}` : ""} (${k.key})`, `<input data-mcpsec="${esc(s.id)}" data-slot="${esc(k.slot)}" type="password" autocomplete="off" spellcheck="false" placeholder="${k.set ? "•••••• (set — type to replace)" : "not set"}">`, "grow")}
      <span class="tag ${k.set ? "ok" : "bad"}">${k.set ? "set" : "unset"}</span>
      <button type="button" class="btn sm ghost" data-mcpclr="${esc(s.id)}" data-slot="${esc(k.slot)}" ${k.set ? "" : "disabled"} aria-label="Clear ${esc(k.key)}">${icon("x")} Clear</button></div>`).join("")}
    ${s.secrets.length ? `<div class="row"><span class="spacer"></span><button type="button" class="btn sm primary" data-mcpsave="${esc(s.id)}">${icon("save")} Save secrets</button></div>` : ""}
    ${signInBlock(s)}
    <div class="row" role="group" aria-label="Agents allowed to use ${esc(s.id)}"><span class="hint">${icon("bot")} Agents:</span>
      ${agents.map((a) => `<label class="chk"><input type="checkbox" data-mcpgrant="${esc(s.id)}" value="${esc(a.id)}" ${s.agents.includes(a.id) ? "checked" : ""}> ${esc(a.id)}</label>`).join(" ") || `<span class="hint">no agents</span>`}
      <span class="spacer"></span><button type="button" class="btn sm" data-mcpgrantsave="${esc(s.id)}">${icon("save")} Save access</button></div>
    ${s.tools?.length ? `<details><summary class="hint">Tools</summary><p class="hint">${s.tools.map((t) => `<span class="kbd">${esc(t)}</span>`).join(" ")}</p></details>` : ""}
  </div>`).join("") || emptyState("wrench", "No MCP servers", "Add one above.")}`);
}

function secretsTab() {
  const keys = S.cfgEnv;
  if (!keys) return section("Secrets (.env)", `<p class="hint" aria-busy="true">Loading…</p>`);
  const groups = [["discord", "Discord"], ["providers", "Providers"], ["access", "Dashboard access"], ["runtime", "Runtime"]];
  return section("Secrets (.env)", `
  <p class="hint">${icon("shield-check")} Write-only. Secret values are never sent back to the browser — you only see whether they're set. Saved to <span class="kbd">.env</span> (mode 0600) and applied to the running process; the bot token and TZ need a restart. Leave a box empty to keep the current value.</p>
  ${groups.map(([g, label]) => {
    const rows = keys.filter((k) => k.group === g);
    return rows.length ? `<h4>${esc(label)}</h4>${rows.map((k) => `<div class="row">
      ${fld(k.name, `<input data-env="${esc(k.name)}" type="${k.secret ? "password" : "text"}" autocomplete="off" spellcheck="false" placeholder="${k.secret ? (k.set ? "•••••• (set — type to replace)" : "not set") : esc(k.value || "not set")}">`, "grow")}
      <span class="tag ${k.set ? "ok" : "bad"}">${k.set ? "set" : "unset"}</span>${k.source ? `<span class="hint">${esc(k.source)}</span>` : ""}
      <button type="button" class="btn sm ghost" data-envclear="${esc(k.name)}" ${k.set && k.source === ".env" ? "" : "disabled"} aria-label="Clear ${esc(k.name)}">${icon("x")} Clear</button></div>
      <p class="hint">${esc(k.hint || "")}</p>`).join("")}` : "";
  }).join("")}
  <div class="row"><span class="spacer"></span><button type="button" class="btn sm primary" id="env-save">${icon("save")} Save secrets</button></div>`);
}

export function configView() {
  const c = S.cfgData;
  if (!c) return `<div class="card" aria-busy="true"><h3>Configuration</h3><div class="skel" style="height:18px;width:60%"></div><div class="skel" style="height:12px;width:90%"></div><p class="hint">Loading providers, models, prompts…</p></div>`;
  const tab = CFG_TABS.some(([v]) => v === S.cfgTab) ? S.cfgTab : "providers";
  const body = tab === "discord" ? discordTab(c) : tab === "agents" ? agentsTab(c) : tab === "pipelines" ? pipelinesTab() : tab === "mcp" ? mcpTab() : tab === "secrets" ? secretsTab() : providersTab(c);
  return `
  ${pageHead("Configuration", "providers · discord · agents · pipelines · mcp · secrets", S.cfgDirty ? `<span class="tag warn">unsaved changes</span><button type="button" class="btn sm primary" id="cfgsave">${icon("save")} Save</button>` : "")}
  ${S.cfgMsg ? `<div class="notice ${S.cfgErr ? "bad" : "ok"}" role="status">${icon(S.cfgErr ? "alert-triangle" : "check-circle-2")} ${esc(S.cfgMsg)}</div>` : ""}
  ${tabBar()}
  ${body}`;
}

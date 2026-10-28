// Rick setup app — vanilla JS + Vite. No framework, single build artifact.
import "./style.css";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STEPS = [
  { id: "providers", n: "Step 1", t: "Providers" },
  { id: "agents", n: "Step 2", t: "Agents" },
  { id: "tools", n: "Step 3", t: "Tools & MCP" },
  { id: "discord", n: "Step 4", t: "Discord" },
  { id: "automations", n: "Step 5", t: "Automations" },
  { id: "streams", n: "Step 6", t: "Streams" },
  { id: "runs", n: "Step 7", t: "Runs" },
  { id: "verify", n: "Step 8", t: "Verify" },
  { id: "deploy", n: "Step 9", t: "Deploy" },
];

const S = {
  tab: "providers",
  done: new Set(),
  node: null,
  providers: [],
  defaultProvider: "azure",
  agents: [],
  servers: [],
  customTools: [],
  discord: { mainChannelId: "", extraChannels: [], ownerUserId: "", guildId: "" },
  workflows: [],
  streams: [],
  pipelines: [],
  busy: false,
};

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, signal: ctrl.signal, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out — server busy or offline. Try again.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function toast(msg, kind = "ok") {
  $(".toast")?.remove();
  const d = document.createElement("div");
  d.className = `toast ${kind}`;
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4500);
}

// ---------- shell ----------
function render() {
  const doneCount = S.done.size;
  $("#app").innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="logo">🤖</div>
        <div>
          <h1>Rick Setup</h1>
          <p class="sub">Clone → <span class="kbd">npm install</span> → <span class="kbd">npm run setup</span> → you're live.</p>
        </div>
        <div class="spacer"></div>
        ${S.node ? `<span class="pill ${S.node.ok ? "ok" : "bad"}">Node ${esc(S.node.version)} ${S.node.ok ? "✓" : "✗ needs 22+"}</span>` : ""}
      </div>
      <div class="progress"><div style="width:${Math.round((doneCount / STEPS.length) * 100)}%"></div></div>
      <div class="stepper">
        ${STEPS.map((s) => `<button class="step ${S.tab === s.id ? "active" : ""} ${S.done.has(s.id) ? "done" : ""}" data-tab="${s.id}"><span class="n">${s.n}</span><span class="t">${s.t}</span></button>`).join("")}
      </div>
      <div id="panel"></div>
      <div class="footer-nav">
        <button class="btn ghost" id="prev">← Back</button>
        <button class="btn primary" id="next">Continue →</button>
      </div>
    </div>`;
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

function markDone(id) {
  S.done.add(id);
}

// ---------- providers ----------
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

function panelProviders(el) {
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

function panelAgents(el) {
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
function authStatus(s) {
  if (s.authStatus === "ok") return `<span class="tag ok">🔓 connected</span>`;
  if (s.authStatus === "needed") return `<span class="tag bad">🔐 sign-in needed</span>`;
  if (s.tokenEnv) return `<span class="tag ok">🔑 saved</span>`;
  return "";
}
function serverCard(s, i) {
  const needsAuth = s.authStatus === "needed";
  return `
  <div class="card" data-i="${i}" ${needsAuth ? `style="border-color:var(--bad)"` : ""}>
    <h3>${esc(s.id)} <span class="tag">${esc(s.transport)}</span> ${authStatus(s)} ${s.disabled ? `<span class="tag bad">disabled</span>` : ""}</h3>
    ${s.note ? `<p class="desc">${esc(s.note)}</p>` : ""}
    ${needsAuth ? `
    <div class="card" style="border-color:var(--bad)">
      <h3>🔐 Sign in required</h3>
      <p class="desc">${esc(s.authHint || "This server needs you to sign in.")}</p>
      <div class="row">
        <button class="btn primary" data-signin="${i}">Sign in</button>
      </div>
      <div class="hint" data-auth-out></div>
    </div>` : ""}
    <div class="grid">
      <label class="field"><span>name</span><input data-f="id" value="${esc(s.id)}"></label>
      <label class="field"><span>how to run</span><select data-f="transport"><option ${s.transport === "stdio" ? "selected" : ""}>stdio</option><option ${s.transport === "http" ? "selected" : ""}>http</option></select></label>
      <label class="field"><span>command</span><input data-f="command" value="${esc(s.command || "npx")}"></label>
      <label class="field"><span>details</span><input data-f="args" value="${esc((s.args || []).join(" "))}"></label>
      <label class="field" ${s.transport === "http" ? "" : `style="display:none"`}><span>server address</span><input data-f="url" value="${esc(s.url || "")}"></label>
    </div>
    <div class="row">
      <button class="btn danger rm">Remove</button>
      ${s.transport === "http" && !needsAuth ? `<button class="btn ghost sm" data-oauth="${i}">Check sign-in</button>` : ""}
    </div>
    <div class="hint" data-oauth-out></div>
  </div>`;
}

function panelTools(el) {
  // Single chat (VS Code Copilot-style): one thread for everything.
  if (!S.chat) S.chat = [];
  el.innerHTML = `
    <div class="section-head"><h2>Tools & MCP</h2><p>Built-ins always on. Chat below to add anything — sign-in happens right here if needed.</p></div>
    <div class="chat" id="chat"></div>
    <div class="chat-input">
      <textarea id="chat-in" rows="2" placeholder='Try: "add reddit posts" / "connect my gmail" / "my bulb turns on/off"'></textarea>
      <button class="btn primary" id="chat-send">Send</button>
    </div>
    <div class="section-head"><h2>Connected</h2><p>Everything added lives here. <span class="tag bad">sign-in needed</span> means click Sign in on that card.</p></div>
    <div id="slist">${S.servers.map(serverCard).join("") || `<div class="empty">Nothing yet — ask above to add Reddit, Gmail, GitHub…</div>`}</div>
    <div class="row"><button class="btn primary" id="save-s">Save + test all</button></div>
    <div id="sprobe"></div>`;
  renderChat();
  const send = () => {
    const v = $("#chat-in").value.trim();
    if (!v || S.busy) return;
    $("#chat-in").value = "";
    // pending AI-builder questions: treat reply as answers, continue build
    if (S.pendingBuild) {
      const pb = S.pendingBuild;
      S.pendingBuild = null;
      chatContinueBuild(pb.need, [...(pb.answers || []), { q: "user reply", a: v }]);
      return;
    }
    chatAsk(v);
  };
  $("#chat-send").onclick = send;
  $("#chat-in").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  $$("#slist .card").forEach((card) => {
    const rm = $(".rm", card);
    if (rm) rm.onclick = () => { S.servers.splice(+card.dataset.i, 1); render(); };
    const btn = $("[data-signin]", card);
    if (btn) btn.onclick = () => startSignin(+btn.dataset.signin, card);
  });
  $("#save-s").onclick = async () => {
    try {
      $$("#slist .card").forEach((card, i) => {
        $$("[data-f]", card).forEach((inp) => {
          if (inp.dataset.f === "args") S.servers[i].args = inp.value.split(/\s+/).filter(Boolean);
          else S.servers[i][inp.dataset.f] = inp.value;
        });
      });
      const r = await api("/api/tools", { method: "POST", body: JSON.stringify({ servers: S.servers, customTools: S.customTools || [] }) });
      const byId = new Map((r.probes || []).map((pp) => [pp.id, pp]));
      S.servers = S.servers.map((sv) => {
        const pp = byId.get(sv.id);
        if (!pp) return sv;
        return { ...sv, authStatus: pp.authStatus || sv.authStatus, authHint: pp.authHint || sv.authHint, note: pp.note || sv.note };
      });
      const needsAuth = (r.probes || []).filter((pp) => pp.authStatus === "needed");
      $("#sprobe").innerHTML = (r.probes || []).map((pp) => `<div class="status ${pp.ok ? "ok" : "bad"}">${esc(pp.id)}: ${pp.ok ? "✅ " + esc(pp.hint) : pp.authStatus === "needed" ? "🔐 sign-in needed — click Sign in on its card" : "❌ " + esc(pp.hint)}</div>`).join("");
      if (!needsAuth.length) markDone("tools");
      toast(needsAuth.length ? `${needsAuth.length} need sign-in — click Sign in on the card.` : "All connected.");
      render();
    } catch (e) { toast(e.message, "bad"); }
  };
}

// ---------- single chat ----------
function renderChat() {
  const box = $("#chat");
  if (!box) return;
  box.innerHTML = S.chat.map((m) => {
    if (m.role === "user") return `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>`;
    return `<div class="msg ai"><div class="bubble">${m.html}</div>${(m.actions || []).map((a, i) => `<button class="btn ${i === 0 ? "primary" : ""} sm" data-act="${m.id}:${i}">${esc(a.label)}</button>`).join("")}</div>`;
  }).join("");
  $$("#chat [data-act]").forEach((btn) => {
    btn.onclick = () => {
      const [mid, ai] = btn.dataset.act.split(":");
      const m = S.chat.find((x) => String(x.id) === String(mid));
      if (m && m.actions[+ai]) m.actions[+ai].fn();
    };
  });
  box.scrollTop = box.scrollHeight;
}
function chatMsg(role, textOrHtml, isHtml = false, actions = []) {
  const m = { id: Date.now() + Math.random().toString(16).slice(2), role, text: isHtml ? "" : textOrHtml, html: isHtml ? textOrHtml : esc(textOrHtml), actions };
  S.chat.push(m);
  renderChat();
  return m;
}
async function chatAsk(text) {
  chatMsg("user", text);
  const thinking = chatMsg("ai", "Thinking…");
  S.busy = true;
  try {
    // 1. try MCP resolve first (add something)
    let resolved = null;
    try {
      const r = await api("/api/mcp/resolve", { method: "POST", body: JSON.stringify({ query: text }) });
      if ((r.candidates || []).length) resolved = r;
    } catch { /* fall through to builder */ }
    if (resolved && resolved.candidates.length) {
      S.chat = S.chat.filter((m) => m !== thinking);
      const cands = resolved.candidates.slice(0, 3);
      chatMsg("ai", `Found ${cands.length} option(s) for "<b>${esc(text)}</b>" — pick one:`, true, cands.map((c) => ({
        label: c.id === cands[0].id ? `Add ${c.id}` : c.id,
        fn: async () => {
          try {
            const added = await api("/api/mcp/add", { method: "POST", body: JSON.stringify({ candidate: c }) });
            S.servers = added.servers;
            markDone("tools");
            chatMsg("ai", added.needsAuth ? `Added <b>${esc(c.id)}</b> — it needs sign-in. Click <b>Sign in</b> on its card below.` : `Added <b>${esc(c.id)}</b> — working ✅`, true);
            render();
          } catch (e) { chatMsg("ai", "❌ " + esc(e.message)); }
        },
      })));
      S.busy = false;
      renderChat();
      return;
    }
    // 2. fall back to AI tool builder
    S.chat = S.chat.filter((m) => m !== thinking);
    const t = chatMsg("ai", `No ready-made connector found. Asking the AI to build one for "<b>${esc(text)}</b>"…`, true);
    try {
      const r = await api("/api/tools/build", { method: "POST", body: JSON.stringify({ need: text }) });
      if (r.status === "ready") {
        t.html = `Built <b>${esc(r.tool.id)}</b> — test passed ✅<br><span class="hint">${esc((r.research || "").slice(0, 200))}</span>`;
        t.actions = [{ label: `Save ${r.tool.id}`, fn: async () => {
          S.customTools = [...(S.customTools || []).filter((x) => x.id !== r.tool.id), r.tool];
          await api("/api/tools", { method: "POST", body: JSON.stringify({ customTools: S.customTools }) });
          markDone("tools");
          chatMsg("ai", `Saved <b>custom_${esc(r.tool.id)}</b>. Assign it to agents in Step 2.`, true);
          render();
        } }];
      } else if (r.status === "failed") {
        t.html = `Tried 3 times, still failing: ${esc(String(r.testOutput).slice(0, 300))}<br><span class="hint">${esc(r.hint || "")}</span>`;
      } else {
        const qs = (r.questions || []).map((qq) => typeof qq === "string" ? qq : (qq.q + (qq.how ? ` (${qq.how})` : ""))).join("<br>• ");
        t.html = `Need a few details before I build this:<br>• ${qs}${r.research ? `<br><span class="hint">Found so far: ${esc(String(r.research).slice(0, 200))}</span>` : ""}<br><span class="hint">Reply below and I'll continue.</span>`;
        t.actions = [];
        S.pendingBuild = { need: text, answers: [] };
      }
    } catch (e) { t.html = "❌ " + esc(e.message); }
  } catch (e) {
    S.chat = S.chat.filter((m) => m !== thinking);
    chatMsg("ai", "❌ " + esc(e.message));
  }
  S.busy = false;
  renderChat();
}
/** Continue a pending AI build with user-supplied answers (chat reply). */
async function chatContinueBuild(need, answers) {
  chatMsg("user", answers.map((a) => a.a).join(" "));
  const thinking = chatMsg("ai", "Continuing with your answers…");
  S.busy = true;
  try {
    const r = await api("/api/tools/build", { method: "POST", body: JSON.stringify({ need, answers }) });
    S.chat = S.chat.filter((m) => m !== thinking);
    if (r.status === "ready") {
      const t = chatMsg("ai", `Built <b>${esc(r.tool.id)}</b> — test passed ✅<br><span class="hint">${esc((r.research || "").slice(0, 200))}</span>`, true);
      t.actions = [{ label: `Save ${r.tool.id}`, fn: async () => {
        S.customTools = [...(S.customTools || []).filter((x) => x.id !== r.tool.id), r.tool];
        await api("/api/tools", { method: "POST", body: JSON.stringify({ customTools: S.customTools }) });
        markDone("tools");
        chatMsg("ai", `Saved <b>custom_${esc(r.tool.id)}</b>. Assign it to agents in Step 2.`, true);
        render();
      } }];
    } else if (r.status === "failed") {
      chatMsg("ai", `Tried 3 times, still failing: ${esc(String(r.testOutput).slice(0, 300))}<br><span class="hint">${esc(r.hint || "")}</span>`, true);
    } else {
      const qs = (r.questions || []).map((qq) => typeof qq === "string" ? qq : (qq.q + (qq.how ? ` (${qq.how})` : ""))).join("<br>• ");
      chatMsg("ai", `Still need a bit more:<br>• ${qs}<br><span class="hint">Reply below and I'll continue.</span>`, true);
      S.pendingBuild = { need, answers };
    }
  } catch (e) {
    S.chat = S.chat.filter((m) => m !== thinking);
    chatMsg("ai", "❌ " + esc(e.message));
  }
  S.busy = false;
  renderChat();
}
async function startSignin(idx, card) {
  const out = $("[data-auth-out]", card);
  out.innerHTML = `<span class="hint">🔍 Checking what sign-in this needs…</span>`;
  try {
    const info = await api("/api/mcp/auth-info", { method: "POST", body: JSON.stringify({ id: S.servers[idx].id }) });
    const kind = info.kind;
    if (kind === "none") { out.innerHTML = `<span class="hint">No sign-in needed.</span>`; return; }
    if (kind === "oauth-proxy") {
      // VS Code-style: one button, browser login, no keys to copy
      out.innerHTML = `
        <p class="desc">${esc(info.title || "Sign in to connect.")}</p>
        <div class="row"><button class="btn primary" data-proxy-go>Sign in with Google</button></div>
        ${info.helpUrl ? `<div class="hint"><a href="${esc(info.helpUrl)}" target="_blank" rel="noopener">How does this work?</a></div>` : ""}`;
      $("[data-proxy-go]", out).onclick = async () => {
        out.innerHTML = `<span class="hint">🔐 Opening Google sign-in…</span>`;
        try {
          const r = await api("/api/mcp/proxy-auth", { method: "POST", body: JSON.stringify({ id: S.servers[idx].id }) });
          out.innerHTML = `<div class="status ok">✅ <a href="${esc(r.authorizeUrl)}" target="_blank" rel="noopener">Click here to sign in with Google</a></div><div class="hint">Approve in the new tab, then come back — this card turns green automatically. No keys to copy.</div>`;
          window.open(r.authorizeUrl, "_blank");
          for (let i = 0; i < 40; i++) {
            await new Promise((res) => setTimeout(res, 3000));
            try {
              const st = await api(`/api/mcp/auth-status?id=${encodeURIComponent(S.servers[idx].id)}`);
              if (st.authed) { S.servers = st.servers; toast("Signed in — working."); render(); return; }
            } catch { /* keep polling */ }
          }
          out.innerHTML += `<div class="hint">Still waiting — if you approved already, click Save + test all.</div>`;
        } catch (e) {
          // First-time Google setup: one-time client ID, then forever one-click
          if (String(e.message).includes("NEED_GOOGLE_CLIENT")) {
            out.innerHTML = `
              <p class="desc">One-time setup (2 min, sirf pehli baar). Google Cloud Console me ek OAuth client banao:</p>
              <pre class="out">1. console.cloud.google.com → APIs & Services → Credentials
2. Create Credentials → OAuth client ID → Desktop app
3. Gmail API enable karo (APIs & Services → Library → Gmail API)
4. Neeche Client ID + secret paste karo</pre>
              <label class="field"><span>Google Client ID</span><input data-gid placeholder="...apps.googleusercontent.com"></label>
              <label class="field"><span>Google Client secret</span><input data-gsec type="password" placeholder="GOCSPX-..."></label>
              <div class="row"><button class="btn primary" data-gsave>Save + continue to sign in</button></div>`;
            $("[data-gsave]", out).onclick = async () => {
              const gid = $("[data-gid]", out).value.trim();
              const gsec = $("[data-gsec]", out).value.trim();
              if (!gid) { toast("Client ID paste karo.", "bad"); return; }
              try {
                await api("/api/mcp/save-creds", { method: "POST", body: JSON.stringify({ id: S.servers[idx].id,
                  creds: { GOOGLE_OAUTH_CLIENT_ID: gid, ...(gsec ? { GOOGLE_OAUTH_CLIENT_SECRET: gsec } : {}) } }) });
                toast("Saved — ab Sign in dabao.");
                startSignin(idx, card);
              } catch (err) { out.innerHTML = `<div class="hint">❌ ${esc(err.message)}</div>`; }
            };
            return;
          }
          out.innerHTML = `<div class="hint">❌ ${esc(e.message)}</div>`;
        }
      };
      return;
    }
    if (kind === "creds") {
      out.innerHTML = `
        <p class="desc">${esc(info.title || "Enter the details from the service.")}</p>
        ${(info.fields || []).map((f) => `<label class="field"><span>${esc(f.label)}</span><input data-cred="${esc(f.key)}" type="${f.secret ? "password" : "text"}" placeholder="${esc(f.hint || "")}"></label>`).join("")}
        ${info.helpUrl ? `<div class="hint"><a href="${esc(info.helpUrl)}" target="_blank" rel="noopener">Where do I find these?</a></div>` : ""}
        <div class="row"><button class="btn primary" data-save-creds>Save + test</button></div>`;
      $("[data-save-creds]", out).onclick = async () => {
        const creds = {};
        $$("[data-cred]", out).forEach((inp) => { creds[inp.dataset.cred] = inp.value.trim(); });
        out.innerHTML = `<span class="hint">Testing…</span>`;
        try {
          const r = await api("/api/mcp/save-creds", { method: "POST", body: JSON.stringify({ id: S.servers[idx].id, creds }) });
          S.servers = r.servers;
          toast(r.ok ? "Signed in — working." : (r.hint || "Saved — check status."));
          render();
        } catch (e) { out.innerHTML = `<span class="hint">❌ ${esc(e.message)}</span>`; }
      };
      return;
    }
    out.innerHTML = `<span class="hint">📝 Preparing sign-in…</span>`;
    const reg = await api("/api/mcp/prepare-auth", { method: "POST", body: JSON.stringify({ id: S.servers[idx].id }) });
    if (reg.manual) {
      out.innerHTML = `<div class="status warn">This service needs a one-time app setup (30 sec):</div>
        <pre class="out">${esc(reg.instructions)}</pre>
        <label class="field"><span>Paste the ID it gives you</span><input data-manual-id placeholder="client id"></label>
        <div class="row"><button class="btn primary" data-manual-go>Continue to sign in</button></div>`;
      $("[data-manual-go]", out).onclick = async () => {
        const clientId = $("[data-manual-id]", out).value.trim();
        if (!clientId) { toast("Paste the ID first.", "bad"); return; }
        await openAuth(idx, out, clientId);
      };
      return;
    }
    await openAuth(idx, out, reg.clientId, reg.clientSecret);
  } catch (e) { out.innerHTML = `<span class="hint">❌ ${esc(e.message)}</span>`; }
}
async function openAuth(idx, out, clientId, clientSecret = "") {
  out.innerHTML = `<span class="hint">🔐 Opening sign-in…</span>`;
  try {
    const r = await api("/api/mcp/authorize", { method: "POST", body: JSON.stringify({ id: S.servers[idx].id, clientId, clientSecret }) });
    out.innerHTML = `<div class="status ok">✅ <a href="${esc(r.authorizeUrl)}" target="_blank" rel="noopener">Click here to sign in</a></div><div class="hint">Approve in the new tab, then come back — this card will turn green automatically.</div>`;
    window.open(r.authorizeUrl, "_blank");
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      try {
        const st = await api(`/api/mcp/auth-status?id=${encodeURIComponent(S.servers[idx].id)}`);
        if (st.authed) {
          S.servers = st.servers;
          toast("Signed in — working.");
          render();
          return;
        }
      } catch { /* keep polling */ }
    }
    out.innerHTML += `<div class="hint">Still waiting — if you approved already, click Save + test all.</div>`;
  } catch (e) { out.innerHTML = `<span class="hint">❌ ${esc(e.message)}</span>`; }
}

// ---------- discord ----------
function panelDiscord(el) {
  el.innerHTML = `
    <div class="section-head"><h2>Discord</h2><p>Token → guild → channels → owner. Probe message confirms send permission.</p></div>
    <div class="card">
      <label class="field"><span>bot token <span class="hint">(→ .env, blank = keep)</span></span><input id="d-token" type="password" placeholder="paste token"></label>
      <div class="row"><button class="btn" id="d-load">Load guilds</button><span id="d-me" class="hint"></span></div>
      <div class="grid">
        <label class="field"><span>guild</span><select id="d-guild"></select></label>
        <label class="field"><span>&nbsp;</span><span><button class="btn" id="d-ch">Load channels</button></span></label>
        <label class="field"><span>main channel</span><select id="d-main"></select></label>
        <label class="field"><span>extra channel ids</span><input id="d-extra" value="${esc((S.discord.extraChannels || []).join(", "))}" placeholder="id1, id2"></label>
        <label class="field"><span>owner user id <span class="hint">(only approver)</span></span><input id="d-owner" value="${esc(S.discord.ownerUserId || "")}" placeholder="right-click user → Copy ID"></label>
      </div>
      <div class="row"><button class="btn primary" id="d-save">Save + send probe</button></div>
      <div id="d-probe"></div>
    </div>`;
  $("#d-load").onclick = async () => {
    try {
      const r = await api("/api/discord/guilds");
      $("#d-me").textContent = `Bot: ${r.me.username} (${r.me.id})`;
      $("#d-guild").innerHTML = r.guilds.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("");
      if (S.discord.guildId) $("#d-guild").value = S.discord.guildId;
    } catch (e) { toast(e.message, "bad"); }
  };
  $("#d-ch").onclick = async () => {
    try {
      const r = await api(`/api/discord/channels?guild=${$("#d-guild").value}`);
      $("#d-main").innerHTML = r.channels.map((c) => `<option value="${c.id}">#${esc(c.name)}</option>`).join("");
      if (S.discord.mainChannelId) $("#d-main").value = S.discord.mainChannelId;
    } catch (e) { toast(e.message, "bad"); }
  };
  $("#d-save").onclick = async () => {
    try {
      const r = await api("/api/discord", { method: "POST", body: JSON.stringify({
        token: $("#d-token").value || undefined,
        mainChannelId: $("#d-main").value,
        extraChannels: $("#d-extra").value.split(",").map((s) => s.trim()).filter(Boolean),
        ownerUserId: $("#d-owner").value,
        guildId: $("#d-guild").value,
      }) });
      $("#d-probe").innerHTML = r.probe ? `<div class="status ${r.probe.ok ? "ok" : "bad"}">${r.probe.ok ? "✅ Probe message sent" : "❌ " + esc(r.probe.hint)}</div>` : "";
      markDone("discord");
      toast("Discord saved.");
    } catch (e) { toast(e.message, "bad"); }
  };
}

// ---------- automations (reference: Edit-flow palette) ----------
const FLOW_TYPES = [
  { id: "run_agent", label: "Run agent", desc: "Agent step, JSON output persisted" },
  { id: "create_task", label: "Create task", desc: "Agent JSON → persisted tasks" },
  { id: "file_request", label: "File request", desc: "File a request / reminder" },
  { id: "notify", label: "Notify", desc: "Tell the operator (Discord)" },
  { id: "condition", label: "Condition", desc: "Continue or stop on a rule" },
  { id: "run_automation", label: "Run automation", desc: "Call another flow" },
  { id: "wait", label: "Wait", desc: "Pause before the next step" },
];
const STEP_TYPES = [
  ...FLOW_TYPES,
  { id: "agent", label: "🤖 Agent", desc: "Run an agent, optionally as JSON vars" },
  { id: "discord_send", label: "💬 Discord msg", desc: "Post to the main channel" },
  { id: "subflow", label: "🔁 Subflow", desc: "Call another workflow" },
  { id: "transform", label: "✏️ Transform", desc: "Build text from variables" },
  { id: "delay", label: "⏳ Delay", desc: "Wait N ms" },
  { id: "http", label: "🌐 HTTP", desc: "GET/POST a URL" },
  { id: "web", label: "🔍 Web", desc: "Search / news / fetch" },
  { id: "finance", label: "📈 Finance", desc: "Market briefing" },
  { id: "remember", label: "🧠 Remember", desc: "Save to memory" },
  { id: "recall", label: "🔎 Recall", desc: "Search memory" },
  { id: "log", label: "📝 Log", desc: "Log a line" },
];

const stepLabel = (t) => STEP_TYPES.find((s) => s.id === t)?.label || t;

/** Variables available at a step index: trigger.* + outputs of earlier steps. */
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

function panelAutomations(el) {
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

function panelStreams(el) {
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
function panelRuns(el) {
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
function panelVerify(el) {
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

function renderPanel() {
  const el = $("#panel");
  ({ providers: panelProviders, agents: panelAgents, tools: panelTools, discord: panelDiscord, automations: panelAutomations, streams: panelStreams, runs: panelRuns, verify: panelVerify, deploy: panelDeploy })[S.tab](el);
}

// ---------- deploy (setup factory -> headless home) ----------
function panelDeploy(el) {
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
    $("#app").innerHTML = `<div class="shell"><div class="status bad">Failed to load setup state: ${esc(e.message)}. Is the setup server running?</div></div>`;
  }
})();

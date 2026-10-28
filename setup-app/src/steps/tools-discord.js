// Setup step: tools + discord. Render + save logic for one wizard step.
import { S, $, $$, esc, api, toast, markDone } from "./state.js";
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

export function panelTools(el) {
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

export function panelDiscord(el) {
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


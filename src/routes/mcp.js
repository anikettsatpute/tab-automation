// Control routes: MCP servers — register, secrets (.env, write-only), OAuth sign-in,
// test (tools/list), and which agents may use each server.
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { atomicWrite } from "../loop/workspace.js";
import { writeEnv, validateEnvValue } from "../services/envfile.js";
import {
  MCP_ID_RE, SLOT_RE, readTools, writeTools, listServers, publicServer, secretKey,
  serverRefs, refAllowed, probeServer, saveTokens, ensureFreshToken,
} from "../services/mcp.js";

const OAUTH_SLOTS = new Set(["ACCESS_TOKEN", "REFRESH_TOKEN", "EXPIRES_AT", "CLIENT_ID", "CLIENT_SECRET"]);
const LITERAL_SECRET_RE = /^(Bearer|Basic|token)\s+[^$]|^(sk-|ghp_|gho_|github_pat_|xox[baprs]-|AIza|eyJ)/i;
const oauthSessions = new Map(); // state -> { id, verifier, redirectUri, tokenEndpoint, at }

const agentsPath = (root) => path.join(root, "config", "agents.json");
function readAgents(root) {
  const p = agentsPath(root);
  if (!existsSync(p)) return { agents: [] };
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { agents: [] }; }
}

export function validateServer(s) {
  if (!MCP_ID_RE.test(String(s.id || ""))) return "id must be lowercase letters/digits/-/_ (max 40)";
  if (s.transport === "http") {
    let u; try { u = new URL(String(s.url || "")); } catch { return "url must be a valid http(s) URL"; }
    if (!/^https?:$/.test(u.protocol)) return "url must be http(s)";
    if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return "plain http is only allowed for localhost";
  } else {
    if (!/^[A-Za-z0-9_./@+-]{1,200}$/.test(String(s.command || ""))) return "command required (single executable, e.g. npx)";
    if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string" || a.length > 500)) return "args must be a list of strings";
  }
  for (const field of ["env", "headers"]) {
    const o = s[field] || {};
    if (typeof o !== "object" || Array.isArray(o)) return `${field} must be an object`;
    for (const [k, v] of Object.entries(o)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(k)) return `${field} name '${k}' invalid`;
      if (typeof v !== "string" || v.length > 2000) return `${field}.${k} must be a string`;
      if (LITERAL_SECRET_RE.test(v)) return `${field}.${k} looks like a literal secret — add a secret slot and reference it as \${MCP_${s.num}_<SLOT>}`;
    }
  }
  for (const sl of s.secrets || []) if (!SLOT_RE.test(String(sl.slot || ""))) return `secret slot '${sl.slot}' must be UPPER_SNAKE`;
  const bad = serverRefs(s).filter((r) => !refAllowed(s, r));
  if (bad.length) return `cannot reference ${bad.join(", ")} — use this server's own MCP_${s.num}_* slots`;
  return null;
}

function baseUrl(c) {
  const host = c.req.header("host") || "localhost:3001";
  const proto = c.req.header("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

export function registerMcpRoutes(app, ctx) {
  const { root, cfg } = ctx;
  const guard = async (c) => {
    const { mutationGuard, originCheck } = await import("../services/access.js");
    const o = originCheck(c); if (!o.ok) return c.json({ error: o.error }, o.status);
    const g = mutationGuard(c); return g.ok ? null : c.json({ error: g.error }, g.status);
  };
  const audit = async (c, action, target, detail = "") => {
    const { auditActor } = await import("../services/access.js");
    const { audit: a } = await import("../db.js");
    try { a(root, { actor: auditActor(c), action, target, detail }); } catch {}
  };
  const view = () => {
    const agents = readAgents(root).agents || [];
    const servers = listServers(root);
    const nextNum = Math.max(0, Number(readTools(root).mcpNextNum) || 0, ...servers.map((s) => Number(s.num) || 0)) + 1;
    return { ok: true, nextNum, servers: servers.map((s) => publicServer(s, agents)), agents: agents.map((a) => ({ id: a.id, description: a.description || "", mcp: a.mcp || [] })) };
  };
  const find = (id) => {
    listServers(root);
    const doc = readTools(root);
    return { doc, s: (doc.servers || []).find((x) => x.id === id) || null };
  };
  const setGrants = (serverId, agentIds) => {
    const doc = readAgents(root);
    for (const a of doc.agents || []) {
      const cur = new Set(a.mcp || []);
      if (agentIds.includes(a.id)) cur.add(serverId); else cur.delete(serverId);
      if (cur.size) a.mcp = [...cur]; else delete a.mcp;
    }
    atomicWrite(agentsPath(root), JSON.stringify(doc, null, 2) + "\n");
    if (cfg.agents instanceof Map) for (const a of doc.agents || []) { const live = cfg.agents.get(a.id); if (live) { if (a.mcp) live.mcp = a.mcp; else delete live.mcp; } }
  };

  app.get("/api/control/mcp", (c) => {
    try { return c.json(view()); } catch (e) { return c.json({ error: e.message }, 500); }
  });

  // Create or update. Secret VALUES are never accepted here — only slot names.
  app.post("/api/control/mcp", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const b = await c.req.json().catch(() => ({}));
      const servers = listServers(root);
      const doc = readTools(root);
      const prev = (doc.servers || []).find((x) => x.id === b.id);
      if (b._new && prev) return c.json({ error: `server '${b.id}' already exists` }, 409);
      const num = prev?.num || (Math.max(0, Number(doc.mcpNextNum) || 0, ...servers.map((x) => Number(x.num) || 0)) + 1);
      const s = {
        ...(prev || {}), num, id: String(b.id || "").trim(), name: String(b.name || "").slice(0, 80), note: String(b.note || "").slice(0, 300),
        transport: b.transport === "http" ? "http" : "stdio",
        env: b.env || {}, headers: b.transport === "http" ? b.headers || {} : {},
        secrets: (b.secrets || []).map((x) => ({ slot: String(x.slot || "").trim().toUpperCase(), label: String(x.label || "").slice(0, 80) })).filter((x) => x.slot),
        enabled: b.enabled !== false,
      };
      // Shorthand: ${SLOT} for a declared slot -> ${MCP_<num>_SLOT}.
      const declared = new Set(s.secrets.map((x) => x.slot));
      for (const field of ["env", "headers"]) {
        if (!s[field] || typeof s[field] !== "object" || Array.isArray(s[field])) continue;
        s[field] = Object.fromEntries(Object.entries(s[field]).map(([k, v]) => [k, typeof v === "string" ? v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (m, n) => (declared.has(n) ? `\${${secretKey(num, n)}}` : m)) : v]));
      }
      if (s.transport === "http") { s.url = String(b.url || "").trim(); delete s.command; delete s.args; }
      else { s.command = String(b.command || "").trim(); s.args = Array.isArray(b.args) ? b.args.map(String) : []; delete s.url; }
      const err = validateServer(s);
      if (err) return c.json({ error: err }, 400);
      if (!prev || prev.command !== s.command || JSON.stringify(prev.args) !== JSON.stringify(s.args) || prev.url !== s.url) { delete s.authStatus; s.authHint = ""; }
      doc.servers = prev ? doc.servers.map((x) => (x.id === s.id ? s : x)) : [...(doc.servers || []), s];
      doc.mcpNextNum = Math.max(Number(doc.mcpNextNum) || 0, num);
      writeTools(root, doc);
      await audit(c, prev ? "mcp.update" : "mcp.add", s.id, `#${num}`);
      return c.json(view());
    } catch (e) { return c.json({ error: e.message }, 500); }
  });

  app.delete("/api/control/mcp/:id", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const { doc, s } = find(c.req.param("id"));
      if (!s) return c.json({ error: "unknown server" }, 404);
      doc.servers = doc.servers.filter((x) => x.id !== s.id);
      writeTools(root, doc);
      const prefix = `MCP_${s.num}_`;
      const clear = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith(prefix)).map((k) => [k, null]));
      if (Object.keys(clear).length) writeEnv(root, clear);
      setGrants(s.id, []);
      await audit(c, "mcp.delete", s.id, `#${s.num}`);
      return c.json(view());
    } catch (e) { return c.json({ error: e.message }, 500); }
  });

  // Write-only secrets: { set: { SLOT: value }, clear: [SLOT] } -> .env MCP_<num>_<SLOT>.
  app.post("/api/control/mcp/:id/secrets", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const { s } = find(c.req.param("id"));
      if (!s) return c.json({ error: "unknown server" }, 404);
      const b = await c.req.json().catch(() => ({}));
      const slots = new Set([...(s.secrets || []).map((x) => x.slot), ...OAUTH_SLOTS]);
      const changes = {};
      for (const [slot, value] of Object.entries(b.set || {})) {
        if (!slots.has(slot)) return c.json({ error: `unknown slot ${slot}` }, 400);
        const err = validateEnvValue(value);
        if (err || !String(value)) return c.json({ error: `${slot}: ${err || "empty"}` }, 400);
        changes[secretKey(s.num, slot)] = String(value);
      }
      for (const slot of Array.isArray(b.clear) ? b.clear : []) {
        if (!slots.has(slot)) return c.json({ error: `unknown slot ${slot}` }, 400);
        changes[secretKey(s.num, slot)] = null;
      }
      if (!Object.keys(changes).length) return c.json({ error: "nothing to change" }, 400);
      writeEnv(root, changes);
      await audit(c, "mcp.secrets", s.id, Object.keys(changes).map((k) => `${changes[k] === null ? "-" : "+"}${k}`).join(","));
      return c.json(view());
    } catch (e) { return c.json({ error: e.message }, 500); }
  });

  app.post("/api/control/mcp/:id/test", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const { doc, s } = find(c.req.param("id"));
      if (!s) return c.json({ error: "unknown server" }, 404);
      await ensureFreshToken(root, s);
      const { buildChildEnv } = await import("../services/runner.js");
      const p = await probeServer(s, { baseEnv: buildChildEnv(cfg) });
      let oauth = null;
      if (!p.ok && p.authRequired && s.transport === "http") {
        const { discoverOAuth } = await import("../oauth.js");
        const d = await discoverOAuth(s.url).catch(() => null);
        if (d?.asMetadata) oauth = { dcr: !!d.dcrSupported, authorizationEndpoint: d.asMetadata.authorization_endpoint, tokenEndpoint: d.asMetadata.token_endpoint };
      }
      s.authStatus = p.ok ? "ok" : p.authRequired ? "needed" : "error";
      s.authHint = p.ok ? "" : p.hint || "";
      s.tools = p.tools || [];
      s.lastTestedAt = new Date().toISOString();
      writeTools(root, doc);
      return c.json({ ...view(), test: { ok: p.ok, tools: p.tools || [], hint: p.hint || "", oauth } });
    } catch (e) { return c.json({ error: e.message }, 500); }
  });

  // Grant: which agents may use this server.
  app.post("/api/control/mcp/:id/agents", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const { s } = find(c.req.param("id"));
      if (!s) return c.json({ error: "unknown server" }, 404);
      const b = await c.req.json().catch(() => ({}));
      const known = new Set((readAgents(root).agents || []).map((a) => a.id));
      const ids = (Array.isArray(b.agents) ? b.agents : []).map(String);
      const bad = ids.filter((x) => !known.has(x));
      if (bad.length) return c.json({ error: `unknown agent ${bad.join(", ")}` }, 400);
      setGrants(s.id, ids);
      await audit(c, "mcp.grant", s.id, ids.join(",") || "(none)");
      return c.json(view());
    } catch (e) { return c.json({ error: e.message }, 500); }
  });

  // OAuth (HTTP servers): discover -> DCR or provided client -> PKCE authorize URL.
  app.post("/api/control/mcp/:id/oauth/start", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const { doc, s } = find(c.req.param("id"));
      if (!s) return c.json({ error: "unknown server" }, 404);
      if (s.transport !== "http") return c.json({ error: "OAuth sign-in is for HTTP servers; stdio servers use secret slots" }, 400);
      const b = await c.req.json().catch(() => ({}));
      const { discoverOAuth, dynamicRegister, pkcePair, newState, buildAuthorizeUrl } = await import("../oauth.js");
      const d = await discoverOAuth(s.url);
      if (!d.asMetadata?.authorization_endpoint || !d.asMetadata?.token_endpoint) return c.json({ error: "server does not advertise OAuth — use a secret slot (API key / PAT) instead" }, 400);
      const redirectUri = `${baseUrl(c)}/api/control/mcp/oauth/callback`;
      const env = (k) => String(process.env[secretKey(s.num, k)] || "").trim();
      let clientId = String(b.clientId || "").trim() || env("CLIENT_ID");
      let clientSecret = String(b.clientSecret || "").trim() || env("CLIENT_SECRET");
      if (b.clientId) { clientSecret = String(b.clientSecret || "").trim(); }
      if (!clientId) {
        if (!d.dcrSupported) return c.json({ error: "NEED_CLIENT", hint: `This provider needs an OAuth app. Create one with redirect URI ${redirectUri}, then paste its Client ID (and secret if any).`, redirectUri }, 400);
        const reg = await dynamicRegister(d.asMetadata.registration_endpoint, { clientName: `tab-automation-${s.id}`, redirectUris: [redirectUri], scope: String(b.scope || "") });
        clientId = reg.client_id; clientSecret = reg.client_secret || "";
      }
      writeEnv(root, { [secretKey(s.num, "CLIENT_ID")]: clientId, [secretKey(s.num, "CLIENT_SECRET")]: clientSecret || null });
      s.oauth = { authorizationEndpoint: d.asMetadata.authorization_endpoint, tokenEndpoint: d.asMetadata.token_endpoint, scope: String(b.scope || s.oauth?.scope || "") };
      s.headers = { ...(s.headers || {}), Authorization: `Bearer \${${secretKey(s.num, "ACCESS_TOKEN")}}` };
      writeTools(root, doc);
      const { verifier, challenge } = pkcePair();
      const state = newState();
      for (const [k, v] of oauthSessions) if (Date.now() - v.at > 15 * 60000) oauthSessions.delete(k);
      oauthSessions.set(state, { id: s.id, verifier, redirectUri, tokenEndpoint: s.oauth.tokenEndpoint, at: Date.now() });
      const authorizeUrl = buildAuthorizeUrl(d.asMetadata, { clientId, redirectUri, scope: s.oauth.scope, state, codeChallenge: challenge, resource: s.url });
      await audit(c, "mcp.oauth.start", s.id, d.dcrSupported && !b.clientId ? "dcr" : "client");
      return c.json({ ok: true, authorizeUrl, redirectUri });
    } catch (e) { return c.json({ error: String(e.message).slice(0, 300) }, 500); }
  });

  // Provider redirects here (top-level GET: session cookie is SameSite=Lax, so it is sent).
  app.get("/api/control/mcp/oauth/callback", async (c) => {
    const page = (title, msg, status = 200) => c.html(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h2>${title}</h2><p>${msg}</p><p><a href="/dashboard">Back to dashboard</a></p><script>setTimeout(()=>{try{window.close()}catch{}},1500)</script>`, status);
    const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const state = c.req.query("state") || "";
    const sess = oauthSessions.get(state);
    if (c.req.query("error")) return page("Sign-in denied", esc(`${c.req.query("error")}: ${c.req.query("error_description") || ""}`), 400);
    if (!sess || !c.req.query("code")) return page("Sign-in expired", "Unknown or expired sign-in. Start again from the dashboard.", 400);
    oauthSessions.delete(state);
    try {
      const { doc, s } = find(sess.id);
      if (!s) return page("Server removed", "That MCP server no longer exists.", 404);
      const { exchangeCode } = await import("../oauth.js");
      const env = (k) => String(process.env[secretKey(s.num, k)] || "").trim();
      const t = await exchangeCode(sess.tokenEndpoint, { code: c.req.query("code"), redirectUri: sess.redirectUri, verifier: sess.verifier, clientId: env("CLIENT_ID"), clientSecret: env("CLIENT_SECRET") });
      saveTokens(root, s, t);
      s.authStatus = "ok"; s.authHint = "";
      writeTools(root, doc);
      await audit(c, "mcp.oauth.done", s.id, t.refresh_token ? "with refresh" : "no refresh");
      return page("Signed in", `${esc(s.name || s.id)} is connected. Token saved as <code>${secretKey(s.num, "ACCESS_TOKEN")}</code>${t.refresh_token ? " (auto-refresh on)" : ""}. You can close this tab.`);
    } catch (e) { return page("Sign-in failed", esc(String(e.message).slice(0, 300)), 502); }
  });

  app.post("/api/control/mcp/:id/oauth/refresh", async (c) => {
    const denied = await guard(c); if (denied) return denied;
    try {
      const { s } = find(c.req.param("id"));
      if (!s?.oauth) return c.json({ error: "not an OAuth server" }, 400);
      const r = await ensureFreshToken(root, s, { force: true });
      if (!r.ok) return c.json({ error: r.error }, 400);
      return c.json(view());
    } catch (e) { return c.json({ error: e.message }, 500); }
  });
}

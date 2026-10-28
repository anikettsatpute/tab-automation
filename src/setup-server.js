// Setup server on Hono: JSON API (config read/write, live probes, run history
// from SQLite) + serves the Vite-built UI from dist-setup/.
// Started by `npm run setup`. Stack: Hono (API) + Vite (UX) + node:sqlite (storage).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  root, loadJson, saveJson, readEnv, writeEnv, getState,
  testProvider, probeMcpStdio, discordFetch, validateOutputSchema,
  tabletStatus, pullTabletDb, tabletDbPath,
} from "./setup-api.js";
import {
  discoverOAuth, dynamicRegister, pkcePair, newState, buildAuthorizeUrl,
  exchangeCode, refreshAccessToken, probeMcpHttp,
} from "./oauth.js";
import { listRuns, getRun, pruneRuns, pendingApprovals, listAutomations, getAutomation, saveAutomation, deleteAutomation, setAutomationEnabled } from "./db.js";
import { getDashboardConfig, saveDashboardConfig } from "./dashboard-db.js";
import { validateCustomTool, runCustomTool } from "./custom-tools.js";
import { chatWithTools } from "./agent.js";
import { loadConfig } from "./config.js";

const app = new Hono();

// ---- API: state ----
app.get("/api/state", (c) => c.json(getState()));

// ---- API: providers ----
app.post("/api/providers", async (c) => {
  const { providers, defaultProvider, keys } = await c.req.json().catch(() => ({}));
  if (keys) writeEnv(keys);
  const { config: loadEnv } = await import("dotenv");
  loadEnv({ path: path.join(root, ".env"), override: true });
  saveJson("config/providers.json", { defaultProvider, providers });
  const results = [];
  for (const p of providers ?? []) {
    const key = (process.env[p.keyEnv] ?? "").trim();
    if (!key) { results.push({ id: p.id, ok: false, hint: "no key in env" }); continue; }
    try {
      results.push({ id: p.id, ...(await testProvider(p, key)) });
    } catch (err) {
      results.push({ id: p.id, ok: false, hint: err.message });
    }
  }
  return c.json({ saved: true, tests: results });
});

// ---- API: agents ----
app.post("/api/agents", async (c) => {
  const { agents } = await c.req.json().catch(() => ({}));
  for (const a of agents ?? []) {
    if (!a.id || !a.systemPrompt) return c.json({ error: "Agent missing id/systemPrompt" }, 400);
    if (a.output === "json") {
      const err = validateOutputSchema(a.outputSchema);
      if (err) return c.json({ error: `Agent ${a.id}: ${err}` }, 400);
    }
  }
  saveJson("config/agents.json", { agents });
  return c.json({ saved: true, count: (agents ?? []).length });
});

// ---- API: tools (single route: save + OAuth-aware probe + auth status) ----
app.post("/api/tools", async (c) => {
  const { servers, customTools } = await c.req.json().catch(() => ({}));
  const doc = loadJson("config/tools.json", {});
  if (servers !== undefined) doc.servers = servers;
  if (customTools !== undefined) {
    for (const t of customTools) {
      const err = validateCustomTool(t);
      if (err) return c.json({ error: `Tool ${t.id || "?"}: ${err}` }, 400);
    }
    doc.customTools = customTools;
  }
  saveJson("config/tools.json", doc);
  const probes = [];
  for (const s of doc.servers ?? []) {
    const p = await probeServer(s);
    probes.push({ id: s.id, ...p });
    // persist auth status on the server so the UI shows sign-in state
    if (p.authStatus) {
      s.authStatus = p.authStatus;
      s.authHint = p.authHint || "";
      if (p.note) s.note = p.note;
    } else if (p.ok) {
      s.authStatus = "ok";
      s.authHint = "";
    }
  }
  saveJson("config/tools.json", doc);
  return c.json({ saved: true, probes });
});

/** Probe one server: stdio tools/list, http OAuth-aware. Returns probe + authStatus. */
async function probeServer(s) {
  if (s.transport === "stdio") {
    // Known-auth stdio MCPs (Google, Reddit full search) start fine without
    // creds but can't actually serve data — always flag sign-in until creds saved.
    if (credSpecFor(s) && !hasCredsSaved(s)) {
      const r = await probeMcpStdio(s);
      return { ...r, ok: r.ok, authStatus: "needed",
        authHint: "Added, but sign-in needed before it can fetch your data. Click Sign in on its card." };
    }
    const r = await probeMcpStdio(s);
    if (r.ok) return { ...r, authStatus: "ok" };
    // stdio MCPs that need creds fail here — surface as sign-in needed
    const hint = String(r.hint || "");
    if (/auth|credential|token|api key|401|403|forbidden|unauthorized/i.test(hint)) {
      return { ...r, authStatus: "needed", authHint: `Needs sign-in details. ${hint.slice(0, 200)}` };
    }
    return { ...r, authStatus: undefined };
  }
  if (s.url) {
    const token = s.tokenEnv ? (readEnv()[s.tokenEnv] || process.env[s.tokenEnv] || "").trim() : "";
    try {
      const p = await probeMcpHttp(s.url, { token });
      if (p.ok) return { ...p, authStatus: "ok" };
      if (p.oauth || p.status === 401 || p.status === 403) {
        return { ...p, authStatus: "needed", authHint: p.hint || "Sign in required." };
      }
      return { ...p, authStatus: undefined };
    } catch (err) {
      return { ok: false, hint: err.message };
    }
  }
  return { ok: false, hint: "no url" };
}

// ---- API: MCP one-box resolve + add ----
// POST /api/mcp/resolve { query } -> { candidates: [{id,label,detail,server}] }
// Accepts: plain words ("reddit posts"), npx snippet, or http(s) URL.
app.post("/api/mcp/resolve", async (c) => {
  try {
    const { query } = await c.req.json().catch(() => ({}));
    const q = String(query || "").trim().slice(0, 300);
    if (!q) return c.json({ error: "query required" }, 400);
    // 1. direct URL -> http candidate
    if (/^https?:\/\/\S+$/i.test(q)) {
      const id = hostToId(q);
      return c.json({ candidates: [{ id, label: `${id} (server at ${q})`, detail: "HTTP MCP server. We'll test it — sign in right here if it asks.", server: { id, transport: "http", url: q } }], hint: "" });
    }
    // 2. npx snippet -> stdio candidate
    const npx = q.match(/npx\s+(?:-y\s+)?(\S+)/);
    if (npx) {
      const pkg = npx[1];
      const id = pkgToId(pkg);
      const args = ["-y", pkg];
      const extra = q.slice(npx[0].length).trim();
      if (extra) args.push(...extra.split(/\s+/));
      return c.json({ candidates: [{ id, label: `${id} (${pkg})`, detail: `Runs with: npx ${args.join(" ")}. We'll test it now.`, server: { id, transport: "stdio", command: "npx", args } }], hint: "" });
    }
    // 3. plain words -> GitHub search, top repos become candidates
    const { runTool } = await import("./webtools.js");
    const gh = await runTool("github_search", { query: `mcp server ${q}`, count: 5 }).catch((e) => `ERROR: ${e.message}`);
    const cands = parseGhCandidates(String(gh), q);
    if (!cands.length) return c.json({ candidates: [], hint: "No MCP found. Try the exact package name (npx ...) or server address (https://...)." });
    return c.json({ candidates: cands.slice(0, 3), hint: "Top pick first — all tested on add." });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

function hostToId(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").split(".")[0];
    return (h || "server").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "server";
  } catch { return "server"; }
}
function pkgToId(pkg) {
  const base = String(pkg).split("/").pop().replace(/^mcp-server-/, "").replace(/^server-/, "").replace(/-mcp.*$/, "");
  return (base || "server").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "server";
}
/** Turn github_search text output into addable candidates. */
function parseGhCandidates(ghText, q) {
  const out = [];
  const re = /(\S+)\s+⭐(\d+)[^\n]*\n\s+(https:\/\/github\.com\/\S+)/g;
  let m;
  while ((m = re.exec(ghText)) && out.length < 5) {
    const full = m[1]; // owner/repo
    const stars = m[2];
    const repoUrl = m[3];
    const descLine = (ghText.slice(m.index, m.index + 600).split("\n")[2] || "").trim().slice(0, 140);
    // npm package guess: repo name, plus known mappings
    const pkg = guessNpmPackage(full, descLine);
    const id = pkgToId(pkg || full);
    out.push({
      id,
      label: `${full} ⭐${stars}`,
      detail: `${descLine} — ${pkg ? `installs as ${pkg}` : repoUrl}`,
      server: pkg
        ? { id, transport: "stdio", command: "npx", args: ["-y", pkg], note: `${full} ⭐${stars}` }
        : { id, transport: "http", url: repoUrl, note: `${full} ⭐${stars} (no npm package found — check repo for server URL)` },
    });
  }
  // known-good mapping for common asks
  if (!out.length && /reddit/i.test(q)) {
    out.push({ id: "reddit", label: "reddit-mcp-buddy ⭐865", detail: "Reddit posts via RSS, no sign-in needed for browsing.", server: { id: "reddit", transport: "stdio", command: "npx", args: ["-y", "reddit-mcp-buddy"], note: "karanb192/reddit-mcp-buddy" } });
  }
  return out;
}
function guessNpmPackage(full, desc) {
  const [owner, repo] = String(full).split("/");
  if (!repo) return null;
  // Verified working packages (probed live — don't guess, use these)
  const known = {
    "karanb192/reddit-mcp-buddy": "reddit-mcp-buddy",
    "adhikasp/mcp-reddit": "mcp-reddit",
    "Hawstein/mcp-server-reddit": "mcp-server-reddit",
    // Gmail: gmail-mcp (npm, 37 tools, verified). taylorwilsdon's repo is Python-only (uvx), NOT on npm — map to gmail-mcp.
    "taylorwilsdon/google_workspace_mcp": "gmail-mcp",
    "taylorwilsdon/google-workspace-mcp": "gmail-mcp",
    "GongRzhe/Gmail-MCP-Server": "gmail-mcp",
    "a-bonus/google-docs-mcp": "gmail-mcp",
    // YouTube: yutu (Go binary via npm wrapper, video search + transcripts)
    "eat-pray-ai/yutu": "yutu",
  };
  if (known[full]) return known[full];
  // heuristic: repo already looks like an npm package
  if (/mcp/i.test(repo)) return repo;
  return null;
}

// POST /api/mcp/add { candidate: {id, server} } -> { servers, needsAuth }
// Saves + probes immediately; flags sign-in needed on the card.
app.post("/api/mcp/add", async (c) => {
  try {
    const { candidate } = await c.req.json().catch(() => ({}));
    const srv = candidate?.server;
    if (!srv?.id) return c.json({ error: "candidate.server.id required" }, 400);
    const doc = loadJson("config/tools.json", {});
    doc.servers = [...(doc.servers ?? []).filter((s) => s.id !== srv.id), { transport: "stdio", command: "npx", args: [], ...srv }];
    const saved = doc.servers.find((s) => s.id === srv.id);
    const p = await probeServer(saved);
    if (p.authStatus) { saved.authStatus = p.authStatus; saved.authHint = p.authHint || ""; if (p.note) saved.note = p.note; }
    else if (p.ok) { saved.authStatus = "ok"; saved.authHint = ""; }
    saveJson("config/tools.json", doc);
    return c.json({ servers: doc.servers, needsAuth: p.authStatus === "needed", probe: { id: saved.id, ...p } });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// POST /api/mcp/auth-info { id } -> { kind, ... } — what sign-in does this need?
// kind: "none" | "oauth-dcr" | "oauth-manual" | "oauth-proxy" | "creds"
app.post("/api/mcp/auth-info", async (c) => {
  try {
    const { id } = await c.req.json().catch(() => ({}));
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === id);
    if (!srv) return c.json({ error: `unknown server '${id}'` }, 404);
    // stdio servers with known auth (reddit creds, google browser login)
    const credSpec = credSpecFor(srv);
    if (credSpec) return c.json({ kind: credSpec.kind || "creds", ...credSpec });
    if (srv.transport === "http" && srv.url) {
      const d = await discoverOAuth(srv.url);
      if (!d.asMetadata) return c.json({ kind: "none", hint: "No sign-in found — it may use a simple key. Paste it as creds if Save+test fails." });
      if (d.dcrSupported) return c.json({ kind: "oauth-dcr", hint: "One click — we register + open sign-in." });
      return c.json({ kind: "oauth-manual", hint: "Needs a one-time app ID.", asMetadataUrl: d.asMetadataUrl });
    }
    return c.json({ kind: "none", hint: "No sign-in needed." });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

/** Known credential specs for stdio MCPs. No env names shown to user — labels only. */
function hasCredsSaved(srv) {
  const spec = credSpecFor(srv);
  if (!spec) return true;
  const env = readEnv();
  return (spec.fields || []).every((f) => String(env[f.key] || process.env[f.key] || "").trim());
}
function credSpecFor(srv) {
  const args = (srv.args || []).join(" ");
  if (/reddit-mcp-buddy/.test(args)) {
    return {
      title: "Reddit sign-in (needs approved Reddit app — full search only; browsing works without).",
      helpUrl: "https://www.reddit.com/prefs/apps",
      fields: [
        { key: "REDDIT_CLIENT_ID", label: "Client ID (under your app name)", secret: false, hint: "from reddit.com/prefs/apps" },
        { key: "REDDIT_CLIENT_SECRET", label: "Client secret", secret: true, hint: "from your Reddit app" },
        { key: "REDDIT_USERNAME", label: "Reddit username", secret: false, hint: "your Reddit login" },
        { key: "REDDIT_PASSWORD", label: "Reddit password", secret: true, hint: "your Reddit password" },
      ],
    };
  }
  if (/gmail-mcp/i.test(args) && !/google_workspace|workspace-mcp/i.test(args)) {
    return {
      kind: "oauth-proxy",
      title: "Sign in with Google to connect Gmail (37 tools: read, send, labels, drafts).",
      helpUrl: "https://console.cloud.google.com/apis/credentials",
      fields: [],
      provider: "google",
    };
  }
  if (/google_workspace_mcp|workspace-mcp|Gmail-MCP-Server|google-docs-mcp|yutu/i.test(args)) {
    return {
      kind: "oauth-proxy", // VS Code-style: one button, browser login, no manual keys
      title: "Sign in with Google to connect Gmail, Calendar, Drive.",
      helpUrl: "https://workspacemcp.com/quick-start",
      fields: [],
      provider: "google",
    };
  }
  return null;
}

// POST /api/mcp/save-creds { id, creds } -> saves to .env, re-probes
app.post("/api/mcp/save-creds", async (c) => {
  try {
    const { id, creds } = await c.req.json().catch(() => ({}));
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === id);
    if (!srv) return c.json({ error: `unknown server '${id}'` }, 404);
    const patch = {};
    for (const [k, v] of Object.entries(creds || {})) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && String(v || "").trim()) patch[k] = String(v).trim();
    }
    if (!Object.keys(patch).length) return c.json({ error: "No details entered." }, 400);
    writeEnv(patch, { overwrite: true });
    // attach env passthrough for stdio servers
    if (srv.transport === "stdio") srv.env = { ...(srv.env || {}), ...Object.fromEntries(Object.keys(patch).map((k) => [k, `\${${k}}`])) };
    // resolve ${VAR} from real env for the probe
    const { config: loadEnv } = await import("dotenv");
    loadEnv({ path: path.join(root, ".env"), override: true });
    if (srv.transport === "stdio" && srv.env) {
      for (const k of Object.keys(srv.env)) {
        if (String(srv.env[k]).startsWith("${")) srv.env[k] = process.env[k] || "";
      }
    }
    const p = await probeServer({ ...srv, env: srv.transport === "stdio" ? Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k] || ""])) : undefined });
    if (p.ok) { srv.authStatus = "ok"; srv.authHint = ""; }
    else if (p.authStatus === "needed") { srv.authStatus = "needed"; srv.authHint = p.authHint || ""; }
    saveJson("config/tools.json", doc);
    return c.json({ ok: p.ok, servers: doc.servers, hint: p.hint || p.authHint || "" });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// POST /api/mcp/prepare-auth { id } -> { clientId, clientSecret?, manual?, instructions? }
app.post("/api/mcp/prepare-auth", async (c) => {
  try {
    const { id } = await c.req.json().catch(() => ({}));
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === id);
    if (!srv?.url) return c.json({ error: "Server has no address." }, 400);
    const d = await discoverOAuth(srv.url);
    if (!d.asMetadata) return c.json({ error: "No sign-in found for this server.", discovery: d }, 400);
    if (!d.dcrSupported) {
      return c.json({ manual: true, instructions: `1. Open your service dashboard and create an app.\n2. Set the redirect/callback to: ${publicBaseUrl(c)}/api/oauth/callback\n3. Copy the Client ID it gives you and paste it below.` });
    }
    const reg = await dynamicRegister(d.asMetadata.registration_endpoint, {
      clientName: `tab-automation-${srv.id}`,
      redirectUris: [`${publicBaseUrl(c)}/api/oauth/callback`],
      scope: "",
    });
    // stash for authorize step
    pendingClient.set(srv.id, { clientId: reg.client_id, clientSecret: reg.client_secret || "" });
    return c.json({ clientId: reg.client_id, clientSecret: reg.client_secret || "" });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});
const pendingClient = new Map();

// POST /api/mcp/proxy-auth { id } -> { authorizeUrl }
// VS Code-style one-click Google sign-in (no manual keys).
// Uses Google's public OAuth: user logs in, token saved to .env, MCP gets it.
app.post("/api/mcp/proxy-auth", async (c) => {
  try {
    const { id } = await c.req.json().catch(() => ({}));
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === id);
    if (!srv) return c.json({ error: `unknown server '${id}'` }, 404);
    const spec = credSpecFor(srv);
    if (spec?.provider !== "google") return c.json({ error: "One-click sign-in not supported for this server yet." }, 400);
    // Google OAuth (PKCE, public client): gmail + readonly scopes
    const scope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly openid profile email";
    const { verifier, challenge } = pkcePair();
    const state = newState();
    const sessionId = newState();
    const redirectUri = `${publicBaseUrl(c)}/api/oauth/callback`;
    // Use a shared public client pattern: user pastes nothing, we use Google's
    // OAuth with our own lightweight client registration via DCR-like flow.
    // Simplest reliable: Google's OAuth2 with client_id from env or fallback to
    // asking Google directly (user's own project). For now: direct Google URL
    // with the setup server as redirect — needs a client_id, so check env first.
    const clientId = (readEnv().GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
    const clientSecret = (readEnv().GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
    if (!clientId) {
      return c.json({ error: "NEED_GOOGLE_CLIENT",
        hint: "One-time: Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Desktop app) → enable Gmail API. Paste the Client ID + secret once — then sign-in is one click forever.",
        helpUrl: "https://console.cloud.google.com/apis/credentials" }, 400);
    }
    oauthSessions.set(sessionId, {
      serverId: srv.id, serverUrl: "https://oauth2.googleapis.com/token",
      asMetadata: null, clientId, clientSecret, redirectUri,
      verifier, state, scope, resource: "",
      tokenEndpoint: "https://oauth2.googleapis.com/token", createdAt: Date.now(),
      provider: "google",
    });
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", scope);
    u.searchParams.set("state", `${sessionId}.${state}`);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    return c.json({ authorizeUrl: u.toString(), hint: "Sign in with Google, approve Gmail access, come back — green automatically." });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});
const proxySessions = new Map();

// POST /api/mcp/authorize { id, clientId?, clientSecret? } -> { authorizeUrl }
app.post("/api/mcp/authorize", async (c) => {
  try {
    const { id, clientId, clientSecret } = await c.req.json().catch(() => ({}));
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === id);
    if (!srv?.url) return c.json({ error: "Server has no address." }, 400);
    const pc = pendingClient.get(id) || {};
    const cid = (clientId || pc.clientId || "").trim();
    const csec = (clientSecret || pc.clientSecret || "").trim();
    if (!cid) return c.json({ error: "Sign-in ID missing — go back one step." }, 400);
    const d = await discoverOAuth(srv.url);
    const { verifier, challenge } = pkcePair();
    const state = newState();
    const sessionId = newState();
    const redirectUri = `${publicBaseUrl(c)}/api/oauth/callback`;
    oauthSessions.set(sessionId, {
      serverId: srv.id, serverUrl: srv.url, asMetadata: d.asMetadata,
      clientId: cid, clientSecret: csec, redirectUri,
      verifier, state, scope: "", resource: srv.url,
      tokenEndpoint: d.asMetadata.token_endpoint, createdAt: Date.now(),
    });
    const authorizeUrl = buildAuthorizeUrl(d.asMetadata, {
      clientId: cid, redirectUri, scope: "", state: `${sessionId}.${state}`, codeChallenge: challenge, resource: srv.url,
    });
    return c.json({ authorizeUrl, hint: "Approve in the new tab, then return here." });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// GET /api/mcp/auth-status?id=xxx -> { authed, servers } — polled after sign-in
app.get("/api/mcp/auth-status", async (c) => {
  const id = c.req.query("id");
  const doc = loadJson("config/tools.json", {});
  const srv = (doc.servers ?? []).find((s) => s.id === id);
  return c.json({ authed: srv?.authStatus === "ok", servers: doc.servers });
});

// ---- API: OAuth discovery + DCR + authorize (MCP HTTP servers) ----
// In-memory pending OAuth sessions (single setup-machine process; keyed by random id).
const oauthSessions = new Map(); // id -> { serverId, serverUrl, asMetadata, clientId, clientSecret, redirectUri, verifier, state, scope, resource, tokenEndpoint, createdAt }

function publicBaseUrl(c) {
  // Setup server runs on localhost; OAuth redirect must hit this machine.
  const host = c.req.header("host") || `localhost:${process.env.SETUP_PORT || 3000}`;
  const proto = c.req.header("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

// POST /api/oauth/discover { serverUrl } -> discovery report (RFC8414/RFC9728)
app.post("/api/oauth/discover", async (c) => {
  try {
    const { serverUrl } = await c.req.json().catch(() => ({}));
    if (!serverUrl) return c.json({ error: "serverUrl required" }, 400);
    const d = await discoverOAuth(serverUrl);
    return c.json(d);
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// POST /api/oauth/register { serverId, serverUrl, asMetadataUrl?, clientName?, redirectUri?, scope? }
// Runs DCR if the AS supports it; else returns manual-registration guidance.
app.post("/api/oauth/register", async (c) => {
  try {
    const { serverId, serverUrl, asMetadataUrl, clientName, redirectUri, scope } = await c.req.json().catch(() => ({}));
    if (!serverUrl) return c.json({ error: "serverUrl required" }, 400);
    const d = await discoverOAuth(serverUrl);
    if (!d.asMetadata) return c.json({ error: "No OAuth metadata found for this server. It likely uses a static token — set tokenEnv instead.", discovery: d }, 400);
    if (!d.dcrSupported) {
      return c.json({
        manual: true,
        discovery: d,
        hint: `No registration_endpoint at ${d.asMetadataUrl}. Create an OAuth client manually in the provider dashboard with redirect URI ${redirectUri || `${publicBaseUrl(c)}/api/oauth/callback`}, then call /api/oauth/authorize with your client_id.`,
        redirectUri: redirectUri || `${publicBaseUrl(c)}/api/oauth/callback`,
      });
    }
    const finalRedirect = redirectUri || `${publicBaseUrl(c)}/api/oauth/callback`;
    const reg = await dynamicRegister(d.asMetadata.registration_endpoint, {
      clientName: clientName || `tab-automation${serverId ? `-${serverId}` : ""}`,
      redirectUris: [finalRedirect],
      scope: scope || "",
    });
    return c.json({ clientId: reg.client_id, clientSecret: reg.client_secret || "", redirectUri: finalRedirect, discovery: d,
      hint: reg.client_secret ? "DCR ok (confidential client). Client secret stored client-side only — paste into Authorize step." : "DCR ok (public client, PKCE). Proceed to Authorize." });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// POST /api/oauth/authorize { serverId, serverUrl, clientId, clientSecret?, scope?, redirectUri? }
// -> { authorizeUrl, sessionId } — open authorizeUrl in a browser, tokens land via callback.
app.post("/api/oauth/authorize", async (c) => {
  try {
    const { serverId, serverUrl, clientId, clientSecret, scope, redirectUri } = await c.req.json().catch(() => ({}));
    if (!serverUrl || !clientId) return c.json({ error: "serverUrl + clientId required" }, 400);
    const d = await discoverOAuth(serverUrl);
    if (!d.asMetadata?.authorization_endpoint || !d.asMetadata?.token_endpoint) {
      return c.json({ error: "AS metadata missing authorization/token endpoints", discovery: d }, 400);
    }
    const { verifier, challenge } = pkcePair();
    const state = newState();
    const finalRedirect = redirectUri || `${publicBaseUrl(c)}/api/oauth/callback`;
    const sessionId = newState();
    oauthSessions.set(sessionId, {
      serverId: serverId || "", serverUrl, asMetadata: d.asMetadata,
      clientId, clientSecret: clientSecret || "", redirectUri: finalRedirect,
      verifier, state, scope: scope || "", resource: serverUrl,
      tokenEndpoint: d.asMetadata.token_endpoint, createdAt: Date.now(),
    });
    // prune sessions older than 15 min
    for (const [k, v] of oauthSessions) if (Date.now() - v.createdAt > 15 * 60 * 1000) oauthSessions.delete(k);
    const authorizeUrl = buildAuthorizeUrl(d.asMetadata, {
      clientId, redirectUri: finalRedirect, scope: scope || "",
      state: `${sessionId}.${state}`, codeChallenge: challenge, resource: serverUrl,
    });
    return c.json({ authorizeUrl, sessionId, redirectUri: finalRedirect,
      hint: "Open authorizeUrl in a browser and approve. This setup server must stay running to receive the callback." });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// GET /api/oauth/callback?code=...&state=<sessionId>.<state> — provider redirects here.
app.get("/api/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const rawState = c.req.query("state") || "";
  const errParam = c.req.query("error");
  if (errParam) return c.html(`<h1>OAuth denied</h1><p>${errParam}: ${c.req.query("error_description") || ""}</p>`, 400);
  const dot = rawState.indexOf(".");
  const sessionId = dot > 0 ? rawState.slice(0, dot) : rawState;
  const sess = oauthSessions.get(sessionId);
  if (!sess || !code) return c.html("<h1>OAuth callback invalid</h1><p>Unknown or expired session. Restart Authorize from setup.</p>", 400);
  try {
    const tokens = await exchangeCode(sess.tokenEndpoint, {
      code, redirectUri: sess.redirectUri, verifier: sess.verifier,
      clientId: sess.clientId, clientSecret: sess.clientSecret,
    });
    // Persist tokens to .env (never config). Key names derived from server id.
    const prefix = (sess.serverId || "mcp").toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 24) || "MCP";
    const patch = { [`${prefix}_ACCESS_TOKEN`]: tokens.access_token };
    if (tokens.refresh_token) patch[`${prefix}_REFRESH_TOKEN`] = tokens.refresh_token;
    if (tokens.expires_in) patch[`${prefix}_EXPIRES_AT`] = String(Date.now() + Number(tokens.expires_in) * 1000);
    // Google MCPs read GOOGLE_ACCESS_TOKEN / GOOGLE_REFRESH_TOKEN directly
    if (sess.provider === "google") {
      patch.GOOGLE_ACCESS_TOKEN = tokens.access_token;
      if (tokens.refresh_token) patch.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
    }
    writeEnv(patch, { overwrite: true });
    // Point the server entry at the access-token env var.
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === sess.serverId || s.url === sess.serverUrl);
    if (srv) {
      srv.tokenEnv = `${prefix}_ACCESS_TOKEN`;
      srv.refreshEnv = tokens.refresh_token ? `${prefix}_REFRESH_TOKEN` : undefined;
      srv.tokenEndpoint = sess.tokenEndpoint;
      srv.oauthClientIdEnv = `${prefix}_CLIENT_ID`;
      // stdio Google MCPs need the token as env passthrough
      if (sess.provider === "google" && srv.transport === "stdio") {
        srv.env = { ...(srv.env || {}), GOOGLE_ACCESS_TOKEN: tokens.access_token,
          ...(tokens.refresh_token ? { GOOGLE_REFRESH_TOKEN: tokens.refresh_token } : {}) };
      }
      srv.authStatus = "ok";
      srv.authHint = "";
      saveJson("config/tools.json", doc);
    }
    writeEnv({ [`${prefix}_CLIENT_ID`]: sess.clientId, ...(sess.clientSecret ? { [`${prefix}_CLIENT_SECRET`]: sess.clientSecret } : {}) }, { overwrite: true });
    oauthSessions.delete(sessionId);
    return c.html(`<h1>✅ Authorized</h1><p>Tokens saved to <code>.env</code> as <code>${prefix}_ACCESS_TOKEN</code>${tokens.refresh_token ? ` + <code>${prefix}_REFRESH_TOKEN</code>` : ""}. Server <code>${sess.serverId || sess.serverUrl}</code> now uses <code>${prefix}_ACCESS_TOKEN</code>. You can close this tab and return to setup.</p>`);
  } catch (err) {
    return c.html(`<h1>OAuth exchange failed</h1><p>${String(err.message).slice(0, 500)}</p>`, 502);
  }
});

// POST /api/oauth/refresh { serverId } — refresh once using stored refresh token.
app.post("/api/oauth/refresh", async (c) => {
  try {
    const { serverId } = await c.req.json().catch(() => ({}));
    const doc = loadJson("config/tools.json", {});
    const srv = (doc.servers ?? []).find((s) => s.id === serverId);
    if (!srv) return c.json({ error: `unknown server '${serverId}'` }, 404);
    const env = readEnv();
    const refreshToken = (env[srv.refreshEnv] || "").trim();
    const tokenEndpoint = srv.tokenEndpoint || "";
    if (!refreshToken || !tokenEndpoint) return c.json({ error: "No refresh token / token endpoint stored for this server. Re-authorize." }, 400);
    const prefix = (serverId || "mcp").toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 24);
    const tokens = await refreshAccessToken(tokenEndpoint, {
      refreshToken,
      clientId: (env[`${prefix}_CLIENT_ID`] || "").trim(),
      clientSecret: (env[`${prefix}_CLIENT_SECRET`] || "").trim(),
    });
    writeEnv({ [`${prefix}_ACCESS_TOKEN`]: tokens.access_token,
      ...(tokens.refresh_token ? { [`${prefix}_REFRESH_TOKEN`]: tokens.refresh_token } : {}) }, { overwrite: true });
    return c.json({ ok: true, hint: `Refreshed ${prefix}_ACCESS_TOKEN.` });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// ---- API: AI tool-maker ----
app.post("/api/tools/build", async (c) => {
  // Agentic loop: research -> generate -> auto-test -> fix/retry (max 3) -> report.
  // Returns { status: "ready"|"needs-info"|"failed", tool?, testOutput?, research?, questions?, attempts? }
  try {
    const { need, answers, testArgs } = await c.req.json().catch(() => ({}));
    if (!need) return c.json({ error: "Describe what the tool should do" }, 400);
    const { cfg } = loadConfig();
    const agentId = [...cfg.agents.keys()][0] || "assistant";
    const history = (answers ?? []).map((a) => `Q: ${a.q}\nA: ${a.a}`).join("\n");
    const log = [];
    const attempt = async (extra, n) => {
      const spec = await chatWithTools(cfg, agentId,
      `You design a custom HTTP tool. The user does NOT have API docs — research first.\n\nUser need: ${need.slice(0, 1000)}\n${history ? `User answers:\n${history}\n` : ""}` +
      `STEP 1 (mandatory): use web_search + github_search + web_fetch to find the public API, local-LAN protocol, or integration docs for this device/service (official docs, GitHub repos, Home Assistant integrations, community reverse-engineering). Do at least 2 searches before deciding — ALWAYS include one github_search (e.g. 'mcp server <service>' or '<device> home assistant') to find existing MCP servers / libraries the user could install instead of building from scratch.\n` +
      `If github_search finds a maintained MCP server for this need, say so in "research" (repo + install command) AND still design the direct-HTTP tool as fallback.\n` +
      `STEP 1b (auth check): if the API/MCP server uses OAuth (401 + WWW-Authenticate, or docs mention OAuth), use oauth_discover on its base URL to report authorization_endpoint / token_endpoint / registration_endpoint (DCR) support. Include the discovery result in "research" so setup can run DCR + Authorize.\n` +
      `STEP 2: respond with ONLY valid JSON, no other text:\n` +
      `{"ready": true, "tool": {...}, "research": "<1-2 lines: what you found + source URLs>"} where tool = {"id": "<snake_case>", "description": "<what it does>", "method": "GET|POST|PUT|DELETE", "url": "<full https URL, use {{params.x}} for variables>", "headers": {}, "bodyTemplate": "<JSON with {{params.x}} vars or empty>", "params": {"<name>": {"description": "", "required": true}}, "timeoutMs": 20000, "approvalRequired": false}\n` +
      `OR if you need credentials or user-specific values: {"ready": false, "questions": [{"q": "<question>", "why": "<why needed>", "how": "<exact steps to get it>"}...], "research": "<what you tried + links>"} (max 3; ask for: API keys/tokens with where-to-get steps, OAuth app credentials, LAN IPs, device IDs, account names)\n` +
      `AUTH RULES: if the API needs a key/token/OAuth, ALWAYS ask for it via questions — never hardcode fake keys, never ship a tool that 401s. For OAuth flows (Reddit, Google, Outlook, any MCP with oauth_discover showing endpoints): ask for Client ID + Client Secret + what redirect URI to register (${publicBaseUrl(c)}/api/oauth/callback), and explain tokens land in .env via setup's Authorize step (DCR auto-registers when registration_endpoint exists). For Tuya: ask for IoT Platform Client ID/Secret + device ID. For LAN devices: ask for the IP from the router list.\n` +
      `Rules: id [a-z0-9_], max 8 params, https (or http://LAN-IP for local devices) only, approvalRequired=true for physical/financial actions. Prefer local-LAN control over cloud when docs support it.\n` +
      `SITE-SPECIFIC: Reddit search.json/search.rss are bot-blocked (403) — for Reddit use subreddit RSS https://www.reddit.com/r/{{params.sub}}/.rss with a browser User-Agent header, never search endpoints. GitHub API needs no key for low rates (set GITHUB_TOKEN in .env for 5000/hr). Hacker News Algolia API (hn.algolia.com/api/v1/search?query=) is open. ArXiv API (export.arxiv.org/api/query) is open.${extra || ""}`,
      {});
      const clean = String(spec).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      return JSON.parse(clean);
    };
    // attempt 1: research + generate
    let gen = await attempt("", 1);
    log.push(`attempt 1: ${gen.ready ? "spec ready" : "needs info"}`);
    if (!gen.ready) {
      return c.json({ status: "needs-info", questions: gen.questions ?? [], research: gen.research ?? "", log });
    }
    // validate + auto-test, retry loop
    for (let n = 1; n <= 3; n++) {
      const tool = gen.tool;
      const verr = validateCustomTool(tool);
      if (verr) {
        log.push(`attempt ${n}: invalid spec (${verr})`);
        gen = await attempt(` Prior spec invalid: ${verr}. Fix it.`, n + 1);
        if (!gen.ready) return c.json({ status: "needs-info", questions: gen.questions ?? [], research: gen.research ?? "", log });
        continue;
      }
      const args = testArgs ?? sampleArgs(tool);
      let out;
      try {
        out = await runCustomTool(tool, args);
      } catch (e) {
        out = `ERROR: ${e.message}`;
      }
      const ok = !String(out).startsWith("ERROR");
      const authFail = /HTTP 40[13]|HTTP 429|unauthorized|forbidden|invalid_token|bad credentials/i.test(String(out));
      log.push(`attempt ${n}: test ${ok ? "PASSED" : "FAILED — " + String(out).slice(0, 160)}`);
      if (!ok && authFail) {
        // Don't burn retries on auth walls — ask the user for credentials immediately.
        log.push("auth wall hit — asking user for credentials instead of retrying.");
        gen = await attempt(` Prior test failed with auth error: ${String(out).slice(0, 300)}. The API needs credentials. Ask for them via questions (with exact where-to-get steps) instead of guessing.`, n + 1);
        return c.json({ status: "needs-info", questions: gen.questions ?? [], research: gen.research ?? "", log,
          hint: "This API needs your credentials — answer the questions and retry." });
      }
      if (ok) {
        return c.json({ status: "ready", tool, testOutput: out, testArgs: args, research: gen.research ?? "", log, attempts: n });
      }
      if (n === 3) {
        return c.json({ status: "failed", tool, testOutput: out, research: gen.research ?? "", log, attempts: n,
          hint: "Auto-test failed 3x. Fix the endpoint/auth and retry, or save anyway and test against the real device." });
      }
      gen = await attempt(` Prior test failed with: ${String(out).slice(0, 400)}. Fix the URL/method/headers/body and retry.`, n + 1);
      if (!gen.ready) return c.json({ status: "needs-info", questions: gen.questions ?? [], research: gen.research ?? "", log });
    }
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

function sampleArgs(tool) {
  const args = {};
  for (const [k, v] of Object.entries(tool.params ?? {})) {
    if (!v.required) continue;
    const d = (v.description || "").toLowerCase();
    if (/key|token|secret/.test(k + d)) args[k] = "test-key";
    else if (/url|endpoint|host/.test(k + d)) args[k] = "https://example.com";
    else if (/state|power|on\/off/.test(k + d)) args[k] = "on";
    else if (/brightness|level|percent/.test(k + d)) args[k] = "80";
    else if (/color/.test(k + d)) args[k] = "white";
    else if (/device|id|name/.test(k + d)) args[k] = "test-device";
    else args[k] = "test";
  }
  return args;
}

app.post("/api/tools/generate", async (c) => {
  // legacy single-shot alias -> delegates to /api/tools/build
  const body = await c.req.json().catch(() => ({}));
  const r = await app.request("/api/tools/build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (data.status === "ready") return c.json({ ready: true, tool: data.tool, research: data.research, testOutput: data.testOutput, log: data.log });
  if (data.status === "needs-info") return c.json({ ready: false, questions: data.questions, research: data.research, log: data.log });
  return c.json({ ready: false, questions: [], research: data.hint ?? "build failed", log: data.log });
});

app.post("/api/tools/test", async (c) => {
  try {
    const { tool, args } = await c.req.json().catch(() => ({}));
    const err = validateCustomTool(tool);
    if (err) return c.json({ error: err }, 400);
    const out = await runCustomTool(tool, args ?? {});
    return c.json({ output: out });
  } catch (err) {
    return c.json({ error: err.message.slice(0, 300) }, 500);
  }
});

// ---- API: discord ----
app.get("/api/discord/guilds", async (c) => {
  const token = (readEnv().DISCORD_BOT_TOKEN || "").trim();
  if (!token) return c.json({ error: "No bot token in .env — save it first" }, 400);
  try {
    const me = await discordFetch(token, "/users/@me");
    const guilds = await discordFetch(token, "/users/@me/guilds");
    return c.json({ me, guilds });
  } catch (err) {
    return c.json({ error: err.message }, 502);
  }
});

app.get("/api/discord/channels", async (c) => {
  const token = (readEnv().DISCORD_BOT_TOKEN || "").trim();
  const gid = c.req.query("guild");
  if (!token || !gid) return c.json({ error: "Need token + ?guild=" }, 400);
  try {
    const channels = await discordFetch(token, `/guilds/${gid}/channels`);
    return c.json({ channels: channels.filter((ch) => [0, 5].includes(ch.type)) });
  } catch (err) {
    return c.json({ error: err.message }, 502);
  }
});

app.post("/api/discord", async (c) => {
  const { token, mainChannelId, extraChannels, ownerUserId, guildId, sendProbe } =
    await c.req.json().catch(() => ({}));
  if (token) writeEnv({ DISCORD_BOT_TOKEN: token });
  const realToken = (token || readEnv().DISCORD_BOT_TOKEN || "").trim();
  saveJson("config/discord.json", { mainChannelId, extraChannels: extraChannels ?? [], ownerUserId, guildId });
  if (mainChannelId) writeEnv({ DISCORD_CHANNEL_ID: mainChannelId });
  if (ownerUserId) writeEnv({ DISCORD_OWNER_USER_ID: ownerUserId });
  let probe = null;
  if (sendProbe !== false && mainChannelId && realToken) {
    try {
      await discordFetch(realToken, `/channels/${mainChannelId}/messages`, {
        method: "POST", body: { content: "✅ Rick setup: channel linked." },
      });
      probe = { ok: true };
    } catch (err) {
      probe = { ok: false, hint: err.message };
    }
  }
  return c.json({ saved: true, probe });
});

// ---- API: workflows ----
app.post("/api/workflows", async (c) => {
  const { workflows } = await c.req.json().catch(() => ({}));
  saveJson("config/workflows.json", { workflows });
  return c.json({ saved: true, count: (workflows ?? []).length });
});

// ---- API: validate ----
app.post("/api/validate", (c) => {
  const r = spawnSync(process.execPath, ["src/validate.js"], { cwd: root, encoding: "utf-8" });
  return c.json({ ok: r.status === 0, output: (r.stdout || "") + (r.stderr || "") });
});

// ---- API: runs (SQLite — LOCAL by default; tablet cache only when pulled) ----
// Setup machine default = local. Headless bot serves its own DB via headless-dashboard.js.
// ?source=tablet reads the adb-pulled cache; ?source=local reads this machine.
function runSource(c) {
  const source = c.req.query("source") || "local";
  if (source === "tablet") return { source: "tablet", file: tabletDbPath() };
  return { source: "local", file: null };
}

app.get("/api/tablet", async (c) => {
  const st = await tabletStatus();
  return c.json({ ...st, cached: Boolean(tabletDbPath()) });
});

app.post("/api/tablet/pull", async (c) => {
  const r = await pullTabletDb();
  return c.json(r, r.ok ? 200 : 502);
});

// POST /api/deploy/push — run scripts/deploy-tab.sh (adb) from the wizard.
// Setup = factory: pushes .env + config + src to the tablet, data/ stays safe.
// GET /api/deploy/tunnel — persistent tunnel status (dashboard on hai tabhi).
app.get("/api/deploy/tunnel", async (c) => {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("bash", ["scripts/tunnel.sh", "status"], { cwd: root, encoding: "utf-8", timeout: 10000 });
    try { return c.json(JSON.parse(r.stdout.trim())); }
    catch { return c.json({ running: false, url: "", hint: r.stdout.slice(0, 300) }); }
  } catch (err) {
    return c.json({ running: false, error: err.message.slice(0, 200) });
  }
});

app.post("/api/deploy/push", async (c) => {
  try {
    const { spawn } = await import("node:child_process");
    const out = await new Promise((resolve) => {
      const child = spawn("bash", ["scripts/deploy-tab.sh"], { cwd: root });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += String(d); });
      child.stderr.on("data", (d) => { stderr += String(d); });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
      setTimeout(() => { try { child.kill(); } catch {} resolve({ code: 124, stdout, stderr: stderr + "\ntimeout" }); }, 90000);
    });
    const tail = (out.stdout + "\n" + out.stderr).slice(-800);
    if (out.code === 0) return c.json({ ok: true, hint: tail.trim().slice(-300) || "Deployed." });
    return c.json({ ok: false, hint: tail.trim().slice(-500) || "Deploy failed." }, 502);
  } catch (err) {
    return c.json({ ok: false, error: err.message.slice(0, 300) }, 500);
  }
});

app.get("/api/runs", (c) => {
  try {
    const { source, file } = runSource(c);
    if (source === "tablet" && !file) {
      return c.json({ runs: [], source, hint: "No tablet DB cached — click Sync tablet first." });
    }
    const workflowId = c.req.query("workflow") || null;
    const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
    return c.json({ runs: listRuns(root, { workflowId, limit, file }), source });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get("/api/runs/:id", (c) => {
  try {
    const { source, file } = runSource(c);
    const run = getRun(root, c.req.param("id"), { file });
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ run, source });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.post("/api/runs/prune", async (c) => {
  try {
    const { days } = await c.req.json().catch(() => ({}));
    return c.json({ pruned: pruneRuns(root, Number(days) || 90) });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get("/api/approvals", (c) => {
  try {
    const { source, file } = runSource(c);
    if (source === "tablet" && !file) {
      return c.json({ approvals: [], source, hint: "No tablet DB cached — click Sync tablet first." });
    }
    return c.json({ approvals: pendingApprovals(root, { file }), source });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// ---- API: dashboard config (factory writes config/dashboard.json for deploy) ----
// Setup sirf factory hai: on/off yahi save hota hai, dashboard UI yaha serve NAHI hota.
// Dashboard UI sirf headless bot pe milega (deploy ke baad).
app.get("/api/dashboard/config", (c) => c.json(getDashboardConfig(root, loadJson)));
app.post("/api/dashboard/config", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cur = getDashboardConfig(root, loadJson);
  const next = saveDashboardConfig(root, loadJson, saveJson, { ...cur, ...body });
  return c.json(next);
});

// ---- API: automations (reference: YOUR FLOWS; SQLite-backed, same on setup+deploy) ----
app.get("/api/automations", (c) => {
  try { return c.json({ automations: listAutomations(root) }); }
  catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/automations", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const id = saveAutomation(root, body);
    try {
      // keep config/workflows.json in sync so Tablet deploy (file-based) still works
      const doc = loadJson("config/workflows.json", { workflows: [] });
      const steps = (body.steps ?? []).map((s) => ({ id: s.id, type: s.type, ...Object.fromEntries(Object.entries(s).filter(([k]) => !["id", "type"].includes(k))) }));
      const trig = body.trigger_type === "schedule"
        ? { type: "schedule", cron: body.trigger_config?.cron || "0 8 * * *", description: body.trigger_config?.label || "" }
        : body.trigger_type === "discord" ? { type: "discord", command: body.trigger_config?.command || "" }
        : { type: "manual" };
      const row = { id, name: body.name || id, description: body.description || "", trigger: trig, steps };
      const i = doc.workflows.findIndex((w) => w.id === id);
      if (i >= 0) doc.workflows[i] = row; else doc.workflows.push(row);
      saveJson("config/workflows.json", doc);
    } catch {}
    return c.json({ saved: true, id, automation: getAutomation(root, id) });
  } catch (err) { return c.json({ error: err.message }, 500); }
});
app.delete("/api/automations/:id", (c) => {
  try { deleteAutomation(root, c.req.param("id")); return c.json({ deleted: true }); }
  catch (err) { return c.json({ error: err.message }, 500); }
});
app.post("/api/automations/:id/enable", async (c) => {
  try {
    const { enabled } = await c.req.json().catch(() => ({}));
    setAutomationEnabled(root, c.req.param("id"), enabled !== false);
    return c.json({ saved: true });
  } catch (err) { return c.json({ error: err.message }, 500); }
});

// ---- static UI (unified service: setup wizard at / + dashboard at /dashboard) ----
// Setup and deployment now share one service + one SQLite DB. Same Hono app
// serves dist-setup/ at / and dist-dashboard/ at /dashboard (base /dashboard/).
const dist = path.join(root, "dist-setup");
const distDash = path.join(root, "dist-dashboard");
app.use("/dashboard/*", serveStatic({ root: distDash }));
app.get("/dashboard", (c) => {
  const index = path.join(distDash, "index.html");
  if (existsSync(index)) return c.html(readFileSync(index, "utf-8"));
  return c.text("dist-dashboard/ missing. Run: npm run dashboard:build", 500);
});
app.use("/*", serveStatic({ root: dist }));

// SPA fallback: setup wizard only
app.get("*", (c) => {
  if (c.req.path.startsWith("/api")) return c.json({ error: "not found" }, 404);
  const index = path.join(dist, "index.html");
  if (existsSync(index)) {
    return c.html(readFileSync(index, "utf-8"));
  }
  return c.text("dist-setup/ missing. Run: npm run setup:build", 500);
});

const PORT = Number(process.env.SETUP_PORT || 3000);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\n  Rick setup UI (hono): http://localhost:${PORT}\n  Opening in your browser… (Ctrl+C to stop)\n`);
  openBrowser(`http://localhost:${PORT}`);
});

async function openBrowser(url) {
  const { exec } = await import("node:child_process");
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || echo "Open manually: ${url}"`;
  exec(cmd);
}

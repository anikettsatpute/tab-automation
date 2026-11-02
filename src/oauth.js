// OAuth discovery + Dynamic Client Registration (DCR) helpers for MCP / tool auth.
// Standards: RFC8414 (AS metadata), RFC7591 (DCR), RFC9728 (protected-resource
// metadata), RFC7636 (PKCE for S256), MCP authorization spec (2025-03-26).
// No extra deps — fetch + node:crypto only. Secrets go to .env, never config.
import { createHash, randomBytes } from "node:crypto";

const UA = "tab-automation/0.1 (oauth-discovery)";

async function fetchJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, text, json };
  } finally {
    clearTimeout(t);
  }
}

/** Parse a WWW-Authenticate: Bearer ... header into a param map. */
export function parseWwwAuthenticate(header) {
  const out = {};
  if (!header) return out;
  // e.g. Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="a b"
  const m = /^Bearer\s+(.*)$/i.exec(header.trim());
  const params = m ? m[1] : header;
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*("([^"]*)"|[^,\s]+)/g;
  let g;
  while ((g = re.exec(params))) {
    out[g[1]] = g[3] !== undefined ? g[3] : g[2];
  }
  return out;
}

function stripTrailingSlash(u) {
  return String(u || "").replace(/\/$/, "");
}

/** Candidate protected-resource-metadata URLs for an MCP server URL (RFC9728 §3.1). */
export function protectedResourceCandidates(serverUrl) {
  try {
    const u = new URL(serverUrl);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const base = `${u.protocol}//${u.host}`;
    const cands = [];
    if (path) cands.push(`${base}/.well-known/oauth-protected-resource${path}`);
    cands.push(`${base}/.well-known/oauth-protected-resource`);
    // Some servers expose metadata relative to the full URL (non-standard but seen).
    cands.push(`${stripTrailingSlash(serverUrl)}/.well-known/oauth-protected-resource`);
    return [...new Set(cands)];
  } catch {
    return [];
  }
}

/** Candidate authorization-server-metadata URLs for an issuer (RFC8414 §3.1). */
export function authServerCandidates(issuer) {
  const clean = stripTrailingSlash(issuer);
  if (!clean) return [];
  try {
    const u = new URL(clean);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const base = `${u.protocol}//${u.host}`;
    const cands = [];
    if (path) {
      cands.push(`${base}/.well-known/oauth-authorization-server${path}`);
      cands.push(`${base}/.well-known/openid-configuration${path}`);
    }
    cands.push(`${base}/.well-known/oauth-authorization-server`);
    cands.push(`${base}/.well-known/openid-configuration`);
    cands.push(`${clean}/.well-known/oauth-authorization-server`);
    cands.push(`${clean}/.well-known/openid-configuration`);
    return [...new Set(cands)];
  } catch {
    return [];
  }
}

/** Fetch the first candidate URL that returns JSON with the expected marker. */
async function fetchFirst(candidates, markerKeys) {
  const tried = [];
  for (const url of candidates) {
    try {
      const r = await fetchJson(url);
      tried.push(`${url} -> ${r.status}`);
      if (r.ok && r.json && markerKeys.some((k) => r.json[k] !== undefined)) {
        return { metadata: r.json, url, tried };
      }
    } catch (err) {
      tried.push(`${url} -> ERR ${String(err.message).slice(0, 80)}`);
    }
  }
  return { metadata: null, url: null, tried };
}

/**
 * Full OAuth discovery for an MCP HTTP server URL.
 * 1. GET server URL unauthenticated, capture 401 WWW-Authenticate.
 * 2. Fetch protected-resource metadata -> authorization_servers[].
 * 3. Fetch AS metadata (RFC8414) for each candidate issuer.
 * Returns { httpStatus, wwwAuthenticate, resourceMetadata, resourceMetadataUrl,
 *   authorizationServers, asMetadata, asMetadataUrl, tried, dcrSupported, hint }.
 */
export async function discoverOAuth(serverUrl) {
  const out = {
    serverUrl,
    httpStatus: null,
    wwwAuthenticate: null,
    resourceMetadata: null,
    resourceMetadataUrl: null,
    authorizationServers: [],
    asMetadata: null,
    asMetadataUrl: null,
    tried: [],
    dcrSupported: false,
    hint: "",
  };
  if (!/^https?:\/\//i.test(serverUrl || "")) {
    out.hint = "serverUrl must start with http(s)://";
    return out;
  }
  // 1. unauthenticated probe — MCP servers SHOULD 401 with WWW-Authenticate
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(serverUrl, { headers: { "User-Agent": UA, Accept: "application/json, text/event-stream" }, signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(t);
    }
    out.httpStatus = res.status;
    const www = res.headers.get("www-authenticate");
    if (www) {
      out.wwwAuthenticate = www;
      const parsed = parseWwwAuthenticate(www);
      if (parsed.resource_metadata) {
        // Direct metadata URL from the challenge — try it first.
        const direct = await fetchFirst([parsed.resource_metadata], ["authorization_servers", "resource"]);
        if (direct.metadata) {
          out.resourceMetadata = direct.metadata;
          out.resourceMetadataUrl = direct.url;
        }
        out.tried.push(...direct.tried);
      }
    }
  } catch (err) {
    out.hint = `probe failed: ${String(err.message).slice(0, 160)}`;
  }
  // 2. well-known protected-resource candidates (if direct failed)
  if (!out.resourceMetadata) {
    const found = await fetchFirst(protectedResourceCandidates(serverUrl), ["authorization_servers", "resource"]);
    out.tried.push(...found.tried);
    if (found.metadata) {
      out.resourceMetadata = found.metadata;
      out.resourceMetadataUrl = found.url;
    }
  }
  const servers = out.resourceMetadata?.authorization_servers ?? [];
  out.authorizationServers = Array.isArray(servers) ? servers : [];
  // 3. AS metadata for the first issuer (multi-issuer: user picks; we surface all)
  for (const issuer of out.authorizationServers) {
    const found = await fetchFirst(authServerCandidates(issuer), ["issuer", "authorization_endpoint", "token_endpoint"]);
    out.tried.push(...found.tried.map((s) => `[as:${issuer}] ${s}`));
    if (found.metadata) {
      out.asMetadata = found.metadata;
      out.asMetadataUrl = found.url;
      break;
    }
  }
  // Fallback: treat the server URL origin itself as the issuer (common for small MCPs)
  if (!out.asMetadata) {
    try {
      const origin = new URL(serverUrl).origin;
      const found = await fetchFirst(authServerCandidates(origin), ["issuer", "authorization_endpoint", "token_endpoint"]);
      out.tried.push(...found.tried.map((s) => `[as:origin] ${s}`));
      if (found.metadata) {
        out.asMetadata = found.metadata;
        out.asMetadataUrl = found.url;
        if (!out.authorizationServers.length) out.authorizationServers = [origin];
      }
    } catch { /* ignore */ }
  }
  out.dcrSupported = Boolean(out.asMetadata?.registration_endpoint);
  if (out.asMetadata) {
    out.hint = out.dcrSupported
      ? `OAuth discovered at ${out.asMetadataUrl}. DCR supported — register, then authorize.`
      : `OAuth discovered at ${out.asMetadataUrl}. No registration_endpoint — create a client manually in the provider dashboard, then authorize.`;
  } else if (out.httpStatus === 401) {
    out.hint = "Server requires auth (401) but exposes no OAuth metadata. Check provider docs for a token / API key, or enter a bearer token manually.";
  } else if (!out.hint) {
    out.hint = "No OAuth metadata found. Server is likely open or uses a static bearer token / API key.";
  }
  return out;
}

/** RFC7591 Dynamic Client Registration. Returns parsed client info. Throws on error. */
export async function dynamicRegister(registrationEndpoint, { clientName = "tab-automation", redirectUris = [], scope = "" } = {}) {
  if (!registrationEndpoint) throw new Error("No registration_endpoint (DCR not supported by this server)");
  if (!redirectUris.length) throw new Error("redirectUris required for DCR");
  const body = {
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none", // public client (PKCE, no secret) — most MCP AS accept this
    ...(scope ? { scope } : {}),
  };
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* fall through */ }
  if (!res.ok) throw new Error(`DCR failed HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!json?.client_id) throw new Error(`DCR response missing client_id: ${text.slice(0, 300)}`);
  return json;
}

/** PKCE S256 pair. */
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newState() {
  return randomBytes(16).toString("hex");
}

/** Build the browser authorize URL for the code flow (PKCE S256). */
export function buildAuthorizeUrl(asMetadata, { clientId, redirectUri, scope = "", state, codeChallenge, resource = "" } = {}) {
  const authEp = asMetadata?.authorization_endpoint;
  if (!authEp) throw new Error("AS metadata has no authorization_endpoint");
  if (!clientId || !redirectUri || !state || !codeChallenge) throw new Error("clientId/redirectUri/state/codeChallenge required");
  const u = new URL(authEp);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (scope) u.searchParams.set("scope", scope);
  if (resource) u.searchParams.set("resource", resource);
  return u.toString();
}

async function tokenPost(tokenEndpoint, params, { clientId = "", clientSecret = "" } = {}) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA };
  if (clientId && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  const res = await fetch(tokenEndpoint, { method: "POST", headers, body: new URLSearchParams(params).toString() });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (!json?.access_token) throw new Error(`token response missing access_token: ${text.slice(0, 300)}`);
  return json;
}

/** Exchange an authorization code for tokens (PKCE). Pass verifier="" for providers without PKCE (e.g. Reddit). */
export function exchangeCode(tokenEndpoint, { code, redirectUri, verifier, clientId = "", clientSecret = "" } = {}) {
  return tokenPost(tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(verifier ? { code_verifier: verifier } : {}),
    ...(clientId ? { client_id: clientId } : {}),
  }, { clientId, clientSecret });
}

/** Refresh an access token. Returns new token JSON. */
export function refreshAccessToken(tokenEndpoint, { refreshToken, clientId = "", clientSecret = "", scope = "" } = {}) {
  return tokenPost(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(scope ? { scope } : {}),
    ...(clientId ? { client_id: clientId } : {}),
  }, { clientId, clientSecret });
}

/** OAuth-aware probe for an MCP HTTP server. Tries bearer token if provided,
 *  else unauthenticated; on 401 runs discovery and reports DCR support. */
export async function probeMcpHttp(serverUrl, { token = "" } = {}) {
  const headers = { "User-Agent": UA, Accept: "application/json, text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let status = null;
  let www = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(serverUrl, { headers, signal: ctrl.signal, redirect: "follow" });
      status = res.status;
      www = res.headers.get("www-authenticate");
      if (res.ok) return { ok: true, status, hint: token ? "HTTP reachable with bearer token" : "HTTP reachable (no auth required)" };
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    return { ok: false, status: status ?? 0, hint: `unreachable: ${String(err.message).slice(0, 160)}` };
  }
  if (status === 401 || status === 403) {
    const discovery = await discoverOAuth(serverUrl);
    const suffix = discovery.dcrSupported
      ? "OAuth required — DCR supported. Use Discover OAuth → Register → Authorize."
      : discovery.asMetadata
        ? "OAuth required — register a client manually, then Authorize."
        : "Auth required — set a bearer token (tokenEnv) or check provider docs.";
    return {
      ok: false, status, oauth: Boolean(discovery.asMetadata || www),
      wwwAuthenticate: www, discovery,
      hint: `HTTP ${status}. ${suffix}`,
    };
  }
  return { ok: false, status, hint: `HTTP ${status}` };
}

// Access control for the headless Control Room.
// Local access (real loopback socket + local Host, no proxy headers) is allowed.
// Remote access via public tunnel needs a session cookie (minted by proving
// CONTROL_TOKEN to POST /api/control/login) or Bearer CONTROL_TOKEN auth.
// Never trust X-Forwarded-For to claim locality; never put secrets in URLs;
// the token value itself is never logged, never sent to the model, and never
// rendered by the frontend.
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackIp(ip) {
  if (!ip) return false;
  const h = String(ip).trim().replace(/^\[|\]$/g, "");
  return LOOPBACK_IPS.has(h) || h.toLowerCase() === "localhost";
}

/** Real socket peer address via @hono/node-server getConnInfo (verified
 *  against node_modules/@hono/node-server/dist/conninfo.mjs: reads
 *  c.env.incoming.socket.remoteAddress). Falls back to the raw env socket,
 *  then — only when no real socket exists (unit-test fakeCtx / app.request
 *  without Env) — to the legacy c.env.remoteAddr test injection. Never
 *  reads X-Forwarded-For here: proxy headers are untrusted input, not identity. */
export function realSocketIp(c) {
  try {
    const info = getConnInfo(c);
    const addr = info?.remote?.address;
    if (addr) return String(addr);
  } catch { /* no node-server bindings (unit tests) */ }
  try {
    const s =
      c?.env?.incoming?.socket?.remoteAddress ||
      c?.env?.server?.incoming?.socket?.remoteAddress ||
      c?.env?.server?.socket?.remoteAddress ||
      "";
    if (s) return String(s);
  } catch { /* ignore */ }
  try {
    if (!c?.env?.incoming && !c?.env?.server) {
      const t = c?.env?.remoteAddr || "";
      if (t) return String(t);
    }
  } catch { /* ignore */ }
  return "";
}

const FORWARDED_HEADERS = [
  "x-forwarded-for", "x-real-ip", "cf-connecting-ip",
  "x-forwarded-host", "forwarded", "x-forwarded-proto", "via",
];

/** Any proxy/tunnel header present means the request came through a proxy —
 *  it must never count as direct-local, even with a loopback socket
 *  (cloudflared terminates on loopback with a public Host). */
export function hasForwardedHeaders(c) {
  try {
    for (const h of FORWARDED_HEADERS) {
      if ((c.req.header(h) || "").trim()) return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function requestHost(c) {
  try {
    const h = (c.req.header("host") || "").trim();
    if (h) return h.toLowerCase();
    const u = new URL(c.req.url);
    if (u.host) return u.host.toLowerCase();
  } catch { /* ignore */ }
  return "";
}

/** Local Host only: localhost / 127.0.0.1 / [::1], any port. */
export function isLocalHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return false;
  try {
    const hn = new URL(`http://${h}`).hostname;
    return hn === "localhost" || hn === "127.0.0.1" || hn === "::1";
  } catch {
    const bare = h.split(":")[0].replace(/^\[|\]$/g, "");
    return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
  }
}

/** Local bypass ONLY when the real socket is loopback AND the Host is local
 *  AND no proxy headers are present. A public tunnel dials a loopback socket
 *  but carries a public Host + forwarded headers -> remote. Spoofed
 *  X-Forwarded-For claiming 127.0.0.1 with a remote socket -> remote.
 *  Legacy fallback (no real socket: unit-test fakeCtx): header/env heuristic
 *  so existing unit tests without socket injection keep working. */
export function isLoopback(c) {
  const sock = realSocketIp(c);
  if (sock) {
    if (!isLoopbackIp(sock)) return false;
    if (hasForwardedHeaders(c)) return false;
    return isLocalHost(requestHost(c));
  }
  let fwd = "";
  try { fwd = (c.req.header("x-forwarded-for") || "").split(",")[0].trim(); } catch {}
  let rip = "";
  try { rip = (c.req.header("x-real-ip") || "").trim(); } catch {}
  const ip = fwd || rip || c?.env?.remoteAddr || "";
  if (!ip) return true;
  return isLoopbackIp(ip);
}

export function controlToken() {
  return (process.env.CONTROL_TOKEN || "").trim();
}

export function tokenRequired() {
  return controlToken().length > 0;
}

function bearerToken(c) {
  const h = c.req.header("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

/** Timing-safe token comparison. Never logs or returns the expected value. */
export function verifyToken(provided) {
  const expect = controlToken();
  if (!expect || provided == null) return false;
  const p = String(provided);
  if (!p) return false;
  const a = Buffer.from(p);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

export function checkToken(c) {
  return verifyToken(bearerToken(c));
}

/** Central auth: every private API route (all methods, reads included) goes
 *  through here via middleware in src/headless-dashboard.js.
 *  - local (strict isLoopback): allowed; mutations still need same-origin.
 *  - remote with valid session cookie: allowed; mutations need same-origin.
 *  - remote with valid Bearer: allowed; Origin checked when present.
 *  - remote otherwise: fail closed (403 no token configured, else 401). */
export function requireAuth(c) {
  const m = (c.req.method || "GET").toUpperCase();
  const isSafe = m === "GET" || m === "HEAD" || m === "OPTIONS";
  if (isLoopback(c)) {
    if (!isSafe) {
      const o = originCheck(c);
      if (!o.ok) return o;
    }
    return { ok: true, via: "local" };
  }
  if (hasValidSession(c)) {
    if (!isSafe) {
      const o = originCheck(c);
      if (!o.ok) return o;
    }
    return { ok: true, via: "session" };
  }
  if (checkToken(c)) {
    const o = originCheck(c);
    if (!o.ok) return o;
    return { ok: true, via: "bearer" };
  }
  if (!tokenRequired()) {
    return { ok: false, status: 403, error: "remote access disabled: set CONTROL_TOKEN env to allow tunnel access" };
  }
  return { ok: false, status: 401, error: "unauthorized: login with CONTROL_TOKEN or provide Bearer CONTROL_TOKEN" };
}

/** Back-compat guards (route modules call these; central middleware enforces
 *  the same requireAuth semantics). */
export function mutationGuard(c) {
  return requireAuth(c);
}
/** Session-aware guard (back-compat alias of requireAuth). */
export function sessionGuard(c) {
  return requireAuth(c);
}

/** Config guard: secret VALUES never leave the server, and secret-looking
 *  KEYS are fully masked as "••••••" (no last-4 suffix — suffixes are still
 *  secret material). keyEnv holds env VAR NAMES (e.g. "MUSE_KEY"), not
 *  secret values — safe to keep. */
const SECRET_VALUE_RE = /^(sk-|sk_|sk-ant|muse-|xox[baprs]?-|ghp_|gho_|ghu_|AKIA|AIza|eyJ[A-Za-z0-9_-]{10,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const SECRET_KEY_FRAGMENTS = [
  "secret", "password", "passwd", "passphrase", "token",
  "apikey", "bearer", "privatekey", "clientsecret",
  "credential", "signingkey", "webhook", "sessionsecret",
];
function isSecretKey(k) {
  if (k === "keyEnv") return false;
  const n = String(k).toLowerCase().replace(/[_-]+/g, "");
  if (n === "keyenv") return false;
  for (const f of SECRET_KEY_FRAGMENTS) {
    if (n.includes(f)) return true;
  }
  if (/(_key|-key|Key)$/.test(String(k))) return true;
  if (/(token|secret|password|passwd|auth|bearer|credential)$/i.test(String(k))) return true;
  return false;
}
export function redactConfig(doc) {
  if (!doc || typeof doc !== "object") return doc;
  if (Array.isArray(doc)) return doc.map(redactConfig);
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "keyEnv") { out[k] = v; continue; } // env var NAME, not a secret
    if (typeof v === "string" && v && (isSecretKey(k) || SECRET_VALUE_RE.test(v))) {
      out[k] = "••••••";
    } else if (v && typeof v === "object") {
      out[k] = redactConfig(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Same-origin check for browser requests. Enforced for mutations even when
 *  no token is set (DNS-rebinding defense). The Origin/Referer must match
 *  the ACTUAL request Host exactly (host+port) — an arbitrary
 *  attacker-controlled localhost:other-port does NOT pass. Non-browser
 *  clients (no Origin/Referer, e.g. curl) pass. A configured
 *  CONTROL_ALLOWED_ORIGIN may additionally allow the public tunnel origin. */
export function originCheck(c) {
  let origin = "";
  let referer = "";
  try { origin = (c.req.header("origin") || "").trim(); } catch {}
  try { referer = (c.req.header("referer") || "").trim(); } catch {}
  if (!origin && !referer) return { ok: true };
  const host = requestHost(c);
  try {
    const oUrl = new URL(origin || referer);
    if (host && oUrl.host.toLowerCase() === host) return { ok: true };
    const allowed = (process.env.CONTROL_ALLOWED_ORIGIN || "").trim();
    if (allowed) {
      try {
        if (oUrl.origin === new URL(allowed).origin) return { ok: true };
      } catch { /* fall through */ }
      if ((origin || referer) === allowed) return { ok: true };
    }
    return { ok: false, status: 403, error: "origin not allowed" };
  } catch {
    return { ok: false, status: 403, error: "origin not allowed" };
  }
}

export function auditActor(c) {
  if (isLoopback(c)) return "local";
  const sock = realSocketIp(c);
  let fwd = "";
  try { fwd = (c.req.header("x-forwarded-for") || "").split(",")[0].trim(); } catch {}
  return `remote:${sock || fwd || "tunnel"}`;
}

/** Session cookies: random ids, HttpOnly + SameSite=Lax (+ Secure on https).
 *  The CONTROL_TOKEN value itself is never stored, logged, or returned —
 *  only the random session id maps server-side. Remote browsers get a usable
 *  same-origin cookie (set on the tunnel host they already use), so no
 *  cross-origin cookie transfer is needed. Frontend integration: fetch with
 *  credentials: "same-origin"; mutations then authenticate via cookie.
 *  The token never appears in JS, logs, model context, or config payloads. */
const _sessions = new Map(); // id -> { createdAt, lastSeen, via }
const SESSION_TTL_MS = 12 * 3600 * 1000;
function pruneSessions() {
  if (_sessions.size < 500) return;
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, v] of _sessions) if (v.createdAt < cutoff) _sessions.delete(k);
}
function mintSessionRecord(via) {
  const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  _sessions.set(id, { createdAt: Date.now(), lastSeen: Date.now(), via });
  pruneSessions();
  return { ok: true, sessionId: id, via };
}
/** Local-only mint (back-compat for existing callers/tests). */
export function mintLocalSession(c) {
  if (!isLoopback(c)) return { ok: false, status: 403, error: "login is local-only" };
  return mintSessionRecord("local");
}
/** Login: local sockets mint freely (same-origin checked); remote callers
 *  must prove CONTROL_TOKEN in the POST body (timing-safe). Fail closed when
 *  no CONTROL_TOKEN is configured. */
export function loginSession(c, providedToken = "") {
  if (isLoopback(c)) {
    const o = originCheck(c);
    if (!o.ok) return o;
    return mintSessionRecord("local");
  }
  if (!tokenRequired()) {
    return { ok: false, status: 403, error: "remote login disabled: set CONTROL_TOKEN env to allow tunnel access" };
  }
  if (!verifyToken(providedToken)) {
    return { ok: false, status: 401, error: "unauthorized: invalid CONTROL_TOKEN" };
  }
  const o = originCheck(c);
  if (!o.ok) return o;
  return mintSessionRecord("token");
}
export function hasValidSession(c) {
  let cookie = "";
  try { cookie = c.req.header("cookie") || ""; } catch { return false; }
  const m = /(?:^|;\s*)tab_session=([^;]+)/.exec(cookie);
  if (!m) return false;
  let id = "";
  try { id = decodeURIComponent(m[1].trim()); } catch { return false; }
  const e = _sessions.get(id);
  if (!e) return false;
  if (Date.now() - e.createdAt > SESSION_TTL_MS) { _sessions.delete(id); return false; }
  e.lastSeen = Date.now();
  return true;
}
function isSecureRequest(c) {
  try {
    const proto = (c.req.header("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
    if (proto === "https") return true;
    if (proto === "http") return false;
  } catch {}
  try {
    if (new URL(c.req.url).protocol === "https:") return true;
  } catch {}
  return false;
}
export function sessionCookieHeader(sessionId, c) {
  const secure = c ? isSecureRequest(c) : false;
  return `tab_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? "; Secure" : ""}`;
}
export function clearSessionCookieHeader(c) {
  const secure = c ? isSecureRequest(c) : false;
  return `tab_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
export function revokeSession(c) {
  try {
    const cookie = c.req.header("cookie") || "";
    const m = /(?:^|;\s*)tab_session=([^;]+)/.exec(cookie);
    if (m) _sessions.delete(decodeURIComponent(m[1].trim()));
  } catch {}
  return { ok: true };
}

export function shaShort(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

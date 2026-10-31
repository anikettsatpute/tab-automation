// Jobs API: enqueue/status/cancel endpoints. All launches return 202 fast
// (job accepted); the worker reconciles results. Idempotency keys dedupe.
import { enqueueJobSync, getJobRow, listJobRows, requestJobCancel, audit } from "../db.js";
import { auditActor, loginSession, sessionCookieHeader, clearSessionCookieHeader, revokeSession } from "../services/access.js";

// Per-route guards are back-compat defense-in-depth; the central middleware
// in src/headless-dashboard.js already enforces requireAuth on every
// /api/control/* route (all methods). Keep these so the routes stay safe if
// mounted elsewhere.
async function guard(c) {
  const { requireAuth } = await import("../services/access.js");
  return requireAuth(c);
}
// Remote login: browser supplies CONTROL_TOKEN via a secure form (POST body,
// never a URL). Compared timing-safe server-side; on success the server mints
// a random HttpOnly SameSite=Lax (+Secure on https) session cookie scoped to
// THIS origin — no cross-origin cookie transfer needed. Local browsers (real
// loopback socket + local Host) mint without typing the token. Fail closed
// when no CONTROL_TOKEN is configured. The token value is never logged,
// never returned, never rendered.

export function registerJobRoutes(app, ctx) {
  const { root, cfg, log } = ctx;

  app.get("/api/control/jobs", (c) => {
    try {
      const { status, kind, limit } = c.req.query();
      return c.json({ ok: true, jobs: listJobRows(root, { status: status || null, kind: kind || null, limit: Math.min(Number(limit) || 50, 200) }) });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.get("/api/control/jobs/:id", (c) => {
    try {
      const j = getJobRow(root, c.req.param("id"));
      if (!j) return c.json({ error: "not found" }, 404);
      let payload = {};
      try { payload = JSON.parse(j.payload || "{}"); } catch {}
      return c.json({ ok: true, job: { ...j, payload } });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/jobs", async (c) => {
    const g = guard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const b = await c.req.json().catch(() => ({}));
      const { kind, payload = {}, idempotencyKey = null, maxAttempts = 3 } = b;
      if (!kind) return c.json({ error: "kind required (request|loop-task|automation|requeue|chat)" }, 400);
      const t0 = Date.now();
      const { id, deduped, job } = enqueueJobSync(root, { kind, payload, idempotencyKey, maxAttempts });
      audit(root, { actor: auditActor(c), action: deduped ? "job.deduped" : "job.enqueue", target: id, detail: `${kind} ${Date.now() - t0}ms` });
      try { log?.(`[jobs] enqueue ${kind} -> ${id}${deduped ? " (deduped)" : ""}`); } catch {}
      return c.json({ ok: true, jobId: id, deduped: !!deduped, status: job.status, acceptedMs: Date.now() - t0 }, deduped ? 200 : 202);
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/login", async (c) => {
    try {
      const b = await c.req.json().catch(() => ({}));
      const r = loginSession(c, b?.token || b?.controlToken || "");
      if (!r.ok) return c.json({ error: r.error }, r.status);
      audit(root, { actor: auditActor(c), action: "session.login", target: "session", detail: `cookie minted via=${r.via}` });
      c.header("Set-Cookie", sessionCookieHeader(r.sessionId, c));
      return c.json({ ok: true, via: r.via });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/logout", async (c) => {
    try {
      revokeSession(c);
      c.header("Set-Cookie", clearSessionCookieHeader(c));
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });

  app.post("/api/control/jobs/:id/cancel", async (c) => {
    const g = guard(c);
    if (!g.ok) return c.json({ error: g.error }, g.status);
    try {
      const ok = requestJobCancel(root, c.req.param("id"));
      audit(root, { actor: auditActor(c), action: "job.cancel", target: c.req.param("id"), detail: ok ? "requested" : "not-cancellable" });
      if (!ok) return c.json({ error: "job not found or not cancellable (already terminal?)" }, 409);
      return c.json({ ok: true, cancelled: true });
    } catch (err) { return c.json({ error: err.message }, 500); }
  });
}

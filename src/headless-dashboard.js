// Headless dashboard — the UX for the headless bot (src/index.js).
// Thin server: route modules in src/routes/* own each API surface.
// The bot owns data/tab-automation.db and runs tasks; this HTTP server gives
// it a visual face: Control Room at /dashboard + JSON feed for runs/steps,
// conversation, approvals.
//
// Enabled via config/dashboard.json { enabled, refreshSec, ... } — the same
// file the setup wizard writes. Port: HEADLESS_PORT || DASHBOARD_PORT || 3001
// (3000 is the setup wizard on a dev PC; on the tablet only headless runs so
// you may set HEADLESS_PORT=3000 there).
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { listRuns, getRun, pendingApprovals } from "./db.js";
import { loadAll } from "./memory.js";
import { getDashboardConfig } from "./dashboard-db.js";
import { loadJson } from "./setup-api.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerLoopTaskRoutes } from "./routes/loop-tasks.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerLoopRoutes } from "./routes/loop.js";
import { registerMcpRoutes } from "./routes/mcp.js";

const DEFAULT_ROOT = process.cwd();

export function createHeadlessApp(cfg, { root = cfg?.root || DEFAULT_ROOT, log = console.log } = {}) {
  const app = new Hono();
  const distDash = path.join(root, "dist-dashboard");
  const ctx = { root, cfg, log };

  // Public, harmless endpoints: health + static Control Room shell (the HTML
  // itself carries no data; the browser login form posts CONTROL_TOKEN to
  // /api/control/login, which mints a same-origin HttpOnly session cookie).
  app.get("/api/health", (c) => c.json({
    ok: true, at: new Date().toISOString(), service: "headless",
    workflows: (cfg.workflows || []).length, agents: cfg.agents ? [...cfg.agents.keys()].length : 0,
  }));

  // Central access middleware: every /api/control/* route (ALL methods —
  // private reads included) plus the private /api/feed + /api/dashboard reads
  // require auth. Public reads stay open: /api/health, /api/dashboard/config
  // (refresh cadence only), /api/dashboard (tool/workflow inventory, no runs).
  // Login/logout are explicitly public (they ARE the auth handshake).
  app.use(async (c, next) => {
    const p = c.req.path;
    if (c.req.method === "OPTIONS") return next();
    // Public handshake: login/logout mint/revoke sessions; auth/status tells
    // the browser login form whether a token is configured and whether this
    // request is local (no secrets in the response).
    if (p === "/api/control/login" || p === "/api/control/logout" || p === "/api/control/auth/status") return next();
    const isPrivate =
      p === "/api/control" || p.startsWith("/api/control/") ||
      p === "/api/feed" || p.startsWith("/api/feed/") ||
      p === "/api/dashboard" || p.startsWith("/api/dashboard/");
    if (!isPrivate) return next();
    // /api/dashboard/config is the public refresh-cadence doc; the run feed
    // /api/dashboard (inventory + recent runs) stays private.
    if (p === "/api/dashboard/config") return next();
    const { requireAuth } = await import("./services/access.js");
    const g = requireAuth(c);
    if (!g.ok) return c.json({ error: g.error, authRequired: true, via: null }, g.status);
    c.set("authVia", g.via);
    return next();
  });

  app.get("/api/dashboard/config", (c) => {
    let dashCfg = { enabled: true, refreshSec: 3 };
    try { dashCfg = getDashboardConfig(root, loadJson); } catch { /* defaults */ }
    return c.json(dashCfg);
  });

  app.get("/api/dashboard", (c) => {
    try {
      const tools = loadJson("config/tools.json", { servers: [] });
      const workflows = loadJson("config/workflows.json", { workflows: [] });
      const runs = listRuns(root, { limit: 10 });
      const approvals = pendingApprovals(root);
      return c.json({
        enabled: true,
        at: new Date().toISOString(),
        source: "headless-local",
        servers: (tools.servers ?? []).map((s) => ({ id: s.id, transport: s.transport, authStatus: s.authStatus || "ok" })),
        workflows: (workflows.workflows ?? []).map((w) => ({ id: w.id, trigger: w.trigger?.type || "manual" })),
        runs: runs.slice(0, 10),
        approvals: approvals.slice(0, 10),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/feed", async (c) => {
    try {
      const limit = Math.min(Number(c.req.query("limit")) || 8, 20);
      const baseRuns = listRuns(root, { limit });
      const runs = baseRuns.map((r) => {
        let full = r;
        try { full = getRun(root, r.id) || r; } catch { /* keep base */ }
        let trigger = {};
        try { trigger = JSON.parse(full.trigger_json || "{}"); } catch { /* ignore */ }
        return {
          id: full.id, workflowId: full.workflow_id, kind: full.kind, status: full.status,
          startedAt: full.started_at, finishedAt: full.finished_at, error: full.error,
          trigger: { text: trigger.text || "", user: trigger.user || "", kind: trigger.kind || full.kind, channelId: trigger.channelId || "" },
          steps: (full.steps || []).map((s) => ({
            id: s.step_id, type: s.type, agent: s.agent, status: s.status,
            text: String(s.raw_text || "").slice(0, 1200), at: s.created_at,
          })),
        };
      });
      let messages = [];
      try {
        const all = loadAll(root);
        messages = all.filter((e) => ["chat", "reply", "pipeline"].includes(e.kind)).slice(-30).map((e) => ({
          ts: e.ts, kind: e.kind, user: e.user, text: String(e.text || "").slice(0, 800), channelId: e.channelId,
        }));
      } catch { /* memory optional */ }
      const stats = {
        running: runs.filter((r) => r.status === "running").length,
        done: runs.filter((r) => r.status === "done").length,
        failed: runs.filter((r) => r.status === "failed").length,
        total: runs.length,
      };
      return c.json({ enabled: true, at: new Date().toISOString(), source: "headless-local", runs, messages, stats });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get("/api/health", (c) => c.json({
    ok: true, at: new Date().toISOString(), service: "headless",
    workflows: (cfg.workflows || []).length, agents: cfg.agents ? [...cfg.agents.keys()].length : 0,
  }));
  // Auth status: public, no secrets. Tells the browser login form whether a
  // token is configured and whether this request is local (local browsers
  // can mint a session without typing the token; remote browsers must).
  // Also reports whether THIS request already carries a valid session so an
  // authed remote browser doesn't get stuck at the gate.
  app.get("/api/control/auth/status", async (c) => {
    const { tokenRequired, isLoopback, hasValidSession } = await import("./services/access.js");
    const local = isLoopback(c);
    const authed = local || hasValidSession(c);
    return c.json({ ok: true, tokenRequired: tokenRequired(), local, authed, via: c.get("authVia") || null });
  });

  // Route modules — one file per surface, shared ctx { root, cfg, log }.
  registerConfigRoutes(app, ctx);
  registerLoopTaskRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerRequestRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerLoopRoutes(app, ctx);
  registerMcpRoutes(app, ctx);

  return { app, root, cfg, log };
}

export async function startHeadlessDashboard(cfg, { log = console.log, worker = true } = {}) {
  const root = cfg?.root || DEFAULT_ROOT;
  let dashCfg = { enabled: true, refreshSec: 3 };
  try { dashCfg = getDashboardConfig(root, loadJson); } catch { /* defaults */ }
  if (!dashCfg.enabled) {
    log("[dashboard] disabled via config/dashboard.json — skipping HTTP server");
    return null;
  }
  const { app } = createHeadlessApp(cfg, { root, log });

  // Worker lifecycle: durable queue claims + startup/periodic scanner.
  // Started with the dashboard so Control Room launches always make progress.
  // Pass { worker: false } for isolated browser/test runs without the bot.
  if (worker) {
    try {
      const { startWorker } = await import("./services/worker.js");
      // Pass through live deps (notably sendDiscord) so worker
      // discord_send steps + completion delivery use the real client.
      // startHeadlessDashboard callers pass { sendDiscord } via cfg deps.
      const wdeps = { log };
      if (cfg?.sendDiscord && typeof cfg.sendDiscord === "function") wdeps.sendDiscord = cfg.sendDiscord;
      startWorker(cfg, wdeps);
    } catch (err) {
      log(`[dashboard] worker start skipped: ${err.message}`);
    }
    // OrchestratorLoop engine: always auto, one step at a time.
    try {
      const { startEngine } = await import("./loop/engine.js");
      startEngine({ ...cfg, root }, { log });
    } catch (err) {
      log(`[dashboard] loop engine start skipped: ${err.message}`);
    }
  }

  // static Control Room build
  const distDash = path.join(root, "dist-dashboard");
  app.get("/dashboard/assets/:file", (c) => {
    const file = path.join(distDash, "assets", c.req.param("file"));
    if (!existsSync(file)) return c.json({ error: "not found" }, 404);
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    return c.body(readFileSync(file), 200, { "Content-Type": type });
  });
  app.get("/dashboard", (c) => {
    const index = path.join(distDash, "index.html");
    if (existsSync(index)) return c.html(readFileSync(index, "utf-8"));
    return c.text("dist-dashboard/ missing. Run: npm run dashboard:build", 500);
  });
  app.get("/dashboard/*", (c) => {
    if (c.req.path.includes("/assets/")) return c.json({ error: "not found" }, 404);
    const index = path.join(distDash, "index.html");
    if (existsSync(index)) return c.html(readFileSync(index, "utf-8"));
    return c.text("dist-dashboard/ missing. Run: npm run dashboard:build", 500);
  });
  app.get("/", (c) => c.redirect("/dashboard"));

  const PORT = Number(process.env.HEADLESS_PORT || process.env.DASHBOARD_PORT || 3001);
  const server = serve({ fetch: app.fetch, port: PORT }, () => {
    log(`[dashboard] headless Control Room: http://localhost:${PORT}/dashboard`);
  });
  const close = async () => {
    try { const { stopWorker } = await import("./services/worker.js"); stopWorker(); } catch { /* ignore */ }
    try { const { stopEngine } = await import("./loop/engine.js"); stopEngine(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  };
  return { app, port: PORT, server, close };
}

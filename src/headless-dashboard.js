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

const root = process.cwd();

export function startHeadlessDashboard(cfg, { log = console.log } = {}) {
  let dashCfg = { enabled: true, refreshSec: 3 };
  try { dashCfg = getDashboardConfig(root, loadJson); } catch { /* defaults */ }
  if (!dashCfg.enabled) {
    log("[dashboard] disabled via config/dashboard.json — skipping HTTP server");
    return null;
  }
  const app = new Hono();
  const distDash = path.join(root, "dist-dashboard");
  const ctx = { root, cfg, log };

  app.get("/api/dashboard/config", (c) => c.json(dashCfg));

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

  // Route modules — one file per surface, shared ctx { root, cfg, log }.
  registerConfigRoutes(app, ctx);
  registerLoopTaskRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerRequestRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);

  // static Control Room build
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
  serve({ fetch: app.fetch, port: PORT }, () => {
    log(`[dashboard] headless Control Room: http://localhost:${PORT}/dashboard`);
  });
  return { port: PORT };
}

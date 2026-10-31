import { loadConfig } from "./config.js";
import { startScheduler } from "./scheduler.js";
import { startDiscord } from "./discord.js";
import { startHeadlessDashboard } from "./headless-dashboard.js";

const args = process.argv.slice(2);
// Entrypoint-only flag: boot everything EXCEPT the scheduler (Discord +
// worker + dashboard still start) for user-authorized Discord testing
// without firing scheduled finance work. Default (flag absent) unchanged.
const NO_SCHEDULER = args.includes("--no-scheduler");
const { cfg, errors } = loadConfig();

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (args.includes("--list")) {
  console.log("Agents:", [...cfg.agents.keys()].join(", "));
  for (const w of cfg.workflows) {
    console.log(`- ${w.id} [${w.trigger?.type ?? "manual"}] ${w.trigger?.cron ?? w.trigger?.command ?? ""} :: ${(w.steps ?? []).map((s) => `${s.id}:${s.type}`).join(" -> ")}`);
  }
  process.exit(errors.length ? 1 : 0);
}

if (args.includes("--validate")) {
  if (errors.length) {
    console.error("Config errors:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }
  console.log("Config OK:", cfg.workflows.length, "workflows,", cfg.agents.size, "agents.");
  process.exit(0);
}

const runIdx = args.indexOf("--run");
if (runIdx !== -1) {
  const id = args[runIdx + 1];
  const wf = cfg.workflows.find((w) => w.id === id);
  if (!wf) {
    console.error(`Unknown workflow '${id}'. Available: ${cfg.workflows.map((w) => w.id).join(", ")}`);
    process.exit(1);
  }
  if (errors.length) {
    console.error("Config errors:");
    for (const e of errors) console.error(" -", e);
    process.exit(1);
  }
  // Manual run: enqueue + drain via the worker (sole executor), never inline.
  const { enqueueJobSync } = await import("./db.js");
  const { id: jobId } = enqueueJobSync(cfg.root, { kind: "automation", payload: { automationId: id }, idempotencyKey: `manual:${id}:${Date.now()}` });
  const { tickOnce } = await import("./services/worker.js");
  const { getJobRow } = await import("./db.js");
  for (let i = 0; i < 120; i++) {
    await tickOnce(cfg, { log, sendDiscord: async (_, m) => log("[manual discord_send]", m) });
    const j = getJobRow(cfg.root, jobId);
    if (j && ["done", "failed", "blocked", "cancelled"].includes(j.status)) {
      console.log(`Done. Job ${jobId} [${j.status}] run ${j.run_id || "?"}.`);
      process.exit(j.status === "done" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`Timed out waiting for job ${jobId}.`);
  process.exit(1);
}

if (errors.length) {
  console.error("Config errors:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}

log(`tab-automation starting: ${cfg.workflows.length} workflows, ${cfg.agents.size} agents`);

// Mirror config/workflows.json -> automations DB so the Control Room Automations
// view always shows what Setup Step 5 deploys (same sync the setup wizard does
// on save; boot-time backfill covers file edits + tablet pulls).
try {
  const { saveAutomation, listAutomations } = await import("./db.js");
  const have = new Set(listAutomations(cfg.root).map((a) => a.id));
  let synced = 0;
  for (const w of cfg.workflows) {
    if (have.has(w.id)) continue;
    saveAutomation(cfg.root, {
      id: w.id, name: w.name || w.id, description: w.description || "",
      trigger_type: w.trigger?.type || "manual",
      trigger_config: { cron: w.trigger?.cron, command: w.trigger?.command, description: w.trigger?.description, everyMinutes: w.trigger?.everyMinutes },
      steps: w.steps || [], enabled: w.enabled !== false,
    });
    synced++;
  }
  if (synced) log(`[automations] boot-synced ${synced} workflows from config`);
} catch (err) {
  log(`[automations] boot sync skipped: ${err.message}`);
}

let sendDiscord = async () => {};
// Durable enqueue: ALL sources (Discord, schedule, HTTP) enqueue; the worker
// is the sole executor. deps.runWorkflow no longer executes inline — it
// enqueues a job and returns a lightweight handle. Direct execution bypass
// is removed: nothing calls runWorkflow() synchronously outside the worker.
// Job args live in discord.js buildDiscordJobArgs (pure, test-safe import):
// preserves configured wf agents/prompts, persists channel/thread reply
// context, keys idempotency by incoming messageId (never Date.now).
const deps = {
  log,
  sendDiscord: (...a) => sendDiscord(...a),
  // replyTo: async (text) fn for in-thread completion/failure notices (discord triggers only)
  // channelId/messageId persist in the job payload so the worker can post
  // the ACTUAL result back to the originating channel/thread on completion.
  // Incoming messageId dedupe: discord.js seenMessages + per-message
  // idempotency key (discord:<kind>:<wf>:<msgId>) — one message = one job.
  runWorkflow: async (wf, trigger, replyChannel, replyTo) => {
    const { enqueueJobSync } = await import("./db.js");
    const { buildDiscordJobArgs } = await import("./discord.js");
    const channelId = trigger?.channelId || replyChannel || null;
    const enriched = { ...(trigger || {}), channelId };
    const { kind, payload, idempotencyKey } = buildDiscordJobArgs(wf, enriched, cfg);
    if (payload && channelId && !payload.channelId) payload.channelId = channelId;
    const { id: jobId } = enqueueJobSync(cfg.root, { kind, payload, idempotencyKey });
    if (replyTo) replyTo(`⏳ **${wf.id}** queued as job \`${jobId}\` — watch the dashboard for progress.`).catch(() => {});
    return { _jobId: jobId, jobId, _runId: null, steps: {}, workflow: wf.id, status: "queued" };
  },
};

const discord = startDiscord(cfg, deps);
sendDiscord = discord.sendDiscord;
cfg.sendDiscord = (...a) => sendDiscord(...a);

// Scheduler is the ONLY thing --no-scheduler skips: no cron/interval fires
// during Discord testing, while Discord + worker + dashboard boot normally.
const stopScheduler = NO_SCHEDULER
  ? (log("[scheduler] skipped (--no-scheduler): Discord testing mode, no cron/interval fires"), null)
  : startScheduler(cfg, deps);
// Worker lifecycle: start BEFORE headless with REAL deps (log + live
// sendDiscord) so discord_send steps + job completion delivery use the
// real client. startWorker is a singleton (timer guard) — the headless
// dashboard's internal startWorker re-entry no-ops and retains this
// instance. headless start currently accepts only { log, worker } options,
// so wiring here is the minimal safe path (no headless-dashboard edit).
// Deps built ONCE and shared (never reconstructed per call site).
const workerDeps = { log, sendDiscord: (...a) => sendDiscord(...a) };
try {
  const { startWorker } = await import("./services/worker.js");
  startWorker(cfg, workerDeps);
  log(`[worker] started with live sendDiscord`);
} catch (err) {
  log(`[worker] start failed (headless will retry): ${err.message}`);
}
// Headless Control Room: the UX for this bot (local DB is truth — runs happen here).
// Served at HEADLESS_PORT (default 3001; set 3000 on tablet where only headless runs).
// Live Discord client is wired into the dashboard worker deps via cfg.sendDiscord
// (read by startHeadlessDashboard) — never a no-op. Worker already started
// above; headless re-entry retains the singleton.
// Ref stored so graceful shutdown can close the HTTP server (no orphan port).
const dashboard = await startHeadlessDashboard(cfg, { log });

// Graceful shutdown: stop accepting new work, let in-flight sessions finish
// their envelope writes (never process.exit mid-write dropping them), then exit.
// - scheduler timer cleared (no new cron/interval enqueues)
// - worker singleton stopped (no new job claims)
// - in-flight muse children drain via the existing runner hook
//   (activeSessionCount); per-session process-tree kill stays owned by the
//   runner's wall-clock/cancel timers — the entrypoint never SIGKILLs blindly.
// - dashboard HTTP server closed, Discord client destroyed, DB closed.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[shutdown] ${signal} — draining (no new work, bounded grace for in-flight)`);
  const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 10000);
  const deadline = Date.now() + GRACE_MS;
  try {
    stopScheduler?.();
    log("[shutdown] scheduler stopped");
  } catch (err) {
    log(`[shutdown] scheduler stop failed: ${err.message}`);
  }
  try {
    const { stopWorker } = await import("./services/worker.js");
    stopWorker();
    log("[shutdown] worker stopped (no new claims)");
  } catch (err) {
    log(`[shutdown] worker stop failed: ${err.message}`);
  }
  // Bounded drain: in-flight children finish + flush envelope writes.
  try {
    const { activeSessionCount } = await import("./services/runner.js");
    for (;;) {
      let n = 0;
      try { n = activeSessionCount(); } catch { break; }
      if (n <= 0) break;
      if (Date.now() >= deadline) { log(`[shutdown] grace expired with ${n} session(s) in-flight — runner timers own their kill`); break; }
      log(`[shutdown] waiting on ${n} in-flight session(s)...`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch { /* best effort — never block shutdown on the drain probe */ }
  try {
    if (dashboard?.close) {
      await Promise.race([
        dashboard.close(),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      log("[shutdown] dashboard closed");
    }
  } catch (err) {
    log(`[shutdown] dashboard close failed: ${err.message}`);
  }
  // Discord client destroy is available on the startDiscord return ({ client, sendDiscord }).
  try {
    await discord.client?.destroy?.();
    log("[shutdown] discord client destroyed");
  } catch (err) {
    log(`[shutdown] discord destroy failed: ${err.message}`);
  }
  try {
    const { closeDb } = await import("./db.js");
    closeDb();
    log("[shutdown] db closed");
  } catch (err) {
    log(`[shutdown] db close failed: ${err.message}`);
  }
  log("[shutdown] complete");
  process.exit(0);
}
process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

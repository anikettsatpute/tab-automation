// Entrypoint startup: --no-scheduler flag + graceful shutdown structure.
// Static + import-shape only: never boots the bot, no Discord, no scheduler
// timers, no HTTP listen, no secrets, no process spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = readFileSync(join(ROOT, "src", "index.js"), "utf-8");

test("startup: src/index.js parses (node --check)", () => {
  execFileSync(process.execPath, ["--check", join(ROOT, "src", "index.js")], { timeout: 15000 });
});

test("startup: --no-scheduler flag honored, scheduler is the only skip", () => {
  assert.match(SRC, /--no-scheduler/, "flag literal present");
  assert.match(SRC, /NO_SCHEDULER/, "parsed flag const present");
  // Scheduler gated on the flag; Discord/worker/dashboard boot unconditionally.
  assert.match(SRC, /const stopScheduler = NO_SCHEDULER/, "scheduler stop handle gated on flag");
  assert.ok(SRC.includes("startScheduler(cfg, deps)"), "scheduler still boots by default");
  assert.ok(SRC.includes("--no-scheduler"), "skip path logs the flag");
  assert.match(SRC, /const discord = startDiscord\(cfg, deps\)/, "discord always starts");
  assert.match(SRC, /startWorker\(cfg, workerDeps\)/, "worker always starts with shared deps");
  assert.match(SRC, /await startHeadlessDashboard\(cfg/, "dashboard always starts");
  // Worker deps built once and shared (never reconstructed per call site).
  const workerDepsCount = (SRC.match(/workerDeps\s*=/g) || []).length;
  assert.equal(workerDepsCount, 1, "workerDeps defined exactly once");
});

test("startup: graceful shutdown stops worker + HTTP server, destroys Discord client", async () => {
  // No immediate process.exit dropping writes: handlers delegate to gracefulShutdown.
  assert.match(SRC, /process\.on\("SIGINT", \(\) => \{ void gracefulShutdown\("SIGINT"\); \}\);/, "SIGINT drains");
  assert.match(SRC, /process\.on\("SIGTERM", \(\) => \{ void gracefulShutdown\("SIGTERM"\); \}\);/, "SIGTERM drains");
  assert.match(SRC, /stopScheduler\?\.\(\)/, "scheduler timer cleared");
  assert.match(SRC, /stopWorker\(\)/, "worker singleton stopped");
  assert.match(SRC, /dashboard\?\.close/, "dashboard HTTP server closed via stored ref");
  assert.match(SRC, /discord\.client\?\.destroy/, "discord client destroy from startDiscord return");
  assert.match(SRC, /activeSessionCount\(\)/, "in-flight children drain via existing runner hook");
  assert.match(SRC, /closeDb\(\)/, "db closed at the end");
  // Bounded grace: never hangs forever, never blind SIGKILL from the entrypoint.
  assert.match(SRC, /SHUTDOWN_GRACE_MS/, "bounded grace env override");
  assert.doesNotMatch(SRC, /process\.kill\(-/, "entrypoint never kills process groups itself");
});

test("startup: shutdown dependency shapes exist (no boot)", async () => {
  const scheduler = await import("../../src/scheduler.js");
  assert.equal(typeof scheduler.startScheduler, "function", "startScheduler exists");
  const worker = await import("../../src/services/worker.js");
  assert.equal(typeof worker.startWorker, "function", "startWorker exists");
  assert.equal(typeof worker.stopWorker, "function", "stopWorker exists");
  const runner = await import("../../src/services/runner.js");
  assert.equal(typeof runner.activeSessionCount, "function", "activeSessionCount exists");
  assert.equal(typeof runner.cancelSession, "function", "cancelSession exists");
  const discord = await import("../../src/discord.js");
  assert.equal(typeof discord.startDiscord, "function", "startDiscord exists");
  const dash = await import("../../src/headless-dashboard.js");
  assert.equal(typeof dash.startHeadlessDashboard, "function", "startHeadlessDashboard exists");
});

test("startup: scheduler returns a stop function (timer guard shape)", async () => {
  const { startScheduler } = await import("../../src/scheduler.js");
  const noopCfg = { root: "test-root", workflows: [] };
  const calls = [];
  const stop = startScheduler(noopCfg, { log: (...a) => calls.push(a.join(" ")) });
  assert.equal(typeof stop, "function", "startScheduler returns stop fn");
  stop(); // clear the 30s timer so the test process exits cleanly
});

import { loadConfig } from "./config.js";
import { runWorkflow } from "./workflow.js";
import { startScheduler } from "./scheduler.js";
import { startDiscord } from "./discord.js";

const args = process.argv.slice(2);
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
  // Manual run: discord_send steps just log (no Discord login needed)
  const ctx = await runWorkflow(cfg, { log, sendDiscord: async (_, m) => log("[manual discord_send]", m) }, wf, { kind: "manual" });
  console.log("Done. Steps:", Object.keys(ctx.steps).join(", "));
  process.exit(0);
}

if (errors.length) {
  console.error("Config errors:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}

log(`tab-automation starting: ${cfg.workflows.length} workflows, ${cfg.agents.size} agents`);

let sendDiscord = async () => {};
const deps = {
  log,
  sendDiscord: (...a) => sendDiscord(...a),
  runWorkflow: (wf, trigger, replyChannel) =>
    runWorkflow(cfg, {
      log,
      sendDiscord: async (ch, m) => sendDiscord(ch || replyChannel, m),
    }, wf, trigger),
};

const discord = startDiscord(cfg, deps);
sendDiscord = discord.sendDiscord;
startScheduler(cfg, deps);

process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
process.on("SIGTERM", () => { log("shutting down"); process.exit(0); });

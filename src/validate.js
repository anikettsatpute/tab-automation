import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
const { errors, cfg } = loadConfig();
if (errors.length) {
  console.error("Config errors:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
// SQLite smoke test (node:sqlite needs Node 22+)
try {
  openDb(cfg.root);
  console.log("OK: sqlite persistence ready");
} catch (err) {
  console.error(`Config errors:\n - SQLite unavailable: ${err.message} (need Node >= 22)`);
  process.exit(1);
}
console.log(`OK: ${cfg.agents.size} agents, ${cfg.workflows.length} workflows, ${(cfg.providers ?? []).length} providers`);

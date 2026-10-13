import { loadConfig } from "./config.js";
const { errors, cfg } = loadConfig();
if (errors.length) {
  console.error("Config errors:");
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}
console.log(`OK: ${cfg.agents.size} agents, ${cfg.workflows.length} workflows`);

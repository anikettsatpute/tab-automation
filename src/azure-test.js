import { loadConfig } from "./config.js";
import { chatCompletion } from "./azure.js";

// Usage: node src/azure-test.js [agent] [prompt...]
const { cfg, errors } = loadConfig();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const agent = process.argv[2] || "assistant";
const prompt = process.argv.slice(3).join(" ") || "Reply with exactly: OK";
const out = await chatCompletion(cfg, agent, prompt);
console.log(out);

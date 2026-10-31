// Shared Discord command rules (kept dependency-free so routes can import it
// without pulling in discord.js).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const BUILTIN_COMMANDS = ["remember", "recall", "memory", "history", "run", "todo", "todos", "done", "digest", "remind", "reminders", "automations", "workflows", "list", "pipelines", "pipeline"];
export const COMMAND_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const BINDING_KINDS = ["automation", "pipeline"];

/** Live lookup (read per message, so dashboard saves apply without restart). */
export function findCommandBinding(cfg, cmd) {
  try {
    const p = path.join(cfg.root, "config", "discord.json");
    if (!existsSync(p)) return null;
    return commandBindings(JSON.parse(readFileSync(p, "utf8"))).find((b) => b.command === cmd) || null;
  } catch { return null; }
}

/** Command bindings from config/discord.json: [{ command, kind, target }]. */
export function commandBindings(doc) {
  return (Array.isArray(doc?.commands) ? doc.commands : [])
    .filter((b) => b && COMMAND_RE.test(b.command) && BINDING_KINDS.includes(b.kind) && b.target);
}

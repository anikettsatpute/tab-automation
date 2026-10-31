// .env editor: write-only secrets, allowlisted keys, atomic 0600 writes.
// Secret VALUES never leave the server — callers only get set/unset status.
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";

/** key -> { secret, group, hint }. Provider keyEnv names are added dynamically. */
export const ENV_KEYS = {
  DISCORD_BOT_TOKEN: { secret: true, group: "discord", hint: "Bot token (Developer Portal → Bot → Reset Token). Restart required." },
  DISCORD_APPLICATION_ID: { secret: false, group: "discord", hint: "Application ID" },
  DISCORD_GUILD_ID: { secret: false, group: "discord", hint: "Overrides config guild id" },
  DISCORD_CHANNEL_ID: { secret: false, group: "discord", hint: "Overrides config main channel" },
  DISCORD_OWNER_USER_ID: { secret: false, group: "discord", hint: "Overrides config owner id" },
  DISCORD_LISTEN_CHANNELS: { secret: false, group: "discord", hint: "Comma separated channel ids the bot answers in" },
  FINANCE_CHANNEL_ID: { secret: false, group: "discord", hint: "Finance brief channel" },
  AZURE_OPENAI_ENDPOINT: { secret: false, group: "providers", hint: "https://<resource>.openai.azure.com" },
  AZURE_OPENAI_API_KEY: { secret: true, group: "providers", hint: "Azure OpenAI key" },
  AZURE_OPENAI_DEPLOYMENT: { secret: false, group: "providers", hint: "Default deployment" },
  AZURE_OPENAI_API_VERSION: { secret: false, group: "providers", hint: "e.g. 2024-10-21" },
  MUSE_KEY: { secret: true, group: "providers", hint: "Muse CLI key" },
  CONTROL_TOKEN: { secret: true, group: "access", hint: "Required for remote (tunnel) dashboard access" },
  LOOP_MUSE_SANDBOX: { secret: false, group: "runtime", hint: "'off' disables the Muse sandbox" },
  ROUTER_DISPATCHER: { secret: false, group: "discord", hint: "@mention intent router: muse (default), copilot, or off (keyword routing)" },
  TZ: { secret: false, group: "runtime", hint: "Timezone, e.g. Asia/Kolkata. Restart required." },
};
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_LEN = 4096;

export function allowedKeys(providerKeyEnvs = []) {
  const keys = { ...ENV_KEYS };
  for (const k of providerKeyEnvs) if (k && NAME_RE.test(k) && !keys[k]) keys[k] = { secret: true, group: "providers", hint: "Provider API key (keyEnv)" };
  return keys;
}

const envPath = (root) => path.join(root, ".env");

function fileKeys(file) {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean));
}

/** Status view: never includes secret values. Non-secret values are shown. */
export function envStatus(root, keys) {
  const inEnv = fileKeys(envPath(root));
  const inLocal = fileKeys(path.join(root, ".env.local"));
  return Object.entries(keys).map(([name, k]) => {
    const v = String(process.env[name] ?? "");
    return {
      name, secret: k.secret, group: k.group, hint: k.hint,
      set: v.trim().length > 0,
      source: inEnv.has(name) ? ".env" : inLocal.has(name) ? ".env.local" : v ? "process" : "",
      ...(k.secret ? {} : { value: v }),
    };
  });
}

export function validateEnvValue(value) {
  const v = String(value ?? "");
  if (v.length > MAX_LEN) return `value too long (max ${MAX_LEN})`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) return "value must be a single line without control characters";
  if (v.trim() !== v) return "value must not have leading/trailing whitespace";
  if (v.includes("'")) return "value must not contain a single quote";
  return null;
}

const PLAIN_RE = /^[A-Za-z0-9_.:/@+=,~%-]*$/;
// Anything else is single-quoted: dotenv treats it literally (no #comments, no expansion).
const serialize = (name, v) => `${name}=${PLAIN_RE.test(v) ? v : `'${v}'`}`;

/** Set (value string) or clear (value null) keys in .env, preserving every
 *  other line and comment. Atomic write, mode 0600. Updates process.env. */
export function writeEnv(root, changes) {
  const file = envPath(root);
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [name, value] of Object.entries(changes)) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const idx = lines.findIndex((l) => re.test(l));
    // Drop duplicates so the edited line is the one dotenv reads.
    for (let i = lines.length - 1; i > idx; i--) if (re.test(lines[i])) lines.splice(i, 1);
    if (value === null) { if (idx >= 0) lines.splice(idx, 1); }
    else if (idx >= 0) lines[idx] = serialize(name, value);
    else lines.push(serialize(name, value));
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* non-POSIX fs */ }
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete process.env[name]; else process.env[name] = value;
  }
}

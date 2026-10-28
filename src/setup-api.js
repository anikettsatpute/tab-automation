// Shared setup logic: pure read/write/test helpers for the UX setup wizard
// (src/setup-server.js + setup-app/). No readline here.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const root = process.cwd();

export function loadJson(rel, fallback) {
  const p = path.join(root, rel);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return fallback; }
}

export function saveJson(rel, obj) {
  writeFileSync(path.join(root, rel), JSON.stringify(obj, null, 2) + "\n");
}

export function readEnv() {
  const envPath = path.join(root, ".env");
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Write keys to .env. Never blanks an existing secret unless overwrite=true. */
export function writeEnv(patch, { overwrite = false } = {}) {
  const envPath = path.join(root, ".env");
  let cur = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") continue;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(cur)) {
      if (overwrite) cur = cur.replace(re, `${key}=${value}`);
    } else {
      cur += (cur.endsWith("\n") || !cur ? "" : "\n") + `${key}=${value}\n`;
    }
  }
  writeFileSync(envPath, cur);
}

export function nodeCheck() {
  const major = Number(process.version.slice(1).split(".")[0]);
  return { version: process.version, ok: major >= 22, required: 22 };
}

// ---- tablet DB pull (runs happen on the tablet, not the setup machine) ----
export const TABLET_DB_CACHE = "data/tablet-tab-automation.db";

function adb(...args) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn("adb", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
      child.on("error", (e) => resolve({ code: 127, out: "", err: e.message }));
    });
  });
}

export async function tabletStatus() {
  const r = await adb("devices");
  if (r.code !== 0) return { connected: false, hint: "adb not available: " + r.err.slice(0, 120) };
  const devices = r.out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.endsWith("\tdevice"));
  if (!devices.length) return { connected: false, hint: "no device: connect tablet via USB / adb" };
  return { connected: true, device: devices[0].split("\t")[0], hint: `${devices.length} device(s)` };
}

/** Pull the tablet's SQLite DB into a local cache file. Returns {ok, path?, hint}. */
export async function pullTabletDb() {
  const st = await tabletStatus();
  if (!st.connected) return { ok: false, hint: st.hint };
  // The bot writes to ~/tab-automation/data/ inside Termux. run-as lets us
  // copy it to shared storage, then adb pull fetches it to this machine.
  // NOTE: requires the new code deployed (scripts/deploy-tab.sh) — old
  // tablet builds predate SQLite and have no DB to pull.
  const remote = "/sdcard/tab-automation/data/tab-automation.db";
  const local = path.join(root, TABLET_DB_CACHE);
  await adb("shell", "run-as com.termux sh -c 'cp files/home/tab-automation/data/tab-automation.db /sdcard/tab-automation/data/tab-automation.db 2>/dev/null || cp ~/tab-automation/data/tab-automation.db /sdcard/tab-automation/data/tab-automation.db'");
  const r = await adb("pull", remote, local);
  if (r.code !== 0 || !existsSync(local)) {
    const detail = (r.err || r.out).slice(0, 200);
    if (/no such file/i.test(detail)) {
      return { ok: false, hint: "No DB on tablet yet — deploy the new code (scripts/deploy-tab.sh), run a workflow, then sync again." };
    }
    return { ok: false, hint: "pull failed: " + detail };
  }
  return { ok: true, path: local, hint: "synced from tablet" };
}

export function tabletDbPath() {
  const p = path.join(root, TABLET_DB_CACHE);
  return existsSync(p) ? p : null;
}

export function getState() {
  const env = readEnv();
  const mask = (v) => (v ? "••••••" + String(v).slice(-4) : "");
  return {
    node: nodeCheck(),
    providers: loadJson("config/providers.json", { defaultProvider: "azure", providers: [] }),
    agents: loadJson("config/agents.json", { agents: [] }),
    tools: loadJson("config/tools.json", { servers: [], customTools: [] }),
    discord: loadJson("config/discord.json", { mainChannelId: "", extraChannels: [], ownerUserId: "" }),
    workflows: loadJson("config/workflows.json", { workflows: [] }),
    envKeys: {
      DISCORD_BOT_TOKEN: mask(env.DISCORD_BOT_TOKEN),
      AZURE_OPENAI_ENDPOINT: env.AZURE_OPENAI_ENDPOINT || "",
      AZURE_OPENAI_DEPLOYMENT: env.AZURE_OPENAI_DEPLOYMENT || "",
      AZURE_OPENAI_API_KEY: mask(env.AZURE_OPENAI_API_KEY),
      OPENROUTER_API_KEY: mask(env.OPENROUTER_API_KEY),
      META_API_KEY: mask(env.META_API_KEY),
      DISCORD_CHANNEL_ID: env.DISCORD_CHANNEL_ID || "",
      DISCORD_OWNER_USER_ID: env.DISCORD_OWNER_USER_ID || "",
    },
  };
}

export async function testProvider(p, key) {
  const { buildChatRequest } = await import("./providers.js");
  const resolved = {
    id: p.id, type: p.type,
    endpoint: (p.endpoint || process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, ""),
    apiKey: key, model: p.modelDefault, apiVersion: "2024-10-21",
  };
  const fakeAgent = { id: "_setup_probe", systemPrompt: "x", maxTokens: 5 };
  const { url, headers, body } = buildChatRequest(resolved, fakeAgent, [{ role: "user", content: "ping" }], { withTools: false });
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, hint: res.ok ? "OK" : (await res.text().catch(() => "")).slice(0, 200) };
}

export async function probeMcpStdio(server) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(server.command, server.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(server.env ?? {}) },
      });
    } catch (err) {
      resolve({ ok: false, hint: err.message });
      return;
    }
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.on("error", (err) => resolve({ ok: false, hint: err.message }));
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "setup", version: "0.1" } } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    } catch (err) {
      resolve({ ok: false, hint: err.message });
      return;
    }
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, hint: "No response in 20s" }); }, 20000);
    const check = setInterval(() => {
      if (/"tools"\s*:\s*\[/.test(out)) {
        clearTimeout(t); clearInterval(check);
        try { child.kill(); } catch {}
        resolve({ ok: true, hint: "Server responded to tools/list" });
      }
    }, 500);
  });
}

export async function discordFetch(token, p, opts = {}) {
  const res = await fetch(`https://discord.com/api/v10${p}`, {
    method: opts.method || "GET",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

export function validateOutputSchema(schema) {
  if (!schema || typeof schema !== "object") return "must be an object";
  const keys = Object.keys(schema);
  if (!keys.length) return "must define at least 1 var";
  if (keys.length > 8) return `max 8 vars, got ${keys.length}`;
  for (const k of keys) {
    if (!["bool", "int", "string"].includes(schema[k])) return `var '${k}' must be bool|int|string`;
  }
  return null;
}

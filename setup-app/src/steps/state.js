// Shared setup wizard state, helpers, API client.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const STEPS = [
  { id: "providers", n: "Step 1", t: "Providers" },
  { id: "agents", n: "Step 2", t: "Agents" },
  { id: "tools", n: "Step 3", t: "Tools & MCP" },
  { id: "discord", n: "Step 4", t: "Discord" },
  { id: "automations", n: "Step 5", t: "Automations" },
  { id: "streams", n: "Step 6", t: "Streams" },
  { id: "runs", n: "Step 7", t: "Runs" },
  { id: "verify", n: "Step 8", t: "Verify" },
  { id: "deploy", n: "Step 9", t: "Deploy" },
];

export const S = {
  tab: "providers",
  done: new Set(),
  node: null,
  providers: [],
  defaultProvider: "azure",
  agents: [],
  servers: [],
  customTools: [],
  discord: { mainChannelId: "", extraChannels: [], ownerUserId: "", guildId: "" },
  workflows: [],
  streams: [],
  pipelines: [],
  busy: false,
};

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  try {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, signal: ctrl.signal, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out — server busy or offline. Try again.");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function toast(msg, kind = "ok") {
  $(".toast")?.remove();
  const d = document.createElement("div");
  d.className = `toast ${kind}`;
  d.setAttribute("role", kind === "bad" ? "alert" : "status");
  d.textContent = msg;
  document.body.appendChild(d);
  const st = $("#status");
  if (st) st.textContent = msg;
  setTimeout(() => d.remove(), 4500);
}

export function markDone(id) {
  S.done.add(id);
}

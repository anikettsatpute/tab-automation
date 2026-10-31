// Provider abstraction: azure-foundry | openrouter | meta | muse.
// Agents pick provider + model; secrets stay in .env, non-secrets in config/providers.json.
// muse = Muse CLI headless dispatch (`muse exec --model <id>`); MUSE_KEY in .env.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const PROVIDER_TYPES = ["azure-foundry", "openrouter", "meta", "muse"];

export const DEFAULT_ENDPOINTS = {
  "azure-foundry": "",
  openrouter: "https://openrouter.ai/api/v1",
  meta: "https://api.llama.com/compat/v1",
  muse: "",
};

export const KEY_ENV = {
  "azure-foundry": "AZURE_OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  meta: "META_API_KEY",
  muse: "MUSE_KEY",
};

// Muse CLI model catalog (reference: muse model-profile show <model>).
// Default per user: muse-spark-1.3 contributor. Other options selectable per
// agent in Configuration (agent.model) or per call (dispatch model override).
export const MUSE_MODELS = [
  "muse-spark-1.3",
  "muse-spark-1.2",
  "muse-spark-1.1",
  "muse-spark",
];

export const MUSE_DEFAULT_MODEL = "muse-spark-1.3";

export function resolveMuseApiKey(cfg, agentOrId) {
  const agent = typeof agentOrId === "string" ? cfg?.agents?.get?.(agentOrId) : agentOrId;
  const providers = new Map((cfg?.providers ?? []).map((p) => [p.id, p]));
  const providerId = agent?.provider || cfg?.defaultProvider || "muse";
  const pr = providers.get(providerId);
  const keyEnv = pr?.keyEnv || KEY_ENV.muse;
  const fromEnv = (process.env[keyEnv] ?? "").trim();
  if (fromEnv) return { key: fromEnv, keyEnv };
  const cfgKey = String(cfg?.museKey ?? "").trim();
  if (cfgKey) return { key: cfgKey, keyEnv };
  if (keyEnv !== KEY_ENV.muse) {
    const std = (process.env[KEY_ENV.muse] ?? "").trim();
    if (std) return { key: std, keyEnv: KEY_ENV.muse };
  }
  return { key: "", keyEnv };
}

export function museApiKeyStdinArgs(key) {
  return key ? ["--api-key-stdin"] : [];
}

export function loadProviders(root) {
  const p = path.join(root, "config", "providers.json");
  if (!existsSync(p)) return { providers: [] };
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return { providers: [] };
  }
}

/** Resolve endpoint + auth headers + request shape for an agent. */
export function resolveProvider(cfg, agent) {
  const providers = new Map((cfg.providers ?? []).map((pr) => [pr.id, pr]));
  const providerId = agent?.provider || cfg.defaultProvider || "azure";
  const pr = providers.get(providerId);

  // Muse CLI: no HTTP endpoint — dispatch shells out to `muse exec`.
  // Model: per-call > agent.model > provider.modelDefault > muse-spark-1.3.
  if (pr?.type === "muse" || providerId === "muse") {
    const keyEnv = pr?.keyEnv || KEY_ENV.muse;
    return {
      id: pr?.id || "muse",
      type: "muse",
      endpoint: "",
      apiKey: (process.env[keyEnv] ?? "").trim(),
      model: (agent?.model?.trim() || pr?.modelDefault || MUSE_DEFAULT_MODEL).trim(),
      apiVersion: "",
    };
  }

  // Legacy fallback: top-level cfg.azure (existing behavior preserved)
  if (!pr) {
    return {
      id: "azure",
      type: "azure-foundry",
      endpoint: cfg.azure.endpoint,
      apiKey: cfg.azure.apiKey,
      model: resolveModel(agent, cfg.azure.deployment),
      apiVersion: cfg.azure.apiVersion,
    };
  }
  const keyEnv = pr.keyEnv || KEY_ENV[pr.type] || "";
  // azure-foundry entries may leave endpoint blank in providers.json —
  // fall back to the AZURE_OPENAI_ENDPOINT env so existing installs keep working.
  const endpoint = (pr.endpoint || (pr.type === "azure-foundry" ? cfg.azure.endpoint : DEFAULT_ENDPOINTS[pr.type]) || "").replace(/\/$/, "");
  return {
    id: pr.id,
    type: pr.type,
    endpoint,
    apiKey: (process.env[keyEnv] ?? "").trim(),
    model: resolveModel(agent, pr.modelDefault || cfg.azure.deployment),
    apiVersion: cfg.azure.apiVersion,
  };
}

function resolveModel(agent, fallback) {
  let m = (agent?.model ?? agent?.deployment ?? "").trim();
  if (!m) return fallback;
  if (m.startsWith("env:")) {
    const v = (process.env[m.slice(4)] ?? "").trim();
    return v || fallback;
  }
  return m;
}

/** Build URL + headers for a chat-completions POST. Returns {url, headers, bodyBase}. */
export function buildChatRequest(resolved, agent, messages, { withTools = false, tools = [] } = {}) {
  const isGpt5 = /gpt-5/i.test(resolved.model);
  if (resolved.type === "azure-foundry") {
    const raw = resolved.endpoint;
    const v1Index = raw.indexOf("/openai/v1");
    if (v1Index !== -1) {
      const base = raw.slice(0, v1Index + "/openai/v1".length);
      const body = { model: resolved.model, messages };
      if (withTools) body.tools = tools;
      if (agent.maxTokens) body.max_completion_tokens = agent.maxTokens;
      return {
        url: `${base}/chat/completions`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
        body,
      };
    }
    const body = { messages };
    if (withTools) body.tools = tools;
    if (!isGpt5 && agent.temperature !== undefined) body.temperature = agent.temperature ?? 0.7;
    if (agent.maxTokens) body.max_tokens = agent.maxTokens;
    return {
      url: `${raw}/openai/deployments/${encodeURIComponent(resolved.model)}/chat/completions?api-version=${encodeURIComponent(resolved.apiVersion || "2024-10-21")}`,
      headers: { "Content-Type": "application/json", "api-key": resolved.apiKey },
      body,
    };
  }
  // openrouter + meta: OpenAI-compatible
  const body = { model: resolved.model, messages };
  if (withTools) body.tools = tools;
  if (agent.temperature !== undefined) body.temperature = agent.temperature ?? 0.7;
  if (agent.maxTokens) body.max_tokens = agent.maxTokens;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` };
  if (resolved.type === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/tab-automation";
    headers["X-Title"] = "tab-automation";
  }
  return { url: `${resolved.endpoint}/chat/completions`, headers, body };
}

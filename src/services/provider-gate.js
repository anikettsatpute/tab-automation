// Provider gate: model execution MUST default to Meta Muse CLI
// (muse-spark-1.3 contributor mode on). Respects configured agents and fails
// closed on non-permitted providers — no silent Azure fallback.
import { MUSE_DEFAULT_MODEL } from "../providers.js";

export const PERMITTED_PROVIDER_TYPES = new Set(["muse"]);
export const PERMITTED_MODELS = new Set(["muse-spark-1.3", "muse-spark-1.2", "muse-spark-1.1", "muse-spark"]);

/** Resolve the effective provider for an agent. Throws (fail closed) on non-permitted types.
 *  Model allowlist: only configured Muse models may execute. A per-call or
 *  agent-level model override outside the allowlist is rejected (no fallback). */
export function gateProvider(cfg, agentId, { allowTypes = null } = {}) {
  const agent = cfg.agents.get(agentId);
  if (!agent) throw new Error(`Unknown agent '${agentId}'`);
  const providers = new Map((cfg.providers ?? []).map((p) => [p.id, p]));
  const providerId = agent.provider || cfg.defaultProvider || "muse";
  const pr = providers.get(providerId);
  const type = pr?.type || (providerId === "muse" ? "muse" : providerId);
  const allowed = allowTypes ? new Set(allowTypes) : PERMITTED_PROVIDER_TYPES;
  if (!allowed.has(type)) {
    throw new Error(`Provider '${providerId}' (type '${type}') not permitted for agent '${agentId}'. Allowed: ${[...allowed].join(", ")}. No silent fallback.`);
  }
  const model = (agent.model?.trim() || pr?.modelDefault || MUSE_DEFAULT_MODEL).trim() || MUSE_DEFAULT_MODEL;
  if (!PERMITTED_MODELS.has(model)) {
    throw new Error(`Model '${model}' not permitted for agent '${agentId}'. Allowed: ${[...PERMITTED_MODELS].join(", ")}. No other provider fallback.`);
  }
  return { providerId, type, model, provider: pr || null };
}

/** Validate a per-call model override against the allowlist. Returns the
 *  trimmed model or throws (fail closed). */
export function gateModel(model) {
  const m = String(model || "").trim();
  if (!m) throw new Error("Empty model override");
  if (!PERMITTED_MODELS.has(m)) {
    throw new Error(`Model '${m}' not permitted. Allowed: ${[...PERMITTED_MODELS].join(", ")}. No other provider fallback.`);
  }
  return m;
}

/** Contributor-mode guard: CLI must run with --contributor-mode on. */
export function contributorArgs() {
  return ["--contributor-mode", "on"];
}

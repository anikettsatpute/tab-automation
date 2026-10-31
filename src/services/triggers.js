// Next-run computation + dry-run + event-trigger honesty contracts.
// Timezone-aware via Intl; cron validated with the repo's matchesCron.
import { matchesCron } from "../scheduler.js";

const CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

export function validateCron(cron) {
  const c = String(cron || "").trim();
  if (!CRON_RE.test(c)) return "cron must be 5 fields: m h dom mon dow";
  // Field-level check via matchesCron probe across a day of minutes.
  let hits = 0;
  const base = new Date(2026, 0, 5, 0, 0, 0); // a Monday
  for (let m = 0; m < 24 * 60; m += 5) {
    const d = new Date(base.getTime() + m * 60000);
    try { if (matchesCron(c, d)) hits++; } catch { return "cron fields invalid"; }
  }
  if (!hits) return "cron never fires (no match in 24h probe)";
  return null;
}

/** Next Date after `from` matching cron (minute resolution, capped scan).
 *  Timezone-correct: matchesCron evaluates in the host local zone, so `from`
 *  is interpreted in local wall time. Callers comparing in UTC must convert
 *  (see test: 00:00Z == 05:30 IST same instant). */
export function nextCronRun(cron, from = new Date()) {
  const err = validateCron(cron);
  if (err) return { ok: false, error: err };
  const start = new Date(from.getTime() + 60000);
  start.setSeconds(0, 0);
  for (let m = 0; m < 366 * 24 * 60; m++) {
    const d = new Date(start.getTime() + m * 60000);
    try { if (matchesCron(cron, d)) return { ok: true, at: d, atUTC: d.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local" }; } catch {}
  }
  return { ok: false, error: "no run within a year" };
}

export function describeTrigger(triggerType, cfg = {}) {
  if (triggerType === "schedule") {
    if (cfg.cron) {
      const n = nextCronRun(cfg.cron, new Date());
      return { ok: true, kind: "schedule", cron: cfg.cron, nextRunAt: n.ok ? n.at.toISOString() : null, nextRunError: n.ok ? null : n.error, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local" };
    }
    if (cfg.everyMinutes) {
      const mins = Number(cfg.everyMinutes) || 0;
      if (!(mins > 0)) return { ok: false, error: "everyMinutes must be > 0" };
      return { ok: true, kind: "schedule", everyMinutes: mins, nextRunAt: new Date(Date.now() + mins * 60000).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local" };
    }
    return { ok: false, error: "schedule trigger needs cron or everyMinutes" };
  }
  if (triggerType === "manual") return { ok: true, kind: "manual", nextRunAt: null };
  if (triggerType === "event") {
    // Honest reject: no event bus exists in this codebase. Only a declared
    // allowlist of synthetic dashboard events is accepted; anything else is
    // visibly unavailable, never silently succeeding.
    const rule = String(cfg.eventRule || cfg.event || "").trim();
    const SUPPORTED = ["dashboard.request_created", "dashboard.job_done", "dashboard.job_failed"];
    if (!rule) return { ok: false, error: "event trigger needs eventRule; supported: " + SUPPORTED.join(", ") };
    if (!SUPPORTED.includes(rule)) return { ok: false, error: `unsupported event '${rule}'; supported: ${SUPPORTED.join(", ")}` };
    return { ok: true, kind: "event", eventRule: rule, nextRunAt: null, note: "fires when the dashboard event occurs (no polling)" };
  }
  return { ok: false, error: `unknown trigger type '${triggerType}'` };
}

/** Real non-side-effect dry-run: validates + returns a step-by-step trace.
 *  Never executes agents, HTTP, Discord, or DB writes. */
export function dryRunAutomation(automation) {
  const steps = automation?.steps || [];
  const trace = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const type = String(s.type || "agent");
    const known = ["agent", "run_agent", "task", "create_task", "file_request", "discord_send", "notify", "condition", "subflow", "run_automation", "transform", "delay", "wait", "http", "log", "finance", "web", "remember", "recall", "digest"];
    if (!known.includes(type)) {
      trace.push({ step: s.id || `step-${i + 1}`, type, ok: false, wouldDo: null, error: `unknown step type '${type}'` });
      continue;
    }
    trace.push({ step: s.id || `step-${i + 1}`, type, ok: true, wouldDo: describeStep(s), error: null });
  }
  const errors = trace.filter((t) => !t.ok);
  return { ok: errors.length === 0, steps: trace.length, trace, note: "dry-run: no side effects executed" };
}

function describeStep(s) {
  const type = String(s.type || "agent");
  if (type === "agent" || type === "run_agent") return `run agent '${s.agent || "assistant"}' with prompt (${String(s.prompt || "").length} chars)`;
  if (type === "discord_send" || type === "notify") return `send Discord message (${String(s.message || "").length} chars) — SKIPPED in dry-run`;
  if (type === "http") return `${(s.method || "GET").toUpperCase()} ${s.url || "(no url)"} — SKIPPED in dry-run`;
  if (type === "condition") return `branch on condition ${JSON.stringify(s.condition || {}).slice(0, 120)}`;
  if (type === "subflow" || type === "run_automation") return `run subflow '${s.workflow || s.automation || ""}'`;
  if (type === "delay" || type === "wait") return `wait ${s.ms ?? s.seconds ?? 1}s`;
  if (type === "task" || type === "create_task") return `create tasks from ${s.from ? `'${s.from}'` : "inline list"}`;
  if (type === "file_request") return `file request/reminder — SKIPPED in dry-run`;
  return `${type} step '${s.id || ""}'`;
}

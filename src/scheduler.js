// Minimal 5-field cron matcher: "m h dom mon dow" — supports * , - / and lists.
export function matchesCron(cron, date = new Date()) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const vals = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  const fields = [m, h, dom, mon, dow];
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.every((f, i) => {
    let [lo, hi] = ranges[i];
    let v = vals[i];
    if (i === 4 && v === 7) v = 0; // allow 7 = Sunday
    return matchField(f, v, lo, i === 4 ? 6 : hi);
  });
}

function matchField(field, value, lo, hi) {
  return field.split(",").some((token) => {
    token = token.trim();
    if (token === "*") return true;
    let step = 1;
    if (token.includes("/")) {
      const [base, s] = token.split("/");
      step = Number(s) || 1;
      token = base;
    }
    let start = lo, end = hi;
    if (token === "*" || token === "") { /* full range */ }
    else if (token.includes("-")) {
      const [a, b] = token.split("-").map(Number);
      start = a; end = b;
    } else {
      const n = Number(token);
      if (Number.isNaN(n)) return false;
      return value === n && (value - n) % step === 0;
    }
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

export function startScheduler(cfg, deps) {
  const seen = new Map(); // workflowId -> last fired minute key
  const tick = async () => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    // due reminders: durable enqueue (worker delivers via real sendDiscord),
    // never direct send from the tick. Tick stays fast; HTTP returns fast.
    try {
      const { dueReminders, enqueueJobSync } = await import("./db.js");
      for (const r of dueReminders(cfg.root)) {
        try {
          enqueueJobSync(cfg.root, { kind: "chat", payload: { text: `⏰ Reminder: ${r.text}`, workflow: "reminder-delivery", reminderId: r.id, channel: r.channel_id || "" }, idempotencyKey: `reminder:${r.id}` });
          deps.log?.(`[scheduler] reminder ${r.id} enqueued`);
        } catch (e) {
          deps.log?.(`[scheduler] reminder ${r.id} enqueue failed: ${e.message}`);
        }
      }
    } catch (e) {
      deps.log?.(`[scheduler] reminder check failed: ${e.message}`);
    }
    for (const w of cfg.workflows) {
      const cron = w.trigger?.cron;
      if (w.trigger?.type !== "schedule" || !cron) continue;
      if (!matchesCron(cron, now)) continue;
      if (seen.get(w.id) === key) continue;
      seen.set(w.id, key);
      // Cross-process claim: a stale second bot with the same token must
      // not fire the same cron (duplicate digests/briefings in Discord).
      try {
        const { claimCronSlot } = await import("./db.js");
        if (!claimCronSlot(cfg.root, `${w.id}:${key}`)) { deps.log?.(`[scheduler] ${w.id} slot taken — skipping`); continue; }
      } catch {}
      deps.log?.(`[scheduler] firing ${w.id}`);
      // Enqueue, never await: the durable worker runs the workflow.
      try {
        const { enqueueJobSync } = await import("./db.js");
        enqueueJobSync(cfg.root, { kind: "automation", payload: { automationId: w.id, workflowId: w.id }, idempotencyKey: `sched:wf:${w.id}:${key}` });
      } catch (err) {
        deps.log?.(`[scheduler] ${w.id} enqueue failed: ${err.message}`);
      }
    }
    // DB automations (reference: YOUR FLOWS with schedule trigger) — same 30s tick.
    // Enqueue, never await: the durable worker runs the flow; the tick stays fast.
    // Scheduler edits to DB automations affect actual schedules: this loop reads
    // listAutomations() live (trigger_type/trigger_config/enabled) every tick.
    // Unsupported trigger types are rejected, never silently run: "event" has no
    // firing path here (dashboard.request_created is the only supported event
    // rule and it fires from the request intake, not the clock).
    try {
      const { listAutomations, enqueueJobSync } = await import("./db.js");
      let describeTrigger = null;
      try { ({ describeTrigger } = await import("./services/triggers.js")); } catch {}
      for (const a of listAutomations(cfg.root)) {
        if (!a.enabled) continue;
        if (a.trigger_type !== "manual" && a.trigger_type !== "schedule" && a.trigger_type !== "event") {
          deps.log?.(`[scheduler] automation ${a.id} has unsupported trigger_type '${a.trigger_type}' — skipping (not enqueued)`);
          continue;
        }
        if (a.trigger_type === "event") {
          const rule = a.trigger_config?.eventRule || a.trigger_config?.event || "";
          const supported = typeof describeTrigger === "function"
            ? describeTrigger("event", { eventRule: rule })
            : { ok: rule === "dashboard.request_created", error: "unsupported event rule" };
          if (!supported?.ok) {
            deps.log?.(`[scheduler] automation ${a.id} unsupported event '${rule || "(none)"}' — skipping (never silently run)`);
            continue;
          }
          // Supported event rules fire from their source (request intake),
          // not from the clock tick — never enqueue here.
          continue;
        }
        const cron = a.trigger_config?.cron;
        const everyMin = Number(a.trigger_config?.everyMinutes) || 0;
        const dueCron = a.trigger_type === "schedule" && cron && matchesCron(cron, now);
        const dueInterval = a.trigger_type === "schedule" && everyMin > 0
          && (!a.state?.last_run_at || (now - new Date(a.state.last_run_at)) >= everyMin * 60_000);
        if (!dueCron && !dueInterval) continue;
        const seenKey = `auto:${a.id}`;
        if (dueCron && seen.get(seenKey) === key) continue;
        seen.set(seenKey, key);
        try {
          const { claimCronSlot } = await import("./db.js");
          if (dueCron && !claimCronSlot(cfg.root, `${seenKey}:${key}`)) { deps.log?.(`[scheduler] automation ${a.id} slot taken — skipping`); continue; }
        } catch {}
        deps.log?.(`[scheduler] enqueue automation ${a.id}`);
        try {
          enqueueJobSync(cfg.root, { kind: "automation", payload: { automationId: a.id }, idempotencyKey: `sched:${a.id}:${dueCron ? key : `interval-${Math.floor(now.getTime() / (everyMin * 60000))}`}` });
        } catch (err) {
          deps.log?.(`[scheduler] automation ${a.id} enqueue failed: ${err.message}`);
        }
      }
    } catch (e) {
      deps.log?.(`[scheduler] automation check failed: ${e.message}`);
    }
  };
  const timer = setInterval(tick, 30_000);
  tick();
  return () => clearInterval(timer);
}

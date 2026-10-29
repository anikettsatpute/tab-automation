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
    // due reminders (every tick, cheap indexed query)
    try {
      const { dueReminders, markReminderSent } = await import("./db.js");
      for (const r of dueReminders(cfg.root)) {
        try {
          await deps.sendDiscord?.(r.channel_id || undefined, `⏰ Reminder: ${r.text}`);
          markReminderSent(cfg.root, r.id);
          deps.log?.(`[scheduler] reminder sent ${r.id}`);
        } catch (e) {
          deps.log?.(`[scheduler] reminder ${r.id} failed: ${e.message}`);
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
      try {
        await deps.runWorkflow(w, { kind: "schedule", at: now.toISOString() });
      } catch (err) {
        deps.log?.(`[scheduler] ${w.id} failed: ${err.message}`);
      }
    }
    // DB automations (reference: YOUR FLOWS with schedule trigger) — same 30s tick.
    // Agent JSON -> task steps -> next step all persist via runWorkflow->recordStep.
    try {
      const { listAutomations, markAutomationRun } = await import("./db.js");
      for (const a of listAutomations(cfg.root)) {
        if (!a.enabled) continue;
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
        deps.log?.(`[scheduler] firing automation ${a.id}`);
        const wf = { id: a.id, name: a.name, steps: a.steps };
        try {
          const ctx = await deps.runWorkflow(wf, { kind: "schedule", at: now.toISOString(), automation: a.id });
          markAutomationRun(cfg.root, a.id, { status: "done", runId: ctx?._runId || null });
        } catch (err) {
          try { markAutomationRun(cfg.root, a.id, { status: `failed: ${String(err.message).slice(0, 120)}` }); } catch {}
          deps.log?.(`[scheduler] automation ${a.id} failed: ${err.message}`);
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

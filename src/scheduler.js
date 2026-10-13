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
    for (const w of cfg.workflows) {
      const cron = w.trigger?.cron;
      if (w.trigger?.type !== "schedule" || !cron) continue;
      if (!matchesCron(cron, now)) continue;
      if (seen.get(w.id) === key) continue;
      seen.set(w.id, key);
      deps.log?.(`[scheduler] firing ${w.id}`);
      try {
        await deps.runWorkflow(w, { kind: "schedule", at: now.toISOString() });
      } catch (err) {
        deps.log?.(`[scheduler] ${w.id} failed: ${err.message}`);
      }
    }
  };
  const timer = setInterval(tick, 30_000);
  tick();
  return () => clearInterval(timer);
}

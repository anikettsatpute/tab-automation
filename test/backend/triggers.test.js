// Triggers: truthful next-run, dry-run no side effects, event honesty,
// outbox dedupe, audit trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";

test("nextCronRun within a minute of expected; validateCron rejects bad", async () => {
  const { nextCronRun, validateCron } = await import("../../src/services/triggers.js");
  const { matchesCron } = await import("../../src/scheduler.js");
  assert.ok(validateCron("not a cron"));
  assert.equal(validateCron("*/5 * * * *"), null);
  const r = nextCronRun("0 9 * * *", new Date("2026-10-30T00:00:00Z"));
  assert.equal(r.ok, true);
  // Timezone-correct: cron matches host LOCAL wall time, not UTC.
  assert.equal(r.at.getHours(), 9);
  assert.equal(r.at.getMinutes(), 0);
  assert.equal(matchesCron("0 9 * * *", r.at), true);
});

test("describeTrigger: schedule ok, event unsupported rejected, unknown rejected", async () => {
  const { describeTrigger } = await import("../../src/services/triggers.js");
  const s = describeTrigger("schedule", { cron: "*/15 * * * *" });
  assert.equal(s.ok, true);
  assert.ok(s.nextRunAt);
  assert.ok(s.timezone);
  const e1 = describeTrigger("event", {});
  assert.equal(e1.ok, false);
  const e2 = describeTrigger("event", { eventRule: "nope" });
  assert.equal(e2.ok, false);
  assert.match(e2.error, /unsupported event/);
  const e3 = describeTrigger("event", { eventRule: "dashboard.request_created" });
  assert.equal(e3.ok, true);
  assert.equal(describeTrigger("bogus", {}).ok, false);
});

test("dryRunAutomation: no side effects, unknown step type fails honestly", async () => {
  const { dryRunAutomation } = await import("../../src/services/triggers.js");
  const good = dryRunAutomation({ steps: [{ id: "a", type: "agent", agent: "assistant", prompt: "hi" }, { id: "n", type: "notify", message: "yo" }] });
  assert.equal(good.ok, true);
  assert.equal(good.steps, 2);
  assert.match(good.trace[1].wouldDo, /SKIPPED/);
  const bad = dryRunAutomation({ steps: [{ id: "x", type: "teleport" }] });
  assert.equal(bad.ok, false);
});

test("outbox dedupe: same channel+text returns same queued id", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const a = dbm.queueOutboxDeduped(root, { channel: "c", text: "hello" });
  const b = dbm.queueOutboxDeduped(root, { channel: "c", text: "hello" });
  assert.equal(a.deduped, false);
  assert.equal(b.deduped, true);
  assert.equal(a.id, b.id);
});

test("audit trail records mutations", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  dbm.audit(root, { actor: "test", action: "job.enqueue", target: "j1", detail: "d" });
  const rows = dbm.listAudit(root, { limit: 10 });
  assert.ok(rows.some((r) => r.action === "job.enqueue" && r.target === "j1"));
});

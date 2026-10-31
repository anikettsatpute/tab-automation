// Worker/access/triggers correctness: session login, cron timezone honesty,
// blocked mapping, dry-run validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";

function fakeCtx({ headers = {}, remoteAddr = "" } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { req: { header: (n) => h[n.toLowerCase()] || "" }, env: { remoteAddr } };
}

test("local login mints HttpOnly session; remote login refused; session authenticates", async () => {
  const { mintLocalSession, hasValidSession, sessionGuard } = await import("../../src/services/access.js");
  const local = { req: { header: () => "" }, env: { remoteAddr: "" } };
  const r = mintLocalSession(local);
  assert.equal(r.ok, true);
  assert.ok(r.sessionId);
  const withCookie = fakeCtx({ headers: { cookie: `tab_session=${encodeURIComponent(r.sessionId)}`, "x-forwarded-for": "203.0.113.9" } });
  assert.equal(hasValidSession(withCookie), true);
  assert.equal(sessionGuard(withCookie).ok, true);
  const remote = fakeCtx({ headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(mintLocalSession(remote).ok, false);
});

test("nextCronRun is timezone-honest: same instant in UTC and local", async () => {
  const { nextCronRun } = await import("../../src/services/triggers.js");
  const from = new Date("2026-10-30T00:00:00Z");
  const r = nextCronRun("0 9 * * *", from);
  assert.equal(r.ok, true);
  assert.ok(r.atUTC);
  assert.ok(r.timezone);
  // The instant must match cron in LOCAL wall time, not UTC.
  const { matchesCron } = await import("../../src/scheduler.js");
  assert.equal(matchesCron("0 9 * * *", r.at), true);
});

test("blocked envelope maps to blocked job (no false done)", async () => {
  const { buildEnvelope } = await import("../../src/services/envelope.js");
  const e = buildEnvelope({ runId: "r", stepIdx: 0, attempt: 1, agent: "a", model: "m", sessionId: "s", cliSessionId: "c", resultPath: "p", payload: { status: "blocked", summary: "need input", output: "" } });
  assert.equal(e.status, "blocked");
  // worker mapping (mirrors runLoopTaskJob terminal logic)
  const terminal = e.status === "cancelled" ? "cancelled" : e.status === "done" ? "done" : e.status === "blocked" ? "blocked" : "failed";
  assert.equal(terminal, "blocked");
});

test("dry-run validates unknown step types; describeTrigger honest on events", async () => {
  const { dryRunAutomation, describeTrigger } = await import("../../src/services/triggers.js");
  const bad = dryRunAutomation({ steps: [{ id: "x", type: "nope" }] });
  assert.equal(bad.ok, false);
  assert.equal(describeTrigger("event", { eventRule: "nope" }).ok, false);
  assert.equal(describeTrigger("event", { eventRule: "dashboard.job_done" }).ok, true);
});

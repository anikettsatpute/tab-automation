// Jobs queue: enqueue 202-fast, idempotency dedupe, atomic claim, cancel,
// crash recovery (expired leases never blindly replay side effects).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot, getDb } from "./_fixture.js";

test("enqueue + idempotency dedupe", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const a = dbm.enqueueJobSync(root, { kind: "request", payload: { text: "hi" }, idempotencyKey: "k1" });
  assert.equal(a.deduped, false);
  const b = dbm.enqueueJobSync(root, { kind: "request", payload: { text: "hi" }, idempotencyKey: "k1" });
  assert.equal(b.deduped, true);
  assert.equal(a.id, b.id);
});

test("atomic claim: one winner", async () => {
  const { openDb } = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const db = openDb(root);
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, created_at, updated_at) VALUES ('j1','request','{}','queued',0,3,'t','t')").run();
  const w1 = jobs.claimNextJob(db, "w1");
  assert.ok(w1 && w1.id === "j1");
  const w2 = jobs.claimNextJob(db, "w2");
  assert.equal(w2, null);
});

test("cancel stops queued job immediately (cancelled, never leased); terminal cancel race", async () => {
  const dbm = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const { openDb } = dbm;
  const db = openDb(root);
  const { id } = dbm.enqueueJobSync(root, { kind: "chat", payload: { text: "x" } });
  assert.equal(dbm.requestJobCancel(root, id), true);
  assert.equal(dbm.isJobCancelRequested(root, id), true);
  // Cancelling a queued job terminalizes it immediately — it is never leased.
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id = ?").get(id).status, "cancelled");
  assert.equal(jobs.claimNextJob(db, "w9"), null);
  // Cancel-race on a leased job: markRunning fails when cancel requested.
  const { id: id2 } = dbm.enqueueJobSync(root, { kind: "chat", payload: { text: "y" } });
  const claimed = jobs.claimNextJob(db, "w9");
  assert.ok(claimed && claimed.id === id2);
  assert.equal(dbm.requestJobCancel(root, id2), true);
  assert.equal(jobs.markRunning(db, claimed.id, "w9"), false);
});

test("recoverStaleJobs: stale leased held blocked (never replayed, never requeued)", async () => {
  const { openDb } = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const db = openDb(root);
  const old = new Date(Date.now() - 3600_000).toISOString();
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, worker_id, lease_until, result_hash, created_at, updated_at) VALUES ('s1','request',?, 'leased',0,3,'w','2000-01-01T00:00:00.000Z','h1','t','t')")
    .run(JSON.stringify({ sideEffectful: true }));
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, worker_id, lease_until, created_at, updated_at) VALUES ('s2','request','{}','leased',0,3,'w','2000-01-01T00:00:00.000Z','t','t')").run();
  void old;
  const r = jobs.recoverStaleJobs(db, { leaseSec: 300 });
  assert.equal(r.checked, 2);
  // Approved hold policy: every stale leased/running job parks blocked for
  // operator review — no auto-requeue, no replay, no requeued count.
  assert.equal(r.held, 2);
  assert.equal(r.requeued, 0);
  assert.equal(r.recovered, 0);
  const s1 = db.prepare("SELECT status FROM jobs WHERE id='s1'").get();
  assert.equal(s1.status, "blocked"); // held for operator review, not requeued
  const s2 = db.prepare("SELECT status FROM jobs WHERE id='s2'").get();
  assert.equal(s2.status, "blocked");
});

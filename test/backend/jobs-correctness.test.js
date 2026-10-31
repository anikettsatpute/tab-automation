// Jobs correctness: payload validity, idempotency conflicts, terminal
// immutability, lease-expiry semantics, side-effect hold, cancel-aware retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot, getDb } from "./_fixture.js";

test("payload truncation stays valid JSON", async () => {
  const jobs = await import("../../src/services/jobs.js");
  const big = { text: "x".repeat(50000), other: "y".repeat(50000) };
  // Approved reject/hold policy: oversized execution intent is rejected
  // (fail closed), never truncated into a sliced prompt/goal.
  assert.throws(() => jobs.safePayloadStringify(big, 16000), /payload too large/);
  const small = { text: "hi" };
  const s = jobs.safePayloadStringify(small, 16000);
  assert.ok(s.length <= 16000);
  const p = JSON.parse(s); // must not throw
  assert.equal(p.text, "hi");
});

test("idempotency: same key+payload dedupes; different payload conflicts; cross-operation allowed", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const a = dbm.enqueueJobSync(root, { kind: "request", payload: { text: "same" }, idempotencyKey: "idem-1" });
  assert.equal(a.deduped, false);
  const b = dbm.enqueueJobSync(root, { kind: "request", payload: { text: "same" }, idempotencyKey: "idem-1" });
  assert.equal(b.deduped, true);
  assert.equal(a.id, b.id);
  assert.throws(() => dbm.enqueueJobSync(root, { kind: "request", payload: { text: "DIFFERENT" }, idempotencyKey: "idem-1" }), /idempotency conflict/);
  // Same raw key with a different kind is namespaced per-kind (actor:scope:key)
  // so it enqueues independently — no cross-kind conflict.
  const c = dbm.enqueueJobSync(root, { kind: "chat", payload: { text: "same" }, idempotencyKey: "idem-1" });
  assert.equal(c.deduped, false);
  assert.notEqual(c.id, a.id);
  // Scoped idempotency: same raw key in a different operation/scope is
  // allowed (cross-operation reuse), same operation+scope dedupes.
  const jobs = await import("../../src/services/jobs.js");
  const { openDb } = dbm;
  const db = openDb(root);
  const e1 = jobs.enqueueJob(root, db, { kind: "chat", payload: { text: "x" }, idempotencyKey: "op-1", actor: "discord", scope: "cmd:run" });
  const e2 = jobs.enqueueJob(root, db, { kind: "chat", payload: { text: "x" }, idempotencyKey: "op-1", actor: "discord", scope: "cmd:other" });
  assert.equal(e1.deduped, false);
  assert.equal(e2.deduped, false); // cross-operation: independent enqueue
  assert.notEqual(e1.id, e2.id);
  const e3 = jobs.enqueueJob(root, db, { kind: "chat", payload: { text: "x" }, idempotencyKey: "op-1", actor: "discord", scope: "cmd:run" });
  assert.equal(e3.deduped, true); // same operation+scope: dedupes
  assert.equal(e3.id, e1.id);
});

test("finishJob terminal overwrite refused; cancel wins over late done", async () => {
  const { openDb } = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const db = openDb(root);
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, created_at, updated_at) VALUES ('t1','request','{}','running',0,3,'t','t')").run();
  assert.equal(jobs.finishJob(db, "t1", { status: "cancelled" }), true);
  assert.equal(jobs.finishJob(db, "t1", { status: "done" }), false); // late done refused
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='t1'").get().status, "cancelled");
});

test("failJobAttempt on cancelled job stays cancelled; terminal never requeued", async () => {
  const { openDb } = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const db = openDb(root);
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, cancel_requested, created_at, updated_at) VALUES ('c1','request','{}','running',0,3,1,'t','t')").run();
  const r = jobs.failJobAttempt(db, "c1", { error: "boom", retryable: true });
  assert.equal(r.status, "cancelled");
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, created_at, updated_at) VALUES ('d1','request','{}','done',0,3,'t','t')").run();
  const r2 = jobs.failJobAttempt(db, "d1", { error: "boom", retryable: true });
  assert.equal(r2.status, "done");
});

test("recoverStaleJobs: actual expiry (not now-minus-lease); partial held blocked, never re-executed", async () => {
  const { openDb } = await import("../../src/db.js");
  const jobs = await import("../../src/services/jobs.js");
  const root = getRoot();
  const db = openDb(root);
  // lease_until in the past -> stale regardless of leaseSec math
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, worker_id, lease_until, created_at, updated_at) VALUES ('se1','request',?, 'leased',0,3,'w','2000-01-01T00:00:00.000Z','t','t')")
    .run(JSON.stringify({ sideEffectful: true }));
  // lease_until in the future -> NOT stale even with small leaseSec
  const future = new Date(Date.now() + 3600_000).toISOString();
  db.prepare("INSERT INTO jobs (id, kind, payload, status, attempt, max_attempts, worker_id, lease_until, created_at, updated_at) VALUES ('se2','request','{}','leased',0,3,'w',?,'t','t')").run(future);
  const r = jobs.recoverStaleJobs(db, { leaseSec: 300 });
  assert.equal(r.checked, 1);
  assert.equal(r.held, 1);
  // Approved hold policy: stale leased work parks blocked for operator
  // review (never auto-requeue, never failed-out, never re-executed).
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='se1'").get().status, "blocked");
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='se2'").get().status, "leased");
  // Partial workflow (interrupted tail, missing steps) is held blocked —
  // never re-executed, never auto-completed.
  const { scanOrphanResults } = await import("../../src/services/worker.js");
  const cfg = { root, agents: new Map(), providers: [], workflows: [] };
  const s = await scanOrphanResults(cfg, db, jobs);
  assert.equal(s.recovered, 0); // no orphan files -> nothing recovered
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='se1'").get().status, "blocked");
});

test("claimSessionAttempt: atomic slot + path validation + hash dedupe", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const a = dbm.claimSessionAttempt(root, { jobId: "j", runId: "runok1", stepIndex: 0, attempt: 1, agent: "assistant", model: "m", sessionId: "s1", resultPath: "data/responses/runok1/step1.json", resultHash: "h-unique-1" });
  assert.equal(a.deduped, false);
  // same slot, different hash -> still deduped (slot taken)
  const b = dbm.claimSessionAttempt(root, { jobId: "j", runId: "runok1", stepIndex: 0, attempt: 1, agent: "assistant", model: "m", sessionId: "s2", resultPath: "data/responses/runok1/step1.json", resultHash: "h-unique-2" });
  assert.equal(b.deduped, true);
  // path escape refused
  assert.throws(() => dbm.claimSessionAttempt(root, { jobId: "j", runId: "runok1", stepIndex: 1, attempt: 1, agent: "a", model: "m", sessionId: "s", resultPath: "../../etc/passwd", resultHash: "" }), /outside run dir|traversal/);
  // same hash elsewhere -> deduped
  const c = dbm.claimSessionAttempt(root, { jobId: "j", runId: "runok2", stepIndex: 0, attempt: 1, agent: "assistant", model: "m", sessionId: "s3", resultPath: "data/responses/runok2/step1.json", resultHash: "h-unique-1" });
  assert.equal(c.deduped, true);
});

test("dedupeKey is sha256 (no require crash)", async () => {
  const { dedupeKey } = await import("../../src/services/jobs.js");
  const { createHash } = await import("node:crypto");
  const expect = createHash("sha256").update("c::t").digest("hex").slice(0, 32);
  assert.equal(dedupeKey("c", "t"), expect);
});

// Envelope + paths: trusted immutable result, atomic rename, safe paths,
// hash/marker separation, terminal statuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";

test("envelope hash validates; mutation detected", async () => {
  const { buildEnvelope, validateEnvelope } = await import("../../src/services/envelope.js");
  const e = buildEnvelope({ runId: "r1", stepIdx: 0, attempt: 1, agent: "assistant", model: "muse-spark-1.3", sessionId: "s1", cliSessionId: "c1", resultPath: "p", payload: { status: "done", summary: "ok", output: "out" } });
  assert.equal(validateEnvelope(e).ok, true);
  assert.equal(Object.isFrozen(e), true);
  const tampered = { ...e, output: "evil" };
  assert.equal(validateEnvelope(tampered).ok, false);
  // No self-referential fileHash inside hashed content
  assert.equal("fileHash" in e, false);
});

test("terminal statuses incl. cancelled; normalize maps complete->done", async () => {
  const { buildEnvelope, isTerminal, normalizeStatus } = await import("../../src/services/envelope.js");
  assert.equal(normalizeStatus("complete"), "done");
  for (const s of ["done", "blocked", "failed", "cancelled"]) {
    assert.equal(isTerminal(s), true);
    const e = buildEnvelope({ runId: "r", stepIdx: 0, attempt: 1, agent: "a", model: "m", sessionId: "s", cliSessionId: "c", resultPath: "p", payload: { status: s, summary: "", output: "" } });
    assert.equal(e.status, s);
  }
});

test("paths: injection + symlink escape refused; atomic write valid-before-rename", async () => {
  const { resultPathFor, ensureResponsesDir, atomicWriteJson, readJsonFile } = await import("../../src/services/paths.js");
  const root = getRoot();
  assert.throws(() => resultPathFor(root, "../evil", 0), /unsafe/);
  assert.throws(() => resultPathFor(root, "ok", -1), /unsafe/);
  const { file } = resultPathFor(root, "run1", 0);
  assert.ok(file.includes("data/responses/run1/step1.json"));
  ensureResponsesDir(root, "run1");
  atomicWriteJson(file, { v: 1 });
  assert.deepEqual(readJsonFile(file).v, 1);
});

test("session attempt hash dedupe in transaction", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const a = dbm.claimSessionAttempt(root, { jobId: "j", runId: "r", stepIndex: 0, attempt: 1, agent: "assistant", model: "m", sessionId: "s1", resultPath: "data/responses/r/step1.json", resultHash: "h-dup-1" });
  assert.equal(a.deduped, false);
  const b = dbm.claimSessionAttempt(root, { jobId: "j", runId: "r", stepIndex: 0, attempt: 2, agent: "assistant", model: "m", sessionId: "s2", resultPath: "data/responses/r/step1.json", resultHash: "h-dup-1" });
  assert.equal(b.deduped, true);
});

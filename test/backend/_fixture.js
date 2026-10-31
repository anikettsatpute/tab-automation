// Focused fixtures: isolated DB/data per test file. No scheduled workflows,
// no Discord, no secrets, no production restart. Run: node --test test/backend/
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root;
let db;

export function fixtureRoot() {
  root = mkdtempSync(join(tmpdir(), "tab-be-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "agents.json"), JSON.stringify({ agents: [{ id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }] }));
  writeFileSync(join(root, "config", "providers.json"), JSON.stringify({ defaultProvider: "muse", providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3" }] }));
  writeFileSync(join(root, "config", "streams.json"), JSON.stringify({ streams: [{ id: "general", agents: ["assistant"] }], pipelines: [{ id: "quick-answer", stream: "general", agents: ["assistant"] }] }));
  return root;
}

export async function loadDb() {
  const m = await import("../../src/db.js");
  m.closeDb();
  m.openDb(root);
  db = m;
  return m;
}

export function getRoot() { return root; }
export function getDb() { return db; }

beforeEach(async () => {
  fixtureRoot();
  await loadDb();
});

afterEach(async () => {
  try { (await import("../../src/db.js")).closeDb(); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

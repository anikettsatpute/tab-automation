// Runner correctness/security: prompt-limit reject (no truncation),
// full-context preservation, supported CLI flags, env hygiene.
// Isolated temp root per test; no production DB, no secrets printed.
// Run: node --test test/backend/runner-correctness.test.js
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

function testCfg(root) {
  return {
    root,
    agents: new Map([
      ["assistant", { id: "assistant", systemPrompt: "SYS", defaultPrompt: "hello" }],
    ]),
    providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3" }],
    defaultProvider: "muse",
    workflows: [],
    museKey: "test",
  };
}

// Fake muse: records argv + env, writes canned JSON.
function installSpyMuse(binDir, { mode = "done", recordPath } = {}) {
  const p = join(binDir, "muse");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let stdinBytes = 0;
try {
  const data = fs.readFileSync(0);
  stdinBytes = data ? data.length : 0;
} catch {}
const rec = {
  args,
  hasApiKeyStdin: args.includes("--api-key-stdin"),
  stdinPresent: stdinBytes > 0,
  stdinBytes,
  env: {
    MUSE_KEY: process.env.MUSE_KEY ? "present" : "absent",
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ? "present" : "absent",
    AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY ? "present" : "absent",
    CONTROL_TOKEN: process.env.CONTROL_TOKEN ? "present" : "absent",
  },
};
try { fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(rec)); } catch {}
const pi = args.indexOf("--prompt-file");
let prompt = "";
try { prompt = fs.readFileSync(args[pi + 1], "utf-8"); } catch {}
const payload = { status: "done", summary: "ok len=" + prompt.length, output: "OUT len=" + prompt.length, next: "", updates: { progress: 100, tokens: 1 } };
process.stdout.write(JSON.stringify(payload));
`;
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

async function withPath(binDir, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${prev}`;
  try { return await fn(); } finally { process.env.PATH = prev; }
}

test("runner: oversized prompt rejected BEFORE spawn (no truncation, no model call)", async () => {
  const { runAgentStep, MAX_PROMPT_BYTES } = await import("../../src/services/runner.js");
  assert.ok(Number(MAX_PROMPT_BYTES) > 0, "documented limit exported");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  const big = "x".repeat(MAX_PROMPT_BYTES + 1000);
  await withPath(binDir, async () => {
    const { envelope, gateError } = await runAgentStep(cfg, {
      agent: "assistant", prompt: big, runId: "rej1", stepIdx: 0, attempt: 1, jobId: "j-rej1",
    });
    assert.equal(envelope.status, "failed");
    assert.match(envelope.summary, /prompt too large/);
    assert.match(envelope.summary, /no truncation/);
    assert.ok(gateError, "gateError surfaces the reject");
    assert.equal(existsSync(recordPath), false, "muse never spawned");
  });
});

test("runner: full approved context preserved (no 20k/30k/3k slices)", async () => {
  const { runAgentStep } = await import("../../src/services/runner.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  // 10k context: old code sliced it to 3k in both the body and the contract.
  const ctx = "CTX-" + "y".repeat(10000);
  await withPath(binDir, async () => {
    const { envelope } = await runAgentStep(cfg, {
      agent: "assistant", prompt: "hello", extraContext: ctx,
      runId: "full1", stepIdx: 0, attempt: 1, jobId: "j-full1",
    });
    assert.equal(envelope.status, "done");
    const files = readdirSync(join(root, "data", "responses", "full1"));
    const promptFile = files.find((f) => f.endsWith(".prompt.md"));
    assert.ok(promptFile, "prompt file written");
    const body = readFileSync(join(root, "data", "responses", "full1", promptFile), "utf-8");
    assert.ok(body.includes(ctx), "full extraContext preserved in prompt file");
    assert.ok(body.length > 10000, "not sliced to 3k");
  });
});

test("runner: supported CLI flags passed; no --disable-sandbox/--yolo; env hygiene", async () => {
  const { runAgentStep } = await import("../../src/services/runner.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  process.env.DISCORD_BOT_TOKEN = "secret-discord";
  process.env.AZURE_OPENAI_API_KEY = "secret-azure";
  process.env.CONTROL_TOKEN = "secret-control";
  process.env.MUSE_KEY = "meta-auth-kept";
  try {
    await withPath(binDir, async () => {
      const { envelope } = await runAgentStep(cfg, {
        agent: "assistant", prompt: "hi", runId: "env1", stepIdx: 0, attempt: 1, jobId: "j-env1",
      });
      assert.equal(envelope.status, "done");
    });
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.CONTROL_TOKEN;
    delete process.env.MUSE_KEY;
  }
  const rec = JSON.parse(readFileSync(recordPath, "utf-8"));
  for (const f of ["--no-foreign-personal-context", "--disable-reminders", "--disable-request-user-input"]) {
    assert.ok(rec.args.includes(f), `flag present: ${f}`);
  }
  for (const bad of ["--disable-sandbox", "--yolo", "--disable-approval", "--disable-shell", "--disable-write", "--disable-web-tools"]) {
    assert.ok(!rec.args.includes(bad), `flag absent: ${bad}`);
  }
  assert.equal(rec.env.MUSE_KEY, "present", "Meta auth kept");
  assert.equal(rec.env.DISCORD_BOT_TOKEN, "absent", "Discord secret stripped");
  assert.equal(rec.env.AZURE_OPENAI_API_KEY, "absent", "Azure secret stripped");
  assert.equal(rec.env.CONTROL_TOKEN, "absent", "tunnel secret stripped");
});

test("runner: buildChildEnv keeps PATH/HOME/MUSE_KEY, strips secret families", async () => {
  const { buildChildEnv } = await import("../../src/services/runner.js");
  process.env.DISCORD_BOT_TOKEN = "x";
  process.env.AZURE_OPENAI_API_KEY = "x";
  process.env.CONTROL_TOKEN = "x";
  process.env.MUSE_KEY = "keep-me";
  try {
    const env = buildChildEnv({ museKey: "" });
    assert.ok(env.PATH, "PATH inherited for tooling");
    assert.equal(env.MUSE_KEY, "keep-me", "Meta auth preserved");
    assert.equal(env.DISCORD_BOT_TOKEN, undefined);
    assert.equal(env.AZURE_OPENAI_API_KEY, undefined);
    assert.equal(env.CONTROL_TOKEN, undefined);
  } finally {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.CONTROL_TOKEN;
    delete process.env.MUSE_KEY;
  }
});

test("runner: envelope validates + preclaim reconciles (structured JSON contract)", async () => {
  const { runAgentStep } = await import("../../src/services/runner.js");
  const { validateEnvelope } = await import("../../src/services/envelope.js");
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  await withPath(binDir, async () => {
    const { envelope } = await runAgentStep(cfg, {
      agent: "assistant", prompt: "ping", runId: "val1", stepIdx: 0, attempt: 1, jobId: "j-val1",
    });
    assert.equal(envelope.status, "done");
    const v = validateEnvelope(envelope);
    assert.equal(v.ok, true, v.error || "envelope valid");
    // Preclaim slot exists for this session (reconcile path covered).
    const db = dbm.openDb(root);
    const row = db.prepare("SELECT session_id, result_hash FROM session_attempts WHERE run_id = ? AND step_index = 0 AND attempt = 1").get("val1");
    assert.ok(row, "pre-claim row exists");
    assert.equal(row.session_id, envelope.sessionId);
  });
});

test("runner: custom keyEnv piped via api-key-stdin with no leakage", async () => {
  const { runAgentStep } = await import("../../src/services/runner.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  cfg.providers = [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3", keyEnv: "CUSTOM_MUSE_KEY" }];
  cfg.museKey = "";
  const secret = "custom-fake-".concat("key-789");
  const prevMuse = process.env.MUSE_KEY;
  delete process.env.MUSE_KEY;
  process.env.CUSTOM_MUSE_KEY = secret;
  process.env.DISCORD_BOT_TOKEN = "x-discord";
  try {
    await withPath(binDir, async () => {
      const { envelope } = await runAgentStep(cfg, {
        agent: "assistant", prompt: "hi", runId: "auth1", stepIdx: 0, attempt: 1, jobId: "j-auth1",
      });
      assert.equal(envelope.status, "done");
    });
  } finally {
    delete process.env.CUSTOM_MUSE_KEY;
    delete process.env.DISCORD_BOT_TOKEN;
    if (prevMuse !== undefined) process.env.MUSE_KEY = prevMuse;
  }
  const raw = readFileSync(recordPath, "utf-8");
  const rec = JSON.parse(raw);
  assert.equal(rec.hasApiKeyStdin, true);
  assert.equal(rec.stdinPresent, true);
  assert.ok(rec.stdinBytes > 0);
  assert.equal(rec.args.includes(secret), false);
  assert.equal(raw.includes(secret), false);
  assert.equal(rec.env.DISCORD_BOT_TOKEN, "absent");
});

test("runner: cfg museKey piped via api-key-stdin", async () => {
  const { runAgentStep } = await import("../../src/services/runner.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  cfg.museKey = "cfg-fake-".concat("key-456");
  const prevMuse = process.env.MUSE_KEY;
  delete process.env.MUSE_KEY;
  try {
    await withPath(binDir, async () => {
      const { envelope } = await runAgentStep(cfg, {
        agent: "assistant", prompt: "hi", runId: "auth2", stepIdx: 0, attempt: 1, jobId: "j-auth2",
      });
      assert.equal(envelope.status, "done");
    });
  } finally {
    if (prevMuse !== undefined) process.env.MUSE_KEY = prevMuse;
  }
  const raw = readFileSync(recordPath, "utf-8");
  const rec = JSON.parse(raw);
  assert.equal(rec.hasApiKeyStdin, true);
  assert.equal(rec.stdinPresent, true);
  assert.equal(raw.includes("cfg-fake-key-456"), false);
});

test("runner: absent key keeps stored auth without flag", async () => {
  const { runAgentStep } = await import("../../src/services/runner.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  cfg.museKey = "";
  const prevMuse = process.env.MUSE_KEY;
  delete process.env.MUSE_KEY;
  try {
    await withPath(binDir, async () => {
      const { envelope } = await runAgentStep(cfg, {
        agent: "assistant", prompt: "hi", runId: "auth3", stepIdx: 0, attempt: 1, jobId: "j-auth3",
      });
      assert.equal(envelope.status, "done");
    });
  } finally {
    if (prevMuse !== undefined) process.env.MUSE_KEY = prevMuse;
  }
  const rec = JSON.parse(readFileSync(recordPath, "utf-8"));
  assert.equal(rec.hasApiKeyStdin, false);
  assert.equal(rec.stdinPresent, false);
  assert.equal(rec.env.MUSE_KEY, "absent");
});

test("providers: resolveMuseApiKey precedence and stdin args", async () => {
  const { resolveMuseApiKey, museApiKeyStdinArgs } = await import("../../src/providers.js");
  const baseCfg = {
    agents: new Map([["assistant", { id: "assistant", provider: "muse" }]]),
    providers: [{ id: "muse", type: "muse", modelDefault: "muse-spark-1.3", keyEnv: "CUSTOM_MUSE_KEY" }],
    defaultProvider: "muse",
    museKey: "",
  };
  const prevCustom = process.env.CUSTOM_MUSE_KEY;
  const prevMuse = process.env.MUSE_KEY;
  delete process.env.CUSTOM_MUSE_KEY;
  delete process.env.MUSE_KEY;
  try {
    process.env.CUSTOM_MUSE_KEY = "env-custom";
    baseCfg.museKey = "cfg-key";
    assert.equal(resolveMuseApiKey(baseCfg, "assistant").key, "env-custom");
    delete process.env.CUSTOM_MUSE_KEY;
    assert.equal(resolveMuseApiKey(baseCfg, "assistant").key, "cfg-key");
    baseCfg.museKey = "";
    process.env.MUSE_KEY = "std-key";
    assert.equal(resolveMuseApiKey(baseCfg, "assistant").key, "std-key");
    delete process.env.MUSE_KEY;
    assert.equal(resolveMuseApiKey(baseCfg, "assistant").key, "");
    assert.deepEqual(museApiKeyStdinArgs("k"), ["--api-key-stdin"]);
    assert.deepEqual(museApiKeyStdinArgs(""), []);
  } finally {
    if (prevCustom !== undefined) process.env.CUSTOM_MUSE_KEY = prevCustom;
    else delete process.env.CUSTOM_MUSE_KEY;
    if (prevMuse !== undefined) process.env.MUSE_KEY = prevMuse;
    else delete process.env.MUSE_KEY;
  }
});

test("agent: dispatchAgent pipes key via api-key-stdin", async () => {
  const { dispatchAgent } = await import("../../src/agent.js");
  const root = getRoot();
  const binDir = mkdtempSync(join(tmpdir(), "fakebin-"));
  const recordPath = join(binDir, "spawn.json");
  installSpyMuse(binDir, { recordPath });
  const cfg = testCfg(root);
  cfg.museKey = "dispatch-".concat("fake-123");
  const prevMuse = process.env.MUSE_KEY;
  delete process.env.MUSE_KEY;
  let out;
  try {
    await withPath(binDir, async () => {
      out = await dispatchAgent(cfg, { agent: "assistant", prompt: "hello pipe", toolCtx: { runId: "dpipe1", stepIdx: 0 } });
    });
  } finally {
    if (prevMuse !== undefined) process.env.MUSE_KEY = prevMuse;
  }
  assert.equal(out.ok, true);
  const raw = readFileSync(recordPath, "utf-8");
  const rec = JSON.parse(raw);
  assert.equal(rec.hasApiKeyStdin, true);
  assert.equal(rec.stdinPresent, true);
  assert.equal(raw.includes("dispatch-fake-123"), false);
});

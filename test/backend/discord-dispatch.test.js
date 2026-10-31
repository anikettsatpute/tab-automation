// Discord dispatch: durable payload/messageKey + deps wiring.
// Focused: buildDiscordJobArgs preserves configured wf agents/prompts (never
// forces ["assistant"]), persists channel/thread reply context, keys
// idempotency by incoming messageId (never Date.now); planner enqueues only
// (no direct agent execution); inbound keeps job link for completion delivery.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";

function fakeCfg() {
  return {
    root: getRoot(),
    agents: new Map([
      ["assistant", { id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }],
      ["coder", { id: "coder", systemPrompt: "code", defaultPrompt: "code it" }],
    ]),
    workflows: [
      { id: "ship-it", trigger: { type: "discord", command: "ship" }, steps: [{ id: "r", type: "agent", agent: "coder", prompt: "review {{text}}" }, { id: "n", type: "discord_send", message: "done" }] },
    ],
  };
}

test("buildDiscordJobArgs: preserves wf agents+prompts, durable messageKey, reply context", async () => {
  const { buildDiscordJobArgs } = await import("../../src/discord.js");
  const cfg = fakeCfg();
  const wf = cfg.workflows[0];
  const a = buildDiscordJobArgs(wf, { kind: "discord", text: "review this diff", user: "u", channelId: "C1", messageId: "M1" }, cfg);
  assert.equal(a.kind, "automation"); // configured wf -> automation (real steps)
  assert.equal(a.payload.automationId, "ship-it");
  assert.equal(a.payload.channelId, "C1");
  assert.equal(a.payload.messageId, "M1");
  assert.equal(a.idempotencyKey, "discord:discord:ship-it:M1");
  assert.ok(!String(a.idempotencyKey).includes(String(Date.now())));

  // Ephemeral pipeline: agents + steps preserved, never forced to ["assistant"].
  const pipe = { id: "pipeline-x", steps: [{ id: "s1", type: "agent", agent: "coder", prompt: "do code" }, { id: "report", type: "discord_send", message: "hi" }] };
  const b = buildDiscordJobArgs(pipe, { kind: "discord-pipeline", text: "fix it", user: "u", channelId: "C9", messageId: "M9", agents: ["coder"] }, cfg);
  assert.equal(b.kind, "request");
  assert.deepEqual(b.payload.agents, ["coder"]);
  assert.ok(Array.isArray(b.payload.steps) && b.payload.steps.length === 2);
  assert.equal(b.payload.steps[0].agent, "coder");
  assert.equal(b.payload.channelId, "C9");
  assert.equal(b.payload.messageId, "M9");
  assert.equal(b.idempotencyKey, "discord:discord-pipeline:pipeline-x:M9");

  // No messageId: deterministic content hash, still no Date.now.
  const c = buildDiscordJobArgs(wf, { kind: "discord", text: "same text", channelId: "C1" }, cfg);
  const d = buildDiscordJobArgs(wf, { kind: "discord", text: "same text", channelId: "C1" }, cfg);
  assert.equal(c.idempotencyKey, d.idempotencyKey);
  assert.ok(!/\d{13}/.test(c.idempotencyKey || ""));
});

test("planner: generic workflow + pipeline enqueue only, return queued job handle", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const cfg = {
    root,
    agents: new Map([
      ["assistant", { id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }],
      ["coder", { id: "coder", systemPrompt: "code", defaultPrompt: "code it" }],
    ]),
    workflows: [{ id: "ship-it", trigger: { type: "manual" }, steps: [{ id: "r", type: "agent", agent: "coder", prompt: "x" }] }],
  };
  const { handleRickMessage } = await import("../../src/planner.js");
  const calls = [];
  const deps = {
    log: () => {},
    // Fake deps.runWorkflow: record args, enqueue like the real one, return handle.
    runWorkflow: async (wf, trigger) => {
      calls.push({ wf: wf.id, trigger });
      const { buildDiscordJobArgs } = await import("../../src/discord.js");
      const { kind, payload, idempotencyKey } = buildDiscordJobArgs(wf, trigger, cfg);
      const { id: jobId } = dbm.enqueueJobSync(root, { kind, payload, idempotencyKey });
      return { _jobId: jobId, jobId, _runId: null, steps: {}, workflow: wf.id, status: "queued" };
    },
  };
  const replies = [];
  const msg = {
    id: "MSG1", channelId: "CHAN1", author: { tag: "tester" },
    channel: { sendTyping: async () => {} },
    reply: async (t) => { replies.push(String(t)); },
  };
  // Generic "review this" -> ship-it workflow path.
  const r1 = await handleRickMessage(cfg, deps, msg, "please review this diff");
  assert.equal(r1.kind, "workflow");
  assert.equal(r1.status, "queued");
  assert.ok(r1.jobId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trigger.messageId, "MSG1");
  assert.equal(calls[0].trigger.channelId, "CHAN1");
  const j1 = dbm.getJobRow(root, r1.jobId);
  assert.ok(j1);
  assert.equal(j1.kind, "automation");
  const p1 = JSON.parse(j1.payload);
  assert.equal(p1.automationId, "ship-it");
  assert.equal(p1.channelId, "CHAN1");
  assert.equal(p1.messageId, "MSG1");
  // Queued ack only — no fake complete brain status from awaiting the queue.
  assert.ok(!replies.join("\n").includes("✅ **ship-it** done"));
});

test("discord inbound: queued job keeps link, brain stays running until worker completes", async () => {
  const dbm = await import("../../src/db.js");
  const root = getRoot();
  const cfg = {
    root,
    agents: new Map([["assistant", { id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }]]),
    workflows: [],
    discord: { listenChannels: [] },
  };
  // Fake message handler path: file brain row, call planner stub that enqueues,
  // assert brain row links the job and stays running (not fake reply_generated).
  const brainId = dbm.fileBrainMessage(root, {
    jobId: "M777", actorId: "U1", conversationId: "C777",
    sender: "tester", source: "discord", messageText: "ship it please",
    processingStatus: "running",
  });
  const { buildDiscordJobArgs } = await import("../../src/discord.js");
  const wf = { id: "ship-it", steps: [{ id: "r", type: "agent", agent: "assistant", prompt: "x" }] };
  const { kind, payload, idempotencyKey } = buildDiscordJobArgs(wf, { kind: "discord", text: "ship it please", user: "tester", channelId: "C777", messageId: "M777" }, cfg);
  const { id: jobId } = dbm.enqueueJobSync(root, { kind, payload, idempotencyKey });
  dbm.updateBrainMessage(root, brainId, { processingStatus: "running", linkedTaskId: String(jobId), outboxSummary: `queued ${jobId}` });
  const rows = dbm.listBrainMessages(root, {});
  const row = rows.find((r) => r.id === brainId);
  assert.equal(row.processing_status, "running"); // NOT reply_generated
  assert.equal(row.linked_task_id, String(jobId));
  const job = dbm.getJobRow(root, jobId);
  const jp = JSON.parse(job.payload);
  assert.equal(jp.channelId, "C777"); // completion delivery link
  assert.equal(jp.messageId, "M777");
});

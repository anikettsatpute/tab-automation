// AI intent router: prompt/parse helpers + planner executes decisions deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";
import { getRoot } from "./_fixture.js";

function setup(decision) {
  const root = getRoot();
  const cfg = {
    root,
    agents: new Map([["assistant", { id: "assistant", systemPrompt: "hi", defaultPrompt: "hello" }]]),
    workflows: [{ id: "ship-it", description: "review", trigger: { type: "manual" }, steps: [{ id: "r", type: "agent", agent: "assistant", prompt: "x" }] }],
  };
  const calls = { runWorkflow: [], prompts: [] };
  const deps = {
    log: () => {},
    routeIntent: async (_cfg, { prompt }) => { calls.prompts.push(prompt); return { decision, session: { dispatcher: "muse", sessionId: "S1" } }; },
    runWorkflow: async (wf, trigger) => {
      calls.runWorkflow.push({ wf, trigger });
      const { buildDiscordJobArgs } = await import("../../src/discord.js");
      const dbm = await import("../../src/db.js");
      const a = buildDiscordJobArgs(wf, trigger, cfg);
      const { id } = dbm.enqueueJobSync(root, a);
      return { _jobId: id, jobId: id, status: "queued" };
    },
  };
  const replies = [];
  const msg = { id: `M${Math.random().toString(36).slice(2, 8)}`, channelId: "123456789", author: { tag: "tester", id: "42" }, channel: { sendTyping: async () => {} }, reply: async (t) => { replies.push(String(t)); } };
  return { cfg, deps, msg, replies, calls, root };
}

test("parseDecision: last valid action object wins, junk ignored", async () => {
  const { parseDecision } = await import("../../src/router.js");
  assert.equal(parseDecision("nope"), null);
  assert.equal(parseDecision('{"action":"explode"}'), null);
  assert.deepEqual(parseDecision('thinking {"x":1}\n```json\n{"action":"list_todos","reason":"r"}\n```'), { action: "list_todos", reason: "r" });
});

test("buildRouterPrompt includes catalogs, todos and the message", async () => {
  const { buildRouterPrompt } = await import("../../src/router.js");
  const p = buildRouterPrompt({ text: "do the thing", user: "u", automations: [{ id: "ship-it", description: "review" }], pipelines: [{ id: "generic", name: "Generic", steps: [{ role: "coder" }] }], todos: [{ id: "t1", text: "buy milk" }] });
  for (const s of ["ship-it", "generic", "buy milk", "do the thing", "clarify"]) assert.ok(p.includes(s), s);
});

test("buildRouterPrompt tells the router it has read-only tools + repo files", async () => {
  const { buildRouterPrompt } = await import("../../src/router.js");
  const p = buildRouterPrompt({ text: "x", user: "u", files: [{ path: "config/tools.json", summary: "MCP servers" }] });
  assert.ok(p.includes("READ-ONLY tools"), "router knows it can inspect");
  assert.ok(p.includes("config/tools.json"), "repo files listed");
  assert.ok(!/Do NOT call tools/.test(p), "old no-tools ban is gone");
});

test("router list_todos replies with open todos", async () => {
  const { handleRickMessage } = await import("../../src/planner.js");
  const { addTodo } = await import("../../src/db.js");
  const s = setup({ action: "list_todos" });
  addTodo(s.root, { text: "router-test todo" });
  const r = await handleRickMessage(s.cfg, s.deps, s.msg, "what are my todos");
  assert.equal(r.kind, "list");
  assert.ok(s.replies.join("\n").includes("router-test todo"));
  assert.ok(s.calls.prompts[0].includes("router-test todo"));
});

test("router clarify asks the question, launches nothing", async () => {
  const { handleRickMessage } = await import("../../src/planner.js");
  const s = setup({ action: "clarify", question: "Which repo?" });
  const r = await handleRickMessage(s.cfg, s.deps, s.msg, "fix it");
  assert.equal(r.kind, "clarify");
  assert.ok(s.replies[0].includes("Which repo?"));
  assert.equal(s.calls.runWorkflow.length, 0);
});

test("router run_automation enqueues the automation with reply context", async () => {
  const { handleRickMessage } = await import("../../src/planner.js");
  const dbm = await import("../../src/db.js");
  const s = setup({ action: "run_automation", automationId: "ship-it", text: "review PR 4" });
  const r = await handleRickMessage(s.cfg, s.deps, s.msg, "review PR 4 please");
  assert.equal(r.kind, "workflow");
  assert.equal(r.status, "queued");
  const p = JSON.parse(dbm.getJobRow(s.root, r.jobId).payload);
  assert.equal(p.automationId, "ship-it");
  assert.equal(p.channelId, "123456789");
  assert.equal(p.messageId, s.msg.id);
});

test("router create_task files a direct loop request tagged with channel/user/message", async () => {
  const { handleRickMessage } = await import("../../src/planner.js");
  const store = await import("../../src/loop/store.js");
  const s = setup({ action: "create_task", taskType: "nope-unknown", goal: "Write a haiku about routers" });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(`${s.root}/config`, { recursive: true });
  writeFileSync(`${s.root}/config/task-types.json`, JSON.stringify({ taskTypes: [{ id: "generic", name: "Generic", steps: [{ role: "coder", goal: "do it" }] }] }));
  const r = await handleRickMessage(s.cfg, s.deps, s.msg, "write a haiku about routers");
  assert.equal(r.kind, "task");
  const req = store.getRequest(s.root, r.requestId);
  assert.equal(req.mode, "direct");
  assert.equal(req.source, `discord:123456789:42:${s.msg.id}`);
  assert.equal(req.task_type, "generic"); // unknown type falls back to generic
  assert.equal(r.jobId, `req:${r.requestId}`);
});

test("router failure falls back to keyword routing", async () => {
  const { handleRickMessage } = await import("../../src/planner.js");
  const s = setup(null);
  const r = await handleRickMessage(s.cfg, s.deps, s.msg, "please review this diff");
  assert.equal(r.kind, "workflow");
  assert.equal(r.router, undefined);
});

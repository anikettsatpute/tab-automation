import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, parseMuseExport, finalAssistantText } from "../../src/loop/transcript.js";
import { jsonFromStdout } from "../../src/loop/reconcile.js";

const j = (o) => JSON.stringify(o);
const shell = j({ command: "cat a.txt", description: "Show a", exit_code: 0, output: "hello\n" });

test("muse exec --json -> user, tool card, assistant", () => {
  const text = [
    j({ payload_type: "run.model.configured", payload: { model_id: "muse-spark-1.3" } }),
    j({ payload_type: "turn.input.user", payload: { prompt: "do it" } }),
    j({ payload_type: "task.lifecycle.side_effect_intent", payload: { event: { operation: "tool:bash", idempotency_key: "tool:c1" } } }),
    j({ payload_type: "tool.result", payload: { call_id: "c1", correlation_facts: { tool_name: "bash", outcome: "success" }, text: shell } }),
    j({ payload_type: "run.output.delta", payload: { text: '{"status":' } }),
    j({ payload_type: "run.output.delta", payload: { text: '"done","summary":"ok"}' } }),
  ].join("\n");
  const t = parseTranscript(text);
  assert.equal(t.format, "muse");
  assert.equal(t.meta.model, "muse-spark-1.3");
  assert.deepEqual(t.items.map((i) => i.k), ["user", "tool", "assistant"]);
  assert.equal(t.items[1].command, "cat a.txt");
  assert.equal(t.items[1].exitCode, 0);
  assert.equal(t.items[1].ok, true);
  assert.deepEqual(jsonFromStdout(text), { status: "done", summary: "ok" });
});

test("copilot --output-format json -> chat + sessionId + final text", () => {
  const text = [
    j({ type: "session.auto_mode_resolved", data: { chosenModel: "gpt-x" } }),
    j({ type: "user.message", data: { content: "go" } }),
    j({ type: "assistant.message", data: { content: "", toolRequests: [{ toolCallId: "t1", name: "bash", arguments: { command: "ls" } }] } }),
    j({ type: "tool.execution_complete", data: { toolCallId: "t1", success: false, result: { content: "boom" }, shellExecution: { exitCode: 2 } } }),
    j({ type: "assistant.message", data: { content: '{"status":"failed","summary":"x"}', toolRequests: [] } }),
    j({ type: "result", sessionId: "sid-1", exitCode: 0 }),
  ].join("\n");
  const t = parseTranscript(text);
  assert.equal(t.format, "copilot");
  assert.equal(t.meta.sessionId, "sid-1");
  assert.equal(t.items.find((i) => i.k === "tool").exitCode, 2);
  assert.equal(t.items.find((i) => i.k === "tool").ok, false);
  assert.equal(finalAssistantText(text), '{"status":"failed","summary":"x"}');
});

test("plain text transcript falls back to raw", () => {
  const t = parseTranscript("just words");
  assert.equal(t.format, "text");
  assert.equal(t.raw, "just words");
  assert.equal(finalAssistantText("just words"), "");
});

test("muse export doc -> chat with tool call/result join", () => {
  const ev = (event) => ({ envelope: { payload_type: "runtime.session", payload: { kind: "run", event } } });
  const doc = { events: [
    ev({ kind: "started", prompt: "hi" }),
    ev({ kind: "assistant_tool_calls_committed", tool_calls: [{ call_id: "c9", name: "bash", args: j({ command: "pwd" }) }] }),
    ev({ kind: "tool_result_batch_committed", results: [{ tool_call_id: "c9", text: shell }] }),
    ev({ kind: "assistant_message_committed", text: "DONE" }),
    ev({ kind: "model_completed", usage: { input_tokens: 10, output_tokens: 2 } }),
  ] };
  const t = parseMuseExport(doc);
  assert.deepEqual(t.items.map((i) => i.k), ["user", "tool", "assistant"]);
  assert.equal(t.items[1].output, "hello\n");
  assert.equal(t.meta.usage.input, 10);
});

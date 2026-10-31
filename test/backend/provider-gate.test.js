// Provider gate: default Meta Muse CLI contributor on; fail closed on
// non-permitted providers (no silent Azure fallback).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";

function cfgWith(providerId, type) {
  return {
    agents: new Map([["assistant", { id: "assistant", provider: providerId, systemPrompt: "hi" }]]),
    providers: [{ id: providerId, type, modelDefault: "muse-spark-1.3" }],
    defaultProvider: providerId,
  };
}

test("muse provider allowed, model resolved", async () => {
  const { gateProvider } = await import("../../src/services/provider-gate.js");
  const g = gateProvider(cfgWith("muse", "muse"), "assistant");
  assert.equal(g.type, "muse");
  assert.equal(g.model, "muse-spark-1.3");
});

test("azure provider fails closed", async () => {
  const { gateProvider } = await import("../../src/services/provider-gate.js");
  assert.throws(() => gateProvider(cfgWith("azure", "azure-foundry"), "assistant"), /not permitted/);
});

test("dispatchAgent fails closed (no live inference, no throw to caller)", async () => {
  const { dispatchAgent } = await import("../../src/agent.js");
  const out = await dispatchAgent(cfgWith("azure", "azure-foundry"), { agent: "assistant", prompt: "hi" });
  assert.equal(out.ok, false);
  assert.match(out.error, /not permitted/);
});

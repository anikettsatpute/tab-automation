// Access control: local allowed, remote mutations need bearer, config
// redaction, origin checks, attachments honest-unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_fixture.js";

function fakeCtx({ headers = {}, remoteAddr = "" } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return { req: { header: (n) => h[n.toLowerCase()] || "", path: "/", }, env: { remoteAddr } };
}

test("loopback allowed without token", async () => {
  const { mutationGuard } = await import("../../src/services/access.js");
  delete process.env.CONTROL_TOKEN;
  const c = fakeCtx({ headers: { "x-forwarded-for": "127.0.0.1" } });
  assert.equal(mutationGuard(c).ok, true);
});

test("remote mutation without token configured is rejected (fail closed)", async () => {
  const { mutationGuard } = await import("../../src/services/access.js");
  delete process.env.CONTROL_TOKEN;
  const c = fakeCtx({ headers: { "x-forwarded-for": "203.0.113.9" } });
  const g = mutationGuard(c);
  assert.equal(g.ok, false);
  assert.equal(g.status, 403);
});

test("remote mutation with valid bearer passes; wrong bearer 401", async () => {
  const { mutationGuard } = await import("../../src/services/access.js");
  process.env.CONTROL_TOKEN = "secret-123";
  try {
    const ok = fakeCtx({ headers: { "x-forwarded-for": "203.0.113.9", authorization: "Bearer secret-123" } });
    assert.equal(mutationGuard(ok).ok, true);
    const bad = fakeCtx({ headers: { "x-forwarded-for": "203.0.113.9", authorization: "Bearer wrong" } });
    const g = mutationGuard(bad);
    assert.equal(g.ok, false);
    assert.equal(g.status, 401);
  } finally { delete process.env.CONTROL_TOKEN; }
});

test("redactConfig masks secret values, keeps keyEnv names", async () => {
  const { redactConfig } = await import("../../src/services/access.js");
  const out = redactConfig({ providers: [{ id: "muse", keyEnv: "MUSE_KEY", apiKey: "sk-live-123456789" }] });
  assert.equal(out.providers[0].keyEnv, "MUSE_KEY");
  assert.match(out.providers[0].apiKey, /••/);
  assert.ok(!out.providers[0].apiKey.includes("sk-live"));
});

test("origin check rejects cross-site when token configured", async () => {
  const { originCheck } = await import("../../src/services/access.js");
  process.env.CONTROL_TOKEN = "secret-123";
  try {
    const bad = fakeCtx({ headers: { origin: "https://evil.example", host: "dash.example" } });
    assert.equal(originCheck(bad).ok, false);
    const none = fakeCtx({ headers: { host: "dash.example" } });
    assert.equal(originCheck(none).ok, true);
  } finally { delete process.env.CONTROL_TOKEN; }
});

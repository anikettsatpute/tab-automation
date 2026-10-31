// README coding-task docs: verify the "Coding with agents (dashboard → PR)"
// section documents the pipeline and worktree-branch contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

test("README documents coding task type flow", () => {
  assert.ok(readme.includes("## Coding with agents (dashboard → PR)"), "missing section heading");
  assert.ok(readme.includes("`coding` task type"), "missing coding task type mention");
  assert.ok(readme.includes("dash-coder"), "missing pipeline agent dash-coder");
  assert.ok(readme.includes("dash-tester"), "missing pipeline agent dash-tester");
  assert.ok(readme.includes("critic"), "missing pipeline agent critic");
  assert.ok(readme.includes("dash-pr"), "missing pipeline agent dash-pr");
  assert.ok(readme.includes("agent/*"), "missing isolated branch convention");
  assert.ok(readme.includes("never main"), "missing never-touch-main contract");
});

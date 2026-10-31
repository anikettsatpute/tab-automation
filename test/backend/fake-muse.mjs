#!/usr/bin/env node
// Fake `muse` for loop tests. Reads --prompt-file, finds the result path, writes a result JSON.
// FAKE_MUSE_MODE: done (default) | fail-once | fail | block | stdout | divider-bad | slow
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("muse-fake 0.0.1"); process.exit(0); }
const pf = args[args.indexOf("--prompt-file") + 1];
const prompt = readFileSync(pf, "utf8");
const mode = process.env.FAKE_MUSE_MODE || "done";
const write = (p, o) => { writeFileSync(`${p}.tmp`, JSON.stringify(o)); renameSync(`${p}.tmp`, p); };

if (prompt.includes("# Role: divider")) {
  const p = /Write JSON to (\S+) \(atomic/.exec(prompt)[1];
  if (mode === "divider-bad") { write(p, { summary: "x", tasks: [{ title: "t", steps: [{ role: "nobody", goal: "g" }] }] }); process.exit(0); }
  write(p, { summary: "two tasks", tasks: [
    { key: "a", title: "First", task_type: "", end_goal: "do A", depends_on: [], steps: [{ role: "coder", goal: "build A" }] },
    { key: "b", title: "Second", task_type: "", end_goal: "do B", depends_on: ["a"], steps: [{ role: "critic", goal: "review A" }] },
  ] });
  process.exit(0);
}

const resultPath = /write ONE JSON file to exactly this path:\n\s+(\S+)/.exec(prompt)[1];
const step = Number(/"step": (\d+)/.exec(prompt)[1]);
const attempt = Number(/"attempt": (\d+)/.exec(prompt)[1]);
const marker = `${resultPath}.seen`;
const res = (status, extra = {}) => ({ v: 1, step, attempt, status, summary: `${status} step ${step}`, output: `out ${step}`, handoff: `handoff from step ${step}`, ...extra });

if (mode === "slow") { setTimeout(() => {}, 60000); }
else if (mode === "fail") { process.stderr.write("boom"); process.exit(2); }
else if (mode === "fail-once" && step === 1 && attempt === 1 && !existsSync(marker)) { writeFileSync(marker, "1"); write(resultPath, res("failed")); }
else if (mode === "block" && step === 1) write(resultPath, res("blocked", { blocked_reason: "need creds" }));
else if (mode === "stdout") console.log(`some chatter\n${JSON.stringify(res("done"))}`);
else write(resultPath, res("done", step === 0 ? { artifacts: [{ kind: "diagram", title: "Flow", body: "graph TD; A-->B" }] } : {}));

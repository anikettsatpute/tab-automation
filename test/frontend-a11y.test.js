// Focused accessibility regression tests (axe serious/critical contract).
// Static source checks only: no DOM, no network, no backend.
// Run: node --test test/frontend-a11y.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const uiSrc = readFileSync("dashboard-app/src/views/ui.js", "utf8");
const shellSrc = readFileSync("dashboard-app/src/views/shell.js", "utf8");
const boardSrc = readFileSync("dashboard-app/src/views/board.js", "utf8");
const tasksSrc = readFileSync("dashboard-app/src/views/runs.js", "utf8");
const loopSrc = readFileSync("dashboard-app/src/views/loop.js", "utf8");

// axe aria-progressbar-name (serious): every role="progressbar" needs a name.
test("progressbars carry an accessible name", () => {
  for (const [name, src] of [["ui.js", uiSrc], ["board.js", boardSrc], ["loop.js", loopSrc]]) {
    for (const m of src.matchAll(/role="progressbar"[^>]*>/g)) {
      assert.match(m[0], /aria-label=|aria-labelledby=/, `${name}: progressbar without a name: ${m[0].slice(0, 100)}`);
    }
  }
});

// axe page-has-heading-one (moderate): pageHead renders exactly one h1.
test("pageHead renders an h1 (one per view)", () => {
  assert.match(uiSrc, /<h1>/, "pageHead must render <h1>");
  assert.doesNotMatch(uiSrc, /<h2>\$\{esc\(title\)/, "pageHead must not render h2 for the title");
});

// axe aria-allowed-role (minor): <button> must not carry role="listitem".
test("no button carries role=listitem", () => {
  for (const [name, src] of [["runs.js", tasksSrc], ["board.js", boardSrc], ["shell.js", shellSrc], ["loop.js", loopSrc]]) {
    assert.doesNotMatch(src, /<button[^>]*role="listitem"/, `${name}: button with role=listitem`);
  }
});

// axe label-content-name-mismatch (serious): card/banner buttons must not
// carry a shortened aria-label that drops their visible text. (The parent
// .banners container keeps aria-label="Needs attention" — that is fine;
// the rule targets the buttons' own names.)
test("card and banner buttons use visible text as the accessible name", () => {
  assert.doesNotMatch(tasksSrc, /class="bcard[^"]*"[^>]*aria-label=/, "runs.js: bcard must not set aria-label");
  assert.doesNotMatch(boardSrc, /class="bcard[^"]*"[^>]*aria-label=/, "board.js: bcard must not set aria-label");
  assert.doesNotMatch(loopSrc, /class="(lrow|lbanner)[ "][^>]*aria-label=/, "loop.js: rows/banners must not set aria-label");
  assert.doesNotMatch(shellSrc, /<button[^>]*class="banner[^>]*aria-label=|aria-label=[^>]*class="banner/, "shell.js: banner button must not set aria-label");
});

// Keyboard: filter inputs expose a programmatic label (axe + Tab reachability).
test("searchBox input exposes an accessible name", () => {
  assert.match(uiSrc, /aria-label="Search"/, "searchBox input needs aria-label");
});

// Offline: tick() keeps last good data and raises the offline banner only
// after 30s without a successful fetch (no blank screen, no shell sleeps).
// (Banner markup lives in shell.js topbar(); the 30s threshold in main.js.)
// Zero-success rule: transport-failure fallbacks ({tasks:[]}, null) never
// count — only fulfilled valid fetches reset the 30s clock.
test("tick() offline contract: keep data, 30s banner threshold", () => {
  const mainSrc = readFileSync("dashboard-app/src/main.js", "utf8");
  assert.match(mainSrc, /> 30000/, "offline banner threshold must be 30s");
  assert.match(mainSrc, /S\.offline = true/, "tick() must set S.offline");
  assert.match(shellSrc, /Offline — showing last good data/, "shell topbar must render the offline banner");
  assert.doesNotMatch(mainSrc, /sleep\(/, "no shell sleeps in the tick path");
  assert.match(mainSrc, /const isValid = \(r, key\)/, "success gated on fulfilled valid shape");
  assert.match(mainSrc, /if \(Array\.isArray\(tasks\?\.tasks\)\) S\.tasks = tasks\.tasks/, "no destructive empty writes");
});

// No runtime CDN: dashboard must load offline (blocked-network safe).
test("no runtime CDN references in dashboard sources", () => {
  for (const [name, src] of [["ui.js", uiSrc], ["shell.js", shellSrc], ["board.js", boardSrc], ["runs.js", tasksSrc]]) {
    assert.doesNotMatch(src, /unpkg|jsdelivr|googleapis|gstatic/, `${name}: no CDN hosts`);
    assert.doesNotMatch(src, /from\s+["']https?:/, `${name}: no remote imports`);
  }
});

test("task drawer dialog carries an accessible name and modal semantics", () => {
  const open = loopSrc.match(/<aside[^>]*id="task-detail-drawer"[^>]*>/)?.[0] || "";
  assert.match(open, /role="dialog"/, "drawer exposes dialog semantics");
  assert.match(open, /aria-modal="true"/, "drawer is modal");
  assert.match(open, /aria-label="Task detail"/, "dialog has an accessible name");
  assert.match(open, /tabindex="-1"/, "drawer is a fallback focus target");
});

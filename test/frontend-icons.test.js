// Offline icon tests: ui.js renders bundled inline SVG (no CDN, no window.lucide).
// Run: node --test test/frontend-icons.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// --- static checks on ui.js source (no DOM, no bundler) ---
const uiSrc = readFileSync("dashboard-app/src/views/ui.js", "utf8");

test("ui.js imports lucide from the bundled npm package (no CDN)", () => {
  assert.match(uiSrc, /from\s+["']lucide["']/, "must import from 'lucide' npm package");
  // NOTE: the SVG xmlns "http://www.w3.org/2000/svg" is a namespace identifier,
  // not a fetch — so ban runtime loads, not the substring "https?://".
  assert.doesNotMatch(uiSrc, /fetch\s*\(|XMLHttpRequest|<script\s+src/i, "no runtime loads");
  assert.doesNotMatch(uiSrc, /from\s+["']https?:/, "no remote imports");
  assert.doesNotMatch(uiSrc, /unpkg|jsdelivr/i, "no CDN host references");
  assert.doesNotMatch(uiSrc, /from\s+["']lucide\/dist/, "no deep dist imports");
});

test("ui.js does not import the full icons registry", () => {
  assert.doesNotMatch(uiSrc, /import\s+\*\s+as\s+icons/, "no `import * as icons`");
  assert.doesNotMatch(uiSrc, /from\s+["']lucide\/dist\/esm\/icons/, "no per-file bulk registry");
  assert.doesNotMatch(uiSrc, /\biconsAndAliases\b/, "no iconsAndAliases registry");
});

test("icon() emits inline <svg> for known names, hook for unknown", () => {
  assert.match(uiSrc, /<svg/, "icon() must render inline svg");
  assert.match(uiSrc, /data-lucide/, "svg keeps data-lucide attr for CSS/tests");
  assert.match(uiSrc, /aria-hidden="true"/, "decorative icons stay aria-hidden");
});

// --- inventory: every icon("...") / { icon: "..." } name resolves ---
function collectNames() {
  const names = new Set();
  for (const f of ["ui.js", "board.js", "tasks.js", "panels.js", "shell.js"]) {
    const t = readFileSync(`dashboard-app/src/views/${f}`, "utf8");
    for (const m of t.matchAll(/icon\(\s*["']([^"']+)["']/g)) names.add(m[1]);
    for (const m of t.matchAll(/icon:\s*["']([^"']+)["']/g)) names.add(m[1]);
    for (const m of t.matchAll(/\["[a-z0-9-]+",\s*"[^"]*",\s*"([a-z0-9-]+)"\]/g)) names.add(m[1]);
  }
  // Drop non-icon string triples (e.g. "..." placeholders matched by the pattern).
  return [...names].filter((n) => /^[a-z][a-z0-9-]{1,}$/.test(n)).sort();
}

test("every icon name used in views has a bundled node", () => {
  const used = collectNames();
  assert.ok(used.length > 40, `expected 40+ icon names, got ${used.length}`);
  const mapBody = uiSrc.slice(uiSrc.indexOf("NODES"));
  const missing = used.filter((n) => !mapBody.includes(`${n}:`) && !mapBody.includes(`"${n}":`));
  assert.deepEqual(missing, [], `unmapped icon names: ${missing.join(", ")}`);
});

// --- runtime: import the real module and render ---
const ui = await import("../dashboard-app/src/views/ui.js");

test("icon('zap') renders offline inline SVG with path data", () => {
  const html = ui.icon("zap");
  assert.match(html, /^<svg\b/, "known icon renders <svg>");
  assert.match(html, /data-lucide="zap"/, "keeps data-lucide name");
  assert.match(html, /class="ic/, "keeps .ic class for sizing");
  assert.match(html, /aria-hidden="true"/, "decorative aria-hidden preserved");
  assert.match(html, /<path\b/, "svg carries path data (not an empty hook)");
  assert.doesNotMatch(html, /<i\b/, "known icon is not an empty <i> hook");
});

test("icon() preserves extra class passthrough", () => {
  assert.match(ui.icon("plus", "foo"), /class="ic foo"/, "cls appended");
});

test("unknown icon name falls back to hidden hook (text carries meaning)", () => {
  const html = ui.icon("not-a-real-icon");
  assert.match(html, /^<i\b/, "unknown renders <i> hook");
  assert.match(html, /data-lucide="not-a-real-icon"/, "hook keeps name for CSS/debug");
});

test("refreshIcons() is a safe no-op offline (no window.lucide)", () => {
  assert.doesNotThrow(() => ui.refreshIcons(), "must not throw without window.lucide");
});

test("toolbar buttons keep text labels alongside icons", () => {
  const head = ui.pageHead("Board", "sub", `<button>${ui.icon("plus")} New task</button>`);
  assert.match(head, /New task/, "text label present next to icon");
  const box = ui.searchBox("q", "", "Filter");
  assert.match(box, /<label class="sr"/, "sr label preserved");
  assert.match(box, /<svg\b/, "search icon renders inline");
});

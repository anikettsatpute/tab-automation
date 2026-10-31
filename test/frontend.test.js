// Frontend-focused tests: pure helpers + render-region + job/session contracts.
// No backend src/** imports, no DOM, no network. Run: node --test test/frontend*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// --- load pure helpers by extracting them from state.js (no DOM at import) ---
const stateSrc = readFileSync("dashboard-app/src/views/state.js", "utf8");

function extractFn(name) {
  // Grab `export const name = ...;` (arrow, possibly multi-line) or
  // `export function name(...) {...}` blocks.
  const src = stateSrc;
  const start = src.indexOf(`export const ${name} =`);
  if (start >= 0) {
    // Balance through the arrow body: find the terminating `;` at depth 0.
    let i = src.indexOf("=", start) + 1;
    let depth = 0;
    let inStr = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === inStr && src[i - 1] !== "\\") inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      else if (ch === ";" && depth === 0) break;
    }
    const block = src.slice(start, i + 1);
    assert.ok(block.length > 20, `helper ${name} exists in state.js`);
    return block;
  }
  const m = src.match(new RegExp(`export function ${name}[\\s\\S]*?\\n\\}`, ""));
  assert.ok(m, `helper ${name} exists in state.js`);
  return m[0];
}

function loadHelper(name) {
  const block = extractFn(name).replace(/^export (const|function) /, "$1 ");
  // isJobTerminal closes over TERMINAL_JOB — include it in scope.
  const preamble = name === "isJobTerminal" ? extractFn("TERMINAL_JOB").replace(/^export const /, "const ") + "\n" : "";
  // `const name = ...; return name;` or `function name...; return name;`
  return new Function(`${preamble}${block}; return ${name};`)();
}

// regionHash must hash the FULL string (old length+first-64-chars skipped updates).
test("regionHash: same prefix, different tail -> different hash", () => {
  const src = extractFn("regionHash");
  const fn = loadHelper("regionHash");
  const a = "x".repeat(64) + "TAIL-A-payload-with-runs";
  const b = "x".repeat(64) + "TAIL-B-payload-with-runs";
  assert.notEqual(fn(a), fn(b), "prefix collision must not collapse regions");
  assert.equal(fn(a), fn(a), "deterministic");
});

// jobRunId accepts backend snake_case run_id AND camelCase runId AND nested job envelope.
test("jobRunId: snake_case, camelCase, nested job envelope", () => {
  const src = extractFn("jobRunId");
  const fn = loadHelper("jobRunId");
  assert.equal(fn({ run_id: "abc123" }), "abc123");
  assert.equal(fn({ runId: "def456" }), "def456");
  assert.equal(fn(null, { job: { run_id: "ghi789" } }), "ghi789");
  assert.equal(fn(null, null), null);
});

// isJobTerminal mirrors backend JOB_STATUSES: blocked is terminal (worker finishJob uses it).
test("isJobTerminal: blocked + cancelled are terminal, leased/running are not", () => {
  const fn = loadHelper("isJobTerminal");
  for (const s of ["done", "failed", "blocked", "cancelled", "canceled"]) assert.equal(fn(s), true, s);
  for (const s of ["queued", "leased", "running"]) assert.equal(fn(s), false, s);
});

// sessionProvenance: bare id is NOT resume evidence.
test("sessionProvenance: honest labels", () => {
  const src = extractFn("sessionProvenance");
  const fn = loadHelper("sessionProvenance");
  assert.equal(fn(null).label, "No session");
  assert.equal(fn({ sessionUuid: "abc" }).label, "Session id only");
  assert.equal(fn({ fresh: true }).label, "Fresh");
  assert.equal(fn({ resumed: true }).label, "Resumed");
});

// needsAttention never gates on prUrl (PR/ADO out of scope).
test("needsAttention: no prUrl gating", () => {
  const src = extractFn("needsAttention");
  const fn = loadHelper("needsAttention");
  assert.equal(fn({ status: "done", prUrl: "https://x" }), false);
  assert.equal(fn({ status: "failed" }), true);
  assert.equal(fn({ status: "done", blockedReason: "x" }), true);
});

// --- static contract checks (read-only, no execution) ---
const mainSrc = readFileSync("dashboard-app/src/main.js", "utf8");
const boardSrc = readFileSync("dashboard-app/src/views/board.js", "utf8");
const panelsSrc = readFileSync("dashboard-app/src/views/panels.js", "utf8");
const indexHtml = readFileSync("dashboard-app/index.html", "utf8");
const tokensCss = readFileSync("dashboard-app/src/css/tokens.css", "utf8");

const loopSrc = readFileSync("dashboard-app/src/views/loop.js", "utf8");
const escHtml = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const sliceFn = (src, start, end) => src.slice(src.indexOf(start), end ? src.indexOf(end) : undefined).replace(/export function/g, "function");

test("loop board: selection keeps the list mounted behind the drawer", () => {
  const source = sliceFn(boardSrc, "export function boardView");
  const state = { sel: "t1", boardTab: "tasks", loopTasks: [{ id: "t1" }], tasks: [] };
  const view = new Function("S", "esc", "isAutomationRun", "icon", "automationRunsView", "filteredLoopTasks", "loopBanners", "loopBoard", "loopBoardHead", "loopDrawer", `${source}; return boardView;`)(state, escHtml, () => false, () => "", () => "RUNS", () => state.loopTasks, () => "BANNERS", () => "LIST", () => "HEAD", () => "DRAWER");
  const html = view();
  for (const k of ["BANNERS", "HEAD", "LIST", "DRAWER", 'data-btab="tasks"', 'data-btab="runs"', "Board view"]) assert.ok(html.includes(k), k);
  state.sel = null;
  assert.ok(!view().includes("DRAWER"), "no drawer without a selection");
  state.boardTab = "runs";
  assert.match(view(), /RUNS/);
  assert.ok(!view().includes("LIST"), "runs tab replaces the loop list");
});

test("loop drawer opens before detail arrives and exposes errors", () => {
  const source = sliceFn(loopSrc, "export function loopDrawer");
  const state = { sel: "t1", detail: null, detailError: "" };
  const drawer = new Function("S", "esc", "icon", "loopDetailPane", `${source}; return loopDrawer;`)(state, escHtml, () => "", () => "Loaded panel");
  const html = drawer();
  for (const re of [/task-detail-drawer/, /role="dialog"/, /aria-modal="true"/, /aria-label="Task detail"/, /data-drawer-backdrop/, /Loading task details/, /id="dclose"/]) assert.match(html, re);
  state.detailError = "Unable to load <task>";
  assert.match(drawer(), /detail-retry/);
  assert.match(drawer(), /Unable to load &lt;task&gt;/);
  state.detail = { task: { id: "t1" } };
  assert.match(drawer(), /Loaded panel/);
});

test("loop ring + pills: progress is labelled and statuses map to tones", () => {
  const ring = new Function(`${sliceFn(loopSrc, "export function ring", "const matches")}; return ring;`)();
  assert.match(ring(2, 5, "running"), /aria-label="2 of 5 steps"/);
  assert.match(ring(0, 0, "queued"), /0\/0/);
  assert.match(loopSrc, /blocked: "orange"/);
  assert.match(loopSrc, /failed: "bad"/);
});

test("pipeline mermaid strips unsafe label characters", () => {
  const fn = new Function(`${sliceFn(loopSrc, "export function pipelineMermaid", "export function diagramsList")}; return pipelineMermaid;`)();
  const out = fn([{ role: 'coder"]-->x<script>', status: "done" }, { role: "tester", status: "running" }]);
  assert.ok(!/[<>"]script/.test(out) && !out.includes('coder"]'), "no injected quotes/brackets");
  assert.match(out, /s0 --> s1/);
  assert.match(out, /class s0 done/);
});

test("offline: no runtime CDN scripts or font imports", () => {
  assert.ok(!indexHtml.includes("unpkg.com"), "no unpkg script");
  assert.ok(!indexHtml.includes("jsdelivr"), "no jsdelivr script");
  assert.ok(!tokensCss.includes("fonts.googleapis.com"), "no remote fonts");
  assert.ok(!/src=["']https?:\/\//.test(indexHtml), "no remote src in index.html");
});

test("offline: chart has CSS fallback, icons degrade to text", () => {
  assert.ok(panelsSrc.includes("fbars"), "retro CSS bar fallback exists");
  assert.ok(panelsSrc.includes("if (!window.Chart) return"), "canvas enhance is optional");
  const uiSrc = readFileSync("dashboard-app/src/views/ui.js", "utf8");
  assert.ok(uiSrc.includes("createIcons?.()"), "optional icon enhance");
  assert.ok(readFileSync("dashboard-app/src/css/components.css", "utf8").includes(".ic:empty"), "empty icon hooks hidden");
});

test("board tabs: data-btab value matches S.boardTab branch", () => {
  assert.ok(boardSrc.includes('["tasks", `Tasks'), "tasks tab");
  assert.ok(boardSrc.includes('["runs", `Automation runs'), "runs tab");
  assert.ok(boardSrc.includes('S.boardTab === "runs"'), "branch matches tab value");
  assert.ok(!boardSrc.includes('"loop"'), "legacy loop tab removed");
});

test("detail sessions: clamped index + lazy file fetch per attempt", () => {
  assert.ok(loopSrc.includes("Math.min(S.sessIdx, atts.length - 1)"), "clamped session index");
  assert.ok(mainSrc.includes("${LOOP}/tasks/${S.sel}/attempts/${encodeURIComponent(aid)}/${kind}"), "attempt files fetched on demand");
  assert.ok(mainSrc.includes("S.files[key] = { loading: true }"), "loading state while fetching");
});

test("loop actions: requests, requeue, append, pause hit the loop API", () => {
  assert.ok(mainSrc.includes('const LOOP = "/api/control/loop"'));
  assert.ok(mainSrc.includes("${LOOP}/requests"), "request intake");
  assert.ok(mainSrc.includes("dispatcher: S.reqDispatcher"), "dispatcher choice sent");
  assert.ok(mainSrc.includes("fromStep: pos, guidance"), "requeue from step with guidance");
  assert.ok(mainSrc.includes("${LOOP}/tasks/${S.sel}/append-task"), "append task");
  assert.ok(mainSrc.includes('${LOOP}/${want ? "pause" : "resume"}'), "pause/resume is server-side");
  assert.ok(!mainSrc.includes("autotoggle"), "auto toggle removed — loop always runs in auto mode");
  assert.ok(mainSrc.includes("jobRunId(final, sync)"), "automation run still polls its job");
});

test("request modal: dispatcher options disable when unavailable", () => {
  assert.ok(panelsSrc.includes("data-reqdisp"), "dispatcher options");
  assert.ok(panelsSrc.includes('${d.ok ? "" : "disabled"}'), "unavailable dispatcher disabled");
  assert.ok(panelsSrc.includes("Let the divider choose"), "task type optional");
  assert.ok(panelsSrc.includes('id="req-repo"'), "repo input");
  assert.ok(!panelsSrc.includes('"assistant", "Go to Assistant"'), "assistant removed from palette");
});

test("dry-run: honest backend trace shape, no fake success", () => {
  assert.ok(mainSrc.includes("r.trace || r.steps"), "trace-first shape");
  assert.ok(mainSrc.includes("no dry-run endpoint yet"), "honest 404 message");
  assert.ok(!mainSrc.includes("Dry run executed"), "no fake success string");
});

test("attach: text-only upload UI with remove + draft persistence, no silent loss", () => {
  assert.ok(panelsSrc.includes("Attachments (text-only)"), "attach section renders");
  assert.ok(panelsSrc.includes('id="req-file"'), "standard file input present");
  assert.ok(panelsSrc.includes("data-reqdel"), "remove-attachment control present");
  assert.ok(panelsSrc.includes("reqAttachNote"), "note wired from state");
  assert.ok(panelsSrc.includes("req-attach-status"), "pending/failure status region");
  assert.ok(panelsSrc.includes('id="req-attach-list"'), "staged list region present");
  assert.ok(panelsSrc.includes('id="req-msg"'), "submit message region present");
  assert.ok(mainSrc.includes("/api/control/requests/attachments"), "upload endpoint wired");
  assert.ok(mainSrc.includes("attachments: (S.reqAttachments"), "refs sent at intake");
  assert.ok(mainSrc.includes("paintReqAttach"), "keyed targeted refresh for modal region");
  assert.ok(mainSrc.includes("S.reqAttachBusy || !!S.reqAttachErr"), "submit disabled while upload pending/errors");
  const stateSrc = readFileSync("dashboard-app/src/views/state.js", "utf8");
  assert.ok(stateSrc.includes("saveReqDraft"), "draft save exists");
  assert.ok(stateSrc.includes("restoreReqDraft"), "draft restore exists");
  assert.ok(stateSrc.includes("clearReqDraft"), "draft cleared on server ack");
  assert.ok(stateSrc.includes("tab.reqDraft.v1"), "namespaced draft key");
  assert.ok(!stateSrc.includes("reqAttachments") || !/localStorage.*reqAttachments|reqAttachments.*localStorage/.test(stateSrc), "uploaded content never persisted to localStorage");
  assert.ok(/CONTROL_TOKEN|tab_session/.test(stateSrc), "draft refuses credential-like text");
});

test("modal: focus trap + Escape closes every modal kind", () => {
  assert.ok(mainSrc.includes("wireModalFocus"), "focus trap wired");
  assert.ok(mainSrc.includes("modal.dataset.trapped"), "trap once");
  for (const k of ["S.cmdOpen", "S.showReq", "S.flowEdit", "S.diagFull"]) {
    assert.ok(mainSrc.includes(k), `Escape handles ${k}`);
  }
});

test("explicit renders update open panels while background renders preserve input", () => {
  const source = mainSrc.slice(mainSrc.indexOf("function render(background"), mainSrc.indexOf("\nfunction wireOnly"));
  const state = { showReq: true, _renderedModal: true };
  const updates = [];
  const app = { dataset: { booted: "1" } };
  const documentStub = { body: { dataset: {} }, activeElement: { tagName: "SELECT" }, querySelectorAll: () => [], getElementById: () => null };
  const renderPanel = new Function("S", "document", "$", "renderRegion", "sidebar", "topbar", "mainHtml", "reqModal", "cmdPalette", "diagramFull", "refreshIcons", "paintRetroChart", "wireOnly", "mountTaskDrawer", "paintDiagrams", `${source}; return render;`)(state, documentStub, (selector) => selector === "#app" ? app : null, (selector) => updates.push(selector), ...Array(11).fill(() => ""));
  renderPanel();
  assert.ok(updates.includes("#rg-modals"), "select changes must update an already open modal");
  updates.length = 0;
  renderPanel(true);
  assert.equal(updates.length, 0, "polling must preserve an active editor");
});

test("detail polling does not cancel in-flight fetches and errors expose retry", () => {
  assert.ok(mainSrc.includes("!S.detailAbort && !S.detailError"));
  assert.ok(mainSrc.includes('$("#detail-retry")'));
  assert.ok(mainSrc.includes('S.detailError = error.message'));
});

test("task drawer traps focus, survives background ticks, and returns focus", () => {
  const source = mainSrc.slice(mainSrc.indexOf("function mountTaskDrawer()"), mainSrc.indexOf("function closeTaskDetail()"));
  const state = { sel: "run-1" };
  let drawer = { id: "task-detail-drawer" };
  let created = 0;
  let activated = 0;
  let deactivated = 0;
  let updated = null;
  let focused = null;
  const card = { focus: () => { focused = "run-1"; } };
  const trap = {
    activate: () => { activated++; },
    deactivate: () => { deactivated++; },
    updateContainerElements: (el) => { updated = el; },
  };
  const mount = new Function("$", "document", "S", "createFocusTrap", `let taskTrap = null; let taskTrapSel = null; ${source}; return mountTaskDrawer;`)(() => drawer, { querySelector: () => card }, state, () => { created++; return trap; });
  mount();
  assert.equal(created, 1, "trap created on drawer mount");
  assert.equal(activated, 1, "trap activated on drawer mount");
  mount();
  assert.equal(created, 1, "background ticks must not recreate the trap");
  assert.equal(updated, drawer, "re-rendered drawer node refreshes trap containers");
  drawer = { id: "task-detail-drawer" };
  mount();
  assert.equal(created, 1, "no new trap when the drawer node is replaced");
  assert.equal(updated, drawer, "trap follows the latest drawer node");
  drawer = null;
  mount();
  assert.equal(deactivated, 1, "closing the drawer deactivates the trap");
  assert.equal(focused, "run-1", "focus returns to the originating task");
});

test("task drawer closes via Escape, backdrop, and buttons", () => {
  assert.ok(mainSrc.includes('import { createFocusTrap } from "focus-trap"'), "focus-trap library wired");
  assert.ok(mainSrc.includes("escapeDeactivates: false"), "Escape owned by the app close path");
  assert.ok(mainSrc.includes("returnFocusOnDeactivate: false"), "focus return owned by the app");
  assert.ok(mainSrc.includes("else if (S.sel) { closeTaskDetail(); }"), "Escape closes the drawer");
  assert.ok(mainSrc.includes("[data-drawer-backdrop]"), "backdrop click closes the drawer");
  assert.ok(mainSrc.includes('$("#dclose")'), "close button wired");
  assert.ok(!mainSrc.includes("mountTaskSplit"), "split layout removed");
});

test("task drawer styling: fixed right panel at every viewport", () => {
  const boardCss = readFileSync("dashboard-app/src/css/board.css", "utf8");
  assert.match(boardCss, /\.tdrawer \{[^}]*position: fixed/, "drawer is fixed");
  assert.match(boardCss, /width: min\(900px, 75vw\)/, "substantial desktop width");
  assert.match(boardCss, /\.tdrawer-backdrop/, "backdrop dims the board");
  assert.match(boardCss, /max-width: 760px[\s\S]*?\.tdrawer \{ width: 100%/, "full-width drawer on narrow mobile");
});

test("offline: transport-failure fallbacks never count as success", () => {
  // Bug caught: failed poll catch returned {tasks:[]} keeping anyOk truthy ->
  // S.offline stayed false forever. Only fulfilled valid fetches count.
  assert.ok(mainSrc.includes("const isValid = (r, key)"), "shape-gated success check exists");
  assert.ok(!mainSrc.includes("Array.isArray(r.tasks) || Array.isArray(r.activity)"), "old truthy-fallback check removed");
  assert.ok(mainSrc.includes("isValidFeed(feed)"), "feed shape validated before counting success");
  assert.ok(mainSrc.includes("zero actual successes"), "documents the zero-success offline rule");
});

test("offline: no destructive empty-array writes on transport failure", () => {
  // tick() must preserve rows/selection/focus: only overwrite on real payloads.
  // Transport failures resolve to null (never {tasks:[]}), and every write is
  // null-guarded so a failed poll cannot blank the board.
  assert.ok(mainSrc.includes("if (Array.isArray(tasks?.tasks)) S.tasks = tasks.tasks"), "tasks only overwritten on real payload");
  assert.ok(mainSrc.includes("if (!S.sseConnected && isValidFeed(feed))"), "poll feed never clobbers live SSE snapshot");
});

test("SSE: authenticated same-origin client, single source, lifecycle", () => {
  // HttpOnly same-origin auth: no token query, no Authorization header.
  assert.ok(mainSrc.includes('new EventSource("/api/feed/stream")'), "same-origin stream URL");
  assert.ok(!mainSrc.includes("feed/stream?token"), "no token query param");
  assert.ok(!mainSrc.includes("feed/stream?since"), "no manual since param (native Last-Event-ID)");
  // Single source: one module-level handle, guarded connect, explicit close.
  assert.ok(mainSrc.includes("let feedEs = null"), "single module-level handle");
  assert.ok(mainSrc.includes("if (feedEs) return feedEs"), "connect guarded against duplicates");
  assert.ok(mainSrc.includes("closeFeedStream()"), "explicit teardown exists");
  // Auth lifecycle: logout tears down, denied fan-out closes, login reconnects.
  assert.ok(mainSrc.includes("closeFeedStream(); await logoutSession()"), "logout tears down stream");
  assert.ok(mainSrc.includes("connectFeedStream(); tick(true)"), "login reconnects stream");
  // Correct shape only: snapshot/reset apply versioned valid feeds, heartbeat ignored.
  assert.ok(mainSrc.includes('addEventListener("snapshot"'), "snapshot listener");
  assert.ok(mainSrc.includes('addEventListener("reset"'), "reset baseline listener");
  assert.ok(mainSrc.includes('addEventListener("heartbeat"'), "heartbeat listener");
  assert.ok(mainSrc.includes("applyFeedSnapshot(d.version, d.feed)"), "versioned apply gate");
  assert.ok(mainSrc.includes("if (applyFeedSnapshot(d.version, d.feed)) render(true)"), "live snapshots preserve open editors");
  assert.ok(mainSrc.includes("if (latest && applyFeedSnapshot(latest.version, latest.feed)) render(true)"), "live resets preserve open editors");
  assert.ok(mainSrc.includes("S.feedVersion = version"), "version tracked");
  // State flags for polling fallback + offline banner.
  assert.ok(readFileSync("dashboard-app/src/views/state.js", "utf8").includes("feedVersion"), "S.feedVersion exists");
  assert.ok(readFileSync("dashboard-app/src/views/state.js", "utf8").includes("sseConnected"), "S.sseConnected exists");
});

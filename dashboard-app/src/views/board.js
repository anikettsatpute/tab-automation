// Board shell: OrchestratorLoop tasks (default) + scheduled automation runs.
// Pure render functions — state + events live in main.js.
import { S, esc, isAutomationRun } from "./state.js";
import { icon } from "./ui.js";
import { automationRunsView } from "./tasks.js";
import { filteredLoopTasks, loopBanners, loopBoard, loopBoardHead, loopDrawer } from "./loop.js";

export function boardView() {
  const list = filteredLoopTasks();
  const runs = (S.tasks || []).filter(isAutomationRun).length;
  const tabs = [["tasks", `Tasks (${(S.loopTasks || []).length})`, "list"], ["runs", `Automation runs${runs ? ` (${runs})` : ""}`, "workflow"]];
  const tabBar = `<div class="btabs" role="tablist" aria-label="Board view">${tabs.map(([v, l, ic]) => `<button type="button" role="tab" aria-selected="${S.boardTab === v}" class="tab ${S.boardTab === v ? "on" : ""}" data-btab="${v}">${icon(ic)} ${esc(l)}</button>`).join("")}</div>`;
  const stale = S.offline ? `<div class="notice" role="status">Server unreachable — showing last loaded data.</div>` : "";
  if (S.boardTab === "runs") return `${stale}${tabBar}${automationRunsView()}`;
  return `${loopBanners()}${stale}${loopBoardHead(list)}${tabBar}${loopBoard(list)}${S.sel ? loopDrawer() : ""}`;
}

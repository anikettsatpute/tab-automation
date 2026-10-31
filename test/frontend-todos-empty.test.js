// Dashboard must not crash when the todo list is empty or not yet loaded.
// Regression test for: "Fix dashboard crash when the todo list is empty".
// Pure render functions only — no DOM, no network. Run: node --test test/frontend-todos-empty.test.js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { S } from "../dashboard-app/src/views/state.js";
import { sidebar } from "../dashboard-app/src/views/shell.js";
import { todosView } from "../dashboard-app/src/views/panels.js";

const prevTodos = S.todos;
afterEach(() => { S.todos = prevTodos; });

test("sidebar renders with an empty todo list", () => {
  S.todos = [];
  const html = sidebar();
  assert.match(html, /TODOs/);
  assert.doesNotMatch(html, /NaN|undefined items/);
});

test("sidebar renders when the todo list is null (never loaded)", () => {
  S.todos = null;
  assert.doesNotThrow(() => sidebar());
  assert.match(sidebar(), /TODOs/);
});

test("sidebar renders when the todo list is undefined", () => {
  S.todos = undefined;
  assert.doesNotThrow(() => sidebar());
});

test("todosView renders empty and missing todo lists", () => {
  for (const v of [[], null, undefined]) {
    S.todos = v;
    const html = todosView();
    assert.match(html, /No TODOs/);
  }
});

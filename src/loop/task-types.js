// Task-type registry (config/task-types.json). Optional templates the divider may reuse.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./workspace.js";

const file = (root) => path.join(root, "config", "task-types.json");
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function loadTaskTypes(root) {
  try {
    if (!existsSync(file(root))) return [];
    const doc = JSON.parse(readFileSync(file(root), "utf8"));
    return Array.isArray(doc.taskTypes) ? doc.taskTypes : [];
  } catch { return []; }
}

export function validateTaskType(tt, knownRoles = null) {
  if (!tt || !ID.test(String(tt.id || ""))) return "id must be lowercase letters/digits/-/_";
  if (!String(tt.name || "").trim()) return "name required";
  if (!Array.isArray(tt.steps) || !tt.steps.length || tt.steps.length > 12) return "1–12 steps required";
  for (const s of tt.steps) {
    if (!s || !String(s.role || "").trim() || !String(s.goal || "").trim()) return "each step needs role and goal";
    if (knownRoles && !knownRoles.includes(s.role)) return `unknown role '${s.role}'`;
  }
  return null;
}

export function saveTaskTypes(root, list) {
  atomicWrite(file(root), JSON.stringify({ taskTypes: list }, null, 2) + "\n");
}

export function upsertTaskType(root, tt, knownRoles) {
  const err = validateTaskType(tt, knownRoles);
  if (err) throw new Error(err);
  const list = loadTaskTypes(root).filter((x) => x.id !== tt.id);
  list.push({ id: tt.id, name: String(tt.name).slice(0, 80), description: String(tt.description || "").slice(0, 400), steps: tt.steps.map((s) => ({ role: s.role, goal: String(s.goal).slice(0, 2000) })) });
  saveTaskTypes(root, list);
  return list;
}

export function deleteTaskType(root, id) {
  const list = loadTaskTypes(root).filter((x) => x.id !== id);
  saveTaskTypes(root, list);
  return list;
}

// Dashboard SQLite DB — separate from the bot DB (data/tab-automation.db).
// File: data/dashboard.db (WAL). Stores dashboard settings + view state so the
// Control Room survives restarts and is independent of bot run data.
// Uses built-in node:sqlite (Node >= 22, Termux-safe, no native deps).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dashboard_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dashboard_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT 'default',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

let _db = null;

export function dashboardDbPath(root) {
  return path.join(root, "data", "dashboard.db");
}

export function openDashboardDb(root) {
  if (_db) return _db;
  mkdirSync(path.join(root, "data"), { recursive: true });
  _db = new DatabaseSync(dashboardDbPath(root));
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec(SCHEMA);
  return _db;
}

const now = () => new Date().toISOString();

export function getDashboardSetting(root, key, fallback = "") {
  const row = openDashboardDb(root).prepare("SELECT value FROM dashboard_settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setDashboardSetting(root, key, value) {
  openDashboardDb(root).prepare(
    "INSERT INTO dashboard_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

/** Dashboard config: DB first, then config/dashboard.json, then defaults. */
export function getDashboardConfig(root, loadJson) {
  const defaults = { enabled: true, refreshSec: 3, showRuns: true, showApprovals: true, showWorkflows: true };
  let cfg = { ...defaults };
  try {
    const fileCfg = loadJson("config/dashboard.json", {});
    cfg = { ...cfg, ...fileCfg };
  } catch { /* defaults */ }
  try {
    const raw = getDashboardSetting(root, "config", "");
    if (raw) cfg = { ...cfg, ...JSON.parse(raw) };
  } catch { /* keep file/defaults */ }
  return cfg;
}

export function saveDashboardConfig(root, loadJson, saveJson, cfg) {
  // Persist to both: JSON (human-editable) + SQLite (runtime source of truth)
  try { saveJson("config/dashboard.json", cfg); } catch { /* best effort */ }
  setDashboardSetting(root, "config", JSON.stringify(cfg));
  setDashboardSetting(root, "updated_at", now());
  return cfg;
}

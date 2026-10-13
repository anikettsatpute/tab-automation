import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_TURNS = 4000; // soft cap: oldest turns pruned beyond this

function memPaths(root) {
  const dir = path.join(root, "data", "memory");
  return { dir, file: path.join(dir, "memory.jsonl") };
}

function ensure(root) {
  const { dir, file } = memPaths(root);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) appendFileSync(file, "");
  return file;
}

export function saveMemory(root, { kind = "note", user = "", text = "", channelId = "" }) {
  const file = ensure(root);
  const entry = { ts: new Date().toISOString(), kind, user, text: String(text).slice(0, 2000), channelId };
  appendFileSync(file, JSON.stringify(entry) + "\n");
  prune(root);
  return entry;
}

export function loadAll(root) {
  const file = ensure(root);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function tokens(s) {
  return String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
}

// Cheap keyword retrieval: token overlap + recency boost. No embeddings, no API cost.
export function searchMemory(root, query, limit = 5) {
  const all = loadAll(root);
  if (!all.length) return [];
  const q = new Set(tokens(query));
  if (!q.size) return all.slice(-limit).reverse();
  const scored = all.map((e, i) => {
    const et = new Set(tokens(`${e.text} ${e.user}`));
    let overlap = 0;
    for (const t of q) if (et.has(t)) overlap += 1;
    const recency = i / all.length; // 0..1, newer wins ties
    return { e, score: overlap * 10 + recency };
  }).filter((s) => s.score > 0.05);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

export function recentMemory(root, limit = 8) {
  return loadAll(root).slice(-limit);
}

export function memoryStats(root) {
  const all = loadAll(root);
  const kinds = {};
  for (const e of all) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  return { total: all.length, kinds, oldest: all[0]?.ts ?? null, newest: all[all.length - 1]?.ts ?? null };
}

function prune(root) {
  try {
    const { file } = memPaths(root);
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    if (lines.length > MAX_TURNS + 500) {
      const keep = lines.slice(-MAX_TURNS);
      writeFileSync(file, keep.join("\n") + "\n");
    }
  } catch { /* best effort */ }
}

export function formatMemories(entries) {
  if (!entries.length) return "No relevant memories.";
  return entries.map((e) => `- [${e.ts.slice(0, 10)}] (${e.kind}${e.user ? `, ${e.user}` : ""}) ${e.text}`).join("\n");
}

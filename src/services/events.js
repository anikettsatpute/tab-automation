// Ordered SSE event buffer for the dashboard feed.
//
// Design (SSE phase, backend only):
// - DB is authoritative. Every tick builds a versioned snapshot from the same
//   sources as GET /api/feed (runs + steps + memory messages + stats).
// - Snapshots are appended to a bounded per-root ring buffer ONLY when the
//   version changes. Each event gets a monotonic ordered id `<boot>:<seq>`.
// - Reconnects send Last-Event-ID (or ?since=): buffered events after that id
//   replay in order. Unknown boot, unknown id, evicted id, or an id older
//   than the replay window -> explicit `reset` so the client refetches.
// - No durable event bus, no DB writes, no Discord. Reads only.
import { createHash, randomUUID } from "node:crypto";
import { listRuns, getRun } from "../db.js";
import { loadAll } from "../memory.js";

export const EVENTS_MAX_BUFFERED = 50;
export const EVENTS_WINDOW_MS = 5 * 60 * 1000;
export const EVENTS_TICK_MS_DEFAULT = 3000;
export const EVENTS_HEARTBEAT_MS_DEFAULT = 15000;

// Per-process boot marker: ids from a previous boot (server restart) never
// replay — the client gets a reset and refetches. Lead restarts the shared
// headless server after deploy, so clients must handle this path.
const BOOT = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 6);

const _states = new Map(); // stateKey(root, limit) -> { seq, events: [{ id, seq, version, at, snapshot }] }
const _active = new Set(); // live stream ids (disconnect cleanup observability)

export function bootShort() {
  return BOOT;
}

/**
 * Canonical feed page size for the SSE contract. The snapshot shape depends
 * on `limit`, so buffers partition by (root, limit) — differing limits must
 * not share version comparisons or replay cursors. Event ids are scoped to
 * their partition; clients reconnect with the same URL (same limit), so the
 * native Last-Event-ID cursor stays in-partition.
 */
export function normalizeFeedLimit(limit) {
  return Math.min(Math.max(Number(limit) || 8, 1), 20);
}

function stateKey(root, limit) {
  return `${root}::limit=${normalizeFeedLimit(limit)}`;
}

function resolveLimitArg(limitOrOpts) {
  if (limitOrOpts == null) return 8;
  if (typeof limitOrOpts === "object") return limitOrOpts.limit ?? 8;
  return limitOrOpts;
}

function getState(root, limitOrOpts) {
  const key = stateKey(root, resolveLimitArg(limitOrOpts));
  let s = _states.get(key);
  if (!s) {
    s = { seq: 0, events: [] };
    _states.set(key, s);
  }
  return s;
}

/** Test-only: drop buffered state for a root (all limit partitions, or one). */
export function resetEventsState(root, limitOrOpts) {
  if (typeof limitOrOpts === "undefined") {
    _states.delete(root); // legacy bare-root key (pre-partition)
    for (const key of [..._states.keys()]) {
      if (key === root || key.startsWith(`${root}::limit=`)) _states.delete(key);
    }
    return;
  }
  _states.delete(stateKey(root, resolveLimitArg(limitOrOpts)));
}

export function activeStreamCount() {
  return _active.size;
}

export function trackStream(id) {
  _active.add(id);
}

export function untrackStream(id) {
  _active.delete(id);
}

/** Same shape as GET /api/feed (runs + steps + memory messages + stats). */
export function buildFeedSnapshot(root, { limit = 8 } = {}) {
  const lim = normalizeFeedLimit(limit);
  const baseRuns = listRuns(root, { limit: lim });
  const runs = baseRuns.map((r) => {
    let full = r;
    try {
      full = getRun(root, r.id) || r;
    } catch {
      /* keep base */
    }
    let trigger = {};
    try {
      trigger = JSON.parse(full.trigger_json || "{}");
    } catch {
      /* ignore */
    }
    return {
      id: full.id,
      workflowId: full.workflow_id,
      kind: full.kind,
      status: full.status,
      startedAt: full.started_at,
      finishedAt: full.finished_at,
      error: full.error,
      trigger: {
        text: trigger.text || "",
        user: trigger.user || "",
        kind: trigger.kind || full.kind,
        channelId: trigger.channelId || "",
      },
      steps: (full.steps || []).map((s) => ({
        id: s.step_id,
        type: s.type,
        agent: s.agent,
        status: s.status,
        text: String(s.raw_text || "").slice(0, 1200),
        at: s.created_at,
      })),
    };
  });
  let messages = [];
  try {
    const all = loadAll(root);
    messages = all
      .filter((e) => ["chat", "reply", "pipeline"].includes(e.kind))
      .slice(-30)
      .map((e) => ({
        ts: e.ts,
        kind: e.kind,
        user: e.user,
        text: String(e.text || "").slice(0, 800),
        channelId: e.channelId,
      }));
  } catch {
    /* memory optional */
  }
  const stats = {
    running: runs.filter((r) => r.status === "running").length,
    done: runs.filter((r) => r.status === "done").length,
    failed: runs.filter((r) => r.status === "failed").length,
    total: runs.length,
  };
  return { at: new Date().toISOString(), source: "headless-local", runs, messages, stats };
}

/** Version string derived from DB content only — changes iff the feed changes. */
export function snapshotVersion(snapshot) {
  const runs = (snapshot.runs || [])
    .map((r) => `${r.id}|${r.status}|${r.finishedAt || ""}|${(r.steps || []).length}`)
    .join(",");
  const msgs = (snapshot.messages || []).map((m) => `${m.ts}|${m.kind}`).join(",");
  const lastMsg = (snapshot.messages || []).at(-1)?.ts || "";
  const canonical = `${runs}#${msgs}#${lastMsg}#${snapshot.stats?.running ?? 0},${snapshot.stats?.done ?? 0},${snapshot.stats?.failed ?? 0}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** Build a snapshot and buffer it if the version changed (partitioned by limit). */
export function tickEvents(root, { limit = 8 } = {}) {
  const snapshot = buildFeedSnapshot(root, { limit });
  return appendSnapshot(root, snapshot, { limit });
}

export function appendSnapshot(root, snapshot, limitOrOpts) {
  const version = snapshotVersion(snapshot);
  const s = getState(root, limitOrOpts);
  const last = s.events.at(-1);
  if (last && last.version === version) return { emitted: false, event: last };
  s.seq += 1;
  const event = { id: `${BOOT}:${s.seq}`, seq: s.seq, version, at: Date.now(), snapshot };
  s.events.push(event);
  while (s.events.length > EVENTS_MAX_BUFFERED) s.events.shift();
  return { emitted: true, event };
}

export function latestEvent(root, limitOrOpts) {
  return getState(root, limitOrOpts).events.at(-1) || null;
}

function parseEventId(id) {
  const parts = String(id || "").split(":");
  if (parts.length !== 2 || parts[0] !== BOOT) return null;
  const seq = Number(parts[1]);
  if (!Number.isInteger(seq) || seq < 1) return null;
  return seq;
}

/**
 * Ordered replay after a client-supplied id (Last-Event-ID / ?since=).
 * Returns { events, reset, reason, latest }.
 * reset=true with reason unknown-id|window-expired means: discard local
 * state, apply `latest` as the new baseline (same contract as poll fallback).
 */
export function replayAfter(root, lastId, limitOrOpts) {
  const s = getState(root, limitOrOpts);
  const latest = s.events.at(-1) || null;
  if (!lastId) return { events: [], reset: false, reason: null, latest };
  const seq = parseEventId(lastId);
  if (seq == null) return { events: [], reset: true, reason: "unknown-id", latest };
  const idx = s.events.findIndex((e) => e.seq === seq);
  if (idx === -1) {
    if (s.events.length === 0) return { events: [], reset: true, reason: "unknown-id", latest };
    if (seq < s.events[0].seq) return { events: [], reset: true, reason: "window-expired", latest };
    // seq beyond the tip (or a gap, which cannot happen with contiguous seqs):
    // client is current or ahead — nothing to replay.
    return { events: [], reset: false, reason: null, latest };
  }
  const anchor = s.events[idx];
  if (Date.now() - anchor.at > EVENTS_WINDOW_MS) {
    return { events: [], reset: true, reason: "window-expired", latest };
  }
  return { events: s.events.slice(idx + 1), reset: false, reason: null, latest };
}

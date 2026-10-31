// SSE dashboard stream: GET /api/feed/stream (same-origin HttpOnly session auth).
//
// Auth: the central middleware in src/headless-dashboard.js gates this path
// (it matches /api/feed/*), so only local sockets, valid session cookies, or
// valid Bearer tokens reach here. No token query params — EventSource sends
// the same-origin session cookie by default (withCredentials is implicit for
// same-origin). GET-only, so no CSRF mutation surface; Origin is still
// checked when present (DNS-rebinding defense, same as other safe reads).
//
// Protocol:
// - event: snapshot { id, data: { version, at, feed } } — periodic versioned
//   dashboard snapshots, emitted only when the DB-derived version changes.
// - event: heartbeat { data: { at, latest } } — keeps proxies/NAT alive.
// - event: reset { id, data: { reason, latest } } — client must discard local
//   state and apply `latest` as the new baseline (same as poll fallback).
//   The reset carries the latest event id so native Last-Event-ID advances.
// - Reconnect: Last-Event-ID header (EventSource native) or ?since=.
//   Buffered events after that id replay in order; unknown/evicted/expired
//   ids get an explicit reset instead of a silent gap.
import { streamSSE } from "hono/streaming";
import {
  tickEvents,
  replayAfter,
  latestEvent,
  normalizeFeedLimit,
  trackStream,
  untrackStream,
  EVENTS_TICK_MS_DEFAULT,
  EVENTS_HEARTBEAT_MS_DEFAULT,
} from "../services/events.js";
import { randomUUID } from "node:crypto";

export function registerEventRoutes(app, ctx) {
  const { root, log } = ctx;

  app.get("/api/feed/stream", (c) => {
    const tickMs = Math.min(
      Math.max(Number(c.req.query("tickMs")) || EVENTS_TICK_MS_DEFAULT, 1000),
      30000
    );
    const heartbeatMs = Math.min(
      Math.max(Number(c.req.query("heartbeatMs")) || EVENTS_HEARTBEAT_MS_DEFAULT, 5000),
      60000
    );
    const limit = normalizeFeedLimit(c.req.query("limit"));
    const since =
      (c.req.header("last-event-id") || "").trim() || (c.req.query("since") || "").trim() || null;

    return streamSSE(c, async (stream) => {
      const streamId = randomUUID().slice(0, 8);
      trackStream(streamId);
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        untrackStream(streamId);
      });
      try {
        // Per-connection cursor: the buffer is shared, so tickEvents() may
        // report emitted=false on this connection when another connection
        // already advanced the tip. Every stream therefore replays after its
        // own lastSentId regardless of who ticked.
        let lastSentId = null;
        // Ensure a tip exists, then resolve the baseline against this
        // connection's cursor (same contract as the poll fallback).
        tickEvents(root, { limit });
        const baseline = replayAfter(root, since, { limit });
        const sendSnapshot = async (e) => {
          await stream.writeSSE({
            event: "snapshot",
            id: e.id,
            data: JSON.stringify({ version: e.version, at: e.snapshot.at, feed: e.snapshot }),
          });
        };
        const sendReset = async (r) => {
          await stream.writeSSE({
            event: "reset",
            ...(r.latest ? { id: r.latest.id } : {}),
            data: JSON.stringify({
              reason: r.reason,
              latest: r.latest
                ? { id: r.latest.id, version: r.latest.version, feed: r.latest.snapshot }
                : null,
            }),
          });
        };
        if (baseline.reset) {
          await sendReset(baseline);
          lastSentId = baseline.latest ? baseline.latest.id : null;
        } else if (baseline.events.length > 0) {
          for (const e of baseline.events) {
            if (closed || stream.aborted) break;
            await sendSnapshot(e);
            lastSentId = e.id;
          }
        } else if (!since) {
          // Fresh subscriber: the current tip is the baseline.
          const tip = latestEvent(root, { limit });
          if (tip) {
            await sendSnapshot(tip);
            lastSentId = tip.id;
          }
        } else {
          // Client already current (or ahead): anchor to the tip so future
          // ticks replay, without resending what the client already has.
          const tip = latestEvent(root, { limit });
          lastSentId = tip ? tip.id : null;
        }

        let lastBeat = Date.now();
        while (!closed && !stream.aborted) {
          await stream.sleep(tickMs);
          if (closed || stream.aborted) break;
          // Advance the shared buffer (another connection may have done so
          // already — the return value is intentionally ignored here).
          tickEvents(root, { limit });
          const replay = replayAfter(root, lastSentId, { limit });
          if (replay.reset) {
            await sendReset(replay);
            lastSentId = replay.latest ? replay.latest.id : null;
            lastBeat = Date.now();
          } else if (replay.events.length > 0) {
            for (const e of replay.events) {
              if (closed || stream.aborted) break;
              await sendSnapshot(e);
              lastSentId = e.id;
            }
            lastBeat = Date.now();
          } else if (Date.now() - lastBeat >= heartbeatMs) {
            const tip = latestEvent(root, { limit });
            await stream.writeSSE({
              event: "heartbeat",
              data: JSON.stringify({ at: new Date().toISOString(), latest: tip ? tip.id : null }),
            });
            lastBeat = Date.now();
          }
        }
      } finally {
        untrackStream(streamId);
        try {
          log?.(`[events] stream closed`);
        } catch {
          /* ignore */
        }
      }
    });
  });
}

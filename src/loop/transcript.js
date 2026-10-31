// Transcript normalizer: Muse `exec --json` JSONL, Muse `export` docs and Copilot
// `--output-format json` JSONL -> one chat shape the dashboard renders like a CLI session.
// items: { k: "user"|"assistant"|"thinking"|"tool", text?, name?, title?, command?, output?, exitCode?, ok? }
const MAX_ITEMS = 400;
const MAX_TEXT = 20000;
const MAX_OUT = 8000;
const cut = (s, n) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more chars)` : t; };
const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

function lines(text) {
  const out = [];
  for (const l of String(text || "").split("\n")) {
    const s = l.trim();
    if (!s.startsWith("{")) continue;
    const o = tryJson(s);
    if (o && typeof o === "object") out.push(o);
  }
  return out;
}

function builder() {
  const items = [];
  const tools = new Map();
  const meta = { model: "", sessionId: "", usage: null };
  const push = (it) => { if (items.length < MAX_ITEMS) items.push(it); return it; };
  return {
    items, meta,
    say(k, text) {
      const t = String(text || "").trim();
      if (!t) return;
      const last = items[items.length - 1];
      if (last && last.k === k && k !== "user") { last.text = cut(`${last.text}\n\n${t}`, MAX_TEXT); return; }
      push({ k, text: cut(t, MAX_TEXT) });
    },
    tool(id, patch) {
      let it = id ? tools.get(id) : null;
      if (!it) { it = push({ k: "tool", name: "tool", title: "", command: "", output: "", exitCode: null, ok: null }); if (id) tools.set(id, it); }
      for (const [key, v] of Object.entries(patch)) if (v != null && v !== "") it[key] = key === "output" ? cut(v, MAX_OUT) : v;
      return it;
    },
  };
}

// Muse shell results are JSON text: {command, description, exit_code, output, ...}.
function museToolText(text) {
  const o = tryJson(String(text || "").trim());
  if (o && typeof o === "object" && ("output" in o || "command" in o)) {
    return { command: o.command, title: o.description, output: o.output ?? "", exitCode: Number.isFinite(o.exit_code) ? o.exit_code : null };
  }
  return { output: String(text || "") };
}

function parseMuseExec(recs) {
  const b = builder();
  let buf = "", terminal = "";
  const flush = () => { if (buf.trim()) b.say("assistant", buf); buf = ""; };
  for (const r of recs) {
    const p = r.payload || {};
    switch (r.payload_type) {
      case "turn.input.user": flush(); b.say("user", p.prompt); break;
      case "run.model.configured": b.meta.model = p.model_id || b.meta.model; break;
      case "run.output.delta": buf += p.text || ""; break;
      case "task.lifecycle.side_effect_intent": {
        const op = String(p.event?.operation || "");
        if (!op.startsWith("tool:")) break;
        flush();
        b.tool(String(p.event?.idempotency_key || "").replace(/^tool:/, ""), { name: op.slice(5) });
        break;
      }
      case "tool.result": {
        const f = p.correlation_facts || {};
        b.tool(p.call_id, { name: f.tool_name, ok: f.outcome ? f.outcome === "success" : null, ...museToolText(p.text) });
        break;
      }
      case "run.usage": {
        const m = (p.models || [])[0];
        if (m) b.meta.usage = { input: m.input_tokens, output: m.output_tokens, cached: m.cached_tokens, calls: p.calls };
        break;
      }
      case "run.terminal.completed": terminal = p.text || ""; break;
      default: break;
    }
  }
  flush();
  if (!b.items.some((i) => i.k === "assistant") && terminal) b.say("assistant", terminal);
  return { format: "muse", items: b.items, meta: b.meta };
}

function parseCopilot(recs) {
  const b = builder();
  for (const r of recs) {
    const d = r.data || {};
    switch (r.type) {
      case "session.auto_mode_resolved": b.meta.model = d.chosenModel || b.meta.model; break;
      case "session.tools_updated": b.meta.model = b.meta.model || d.model || ""; break;
      case "user.message": b.say("user", d.content); break;
      case "assistant.message":
        if (d.model) b.meta.model = d.model;
        b.say("assistant", d.content);
        for (const t of d.toolRequests || []) b.tool(t.toolCallId, { name: t.name, command: t.arguments?.command, title: t.arguments?.description || t.intentionSummary });
        break;
      case "tool.execution_start":
        b.tool(d.toolCallId, { name: d.toolName, command: d.arguments?.command, title: d.arguments?.description || d.toolTitle });
        break;
      case "tool.execution_complete": {
        const out = typeof d.result?.content === "string" ? d.result.content : d.result?.detailedContent || d.error?.message || "";
        b.tool(d.toolCallId, { output: out, ok: typeof d.success === "boolean" ? d.success : null, exitCode: d.shellExecution?.exitCode ?? null });
        break;
      }
      case "result":
        b.meta.sessionId = r.sessionId || d.sessionId || "";
        if (r.usage || d.usage) b.meta.usage = r.usage || d.usage;
        break;
      default: break;
    }
  }
  return { format: "copilot", items: b.items, meta: b.meta };
}

/** Parse a dispatcher transcript (JSONL event stream or plain text). */
export function parseTranscript(text) {
  const recs = lines(text);
  if (recs.some((r) => typeof r.payload_type === "string")) return parseMuseExec(recs.filter((r) => r.payload_type));
  if (recs.some((r) => typeof r.type === "string" && (r.data || r.type === "result"))) return parseCopilot(recs);
  return { format: "text", items: [], meta: {}, raw: cut(text, 400000) };
}

/** Final assistant text of a structured transcript ("" when not structured). */
export function finalAssistantText(text) {
  const t = parseTranscript(text);
  if (t.format === "text") return "";
  const asst = t.items.filter((i) => i.k === "assistant");
  return asst.length ? asst[asst.length - 1].text : "";
}

/** Normalize a `muse export --out` document (session log) into the same chat shape. */
export function parseMuseExport(doc) {
  const recs = [];
  for (const e of doc?.events || []) {
    const env = e.envelope || {};
    if (env.payload_type) recs.push(env);
    for (const k of env.children || []) { const r = tryJson(k.record_json || ""); if (r?.payload_type) recs.push(r); }
  }
  const b = builder();
  const usage = { input: 0, output: 0, cached: 0, calls: 0 };
  for (const r of recs) {
    const p = r.payload || {};
    if (r.payload_type === "run.model.configured") { b.meta.model = p.record?.model_id || p.model_id || b.meta.model; continue; }
    if (r.payload_type !== "runtime.session" || p.kind !== "run" || !p.event) continue;
    const ev = p.event;
    switch (ev.kind) {
      case "started": b.say("user", ev.prompt); break;
      case "reasoning_summary_committed": b.say("thinking", ev.text); break;
      case "assistant_message_committed": b.say("assistant", ev.text); break;
      case "assistant_tool_calls_committed":
        for (const t of ev.tool_calls || []) {
          const a = typeof t.args === "string" ? tryJson(t.args) || {} : t.args || {};
          b.tool(t.call_id, { name: t.name, command: a.command || a.path || a.query, title: a.description });
        }
        break;
      case "tool_result_batch_committed":
        for (const x of ev.results || []) {
          const parsed = museToolText(x.text);
          b.tool(x.tool_call_id, { ...parsed, ok: parsed.exitCode == null ? null : parsed.exitCode === 0 });
        }
        break;
      case "model_completed":
        usage.input += ev.usage?.input_tokens || 0; usage.output += ev.usage?.output_tokens || 0;
        usage.cached += ev.usage?.cached_tokens || 0; usage.calls += 1;
        break;
      default: break;
    }
  }
  if (usage.calls) b.meta.usage = usage;
  return { format: "muse", items: b.items, meta: b.meta };
}

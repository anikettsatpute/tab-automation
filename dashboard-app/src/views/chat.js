// Session transcript as a chat (Copilot CLI / VS Code style): prompt, replies, tool calls.
// Input is the normalized shape from src/loop/transcript.js: { format, items[], meta, raw? }.
import { S, esc } from "./state.js";
import { icon } from "./ui.js";
import { md } from "./md.js";

const TOOL_IC = { bash: "terminal", shell: "terminal", read: "file-text", view: "file-text", edit: "pencil", write: "pencil", create: "file-plus", grep: "search", glob: "search", web_fetch: "globe", web_search: "globe" };

function toolCard(it, key) {
  const open = S.chatOpen?.has(key);
  const st = it.ok === false || (it.exitCode != null && it.exitCode !== 0) ? "failed" : it.ok === true || it.exitCode === 0 ? "done" : "pending";
  const head = it.title || it.command || it.name;
  return `<div class="ctool ${st}">
    <button type="button" class="ctool-h" data-chatopen="${esc(key)}" aria-expanded="${!!open}">
      <span class="ctool-dot" aria-hidden="true">●</span><span class="ctool-ic">${icon(TOOL_IC[it.name] || "wrench")}</span>
      <span class="ctool-t">${esc(String(head).split("\n")[0].slice(0, 160))}</span><span class="ctool-n">${esc(it.name)}</span>
      ${it.exitCode != null ? `<span class="ctool-x">exit ${esc(it.exitCode)}</span>` : ""}<span class="acc-chev">${icon("chevron-right")}</span>
    </button>
    ${open ? `<div class="ctool-b">${it.command ? `<pre class="ccmd"><span class="cprompt" aria-hidden="true">$ </span>${esc(it.command)}</pre>` : ""}${it.output ? `<pre class="cout" tabindex="0">${esc(it.output)}</pre>` : `<p class="hint">No output captured.</p>`}</div>` : ""}
  </div>`;
}

/** Render a normalized transcript. `scope` keeps expand state unique per session. */
export function chatView(chat, scope = "") {
  if (!chat) return "";
  if (chat.loading) return `<p class="hint" role="status">Loading session…</p>`;
  if (chat.error) return `<div class="status bad" role="alert">${esc(chat.error)}</div>`;
  if (chat.format === "text") return `<p class="hint">Plain-text transcript (recorded before structured sessions).</p><pre class="filebox" tabindex="0">${esc(chat.raw || "(empty)")}</pre>`;
  const items = chat.items || [];
  if (!items.length) return `<p class="hint">No transcript recorded for this session yet.</p>`;
  const m = chat.meta || {};
  const u = m.usage || null;
  const usage = u && (u.input || u.output) ? `${Number(u.input || 0).toLocaleString()} in · ${Number(u.output || 0).toLocaleString()} out${u.calls ? ` · ${u.calls} calls` : ""}` : u?.premiumRequests ? `${u.premiumRequests} premium req` : "";
  const nTools = items.filter((i) => i.k === "tool").length;
  const body = items.map((it, i) => {
    const key = `${scope}:${i}`;
    if (it.k === "user") return `<div class="cmsg user"><div class="cwho">${icon("user")} Prompt</div><details class="cprompt-d"><summary>${esc(String(it.text).split("\n")[0].slice(0, 140))}${String(it.text).length > 140 || String(it.text).includes("\n") ? " …" : ""}</summary><pre class="cout">${esc(it.text)}</pre></details></div>`;
    if (it.k === "thinking") return `<div class="cmsg think"><div class="cwho">${icon("brain")} Thinking</div><div class="ctext">${md(it.text)}</div></div>`;
    if (it.k === "assistant") return `<div class="cmsg asst"><div class="cwho">${icon("bot")} Agent</div><div class="ctext mdbox">${md(it.text)}</div></div>`;
    if (it.k === "tool") return toolCard(it, key);
    return "";
  }).join("");
  return `<div class="chatlog" aria-label="Session transcript">
    <div class="chat-meta">${m.model ? `<span class="kbd">${esc(m.model)}</span>` : ""}<span>${items.length} events · ${nTools} tool calls</span>${usage ? `<span>${esc(usage)}</span>` : ""}${nTools ? `<span class="spacer"></span><button type="button" class="btn sm ghost" data-chatall="${esc(scope)}">${icon("chevrons-up-down")} Expand all</button>` : ""}</div>
    ${body}
  </div>`;
}

/** Wire expand/collapse for chat tool cards (call from the main wiring pass). */
export function wireChat($$, render) {
  $$("[data-chatopen]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.chatopen;
    S.chatOpen = S.chatOpen || new Set();
    S.chatOpen.has(k) ? S.chatOpen.delete(k) : S.chatOpen.add(k);
    render();
  }));
  $$("[data-chatall]").forEach((b) => (b.onclick = () => {
    const scope = b.dataset.chatall;
    S.chatOpen = S.chatOpen || new Set();
    const keys = [...document.querySelectorAll("[data-chatopen]")].map((x) => x.dataset.chatopen).filter((k) => k.startsWith(`${scope}:`));
    const allOpen = keys.every((k) => S.chatOpen.has(k));
    keys.forEach((k) => (allOpen ? S.chatOpen.delete(k) : S.chatOpen.add(k)));
    render();
  }));
}

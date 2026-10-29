// Shared UI kit: page headers, stat cards, empty states, icons.
// Every view imports from here so the Control Room looks like one product.
// Icons: lucide via CDN (window.lucide). Call refreshIcons() after each render.
import { esc } from "./state.js";

export const icon = (name, cls = "") =>
  `<i data-lucide="${name}" class="ic ${cls}" aria-hidden="true"></i>`;

export function refreshIcons() {
  try { window.lucide?.createIcons(); } catch { /* CDN blocked — text still reads fine */ }
}

// Page header: title + subtitle + right-side actions. One pattern everywhere.
export const pageHead = (title, sub = "", actions = "") => `
  <div class="phead"><div><h2>${esc(title)}${sub ? ` <span class="hint">${esc(sub)}</span>` : ""}</h2></div>
  <span class="spacer"></span><div class="row">${actions}</div></div>`;

// Stat cards row: [{icon, label, value, tone}]. tone: ok|bad|run|warn|dim.
export const statRow = (stats = []) => `
  <div class="stats">${stats.map((s) => `
    <div class="stat ${s.tone || ""}">
      <span class="sic">${icon(s.icon || "activity")}</span>
      <span class="sval">${s.value}</span><span class="slab">${esc(s.label)}</span>
    </div>`).join("")}</div>`;

// Empty state with icon + CTA.
export const emptyState = (ic, title, hint = "", cta = "") => `
  <div class="empty"><span class="eic">${icon(ic)}</span><b>${esc(title)}</b>
  ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}${cta}</div>`;

// Section card: titled container for a group of content.
export const section = (title, inner, extra = "") => `
  <section class="card sec"><h3>${icon("layers")} ${esc(title)} ${extra}</h3>${inner}</section>`;

// Status pill shared by tables + cards (maps run status -> tone).
export const pill = (status) => {
  const m = { done: "ok", ok: "ok", failed: "bad", blocked: "bad", running: "run", queued: "", sent: "ok" };
  const label = { done: "Done", ok: "Done", failed: "Blocked", blocked: "Blocked", running: "Running", queued: "Queued", sent: "Sent" }[status] || status || "—";
  return `<span class="tag ${m[status] || ""}">${esc(label)}</span>`;
};

// Origin chip: where a run came from.
export const originChip = (kind) =>
  `<span class="kbd kind">${icon("git-branch")} ${esc(kind)}</span>`;

// Progress bar with label.
export const progress = (done, total) => {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<span class="mpbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></span>
  <span class="hint">${done}/${total} steps · ${pct}%</span>`;
};

// Filter toolbar: search + selects in one row.
export const toolbar = (inner) => `<div class="toolbar">${inner}</div>`;
export const searchBox = (id, val, ph) =>
  `<label class="sr" for="${id}">Search</label><span class="sbox">${icon("search")}<input id="${id}" type="search" value="${esc(val || "")}" placeholder="${esc(ph)}" autocomplete="off"></span>`;
export const selectBox = (id, opts, cur, label) =>
  `<label class="sr" for="${id}">${esc(label)}</label><select id="${id}" class="sel">${opts.map(([v, l]) => `<option value="${v}" ${cur === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;

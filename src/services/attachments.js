// Scoped safe attachments: text-only UTF-8, tiny allowlist, in-memory,
// owner-bound opaque IDs, TTL cleanup. No filesystem writes (no traversal /
// symlink surface), no public downloads — content is only embedded at
// request intake into the job payload (explicit 400 if it would overflow).
import { randomUUID } from "node:crypto";

export const ATTACH_ALLOWLIST = [".txt", ".md", ".json", ".csv"];
export const ATTACH_MIME_ALLOW = new Set([
  "text/plain", "text/markdown", "text/x-markdown", "text/csv",
  "application/json", "text/json", "",
]);
export const ATTACH_REJECT_MIME = new Set([
  "text/html", "application/javascript", "text/javascript",
  "application/octet-stream", "application/x-msdownload", "application/x-sh",
]);
export const MAX_ATTACH_FILES = 3;
export const MAX_ATTACH_FILE_BYTES = 4096;
export const MAX_ATTACH_TOTAL_BYTES = 8192;
export const ATTACH_TTL_MS = 30 * 60 * 1000;
export const MAX_STEP_PROMPT_BYTES = 8000;

const store = new Map(); // id -> { id, name, size, mime, text, owner, createdAt }

const SAFE_ID = /^[A-Za-z0-9_-]{8,32}$/;

export function attachStats() {
  return { count: store.size };
}

export function pruneAttachments(nowMs = Date.now()) {
  let pruned = 0;
  for (const [k, v] of store) {
    if (nowMs - v.createdAt > ATTACH_TTL_MS) { store.delete(k); pruned++; }
  }
  return { pruned };
}

export function clearAttachmentsForTest() {
  store.clear();
}

/** Owner binding: session cookie value when present (opaque, per-browser),
 *  else the audit actor (local / remote:ip). Upload + intake must agree. */
export function ownerForRequest(c, access) {
  try {
    const cookie = c?.req?.header?.("cookie") || "";
    const m = /(?:^|;\s*)tab_session=([^;]+)/.exec(cookie);
    if (m) {
      const id = decodeURIComponent(m[1].trim()).slice(0, 64);
      if (id) return `sess:${id}`;
    }
  } catch {}
  try {
    if (access?.auditActor) return access.auditActor(c);
  } catch {}
  return "local";
}

function extOf(name) {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i) : "";
}

function hasHtmlOrExecutableSignals(text) {
  const t = String(text || "");
  if (/^\s*#!\s*\//.test(t)) return "executable shebang refused";
  if (/<\s*(!doctype|html|script|iframe|object|embed|form)\b/i.test(t)) return "html/script markup refused (text-only)";
  if (/<\?php/i.test(t)) return "embedded code refused (text-only)";
  return null;
}

/** Validate + store one text attachment. Returns { id, name, size }.
 *  Throws with explicit message on any rejection (never silent). */
export function createAttachment({ owner, filename, mime = "", content }) {
  pruneAttachments();
  if (!owner) throw new Error("owner required");
  const name = String(filename || "").slice(0, 120);
  if (!name || name.length > 120) throw new Error("filename required (<=120 chars)");
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`unsafe filename refused: ${name.slice(0, 60)}`);
  }
  const ext = extOf(name);
  if (!ATTACH_ALLOWLIST.includes(ext)) {
    throw new Error(`file type refused: '${ext || "(none)"}' — allowed: ${ATTACH_ALLOWLIST.join(", ")} (text-only)`);
  }
  const mt = String(mime || "").split(";")[0].trim().toLowerCase();
  if (ATTACH_REJECT_MIME.has(mt)) throw new Error(`mime refused: '${mt}' (text-only uploads)`);
  if (mt && !ATTACH_MIME_ALLOW.has(mt) && !mt.startsWith("text/")) {
    throw new Error(`mime refused: '${mt}' — text-only`);
  }
  const text = String(content ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0) throw new Error("empty file refused");
  if (bytes > MAX_ATTACH_FILE_BYTES) {
    throw new Error(`file too large: ${bytes} bytes > ${MAX_ATTACH_FILE_BYTES} max per file — shorten and retry (no truncation)`);
  }
  // Binary / control-char rejection (allow \n \r \t only).
  if (text.includes("\u0000")) throw new Error("binary content refused (NUL byte, text-only)");
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw new Error("binary/control characters refused (text-only UTF-8)");
  }
  const sig = hasHtmlOrExecutableSignals(text);
  if (sig) throw new Error(sig);
  if (ext === ".json") {
    try { JSON.parse(text); }
    catch { throw new Error("invalid JSON: file must parse as JSON"); }
  }
  // Per-owner count + total-bytes caps.
  let count = 0, total = 0;
  for (const v of store.values()) {
    if (v.owner === owner) { count++; total += v.size; }
  }
  if (count >= MAX_ATTACH_FILES) {
    throw new Error(`too many attachments: max ${MAX_ATTACH_FILES} per request — remove one and retry`);
  }
  if (total + bytes > MAX_ATTACH_TOTAL_BYTES) {
    throw new Error(`attachments too large: ${total + bytes} bytes > ${MAX_ATTACH_TOTAL_BYTES} max total — remove or shorten a file (no truncation)`);
  }
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  if (!SAFE_ID.test(id)) throw new Error("id generation failed");
  store.set(id, { id, name, size: bytes, mime: mt, text, owner, createdAt: Date.now() });
  return { id, name, size: bytes };
}

export function getAttachmentOwned(id, owner) {
  pruneAttachments();
  const sid = String(id || "");
  if (!SAFE_ID.test(sid)) return null;
  const a = store.get(sid);
  if (!a) return null;
  if (a.owner !== owner) return null;
  return a;
}

export function deleteAttachmentOwned(id, owner) {
  const a = getAttachmentOwned(id, owner);
  if (!a) return false;
  store.delete(a.id);
  return true;
}

export function listAttachmentsOwned(owner) {
  pruneAttachments();
  const out = [];
  for (const v of store.values()) {
    if (v.owner === owner) out.push({ id: v.id, name: v.name, size: v.size, createdAt: v.createdAt });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Sanitize for prompt inclusion: strip stray control chars (already
 *  validated), trim trailing whitespace runs, keep full content (no silent
 *  truncation — callers enforce byte caps with explicit errors). */
export function sanitizeForPrompt(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function buildAttachmentSection(ownedFiles) {
  if (!ownedFiles?.length) return "";
  const parts = [`\n\nAttachments (${ownedFiles.length} file(s), sanitized text-only):`];
  for (const f of ownedFiles) {
    const clean = sanitizeForPrompt(f.text);
    parts.push(`\n--- ${f.name} (${f.size} bytes) ---\n${clean}\n--- end ${f.name} ---`);
  }
  return parts.join("\n");
}

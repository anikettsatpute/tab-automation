// Custom tools: user-defined HTTP tools created by the AI tool-maker
// (setup wizard) or by hand. Stored in config/tools.json under customTools.
// Each tool: { id, description, method, url, headers, bodyTemplate, params,
//   timeoutMs, approvalRequired }. Params use {{name}} templating.
import { renderTemplate } from "./workflow.js";

export function customToolDefs(customTools = []) {
  return (customTools ?? []).map((t) => ({
    name: `custom_${t.id}`,
    description: `${t.description || t.id}. ${t.approvalRequired ? "(Requires owner approval.)" : ""}`,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(t.params ?? {}).map(([k, v]) => [k, { type: "string", description: v.description || k }])
      ),
      required: Object.entries(t.params ?? {}).filter(([, v]) => v.required).map(([k]) => k),
    },
  }));
}

export async function runCustomTool(tool, args) {
  const ctx = { params: args ?? {}, now: new Date().toISOString() };
  // renderTemplate expects {{steps.*}} style; map {{params.x}} via ctx.params
  const render = (s) => String(s ?? "").replace(/\{\{\s*params\.([^}]+?)\s*\}\}/g, (_, k) => args?.[k.trim()] ?? "");
  const url = render(tool.url);
  if (!/^https?:\/\//i.test(url)) return `ERROR: bad URL '${url}'`;
  const headers = {};
  for (const [k, v] of Object.entries(tool.headers ?? {})) headers[k] = render(v);
  let body;
  if (tool.bodyTemplate) {
    const raw = render(tool.bodyTemplate);
    body = raw;
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), tool.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      method: (tool.method || "GET").toUpperCase(),
      headers, body, signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return `ERROR: HTTP ${res.status}: ${text.slice(0, 500)}`;
    return text.slice(0, 4000) || "(empty response)";
  } catch (err) {
    return `ERROR: ${String(err.message).slice(0, 200)}`;
  } finally {
    clearTimeout(t);
  }
}

/** Validate a custom tool spec. Returns error string or null. */
export function validateCustomTool(t) {
  if (!t.id || !/^[a-z0-9_]{2,32}$/.test(t.id)) return "id must be 2-32 chars [a-z0-9_]";
  if (!t.url || !/^https?:\/\//i.test(t.url)) return "url must start with http(s)://";
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes((t.method || "GET").toUpperCase())) return "bad method";
  const params = t.params ?? {};
  if (Object.keys(params).length > 8) return "max 8 params";
  return null;
}

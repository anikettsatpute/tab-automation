// Markdown + diagrams. Kept out of ui.js so node-side tests never load DOM-only libs.
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

/** Agent/user markdown -> sanitized HTML (no scripts, no event handlers). */
export const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? "")), { USE_PROFILES: { html: true } });

const svgCache = new Map(); // source -> svg | Error
let mermaidP = null;
async function mermaid() {
  if (!mermaidP) {
    mermaidP = import("mermaid").then(({ default: m }) => {
      m.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.body.dataset.theme === "light" ? "default" : "dark", flowchart: { htmlLabels: false } });
      return m;
    });
  }
  return mermaidP;
}
let seq = 0;

/** Fill every [data-mermaid] placeholder in the DOM (lazy; cached by source). */
export async function paintDiagrams(root = document) {
  const nodes = [...root.querySelectorAll("[data-mermaid]")];
  for (const el of nodes) {
    const src = el.dataset.src || "";
    if (!src || el.dataset.painted === src.length + ":" + src.slice(0, 32)) continue;
    let out = svgCache.get(src);
    if (!out) {
      try {
        const m = await mermaid();
        const { svg } = await m.render(`mmd-${++seq}`, src);
        out = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      } catch (e) { out = new Error(e?.message || "diagram failed to render"); }
      svgCache.set(src, out);
    }
    const target = el.querySelector(".mmd-out");
    if (!target) continue;
    if (out instanceof Error) target.innerHTML = `<p class="status bad">Diagram error: ${String(out.message).replace(/</g, "&lt;").slice(0, 300)}</p><pre class="out">${src.replace(/</g, "&lt;")}</pre>`;
    else target.innerHTML = out;
    el.dataset.painted = src.length + ":" + src.slice(0, 32);
  }
  // Fullscreen viewer: pan + zoom.
  const full = root.querySelector("[data-panzoom] .mmd-out svg");
  if (full && !full.dataset.pz) {
    full.dataset.pz = "1";
    const { default: Panzoom } = await import("@panzoom/panzoom");
    const pz = Panzoom(full, { maxScale: 6, minScale: 0.3, canvas: true });
    full.parentElement.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); pz.zoomWithWheel(e); } }, { passive: false });
  }
}

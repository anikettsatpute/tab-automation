// Web toolkit for the always-on agent: fetch, search, scrape.
// No extra deps. Search via Google News RSS + DuckDuckGo HTML; scrape via fetch + tag stripping.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export const TOOL_DEFS = [
  {
    name: "web_fetch",
    description: "Fetch a URL and return its text content (HTML stripped, truncated). Use for reading articles, docs, pages.",
    parameters: { type: "object", properties: { url: { type: "string", description: "Full http(s) URL to fetch" } }, required: ["url"] },
  },
  {
    name: "web_search",
    description: "Search the web for a query. Returns titles, links, snippets from DuckDuckGo + Google News.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Search query" }, count: { type: "integer", description: "Max results (default 6, max 10)" } }, required: ["query"] },
  },
  {
    name: "web_news",
    description: "Get recent news headlines for a topic via Google News RSS.",
    parameters: { type: "object", properties: { topic: { type: "string" }, region: { type: "string", description: "IN or US (default IN)" } }, required: ["topic"] },
  },
];

export async function runTool(name, args) {
  switch (name) {
    case "web_fetch": return toolFetch(args.url);
    case "web_search": return toolSearch(args.query, Math.min(args.count ?? 6, 10));
    case "web_news": return toolNews(args.topic, args.region ?? "IN");
    default: throw new Error(`Unknown tool '${name}'`);
  }
}

async function toolFetch(url) {
  if (!/^https?:\/\//i.test(url || "")) return "ERROR: URL must start with http(s)://";
  try {
    const html = await fetchText(url);
    const text = htmlToText(html).slice(0, 6000);
    return text || "ERROR: page had no readable text";
  } catch (err) {
    return `ERROR: ${String(err.message).slice(0, 200)}`;
  }
}

async function toolSearch(query, count) {
  const out = [];
  // 1) DuckDuckGo Instant Answer API (abstract + related topics)
  try {
    const raw = await fetchText(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
    const data = JSON.parse(raw);
    if (data.Abstract) out.push({ title: data.Heading || query, link: data.AbstractURL || "", snippet: data.Abstract.slice(0, 400) });
    for (const t of data.RelatedTopics ?? []) {
      if (out.length >= count) break;
      const topic = t.Text ? t : t.Topics?.[0];
      if (topic?.Text) out.push({ title: topic.Text.slice(0, 120), link: topic.FirstURL || "", snippet: topic.Text.slice(0, 300) });
    }
  } catch { /* fall through to news */ }
  // 2) Google News RSS (fresh, usually most useful for current events)
  if (out.length < count) {
    try {
      const news = await toolNewsRaw(query, "IN", count - out.length);
      for (const n of news) out.push({ title: n.title, link: n.link, snippet: `(${n.source}) ${n.title}`.slice(0, 300) });
    } catch { /* ignore */ }
  }
  if (!out.length) return "No results found.";
  return out.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`).join("\n");
}

async function toolNews(topic, region) {
  const items = await toolNewsRaw(topic, region, 8);
  if (!items.length) return "No news found.";
  return items.map((n, i) => `${i + 1}. ${n.title} (${n.source || "news"})\n   ${n.link}`).join("\n");
}

async function toolNewsRaw(query, region, limit) {
  const hl = region === "US" ? "en-US" : "en-IN";
  const gl = region === "US" ? "US" : "IN";
  const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`);
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const b = m[1];
    const title = clean(tag(b, "title"));
    const link = tag(b, "link");
    const source = clean(/<source[^>]*>([^<]*)<\/source>/.exec(b)?.[1] ?? "");
    if (title) items.push({ title, link, source });
  }
  return items;
}

function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(block);
  return m ? m[1].trim() : "";
}

function clean(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function htmlToText(html) {
  let t = String(html);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<(h1|h2|h3|p|br|li|tr)[^>]*>/gi, "\n");
  t = clean(t);
  // collapse excessive blank lines
  return t.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}

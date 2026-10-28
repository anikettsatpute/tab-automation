// Web toolkit for the always-on agent: fetch, search, scrape + GitHub + OAuth discovery.
// No extra deps. Search via Google News RSS + DuckDuckGo HTML; scrape via fetch + tag stripping.
// GitHub repo search via api.github.com/search/repositories (optional GITHUB_TOKEN env).
// OAuth discovery via RFC8414/RFC9728 metadata (see src/oauth.js).
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
  {
    name: "github_search",
    description: "Search GitHub repositories (name, description, README). Returns repo full_name, stars, URL, description. Use when the user asks for an MCP server, integration, library, or code for a service/device.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords, e.g. 'mcp server gmail' or 'tuya smart bulb home assistant'" },
        count: { type: "integer", description: "Max results (default 6, max 10)" },
        sort: { type: "string", description: "stars (default), updated, or best-match" },
      },
      required: ["query"],
    },
  },
  {
    name: "oauth_discover",
    description: "Discover OAuth / auth for an MCP HTTP server URL (or any API base URL). Probes 401/WWW-Authenticate, fetches RFC8414/RFC9728 metadata, reports authorization + token + DCR registration endpoints. Use before wiring OAuth for an MCP server or custom tool.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Full http(s) URL of the MCP server or API base" } },
      required: ["url"],
    },
  },
];

export async function runTool(name, args) {
  switch (name) {
    case "web_fetch": return toolFetch(args.url);
    case "web_search": return toolSearch(args.query, Math.min(args.count ?? 6, 10));
    case "web_news": return toolNews(args.topic, args.region ?? "IN");
    case "github_search": return toolGithubSearch(args.query, Math.min(args.count ?? 6, 10), args.sort ?? "stars");
    case "oauth_discover": return toolOAuthDiscover(args.url);
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

async function toolGithubSearch(query, count, sort) {
  if (!query || !String(query).trim()) return "ERROR: query required";
  const sortParam = sort === "updated" ? "&sort=updated" : sort === "best-match" ? "" : "&sort=stars&order=desc";
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(count, 10)}${sortParam}`;
  try {
    const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
    const token = (process.env.GITHUB_TOKEN || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      return `ERROR: GitHub rate limit hit${remaining === "0" ? " (60/hr unauthenticated — set GITHUB_TOKEN in .env for 5000/hr)" : ""}. Retry later or narrow the query.`;
    }
    if (!res.ok) return `ERROR: GitHub API HTTP ${res.status}`;
    const data = await res.json();
    const items = (data.items ?? []).slice(0, count);
    if (!items.length) return "No GitHub repos found.";
    return items.map((r, i) =>
      `${i + 1}. ${r.full_name} ⭐${r.stargazers_count} (${r.language || "?"}, updated ${String(r.updated_at || "").slice(0, 10)})\n` +
      `   ${r.html_url}\n   ${String(r.description || "no description").slice(0, 220)}`
    ).join("\n");
  } catch (err) {
    return `ERROR: ${String(err.message).slice(0, 200)}`;
  }
}

async function toolOAuthDiscover(url) {
  if (!/^https?:\/\//i.test(url || "")) return "ERROR: URL must start with http(s)://";
  try {
    const { discoverOAuth } = await import("./oauth.js");
    const d = await discoverOAuth(url);
    const lines = [
      `Server: ${d.serverUrl} (HTTP ${d.httpStatus ?? "?"})`,
      d.wwwAuthenticate ? `WWW-Authenticate: ${d.wwwAuthenticate.slice(0, 300)}` : "WWW-Authenticate: (none)",
      d.resourceMetadataUrl ? `Protected-resource metadata: ${d.resourceMetadataUrl}` : "Protected-resource metadata: not found",
      d.authorizationServers.length ? `Authorization servers: ${d.authorizationServers.join(", ")}` : "Authorization servers: none discovered",
      d.asMetadataUrl ? `AS metadata: ${d.asMetadataUrl}` : "AS metadata: not found",
    ];
    if (d.asMetadata) {
      lines.push(`authorization_endpoint: ${d.asMetadata.authorization_endpoint || "(none)"}`);
      lines.push(`token_endpoint: ${d.asMetadata.token_endpoint || "(none)"}`);
      lines.push(`registration_endpoint (DCR): ${d.asMetadata.registration_endpoint || "(not supported — register manually)"}`);
      if (Array.isArray(d.asMetadata.scopes_supported)) lines.push(`scopes: ${d.asMetadata.scopes_supported.slice(0, 12).join(", ")}`);
    }
    lines.push(`Hint: ${d.hint}`);
    return lines.join("\n");
  } catch (err) {
    return `ERROR: ${String(err.message).slice(0, 200)}`;
  }
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

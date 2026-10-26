import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// --- Yahoo Finance chart API: prev close + last close + % change ---
const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
let yahooHostIdx = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getQuote(symbol, attempt = 0) {
  const host = YAHOO_HOSTS[(yahooHostIdx + attempt) % YAHOO_HOSTS.length];
  try {
    // range=1mo guarantees >=2 trading closes across weekends/holidays.
    // range=5d was dropping the prior session (e.g. Mon close missing on Tue).
    const raw = await fetchText(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`);
    const data = JSON.parse(raw);
    const result = data?.chart?.result?.[0];
    const stamps = result?.timestamp ?? [];
    const rawCloses = result?.indicators?.quote?.[0]?.close ?? [];
    // Pair timestamps with non-null closes, then take last 2 TRADING sessions.
    const sessions = stamps.map((t, i) => ({ t, c: rawCloses[i] })).filter((s) => s.c != null);
    if (sessions.length < 2) return { symbol, error: "insufficient data" };
    const prev = sessions[sessions.length - 2];
    const last = sessions[sessions.length - 1];
    const changePct = ((last.c - prev.c) / prev.c) * 100;
    const meta = result?.meta ?? {};
    const fmt = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    return {
      symbol,
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency || "",
      last: round2(last.c),
      prevClose: round2(prev.c),
      changePct: round2(changePct),
      lastDate: fmt(last.t),
      prevDate: fmt(prev.t),
    };
  } catch (err) {
    const msg = String(err.message || err);
    // Rotate host + backoff on rate limit, up to 5 attempts
    if (/429/.test(msg) && attempt < 5) {
      yahooHostIdx += 1;
      await sleep(2000 * (attempt + 1));
      return getQuote(symbol, attempt + 1);
    }
    return { symbol, error: msg.slice(0, 120) };
  }
}

export async function getQuotes(symbols, concurrency = 2) {
  const out = [];
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = await Promise.all(symbols.slice(i, i + concurrency).map((s) => getQuote(s)));
    out.push(...batch);
    if (i + concurrency < symbols.length) await sleep(2500); // stay under Yahoo rate limit
  }
  return out;
}

// --- Quote cache: last-good quotes so briefings survive Yahoo 429s ---
export function loadQuoteCache(root) {
  const file = path.join(root, "data", "finance", "quotes-cache.json");
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function saveQuoteCache(root, quotes) {
  const dir = path.join(root, "data", "finance");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "quotes-cache.json");
  let cache = loadQuoteCache(root);
  for (const q of quotes) {
    if (!q.error) cache[q.symbol] = { ...q, cachedAt: new Date().toISOString() };
  }
  try {
    writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch { /* best effort */ }
  return cache;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Google News RSS ---
export async function getNews(query, region = "IN") {
  const hl = region === "IN" ? "en-IN" : "en-US";
  const gl = region === "IN" ? "IN" : "US";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;
  try {
    const xml = await fetchText(url);
    return parseRssItems(xml).slice(0, 8);
  } catch (err) {
    return [{ title: `news fetch failed: ${String(err.message).slice(0, 100)}`, link: "" }];
  }
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 12) {
    const block = m[1];
    const title = tag(block, "title");
    const link = tag(block, "link");
    const pubDate = tag(block, "pubDate");
    const source = /<source[^>]*>([^<]*)<\/source>/.exec(block)?.[1] ?? "";
    if (title) items.push({ title: decodeEntities(title), link, pubDate, source: decodeEntities(source) });
  }
  return items;
}

function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(block);
  return m ? m[1].trim() : "";
}

function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// --- Reddit RSS (sentiment pulse) ---
export async function getReddit(sub, limit = 6) {
  try {
    const xml = await fetchText(`https://www.reddit.com/r/${sub}/.rss`);
    const entries = [];
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = re.exec(xml)) && entries.length < limit) {
      const block = m[1];
      const title = decodeEntities(tag(block, "title"));
      const updated = tag(block, "updated");
      if (title) entries.push({ title, updated });
    }
    return entries;
  } catch {
    return [];
  }
}

// --- Local file store: data/finance/YYYY-MM-DD-<market>.json ---
export function saveBriefing(root, market, payload) {
  const dir = path.join(root, "data", "finance");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${date}-${market}.json`);
  writeFileSync(file, JSON.stringify({ ...payload, market, date, savedAt: new Date().toISOString() }, null, 2));
  return file;
}

export function loadRecentBriefings(root, market, days = 5) {
  const dir = path.join(root, "data", "finance");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(`-${market}.json`))
    .sort()
    .slice(-days)
    .map((f) => {
      try { return JSON.parse(readFileSync(path.join(dir, f), "utf-8")); } catch { return null; }
    })
    .filter(Boolean);
}

export function loadWatchlists(root) {
  const p = path.join(root, "config", "watchlists.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

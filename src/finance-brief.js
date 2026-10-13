import { chatCompletion } from "./azure.js";
import {
  getQuotes, getNews, getReddit, saveBriefing, loadRecentBriefings, loadWatchlists,
  loadQuoteCache, saveQuoteCache,
} from "./finance.js";
import { chunk } from "./workflow.js";

export function flattenWatchlist(entry) {
  if (Array.isArray(entry)) return entry.map((c) => ({ ...c, cap: "unknown" }));
  const out = [];
  for (const c of entry?.large ?? []) out.push({ ...c, cap: "large" });
  for (const c of entry?.small ?? []) out.push({ ...c, cap: "small" });
  return out;
}

// Shared by CLI (finance-run.js) and workflow step type "finance".
export async function runFinanceBriefing(cfg, deps, { market = "india", post = true, channel } = {}) {
  const watchlists = loadWatchlists(cfg.root);
  const list = flattenWatchlist(watchlists[market]);
  if (!list.length) throw new Error(`Unknown market '${market}'`);
  const capOf = (symbol) => list.find((c) => c.symbol === symbol)?.cap ?? "?";
  const region = market === "india" ? "IN" : "US";
  const marketLabel = market === "india" ? "NSE (opens 09:15 IST)" : "US (opens 19:00 IST / 9:30 ET)";

  deps.log?.(`[finance:${market}] fetching ${list.length} quotes (${list.filter((c) => c.cap === "large").length} large + ${list.filter((c) => c.cap === "small").length} small)...`);
  const quotes = await getQuotes(list.map((c) => c.symbol));
  saveQuoteCache(cfg.root, quotes);
  const cache = loadQuoteCache(cfg.root);
  const failed = quotes.filter((q) => q.error).map((q) => q.symbol);
  // Fill gaps from last-good cache so one bad Yahoo run doesn't gut the briefing
  const okQuotes = quotes.filter((q) => !q.error);
  for (const sym of failed) {
    if (cache[sym]) okQuotes.push({ ...cache[sym], stale: true });
  }
  deps.log?.(`[finance:${market}] quotes: ${okQuotes.filter((q) => !q.stale).length} fresh + ${okQuotes.filter((q) => q.stale).length} cached, ${failed.filter((s) => !cache[s]).length} missing`);
  const movers = [...okQuotes].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 10);

  deps.log?.(`[finance:${market}] fetching news + reddit...`);
  const marketQuery = market === "india" ? "Nifty Sensex stock market" : "S&P 500 stock market";
  const [marketNews, ...moverNews] = await Promise.all([
    getNews(marketQuery, region),
    ...movers.slice(0, 5).map((m) => getNews(`${m.name} stock`, region)),
  ]);
  const subs = market === "india"
    ? (await Promise.all([getReddit("IndianStockMarket"), getReddit("DalalStreetTalks")])).flat()
    : (await Promise.all([getReddit("stocks"), getReddit("wallstreetbets")])).flat();
  const history = loadRecentBriefings(cfg.root, market, 3);
  const historyNote = history.length
    ? `Recent picks context:\n${history.map((h) => `${h.date}: ${(h.picks ?? []).map((p) => `${p.symbol} (${p.call})`).join(", ") || "n/a"}`).join("\n")}`
    : "No prior briefings yet.";

  const agentId = market === "india" ? "finance-india" : "finance-us";
  const prompt = [
    `Date: ${new Date().toISOString().slice(0, 10)}. Market: ${marketLabel}.`,
    `Watchlist: 15 LARGE-CAP (stable) + 15 SMALL-CAP/VOLATILE (high risk/reward). Cap is tagged per stock.`,
    ``,
    `Watchlist closes (prev session):`,
    okQuotes.map((q) => `- [${capOf(q.symbol).toUpperCase()}]${q.stale ? " (cached, may be stale)" : ""} ${q.symbol} (${q.name}): ${q.last} ${q.currency}, ${q.changePct >= 0 ? "+" : ""}${q.changePct}%`).join("\n"),
    ``,
    `Biggest movers: ${movers.map((m) => `${m.symbol} [${capOf(m.symbol)}] ${m.changePct}%`).join(", ")}`,
    ``,
    `Market headlines:`,
    marketNews.slice(0, 6).map((n) => `- ${n.title} (${n.source})`).join("\n"),
    ``,
    ...movers.slice(0, 5).map((m, i) => `News for ${m.symbol}:\n${(moverNews[i] ?? []).slice(0, 4).map((n) => `- ${n.title} (${n.source})`).join("\n") || "- none"}`),
    ``,
    `Reddit pulse:`,
    subs.slice(0, 8).map((s) => `- ${s.title}`).join("\n") || "- none",
    ``,
    historyNote,
    ``,
    `Also name up to 2 OFF-WATCHLIST names if news strongly supports them.`,
  ].join("\n");

  deps.log?.(`[finance:${market}] asking ${agentId}...`);
  const analysis = await chatCompletion(cfg, agentId, prompt);
  const picks = extractPicks(analysis);
  const file = saveBriefing(cfg.root, market, {
    quotes: okQuotes,
    movers: movers.map((m) => m.symbol),
    headlines: marketNews.slice(0, 6).map((n) => n.title),
    analysis,
    picks,
  });
  deps.log?.(`[finance:${market}] saved ${file}`);

  const header = market === "india" ? "🇮🇳 Pre-market briefing — NSE" : "🇺🇸 Pre-market briefing — US";
  const message = `${header} · ${new Date().toISOString().slice(0, 10)}\n\n${analysis}\n\n_Stored for reference. Not financial advice._`;

  if (post) {
    const target = channel || cfg.discord.financeChannelId || cfg.discord.channelId;
    if (!target) {
      deps.log?.(`[finance:${market}] no channel configured, skipping post`);
    } else {
      for (const part of chunk(message)) await deps.sendDiscord?.(target, part);
    }
  }
  return { message, file, picks };
}

function extractPicks(text) {
  const picks = [];
  const re = /\*\*([A-Z][A-Z0-9.\-]{1,14})\s*[—–-]\s*(BUY|WATCH|AVOID)\*\*/g;
  let m;
  while ((m = re.exec(text))) picks.push({ symbol: m[1], call: m[2] });
  return picks.slice(0, 8);
}

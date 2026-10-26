import { loadConfig } from "./config.js";
import { chatCompletion } from "./azure.js";
import {
  getQuotes, getNews, getReddit, saveBriefing, loadRecentBriefings, loadWatchlists,
  loadQuoteCache, saveQuoteCache,
} from "./finance.js";
import { chunk } from "./workflow.js";
import { Client, GatewayIntentBits } from "discord.js";

// Usage:
//   node src/finance-run.js india|us [--post] [--channel ID]
// Without --post: prints the briefing, saves to data/finance/. With --post: also sends to Discord.

const { cfg, errors } = loadConfig();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const market = (process.argv[2] || "india").toLowerCase();
if (!["india", "us"].includes(market)) {
  console.error("Usage: node src/finance-run.js india|us [--post] [--channel ID]");
  process.exit(1);
}
const shouldPost = process.argv.includes("--post");
const chIdx = process.argv.indexOf("--channel");
const channelOverride = chIdx !== -1 ? process.argv[chIdx + 1] : undefined;

const watchlists = loadWatchlists(process.cwd());
const { flattenWatchlist, nextTradingSession } = await import("./finance-brief.js");
const list = flattenWatchlist(watchlists[market]);
const capOf = (symbol) => list.find((c) => c.symbol === symbol)?.cap ?? "?";
const region = market === "india" ? "IN" : "US";
const marketLabel = market === "india" ? "🇮🇳 NSE (opens 09:15 IST)" : "🇺🇸 US (opens 19:00 IST / 9:30 ET)";

console.log(`Fetching ${list.length} quotes for ${market}...`);
const quotes = await getQuotes(list.map((c) => c.symbol));
saveQuoteCache(process.cwd(), quotes);
const cache = loadQuoteCache(process.cwd());
const okQuotes = quotes.filter((q) => !q.error);
for (const q of quotes.filter((x) => x.error)) {
  if (cache[q.symbol]) okQuotes.push({ ...cache[q.symbol], stale: true });
}
console.log(`Quotes: ${okQuotes.filter((q) => !q.stale).length} fresh + ${okQuotes.filter((q) => q.stale).length} cached`);
const movers = [...okQuotes].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 10);

console.log(`Top movers: ${movers.map((m) => `${m.symbol} ${m.changePct}%`).join(", ")}`);

// News: market-level + per top-mover (top 5 to bound time)
console.log("Fetching news...");
const marketQuery = market === "india" ? "Nifty Sensex stock market" : "S&P 500 stock market";
const earningsQuery = market === "india" ? "NSE earnings results quarterly" : "earnings reports quarterly results";
const [marketNews, earningsNews, ...moverNews] = await Promise.all([
  getNews(marketQuery, region),
  getNews(earningsQuery, region),
  ...movers.slice(0, 5).map((m) => getNews(`${m.name} stock`, region)),
]);

console.log("Fetching Reddit pulse...");
const [subs, history] = await Promise.all([
  market === "india"
    ? Promise.all([getReddit("IndianStockMarket"), getReddit("DalalStreetTalks")]).then((a) => a.flat())
    : Promise.all([getReddit("stocks"), getReddit("wallstreetbets")]).then((a) => a.flat()),
  Promise.resolve(loadRecentBriefings(process.cwd(), market, 3)),
]);

const historyNote = history.length
  ? `Recent picks context:\n${history.map((h) => `${h.date}: ${(h.picks ?? []).map((p) => `${p.symbol} (${p.call})`).join(", ") || "n/a"}`).join("\n")}`
  : "No prior briefings yet.";

const agentId = market === "india" ? "finance-india" : "finance-us";
const freshCount = okQuotes.filter((q) => !q.stale).length;
const coveragePct = list.length ? Math.round((freshCount / list.length) * 100) : 0;
const coverageFlag = coveragePct >= 80 ? "HIGH" : coveragePct >= 50 ? "MEDIUM" : "LOW";
const sessionDates = [...new Set(okQuotes.map((q) => q.lastDate).filter(Boolean))].sort();
const lastSession = sessionDates[sessionDates.length - 1] ?? "unknown";
const targetSession = nextTradingSession(lastSession, market);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); if (Number.isNaN(d.getTime())) return "?"; d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekAhead = addDays(targetSession, 7);
const monthAhead = addDays(targetSession, 30);
const smallMovers = [...okQuotes].filter((q) => capOf(q.symbol) === "small")
  .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);
const largeMovers = [...okQuotes].filter((q) => capOf(q.symbol) !== "small")
  .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);
const prompt = [
  `Date now: ${new Date().toISOString().slice(0, 10)}. Market: ${marketLabel}.`,
  `Quote session (prev close data ends): ${lastSession}.`,
  `Horizons: next session = ${targetSession} | week ahead ≈ ${weekAhead} | month ahead ≈ ${monthAhead}.`,
  `Give all three horizons per pick: Next session range (tight), Week ahead range (wider, needs a dated catalyst like earnings/policy event or say 'no dated catalyst'), Month ahead range (widest, one-line thesis). Week/month must cite a real catalyst from input — never invent earnings dates.`,
  `Coverage: ${freshCount}/${list.length} fresh quotes (${coveragePct}% = ${coverageFlag}).${coverageFlag === "LOW" ? " Data is thin — widen expected ranges and lower confidence." : ""}`,
  `Watchlist: 15 LARGE-CAP (stable) + 15 SMALL-CAP/VOLATILE (high risk/reward). Cap is tagged per stock.`,
  ``,
  `Watchlist closes (prev session ${lastSession}):`,
  okQuotes.map((q) => `- [${capOf(q.symbol).toUpperCase()}]${q.stale ? " (cached, may be stale)" : ""} ${q.symbol} (${q.name}): ${q.last} ${q.currency} @${q.lastDate ?? "?"} vs prev ${q.prevClose} @${q.prevDate ?? "?"}, ${q.changePct >= 0 ? "+" : ""}${q.changePct}%`).join("\n"),
  ``,
  `Biggest movers: ${movers.map((m) => `${m.symbol} [${capOf(m.symbol)}] ${m.changePct}%`).join(", ")}`,
  `Top LARGE movers: ${largeMovers.map((m) => `${m.symbol} ${m.changePct}%`).join(", ") || "none"}`,
  `Top SMALL movers (must pick 2-3 from SMALL watchlist): ${smallMovers.map((m) => `${m.symbol} ${m.changePct}%`).join(", ") || "none — pick on momentum/history anyway"}`,
  ``,
  `Market headlines:`,
  marketNews.slice(0, 6).map((n) => `- ${n.title} (${n.source})`).join("\n"),
  ``,
  `Earnings / upcoming catalysts:`,
  earningsNews.slice(0, 6).map((n) => `- ${n.title} (${n.source})`).join("\n") || "- none",
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

console.log("Asking agent...");
const analysis = await chatCompletion(cfg, agentId, prompt);

const picks = extractPicks(analysis);
const outlooks = extractOutlooks(analysis);
const file = saveBriefing(process.cwd(), market, {
  quotes: okQuotes,
  movers: movers.map((m) => m.symbol),
  headlines: marketNews.slice(0, 6).map((n) => n.title),
  catalysts: earningsNews.slice(0, 6).map((n) => n.title),
  analysis,
  picks,
  outlooks,
  meta: { lastSession, targetSession, weekAhead, monthAhead, coveragePct, coverageFlag },
});
console.log(`Saved ${file}`);

const header = market === "india" ? "🇮🇳 Pre-market briefing — NSE" : "🇺🇸 Pre-market briefing — US";
const message = `${header} · ${new Date().toISOString().slice(0, 10)}\n\n${analysis}\n\n_Stored for reference. Not financial advice._`;

if (shouldPost) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(cfg.discord.token);
  const ch = await client.channels.fetch(channelOverride || cfg.discord.financeChannelId || cfg.discord.channelId);
  if (!ch?.isSendable()) throw new Error("Finance channel is not sendable — create #finance and set FINANCE_CHANNEL_ID");
  for (const part of chunk(message)) await ch.send(part);
  console.log("Posted to Discord.");
  await client.destroy();
} else {
  console.log("\n--- MESSAGE PREVIEW ---\n" + message.slice(0, 1500));
}

function extractPicks(text) {
  const picks = [];
  const re = /\*\*([A-Z][A-Z0-9.\-]{1,14})\s*[—–-]\s*(BUY|WATCH|AVOID)\*\*/g;
  let m;
  while ((m = re.exec(text))) picks.push({ symbol: m[1], call: m[2] });
  return picks.slice(0, 8);
}

function extractOutlooks(text) {
  const out = [];
  const lines = text.split("\n");
  let current = null;
  const pickRe = /\*\*([A-Z][A-Z0-9.\-]{1,14})\s*[—–-]\s*(BUY|WATCH|AVOID)\*\*/;
  for (const line of lines) {
    const pm = pickRe.exec(line);
    if (pm) current = pm[1];
    const w = /Week ahead:\s*([+-]?\d+(?:\.\d+)?%\s*to\s*[+-]?\d+(?:\.\d+)?%)/i.exec(line);
    if (w && current) out.push({ symbol: current, horizon: "week", range: w[1].trim() });
    const mo = /Month ahead:\s*([+-]?\d+(?:\.\d+)?%\s*to\s*[+-]?\d+(?:\.\d+)?%)/i.exec(line);
    if (mo && current) out.push({ symbol: current, horizon: "month", range: mo[1].trim() });
  }
  return out;
}

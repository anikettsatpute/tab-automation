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
  const earningsQuery = market === "india" ? "NSE earnings results quarterly" : "earnings reports quarterly results";
  const [marketNews, earningsNews, ...moverNews] = await Promise.all([
    getNews(marketQuery, region),
    getNews(earningsQuery, region),
    ...movers.slice(0, 5).map((m) => getNews(`${m.name} stock`, region)),
  ]);
  const subs = market === "india"
    ? (await Promise.all([getReddit("IndianStockMarket"), getReddit("DalalStreetTalks")])).flat()
    : (await Promise.all([getReddit("stocks"), getReddit("wallstreetbets")])).flat();
  const history = loadRecentBriefings(cfg.root, market, 3);
  const historyNote = history.length
    ? `Recent picks context:\n${history.map((h) => `${h.date}: ${(h.picks ?? []).map((p) => `${p.symbol} (${p.call})`).join(", ") || "n/a"}`).join("\n")}`
    : "No prior briefings yet.";

  // Coverage + session dating: prevents lookahead bias (predicting "today" with today's close)
  // and flags thin-data briefings so the agent widens ranges / lowers confidence.
  const freshCount = okQuotes.filter((q) => !q.stale).length;
  const coveragePct = list.length ? Math.round((freshCount / list.length) * 100) : 0;
  const coverageFlag = coveragePct >= 80 ? "HIGH" : coveragePct >= 50 ? "MEDIUM" : "LOW";
  const sessionDates = [...new Set(okQuotes.map((q) => q.lastDate).filter(Boolean))].sort();
  const prevDates = [...new Set(okQuotes.map((q) => q.prevDate).filter(Boolean))].sort();
  const lastSession = sessionDates[sessionDates.length - 1] ?? "unknown";
  const targetSession = nextTradingSession(lastSession, market);
  const weekAhead = addDaysIso(targetSession, 7);
  const monthAhead = addDaysIso(targetSession, 30);
  const smallMovers = [...okQuotes].filter((q) => capOf(q.symbol) === "small")
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);
  const largeMovers = [...okQuotes].filter((q) => capOf(q.symbol) !== "small")
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);

  const agentId = market === "india" ? "finance-india" : "finance-us";
  const prompt = [
    `Date now: ${new Date().toISOString().slice(0, 10)}. Market: ${marketLabel}.`,
    `Quote session (prev close data ends): ${lastSession} (prev: ${prevDates[prevDates.length - 1] ?? "unknown"}).`,
    `Horizons: next session = ${targetSession} | week ahead ≈ ${weekAhead} | month ahead ≈ ${monthAhead}.`,
    `Give all three horizons per pick: Next session range (tight), Week ahead range (wider, needs a dated catalyst like earnings/policy event or say 'no dated catalyst'), Month ahead range (widest, one-line thesis). Week/month must cite a real catalyst from input — never invent earnings dates.`,
    `Coverage: ${freshCount}/${list.length} fresh quotes (${coveragePct}% = ${coverageFlag}).${coverageFlag === "LOW" ? " Data is thin — widen expected ranges and lower confidence." : ""}`,
    `Watchlist: 15 LARGE-CAP (stable) + 15 SMALL-CAP/VOLATILE (high risk/reward). Cap is tagged per stock.`,
    ``,
    `Watchlist closes (prev session ${lastSession}):`,
    okQuotes.map((q) => `- [${capOf(q.symbol).toUpperCase()}]${q.stale ? " (cached, may be stale)" : ""} ${q.symbol} (${q.name}): ${q.last} ${q.currency} @${q.lastDate ?? "?"} vs prev ${q.prevClose} @${q.prevDate ?? "?"}, ${q.changePct >= 0 ? "+" : ""}${q.changePct}%`).join("\n"),
    ``,
    `Biggest movers overall: ${movers.map((m) => `${m.symbol} [${capOf(m.symbol)}] ${m.changePct}%`).join(", ") || "none"}`,
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

  deps.log?.(`[finance:${market}] asking ${agentId}... (session ${lastSession} -> target ${targetSession}, coverage ${coverageFlag})`);
  const analysis = await chatCompletion(cfg, agentId, prompt);
  const picks = extractPicks(analysis);
  const outlooks = extractOutlooks(analysis);
  const smallSymbols = new Set(list.filter((c) => c.cap === "small").map((c) => c.symbol.replace(/\.NS$/, "")));
  const hasSmallPick = picks.some((p) => smallSymbols.has(p.symbol) || p.symbol.includes("."));
  if (!hasSmallPick) {
    deps.log?.(`[finance:${market}] WARNING: no SMALL-cap pick detected — prompt requires 2-3 SMALL picks`);
  }
  const file = saveBriefing(cfg.root, market, {
    quotes: okQuotes,
    movers: movers.map((m) => m.symbol),
    headlines: marketNews.slice(0, 6).map((n) => n.title),
    catalysts: earningsNews.slice(0, 6).map((n) => n.title),
    analysis,
    picks,
    outlooks,
    meta: { lastSession, targetSession, weekAhead, monthAhead, coveragePct, coverageFlag, smallCapEnforced: hasSmallPick },
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

// Week/month outlooks: "Week ahead: +X% to +Y%" lines per pick, for scoring later.
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

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "?";
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Next trading session after a YYYY-MM-DD date: skip weekends,
// plus NSE Saturday/Sunday only (holiday calendar not embedded —
// agent is told the target is approximate around holidays).
export function nextTradingSession(lastSession, market) {
  const d = new Date(`${lastSession}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "next session";
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

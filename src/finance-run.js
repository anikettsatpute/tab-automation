import { loadConfig } from "./config.js";
import { chatCompletion } from "./azure.js";
import {
  getQuotes, getNews, getReddit, saveBriefing, loadRecentBriefings, loadWatchlists,
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
const list = watchlists[market];
const region = market === "india" ? "IN" : "US";
const marketLabel = market === "india" ? "🇮🇳 NSE (opens 09:15 IST)" : "🇺🇸 US (opens 19:00 IST / 9:30 ET)";

console.log(`Fetching ${list.length} quotes for ${market}...`);
const quotes = await getQuotes(list.map((c) => c.symbol));
const okQuotes = quotes.filter((q) => !q.error);
const movers = [...okQuotes].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 10);

console.log(`Top movers: ${movers.map((m) => `${m.symbol} ${m.changePct}%`).join(", ")}`);

// News: market-level + per top-mover (top 5 to bound time)
console.log("Fetching news...");
const marketQuery = market === "india" ? "Nifty Sensex stock market" : "S&P 500 stock market";
const [marketNews, ...moverNews] = await Promise.all([
  getNews(marketQuery, region),
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
const prompt = [
  `Date: ${new Date().toISOString().slice(0, 10)}. Market: ${marketLabel}.`,
  ``,
  `Watchlist closes (prev session):`,
  okQuotes.map((q) => `- ${q.symbol} (${q.name}): ${q.last} ${q.currency}, ${q.changePct >= 0 ? "+" : ""}${q.changePct}%`).join("\n"),
  ``,
  `Biggest movers: ${movers.map((m) => `${m.symbol} ${m.changePct}%`).join(", ")}`,
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

console.log("Asking agent...");
const analysis = await chatCompletion(cfg, agentId, prompt);

const picks = extractPicks(analysis);
const file = saveBriefing(process.cwd(), market, {
  quotes: okQuotes,
  movers: movers.map((m) => m.symbol),
  headlines: marketNews.slice(0, 6).map((n) => n.title),
  analysis,
  picks,
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

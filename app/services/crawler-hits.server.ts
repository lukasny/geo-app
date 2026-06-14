/**
 * Crawler-hit logging and stats for the public llms.txt proxy.
 *
 * Every proxy request is counted (browsers included, botName "") so the
 * manager page can say "9 of 14 fetches were AI bots" - a better story than
 * bot-only counts. Storage is a daily counter, not a row per request: the
 * proxy is unauthenticated public traffic, so a row-per-hit design let any
 * client grow the table without bound. One upsert per (store, bot, UTC day)
 * caps the table at stores x bots x retained-days. An in-memory per-store
 * throttle additionally bounds write amplification during a flood. Logging
 * is strictly fire-and-forget: a DB hiccup here must never add latency or
 * turn the public 200 into a 500.
 */
import prisma from "~/db.server";

/** Real crawler UAs are under ~200 chars; the cap keeps a hostile client
 *  from storing arbitrarily long User-Agent headers. */
const MAX_USER_AGENT_LENGTH = 250;

export interface CrawlerPattern {
  /** Case-insensitive substring matched against the User-Agent header. */
  pattern: string;
  /** Canonical bot id stored in AiCrawlerHit.botName. */
  botName: string;
}

/**
 * AI crawler User-Agent tokens, doc-verified 2026-06-12 against each
 * vendor's official bot documentation:
 *
 * - OpenAI (developers.openai.com/api/docs/bots): GPTBot, OAI-SearchBot,
 *   ChatGPT-User
 * - Anthropic (support.claude.com article 8896518): ClaudeBot,
 *   Claude-User, Claude-SearchBot
 * - Perplexity (docs.perplexity.ai/guides/bots): PerplexityBot,
 *   Perplexity-User
 * - Google (developers.google.com crawler docs): GoogleOther. Per Google's
 *   docs, Google-Extended "doesn't have a separate HTTP request user agent
 *   string" - it is a robots.txt-only token. The pattern is kept anyway as
 *   a zero-cost safety net in case Google ever starts sending it.
 * - Microsoft (blogs.bing.com webmaster blog): bingbot (lowercase in the
 *   UA string; matching is case-insensitive, canonical name "Bingbot")
 * - Common Crawl (commoncrawl.org/ccbot): CCBot
 * - ByteDance: Bytespider. No official English docs page exists; the token
 *   is the one ByteDance sends ("compatible; Bytespider;
 *   https://zhanzhang.toutiao.com/").
 * - Meta (developers.facebook.com/docs/sharing/webmasters/web-crawlers):
 *   meta-externalagent
 * - Amazon (developer.amazon.com/amazonbot): Amazonbot
 * - Apple (support.apple.com/en-us/119829): Applebot-Extended. Like
 *   Google-Extended, Apple documents that it "does not crawl webpages"
 *   (robots.txt-only token; the live crawler UA is plain Applebot, which
 *   is a search crawler, not an AI-training one). Kept as a safety net.
 *
 * None of these tokens are substrings of each other (case-insensitively),
 * so list order carries no precedence semantics.
 */
export const AI_CRAWLER_PATTERNS: CrawlerPattern[] = [
  // OpenAI
  { pattern: "GPTBot", botName: "GPTBot" },
  { pattern: "OAI-SearchBot", botName: "OAI-SearchBot" },
  { pattern: "ChatGPT-User", botName: "ChatGPT-User" },
  // Anthropic
  { pattern: "ClaudeBot", botName: "ClaudeBot" },
  { pattern: "Claude-User", botName: "Claude-User" },
  { pattern: "Claude-SearchBot", botName: "Claude-SearchBot" },
  // Perplexity
  { pattern: "PerplexityBot", botName: "PerplexityBot" },
  { pattern: "Perplexity-User", botName: "Perplexity-User" },
  // Google
  { pattern: "Google-Extended", botName: "Google-Extended" },
  { pattern: "GoogleOther", botName: "GoogleOther" },
  // Microsoft
  { pattern: "bingbot", botName: "Bingbot" },
  // Common Crawl
  { pattern: "CCBot", botName: "CCBot" },
  // ByteDance
  { pattern: "Bytespider", botName: "Bytespider" },
  // Meta
  { pattern: "meta-externalagent", botName: "meta-externalagent" },
  // Amazon
  { pattern: "Amazonbot", botName: "Amazonbot" },
  // Apple
  { pattern: "Applebot-Extended", botName: "Applebot-Extended" },
];

// Lowercased once at module load; classifyCrawler runs on every public
// proxy request, so per-request toLowerCase over the pattern list is
// avoidable work.
const LOWERCASE_PATTERNS = AI_CRAWLER_PATTERNS.map(({ pattern, botName }) => ({
  pattern: pattern.toLowerCase(),
  botName,
}));

/** Map a User-Agent header to a canonical AI bot id, or null when it
 *  matches none of the known crawler tokens. */
export function classifyCrawler(userAgent: string): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const { pattern, botName } of LOWERCASE_PATTERNS) {
    if (ua.includes(pattern)) return botName;
  }
  return null;
}

// ─── Write throttle ─────────────────────────────────────────────────────────
// The public proxy is unauthenticated, so a flood of requests to one store
// would otherwise fire one upsert each, all contending on the same daily
// counter row plus pressuring the connection pool. A per-store sliding
// window caps DB writes; dropped writes only undercount during an abusive
// burst, and legitimate crawler traffic is orders of magnitude below the
// limit. In-memory is correct here: single long-lived Render process (same
// assumption the llms-regen queue relies on), and a restart just resets the
// window. The map holds at most one entry per store (bounded by store count).
const RATE_WINDOW_MS = 60_000;
const MAX_WRITES_PER_WINDOW = 60;
const writeWindows = new Map<string, { windowStart: number; count: number }>();

function allowWrite(storeId: string): boolean {
  const now = Date.now();
  const window = writeWindows.get(storeId);
  if (!window || now - window.windowStart >= RATE_WINDOW_MS) {
    writeWindows.set(storeId, { windowStart: now, count: 1 });
    return true;
  }
  if (window.count >= MAX_WRITES_PER_WINDOW) return false;
  window.count += 1;
  return true;
}

/** UTC midnight for the given moment - the day bucket a hit counts toward. */
function utcDayStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Count one proxy hit. Fire-and-forget by contract: the upsert is not
 * awaited and every failure path (sync and async) lands in console.error,
 * so the caller's response latency and failure behavior are untouched.
 * Throttled per store to bound DB write amplification under a flood.
 */
export function recordCrawlerHit(storeId: string, userAgent: string): void {
  if (!allowWrite(storeId)) return;
  try {
    const botName = classifyCrawler(userAgent) ?? "";
    const day = utcDayStart(Date.now());
    const ua = userAgent.slice(0, MAX_USER_AGENT_LENGTH);
    void prisma.aiCrawlerHit
      .upsert({
        where: { storeId_botName_day: { storeId, botName, day } },
        create: { storeId, botName, day, count: 1, lastUserAgent: ua },
        update: {
          count: { increment: 1 },
          lastUserAgent: ua,
          lastHitAt: new Date(),
        },
      })
      .catch((err: unknown) => {
        console.error("[GEO Rise] Failed to record crawler hit:", err);
      });
  } catch (err) {
    // Defensive: the never-throws contract is what keeps the public proxy
    // safe even if the upsert call itself throws synchronously.
    console.error("[GEO Rise] Failed to record crawler hit:", err);
  }
}

export interface CrawlerBotStat {
  botName: string;
  count: number;
  /** ISO timestamp of the most recent hit from this bot. */
  lastHitAt: string;
}

export interface CrawlerStats {
  /** All proxy hits in the range, classified or not. */
  totalHits: number;
  /** Hits whose UA matched a known AI crawler. */
  botHits: number;
  /** Per-bot breakdown, highest count first. */
  byBot: CrawlerBotStat[];
}

/** Day bucket boundary covering the last `rangeDays` (inclusive of today). */
function rangeStart(rangeDays: number): Date {
  return utcDayStart(Date.now() - (rangeDays - 1) * 24 * 60 * 60 * 1000);
}

/**
 * Crawler activity for one store over the last `rangeDays`. The counter
 * design means at most bots x days rows per store (~17 x 30), so a small
 * findMany plus in-JS aggregation is cheaper and simpler than a groupBy.
 */
export async function getCrawlerStats(
  storeId: string,
  rangeDays = 30
): Promise<CrawlerStats> {
  const since = rangeStart(rangeDays);
  const rows = await prisma.aiCrawlerHit.findMany({
    where: { storeId, day: { gte: since } },
    select: { botName: true, count: true, lastHitAt: true },
  });

  let totalHits = 0;
  let botHits = 0;
  const byBotMap = new Map<string, { count: number; lastHitAt: Date }>();
  for (const row of rows) {
    totalHits += row.count;
    if (row.botName === "") continue; // unclassified traffic
    botHits += row.count;
    const existing = byBotMap.get(row.botName);
    if (existing) {
      existing.count += row.count;
      if (row.lastHitAt > existing.lastHitAt) existing.lastHitAt = row.lastHitAt;
    } else {
      byBotMap.set(row.botName, { count: row.count, lastHitAt: row.lastHitAt });
    }
  }

  const byBot: CrawlerBotStat[] = Array.from(byBotMap.entries())
    .map(([botName, v]) => ({
      botName,
      count: v.count,
      lastHitAt: v.lastHitAt.toISOString(),
    }))
    .sort((a, b) => b.count - a.count);

  return { totalHits, botHits, byBot };
}

/**
 * Total classified AI-bot fetches for one store over the last `rangeDays`,
 * for the dashboard stat card. Sums the daily counters (excludes the ""
 * unclassified bucket) in the database.
 */
export async function getBotFetchCount(
  storeId: string,
  rangeDays = 30
): Promise<number> {
  const since = rangeStart(rangeDays);
  const result = await prisma.aiCrawlerHit.aggregate({
    where: { storeId, botName: { not: "" }, day: { gte: since } },
    _sum: { count: true },
  });
  return result._sum.count ?? 0;
}

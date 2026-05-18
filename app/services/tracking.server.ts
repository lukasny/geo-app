import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { withRetry } from "./ai-retry.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// OpenAI: real ChatGPT-equivalent answers via gpt-4o-search-preview.
// Perplexity exposes an OpenAI-compatible API at api.perplexity.ai so the
// same SDK works - just a different base URL + key. Both clients are
// constructed lazily so missing keys don't crash on module load; the
// per-platform fetcher checks before calling.
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const perplexity = process.env.PERPLEXITY_API_KEY
  ? new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: "https://api.perplexity.ai",
    })
  : null;

type AiPlatform = "CLAUDE" | "CHATGPT" | "PERPLEXITY";

/** Which platforms are configured at runtime. Used by the orchestrator
 *  in `runTrackingCheck` to decide which API calls to fan out. CLAUDE
 *  is always available (ANTHROPIC_API_KEY is required at module init);
 *  the other two are optional. */
function enabledPlatforms(): AiPlatform[] {
  const out: AiPlatform[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push("CLAUDE");
  if (openai) out.push("CHATGPT");
  if (perplexity) out.push("PERPLEXITY");
  return out;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CitationSentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE";

export interface TrackingCheckResult {
  citationId: string;
  cited: boolean;
  position: number | null;
  citationContext: string | null;
  responseSnippet: string;
  productsCited: string[];
  vendorsCited: string[];
  competitorsDetected: string[];
  sentiment: CitationSentiment;
}

export type SuggestionSource = "shopify_search" | "reddit" | "ai_brainstorm";

export interface SuggestedPrompt {
  prompt: string;
  category: "comparison" | "recommendation" | "use_case" | "price" | "brand";
  rationale: string;
  /** Where this suggestion came from. shopify_search means the prompt was
   *  derived from one of the merchant's own storefront search queries.
   *  reddit means it was derived from a post title in a relevant
   *  community. ai_brainstorm is the fallback when both data sources
   *  returned nothing - Claude generated the prompt from the catalog alone. */
  source: SuggestionSource;
  /** Human-readable context surfaced under the suggestion in the UI. For
   *  shopify_search: e.g. "search query: 'best beginner snowboard' (37 searches)".
   *  For reddit: e.g. "from r/snowboarding". Undefined for ai_brainstorm. */
  sourceDetail?: string;
}

// ─── Mention Detection Helpers ────────────────────────────────────────────────

/** Strip the `.myshopify.com` suffix and lowercase, so we can match the store
 *  in AI output that references either the bare brand or the full domain. */
function shortDomain(shopifyDomain: string): string {
  return shopifyDomain.replace(/\.myshopify\.com$/i, "").toLowerCase();
}

/** Return a snippet of `text` centered around the first occurrence of any
 *  keyword in `keywords` (case-insensitive). Used for the citation context. */
function snippetAround(text: string, keywords: string[], pad = 100): string | null {
  const lower = text.toLowerCase();
  for (const raw of keywords) {
    const kw = raw?.trim();
    if (!kw) continue;
    const i = lower.indexOf(kw.toLowerCase());
    if (i >= 0) {
      const start = Math.max(0, i - pad);
      const end = Math.min(text.length, i + kw.length + pad);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < text.length ? "…" : "";
      return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
    }
  }
  return null;
}

/** Find position (1-based ordinal) of the first occurrence of any of the
 *  keywords in the response text. Used to record whether the store was
 *  cited "first," "second," etc. in a recommendation list. Returns null if
 *  no match. */
function firstPosition(text: string, keywords: string[]): number | null {
  const lower = text.toLowerCase();
  let earliest = Infinity;
  for (const raw of keywords) {
    const kw = raw?.trim();
    if (!kw) continue;
    const i = lower.indexOf(kw.toLowerCase());
    if (i >= 0 && i < earliest) earliest = i;
  }
  if (earliest === Infinity) return null;
  // Count occurrences of either "1." / "1)" or newlines before earliest to
  // approximate a list position. Imperfect but good enough for v1.
  const before = text.slice(0, earliest);
  const listMarkers = before.match(/\n\s*\d+[.)]/g) ?? [];
  return listMarkers.length + 1;
}

// ─── Sentiment Classification ─────────────────────────────────────────────────

const SENTIMENT_SYSTEM_PROMPT = `You judge whether an AI assistant's mention of a specific store, brand, or product is POSITIVE, NEUTRAL, or NEGATIVE in tone toward that subject.

- POSITIVE: recommended, praised, highlighted as a good choice, comparison-favored ("one of the best", "great for X", "stands out")
- NEUTRAL: listed without judgment, mentioned as one option among many, simply named
- NEGATIVE: criticized, advised against, comparison-disfavored, called out for problems

If unsure or the mention is purely factual, return NEUTRAL.

Output strictly as JSON: {"sentiment": "POSITIVE" | "NEUTRAL" | "NEGATIVE"}`;

async function classifySentiment(
  excerpt: string,
  subjects: string[]
): Promise<CitationSentiment> {
  const cleanedSubjects = subjects.map((s) => s?.trim()).filter(Boolean);
  if (!excerpt.trim() || cleanedSubjects.length === 0) return "NEUTRAL";

  try {
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 256,
          system: SENTIMENT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Subject(s): ${cleanedSubjects.join(", ")}

AI response excerpt:
"""
${excerpt}
"""

Classify the tone toward the subject(s).`,
            },
          ],
        }),
      "classifySentiment"
    );

    const block = message.content[0];
    if (block?.type !== "text") return "NEUTRAL";

    const raw = block.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(raw) as { sentiment?: string };
    const s = parsed.sentiment?.toUpperCase();
    if (s === "POSITIVE" || s === "NEGATIVE" || s === "NEUTRAL") return s;
    return "NEUTRAL";
  } catch {
    return "NEUTRAL";
  }
}

// ─── Claude Call ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI shopping assistant similar to ChatGPT, Perplexity, or Gemini. When asked for product recommendations, search the web for current information and give concrete, specific recommendations. Name actual products and the stores or brands that sell them. Cite real sources.`;

interface ClaudeWebSearchResponse {
  responseText: string;
  sourceDomains: string[];
}

async function askClaudeWithWebSearch(prompt: string): Promise<ClaudeWebSearchResponse> {
  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [
          // Anthropic's server-hosted web search tool - runs the search on
          // Anthropic's infrastructure and returns citations inline.
          { type: "web_search_20260209", name: "web_search", max_uses: 5 },
        ],
        messages: [{ role: "user", content: prompt }],
      }),
    "askClaudeWithWebSearch"
  );

  let responseText = "";
  const sourceDomains = new Set<string>();

  for (const block of message.content) {
    if (block.type === "text") {
      responseText += block.text + "\n";
      // Claude returns inline citations as `citations` on text blocks
      // (server-side web_search tool). Pull domains from them.
      const citations = (block as unknown as { citations?: Array<{ url?: string }> })
        .citations;
      if (citations) {
        for (const c of citations) {
          try {
            if (c.url) sourceDomains.add(new URL(c.url).hostname.toLowerCase());
          } catch {
            // skip unparseable URLs
          }
        }
      }
    } else if (block.type === "web_search_tool_result") {
      // Extract source URLs from the tool result envelope as well, in case
      // citations aren't surfaced inline.
      const content = (block as unknown as { content?: Array<{ url?: string }> }).content;
      if (Array.isArray(content)) {
        for (const item of content) {
          try {
            if (item.url) sourceDomains.add(new URL(item.url).hostname.toLowerCase());
          } catch {
            // skip
          }
        }
      }
    }
  }

  return { responseText: responseText.trim(), sourceDomains: [...sourceDomains] };
}

/** OpenAI's gpt-4o-search-preview model has built-in web search. Citations
 *  come back as `message.annotations[].url_citation.url`. */
async function askOpenAIWithWebSearch(prompt: string): Promise<ClaudeWebSearchResponse> {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");

  const completion = await withRetry(
    () =>
      openai!.chat.completions.create({
        model: "gpt-4o-search-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    "askOpenAIWithWebSearch"
  );

  const msg = completion.choices[0]?.message;
  const responseText = msg?.content ?? "";
  const sourceDomains = new Set<string>();

  // OpenAI returns inline citations on the message as `annotations`. The shape
  // is `{ type: "url_citation", url_citation: { url, title, ... } }`. Pull
  // hostnames from each.
  const annotations = (msg as unknown as {
    annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
  }).annotations;
  if (Array.isArray(annotations)) {
    for (const ann of annotations) {
      const url = ann.url_citation?.url;
      if (!url) continue;
      try {
        sourceDomains.add(new URL(url).hostname.toLowerCase());
      } catch {
        // skip unparseable
      }
    }
  }

  return { responseText: responseText.trim(), sourceDomains: [...sourceDomains] };
}

/** Perplexity's `sonar` family has web search built in. Citations come back
 *  on the completion object as either `citations: string[]` (older) or
 *  `search_results: [{ url, ... }]` (newer). Handle both. */
async function askPerplexityWithWebSearch(prompt: string): Promise<ClaudeWebSearchResponse> {
  if (!perplexity) throw new Error("PERPLEXITY_API_KEY not configured");

  const completion = await withRetry(
    () =>
      perplexity!.chat.completions.create({
        model: "sonar",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    "askPerplexityWithWebSearch"
  );

  const responseText = completion.choices[0]?.message?.content ?? "";
  const sourceDomains = new Set<string>();

  const extra = completion as unknown as {
    citations?: string[];
    search_results?: Array<{ url?: string }>;
  };
  if (Array.isArray(extra.citations)) {
    for (const url of extra.citations) {
      try {
        sourceDomains.add(new URL(url).hostname.toLowerCase());
      } catch {
        // skip
      }
    }
  }
  if (Array.isArray(extra.search_results)) {
    for (const item of extra.search_results) {
      if (!item.url) continue;
      try {
        sourceDomains.add(new URL(item.url).hostname.toLowerCase());
      } catch {
        // skip
      }
    }
  }

  return { responseText: responseText.trim(), sourceDomains: [...sourceDomains] };
}

// ─── Main Tracking Check ──────────────────────────────────────────────────────

/** Per-platform processor: takes one platform's web-search result, runs
 *  mention detection / position scoring / sentiment classification, and
 *  persists an AiCitation row tagged with that platform. Called once per
 *  enabled platform by the orchestrator below. */
async function processPlatformCitation(args: {
  prompt: { id: string; storeId: string; prompt: string; category: string | null };
  storeName: string;
  shortDom: string;
  fullDom: string;
  productTitles: string[];
  vendors: string[];
  platform: AiPlatform;
  apiResult: ClaudeWebSearchResponse;
}): Promise<{
  citationId: string;
  cited: boolean;
  position: number | null;
  citationContext: string | null;
  responseSnippet: string;
  productsCited: string[];
  vendorsCited: string[];
  competitorsDetected: string[];
  sentiment: CitationSentiment;
  platform: AiPlatform;
}> {
  const {
    prompt,
    storeName,
    shortDom,
    fullDom,
    productTitles,
    vendors,
    platform,
    apiResult,
  } = args;
  const { responseText, sourceDomains } = apiResult;
  const lower = responseText.toLowerCase();

  const mentionedDomain =
    sourceDomains.some((d) => d.includes(shortDom)) ||
    lower.includes(fullDom) ||
    lower.includes(shortDom);
  const mentionedStoreName = !!storeName && lower.includes(storeName.toLowerCase());
  const mentionedProducts = productTitles.filter((t) =>
    lower.includes(t.toLowerCase())
  );
  const mentionedVendors = vendors.filter((v) =>
    lower.includes(v.toLowerCase())
  );

  const cited =
    mentionedDomain ||
    mentionedStoreName ||
    mentionedProducts.length > 0 ||
    mentionedVendors.length > 0;

  const positionKeywords = [
    storeName,
    shortDom,
    ...mentionedProducts.slice(0, 3),
    ...mentionedVendors.slice(0, 3),
  ].filter(Boolean) as string[];
  const position = cited ? firstPosition(responseText, positionKeywords) : null;
  const citationContext = cited
    ? snippetAround(responseText, positionKeywords)
    : null;

  const competitorsDetected = sourceDomains.filter(
    (d) => !d.includes(shortDom) && !d.includes("shopify.com")
  );

  let sentiment: CitationSentiment = "NEUTRAL";
  if (cited) {
    const sentimentExcerpt =
      snippetAround(responseText, positionKeywords, 400) ??
      responseText.slice(0, 1500);
    sentiment = await classifySentiment(sentimentExcerpt, positionKeywords);
  }

  const citation = await prisma.aiCitation.create({
    data: {
      storeId: prompt.storeId,
      platform,
      prompt: prompt.prompt,
      promptCategory: prompt.category,
      cited,
      position: position ?? null,
      citationContext,
      sentiment,
      productsCited: mentionedProducts.length > 0 ? mentionedProducts : undefined,
      competitorsCited:
        competitorsDetected.length > 0 ? competitorsDetected : undefined,
      responseSnippet: responseText.slice(0, 2000),
    },
  });

  return {
    citationId: citation.id,
    cited,
    position,
    citationContext,
    responseSnippet: responseText.slice(0, 500),
    productsCited: mentionedProducts,
    vendorsCited: mentionedVendors,
    competitorsDetected,
    sentiment,
    platform,
  };
}

export async function runTrackingCheck(
  promptId: string
): Promise<TrackingCheckResult> {
  const prompt = await prisma.trackingPrompt.findUnique({
    where: { id: promptId },
    include: { store: true },
  });
  if (!prompt) throw new Error("Tracking prompt not found");

  // Load identifying signals ONCE and share across all platform fanouts.
  const products = await prisma.product.findMany({
    where: { storeId: prompt.storeId },
    select: { title: true, vendor: true, handle: true },
    take: 100,
  });
  const productTitles = [...new Set(products.map((p) => p.title).filter(Boolean))];
  const vendorSet = new Set<string>();
  for (const p of products) if (p.vendor) vendorSet.add(p.vendor);
  const vendors = [...vendorSet];

  const storeName = prompt.store.shopName;
  const shortDom = shortDomain(prompt.store.shopifyDomain);
  const fullDom = prompt.store.shopifyDomain.toLowerCase();

  const platforms = enabledPlatforms();
  if (platforms.length === 0) {
    throw new Error(
      "No AI tracking platforms configured - set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or PERPLEXITY_API_KEY"
    );
  }

  const askFn = {
    CLAUDE: askClaudeWithWebSearch,
    CHATGPT: askOpenAIWithWebSearch,
    PERPLEXITY: askPerplexityWithWebSearch,
  } as const;

  // Parallel fanout. allSettled so one platform's failure (network, rate
  // limit, model deprecated, missing model permission) doesn't abort the
  // others - partial results are still useful tracking data.
  const settled = await Promise.allSettled(
    platforms.map(async (p) => {
      const apiResult = await askFn[p](prompt.prompt);
      return processPlatformCitation({
        prompt,
        storeName,
        shortDom,
        fullDom,
        productTitles,
        vendors,
        platform: p,
        apiResult,
      });
    })
  );

  const results = settled
    .filter(
      (r): r is PromiseFulfilledResult<
        Awaited<ReturnType<typeof processPlatformCitation>>
      > => r.status === "fulfilled"
    )
    .map((r) => r.value);

  // Always log rejections so the merchant can correlate "I expected ChatGPT
  // to run but it didn't" with a concrete error in Render logs.
  for (const r of settled) {
    if (r.status === "rejected") {
      console.error(
        "[tracking] platform check failed:",
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      );
    }
  }

  if (results.length === 0) {
    const failureMessages = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
      .join("; ");
    throw new Error(
      `All ${platforms.length} AI platform check${
        platforms.length === 1 ? "" : "s"
      } failed: ${failureMessages}`
    );
  }

  // lastCheckedAt is owned by the orchestrator, not the scheduler - manual
  // clicks intentionally don't disturb the schedule clock (see A4 audit).
  await prisma.trackingPrompt.update({
    where: { id: promptId },
    data: { lastCheckedAt: new Date() },
  });

  // Aggregate for the caller. "cited" reflects whether ANY platform cited
  // the store. We surface the first cited platform's snippet / sentiment /
  // position to the UI (or just the first result if none cited) - the full
  // per-platform breakdown lives in the AiCitation rows the loader pulls.
  const anyCited = results.some((r) => r.cited);
  const primary = results.find((r) => r.cited) ?? results[0];

  return {
    citationId: primary.citationId,
    cited: anyCited,
    position: primary.position,
    citationContext: primary.citationContext,
    responseSnippet: primary.responseSnippet,
    productsCited: primary.productsCited,
    vendorsCited: primary.vendorsCited,
    competitorsDetected: primary.competitorsDetected,
    sentiment: primary.sentiment,
  };
}

// ─── Intent Lab signal sources ────────────────────────────────────────────────

interface SearchTerm {
  term: string;
  count: number;
}

const SHOPIFY_SEARCH_ANALYTICS_QUERY = `#graphql
  query SearchAnalytics($q: String!) {
    shopifyqlQuery(query: $q) {
      __typename
      ... on TableResponse {
        tableData {
          rowData
          columns { name dataType }
        }
      }
      ... on ParseError {
        code
        message
      }
    }
  }
`;

const SHOPIFYQL = `FROM online_store_search
SHOW count
BY search_term
SINCE -30d UNTIL today
ORDER BY count DESC
LIMIT 50`;

/** Stage 1 of Intent Lab. Pulls the top 50 storefront search terms from the
 *  merchant's last 30 days via ShopifyQL. Returns up to 20 cleaned results
 *  (3 to 200 character terms, deduped, ordered by count). Returns [] on any
 *  error so the caller can run Stage 2 regardless. */
async function fetchShopifySearchAnalytics(
  admin: AdminApiContext
): Promise<SearchTerm[]> {
  try {
    const response = await admin.graphql(SHOPIFY_SEARCH_ANALYTICS_QUERY, {
      variables: { q: SHOPIFYQL },
    });
    const json = (await response.json()) as {
      data?: {
        shopifyqlQuery?:
          | {
              __typename: "TableResponse";
              tableData: { rowData: unknown[][] };
            }
          | {
              __typename: "ParseError";
              code: string;
              message: string;
            };
      };
      errors?: { message?: string }[];
    };

    if (json.errors && json.errors.length > 0) {
      console.warn(
        "[Intent Lab] shopifyqlQuery returned top-level errors:",
        json.errors
      );
      return [];
    }

    const result = json.data?.shopifyqlQuery;
    if (!result) return [];
    if (result.__typename === "ParseError") {
      console.warn(
        `[Intent Lab] shopifyqlQuery ParseError ${result.code}: ${result.message}`
      );
      return [];
    }

    const rows = result.tableData?.rowData ?? [];
    const terms: SearchTerm[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const rawTerm = String(row[0] ?? "").trim();
      const rawCount = Number(row[1]);
      if (!rawTerm) continue;
      if (rawTerm.length < 3 || rawTerm.length > 200) continue;
      if (!Number.isFinite(rawCount) || rawCount <= 0) continue;
      const lower = rawTerm.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      terms.push({ term: rawTerm, count: rawCount });
      if (terms.length >= 20) break;
    }
    return terms;
  } catch (err) {
    console.warn("[Intent Lab] fetchShopifySearchAnalytics threw:", err);
    return [];
  }
}

interface NicheInfo {
  niche: string;
  subreddits: string[];
}

const NICHE_DETECTION_SYSTEM_PROMPT = `You analyze a Shopify merchant's product catalog and identify two things:
1. The niche: a short descriptor of what they sell (e.g. "snowboarding gear and apparel", "natural skincare", "home espresso equipment")
2. 3 to 5 relevant subreddits where shoppers in this niche discuss products and recommendations

Choose subreddits known for product discussions and gear recommendations. Avoid NSFW, off-topic, or meme subreddits. Use real subreddit names that you are confident exist. Use lowercase names without the "r/" prefix.

CRITICAL: never use em-dashes (the long horizontal dash, U+2014) anywhere in your output. Use commas, colons, or periods instead.

Output strictly as JSON: { "niche": "string", "subreddits": ["name1", "name2"] }`;

const SUBREDDIT_DENYLIST = new Set<string>([
  "all",
  "popular",
  "askreddit",
  "funny",
  "memes",
  "nsfw",
]);

/** Stage 2a of Intent Lab. Returns the merchant's niche + 3 to 5 candidate
 *  subreddits. Used to drive the Stage 2b Reddit fetch. Returns null if the
 *  store has no products, Claude errors, or output is malformed. */
async function detectNicheAndSubreddits(
  storeId: string
): Promise<NicheInfo | null> {
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });
  if (products.length === 0) return null;

  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");

  try {
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          system: NICHE_DETECTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Catalog (up to 25 active products):\n${productLines}\n\nIdentify the niche and suggest 3 to 5 subreddits.`,
            },
          ],
        }),
      "detectNicheAndSubreddits"
    );

    const block = message.content[0];
    if (block?.type !== "text") return null;

    const raw = block.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(raw) as {
      niche?: unknown;
      subreddits?: unknown;
    };

    const niche = typeof parsed.niche === "string" ? parsed.niche.trim() : "";
    const subreddits = Array.isArray(parsed.subreddits)
      ? parsed.subreddits
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.replace(/^r\//i, "").trim().toLowerCase())
          .filter((s) => /^[a-z0-9_]{2,21}$/i.test(s))
          .filter((s) => !SUBREDDIT_DENYLIST.has(s))
          .slice(0, 5)
      : [];

    if (!niche || subreddits.length === 0) return null;
    return { niche, subreddits };
  } catch (err) {
    console.warn("[Intent Lab] detectNicheAndSubreddits failed:", err);
    return null;
  }
}

interface RedditSignal {
  subreddit: string;
  title: string;
  permalink: string;
}

const QUESTION_OPENERS_RE =
  /^(best|should i|what['']s the difference|what is|how to|how do|vs\b|recommend|looking for|any tips for|need help|which|where|why)\b/i;

function isQuestionShapedTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 10 || t.length > 200) return false;
  if (t.endsWith("?")) return true;
  return QUESTION_OPENERS_RE.test(t);
}

/** Stage 2b of Intent Lab. Fetches recent question-shaped post titles from
 *  the given subreddits via Reddit's public JSON endpoint. No auth needed;
 *  Reddit requires a non-default User-Agent so we set one. Returns up to
 *  25 titles total, 10 per subreddit max. */
async function fetchRedditTitles(
  subreddits: string[]
): Promise<RedditSignal[]> {
  const results: RedditSignal[] = [];
  const PER_SUBREDDIT_LIMIT = 10;
  const TOTAL_LIMIT = 25;

  for (const subreddit of subreddits) {
    if (results.length >= TOTAL_LIMIT) break;
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?t=month&limit=25`;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "web:geo-rise-shopify-app:1.0" },
      });
      if (!response.ok) {
        console.warn(
          `[Intent Lab] reddit ${subreddit} returned ${response.status}, skipping`
        );
        continue;
      }
      const json = (await response.json()) as {
        data?: {
          children?: Array<{
            data?: { title?: string; permalink?: string };
          }>;
        };
      };
      const posts = json.data?.children ?? [];
      let countForThisSub = 0;
      for (const post of posts) {
        if (countForThisSub >= PER_SUBREDDIT_LIMIT) break;
        if (results.length >= TOTAL_LIMIT) break;
        const title = post.data?.title?.trim();
        const permalink = post.data?.permalink ?? "";
        if (!title || !isQuestionShapedTitle(title)) continue;
        results.push({ subreddit, title, permalink });
        countForThisSub += 1;
      }
    } catch (err) {
      console.warn(`[Intent Lab] reddit ${subreddit} fetch threw:`, err);
      continue;
    }
  }

  return results;
}

// ─── Suggest Tracking Prompts ─────────────────────────────────────────────────

// Used only as the Stage 0 fallback when both Shopify search analytics and
// Reddit returned zero signals. Same text as the pre-Intent-Lab prompt.
const BRAINSTORM_SYSTEM_PROMPT = `You are an AEO (Answer Engine Optimization) strategist. Your job is to generate the kinds of questions a real shopper would ask an AI assistant (ChatGPT, Perplexity, Claude, Gemini) when researching products in a specific store's category.

You will be given a store's product catalog. Generate 8 tracking prompts that:
1. Sound like natural, conversational questions a human would type into an AI
2. Cover a mix of intents: product comparisons, "best of" recommendations, use-case scenarios, price/value, and brand questions
3. Are specific enough to be answerable but broad enough that the store could realistically be cited

Do NOT include the store's brand name in the prompts. These are questions OTHER people would ask, not the store owner. The whole point is to find prompts where AI might mention the store organically.

CRITICAL: never use em-dashes (the long horizontal dash) anywhere in your output. Use commas, colons, or periods instead. This rule applies to both the "prompt" and "rationale" fields.

Output strictly as JSON: { "suggestions": [{ "prompt": "...", "category": "comparison|recommendation|use_case|price|brand", "rationale": "one sentence on why this prompt matters for this store" }] }`;

// Stage 3 prompt: polish real shopper signals into tracking prompts. Each
// output prompt must cite the index of the signal it was derived from.
const POLISH_SYSTEM_PROMPT = `You polish real shopper queries into tracking prompts for a Shopify merchant's AI search visibility tool.

The signals provided are REAL shopper queries from two sources:
  - shopify_search: terms the merchant's own shoppers typed into their storefront search bar
  - reddit: question-shaped post titles from relevant subreddits

Your job: convert these raw signals into 8 well-formed tracking prompts. Each output prompt MUST be derived from one of the provided signals. Do not fabricate prompts that have no signal backing.

For each prompt:
- Phrase as a question a shopper would ask an AI search engine like ChatGPT or Perplexity
- Reference specific products or brands from the merchant's catalog when relevant
- Categorize as one of: comparison / recommendation / use_case / price / brand
- Add a one-sentence rationale explaining why this prompt matters for this merchant
- Cite the source index (the integer prefix of the signal that inspired it)

CRITICAL: never use em-dashes (the long horizontal dash, U+2014). Use commas, colons, or periods instead. This rule applies to the prompt and rationale fields.

Output strictly as JSON:
{
  "suggestions": [
    {
      "prompt": "string",
      "category": "comparison|recommendation|use_case|price|brand",
      "rationale": "one sentence",
      "sourceIndex": 0
    }
  ]
}`;

/** Intent Lab orchestrator. Pulls real shopper signals from Shopify
 *  storefront search analytics and Reddit in parallel, then asks Claude to
 *  polish them into 8 tracking prompts. Falls back to pure-Claude
 *  brainstorming if both signal sources came back empty.
 *
 *  Each returned SuggestedPrompt carries a `source` field showing where
 *  it came from so the UI can attribute it. */
export async function suggestTrackingPrompts(
  storeId: string,
  admin: AdminApiContext
): Promise<SuggestedPrompt[]> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  // Stages 1 + 2 run in parallel. Both gracefully return empty arrays on
  // error so the orchestrator can always proceed to polish or fallback.
  const [searchTerms, niche] = await Promise.all([
    fetchShopifySearchAnalytics(admin),
    detectNicheAndSubreddits(storeId),
  ]);
  const redditSignals: RedditSignal[] = niche
    ? await fetchRedditTitles(niche.subreddits)
    : [];

  const haveSignals = searchTerms.length > 0 || redditSignals.length > 0;

  if (!haveSignals) {
    // Stage 0 fallback: existing pure-Claude brainstorm. Same as the
    // pre-Intent-Lab behavior. Output gets the ai_brainstorm source tag.
    return runBrainstormFallback(storeId, store.shopName);
  }

  return runPolishStage({
    storeId,
    shopName: store.shopName,
    searchTerms,
    redditSignals,
  });
}

/** Stage 3 polish: hand all collected signals to Claude with the polish
 *  prompt. Each Claude-returned suggestion cites a sourceIndex which we
 *  map back to the originating signal for source attribution. */
async function runPolishStage(args: {
  storeId: string;
  shopName: string;
  searchTerms: SearchTerm[];
  redditSignals: RedditSignal[];
}): Promise<SuggestedPrompt[]> {
  const { storeId, shopName, searchTerms, redditSignals } = args;

  type Signal =
    | { kind: "shopify_search"; index: number; term: string; count: number }
    | {
        kind: "reddit";
        index: number;
        subreddit: string;
        title: string;
      };
  const signals: Signal[] = [];
  for (const t of searchTerms) {
    signals.push({
      kind: "shopify_search",
      index: signals.length,
      term: t.term,
      count: t.count,
    });
  }
  for (const r of redditSignals) {
    signals.push({
      kind: "reddit",
      index: signals.length,
      subreddit: r.subreddit,
      title: r.title,
    });
  }

  const signalLines = signals
    .map((s) => {
      if (s.kind === "shopify_search") {
        return `[${s.index}] shopify_search: "${s.term}" (${s.count} ${s.count === 1 ? "search" : "searches"})`;
      }
      return `[${s.index}] reddit (r/${s.subreddit}): "${s.title}"`;
    })
    .join("\n");

  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });
  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");
  const vendorSet = new Set<string>();
  for (const p of products) if (p.vendor) vendorSet.add(p.vendor);
  const vendors = [...vendorSet];

  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: POLISH_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Store name: ${shopName}
${vendors.length > 0 ? `Brands sold: ${vendors.join(", ")}` : ""}

Products (up to 25):
${productLines}

Signals (real shopper data):
${signalLines}

Generate 8 tracking prompts derived from these signals.`,
          },
        ],
      }),
    "suggestTrackingPrompts.polish"
  );

  const block = message.content[0];
  if (block?.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: {
    suggestions?: Array<{
      prompt?: unknown;
      category?: unknown;
      rationale?: unknown;
      sourceIndex?: unknown;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Couldn't parse Claude's suggestions - please try again.");
  }
  const rawSuggestions = parsed.suggestions ?? [];

  const existing = await prisma.trackingPrompt.findMany({
    where: { storeId },
    select: { prompt: true },
  });
  const existingLower = new Set(
    existing.map((p) => p.prompt.toLowerCase().trim())
  );

  const validCategories = new Set([
    "comparison",
    "recommendation",
    "use_case",
    "price",
    "brand",
  ]);

  const polished: SuggestedPrompt[] = [];
  for (const s of rawSuggestions) {
    if (typeof s.prompt !== "string") continue;
    if (typeof s.category !== "string") continue;
    if (typeof s.rationale !== "string") continue;
    if (typeof s.sourceIndex !== "number") continue;

    const promptText = s.prompt.trim();
    const category = s.category.trim();
    const rationale = s.rationale.trim();
    const sourceIndex = Math.floor(s.sourceIndex);

    if (!promptText || promptText.length > 500) continue;
    if (!validCategories.has(category)) continue;
    if (existingLower.has(promptText.toLowerCase())) continue;

    const signal = signals[sourceIndex];
    if (!signal) continue;

    const source: SuggestionSource =
      signal.kind === "shopify_search" ? "shopify_search" : "reddit";
    const sourceDetail =
      signal.kind === "shopify_search"
        ? `search query: "${signal.term}" (${signal.count} ${signal.count === 1 ? "search" : "searches"} on your store)`
        : `from r/${signal.subreddit}`;

    polished.push({
      prompt: promptText,
      category: category as SuggestedPrompt["category"],
      rationale,
      source,
      sourceDetail,
    });
  }

  // If polish produced too few results, fall through to brainstorm fallback
  // for the remainder. Most stores should get at least 8 here.
  if (polished.length < 4) {
    const fallback = await runBrainstormFallback(storeId, shopName);
    const merged = [...polished];
    for (const f of fallback) {
      if (merged.length >= 8) break;
      if (
        !merged.some((m) => m.prompt.toLowerCase() === f.prompt.toLowerCase())
      ) {
        merged.push(f);
      }
    }
    return merged;
  }
  return polished.slice(0, 8);
}

/** Stage 0 fallback. The original pure-Claude brainstorm flow. Used when
 *  both Stage 1 and Stage 2 returned zero signals. */
async function runBrainstormFallback(
  storeId: string,
  shopName: string
): Promise<SuggestedPrompt[]> {
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });
  if (products.length === 0) {
    throw new Error(
      "Run an audit first - we need product data to generate relevant prompts."
    );
  }

  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");
  const vendorSet = new Set<string>();
  for (const p of products) if (p.vendor) vendorSet.add(p.vendor);
  const vendors = [...vendorSet];

  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: BRAINSTORM_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Store name: ${shopName}
${vendors.length > 0 ? `Brands sold: ${vendors.join(", ")}` : ""}

Products (up to 25):
${productLines}

Generate 8 tracking prompts for this store.`,
          },
        ],
      }),
    "suggestTrackingPrompts.brainstorm"
  );

  const block = message.content[0];
  if (block?.type !== "text") {
    throw new Error("Claude returned no text response");
  }
  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: {
    suggestions?: Array<{
      prompt?: unknown;
      category?: unknown;
      rationale?: unknown;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Couldn't parse Claude's suggestions - please try again.");
  }
  const rawSuggestions = parsed.suggestions ?? [];

  const existing = await prisma.trackingPrompt.findMany({
    where: { storeId },
    select: { prompt: true },
  });
  const existingLower = new Set(
    existing.map((p) => p.prompt.toLowerCase().trim())
  );
  const validCategories = new Set([
    "comparison",
    "recommendation",
    "use_case",
    "price",
    "brand",
  ]);

  const valid: SuggestedPrompt[] = [];
  for (const s of rawSuggestions) {
    if (typeof s.prompt !== "string") continue;
    if (typeof s.category !== "string") continue;
    if (typeof s.rationale !== "string") continue;
    const promptText = s.prompt.trim();
    const category = s.category.trim();
    const rationale = s.rationale.trim();
    if (!promptText || promptText.length > 500) continue;
    if (!validCategories.has(category)) continue;
    if (existingLower.has(promptText.toLowerCase())) continue;
    valid.push({
      prompt: promptText,
      category: category as SuggestedPrompt["category"],
      rationale,
      source: "ai_brainstorm",
    });
  }
  return valid.slice(0, 8);
}

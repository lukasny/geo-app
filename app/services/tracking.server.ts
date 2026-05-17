import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import prisma from "~/db.server";
import { withRetry } from "./ai-retry.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// OpenAI: real ChatGPT-equivalent answers via gpt-4o-search-preview.
// Perplexity exposes an OpenAI-compatible API at api.perplexity.ai so the
// same SDK works — just a different base URL + key. Both clients are
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

export interface SuggestedPrompt {
  prompt: string;
  category: "comparison" | "recommendation" | "use_case" | "price" | "brand";
  rationale: string;
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
  const listMarkers = before.match(/\n\s*\d+[.\)]/g) ?? [];
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
          // Anthropic's server-hosted web search tool — runs the search on
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
      "No AI tracking platforms configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or PERPLEXITY_API_KEY"
    );
  }

  const askFn = {
    CLAUDE: askClaudeWithWebSearch,
    CHATGPT: askOpenAIWithWebSearch,
    PERPLEXITY: askPerplexityWithWebSearch,
  } as const;

  // Parallel fanout. allSettled so one platform's failure (network, rate
  // limit, model deprecated, missing model permission) doesn't abort the
  // others — partial results are still useful tracking data.
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

  // lastCheckedAt is owned by the orchestrator, not the scheduler — manual
  // clicks intentionally don't disturb the schedule clock (see A4 audit).
  await prisma.trackingPrompt.update({
    where: { id: promptId },
    data: { lastCheckedAt: new Date() },
  });

  // Aggregate for the caller. "cited" reflects whether ANY platform cited
  // the store. We surface the first cited platform's snippet / sentiment /
  // position to the UI (or just the first result if none cited) — the full
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

// ─── Suggest Tracking Prompts ─────────────────────────────────────────────────

const SUGGEST_SYSTEM_PROMPT = `You are an AEO (Answer Engine Optimization) strategist. Your job is to generate the kinds of questions a real shopper would ask an AI assistant (ChatGPT, Perplexity, Claude, Gemini) when researching products in a specific store's category.

You will be given a store's product catalog. Generate 8 tracking prompts that:
1. Sound like natural, conversational questions a human would type into an AI
2. Cover a mix of intents: product comparisons, "best of" recommendations, use-case scenarios, price/value, and brand questions
3. Are specific enough to be answerable but broad enough that the store could realistically be cited

Do NOT include the store's brand name in the prompts — these are questions OTHER people would ask, not the store owner. The whole point is to find prompts where AI might mention the store organically.

Output strictly as JSON: { "suggestions": [{ "prompt": "...", "category": "comparison|recommendation|use_case|price|brand", "rationale": "one sentence on why this prompt matters for this store" }] }`;

export async function suggestTrackingPrompts(storeId: string): Promise<SuggestedPrompt[]> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  // Pull up to 25 representative products to give Claude enough context
  // without spending too many tokens. Active products only.
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });

  if (products.length === 0) {
    throw new Error("Run an audit first — we need product data to generate relevant prompts.");
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
        system: SUGGEST_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Store name: ${store.shopName}
${vendors.length > 0 ? `Brands sold: ${vendors.join(", ")}` : ""}

Products (up to 25):
${productLines}

Generate 8 tracking prompts for this store.`,
          },
        ],
      }),
    "suggestTrackingPrompts"
  );

  const block = message.content[0];
  if (block?.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  // Strip code fences if Claude wrapped the JSON in ```json … ```
  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: { suggestions?: SuggestedPrompt[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Couldn't parse Claude's suggestions — please try again.");
  }

  const suggestions = parsed.suggestions ?? [];

  // Filter against prompts the merchant already has so we don't suggest dupes.
  const existing = await prisma.trackingPrompt.findMany({
    where: { storeId },
    select: { prompt: true },
  });
  const existingLower = new Set(existing.map((p) => p.prompt.toLowerCase().trim()));

  const valid = suggestions
    .filter(
      (s): s is SuggestedPrompt =>
        typeof s?.prompt === "string" &&
        s.prompt.trim().length > 0 &&
        s.prompt.length <= 500 &&
        !existingLower.has(s.prompt.toLowerCase().trim()) &&
        ["comparison", "recommendation", "use_case", "price", "brand"].includes(
          s.category as string
        )
    )
    .slice(0, 10);

  return valid;
}

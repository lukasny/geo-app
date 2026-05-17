import Anthropic from "@anthropic-ai/sdk";
import prisma from "~/db.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackingCheckResult {
  citationId: string;
  cited: boolean;
  position: number | null;
  citationContext: string | null;
  responseSnippet: string;
  productsCited: string[];
  vendorsCited: string[];
  competitorsDetected: string[];
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

// ─── Claude Call ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI shopping assistant similar to ChatGPT, Perplexity, or Gemini. When asked for product recommendations, search the web for current information and give concrete, specific recommendations. Name actual products and the stores or brands that sell them. Cite real sources.`;

interface ClaudeWebSearchResponse {
  responseText: string;
  sourceDomains: string[];
}

async function askClaudeWithWebSearch(prompt: string): Promise<ClaudeWebSearchResponse> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [
      // Anthropic's server-hosted web search tool — runs the search on
      // Anthropic's infrastructure and returns citations inline.
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
    ],
    messages: [{ role: "user", content: prompt }],
  });

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

// ─── Main Tracking Check ──────────────────────────────────────────────────────

export async function runTrackingCheck(
  promptId: string
): Promise<TrackingCheckResult> {
  const prompt = await prisma.trackingPrompt.findUnique({
    where: { id: promptId },
    include: { store: true },
  });
  if (!prompt) throw new Error("Tracking prompt not found");

  // Load identifying signals for the store: domain, brand name, vendor names,
  // and product titles. Mention detection compares these against the AI's
  // response text and the source URLs Claude cited.
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

  // Run the AI search.
  const { responseText, sourceDomains } = await askClaudeWithWebSearch(
    prompt.prompt
  );

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

  // For the position approximation, look for our brand / product references
  // in the response text.
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

  // Competitor detection: source domains other than our own that look like
  // ecommerce/store domains. A rough first pass — we don't try to filter
  // marketplaces vs reviews here.
  const competitorsDetected = sourceDomains.filter(
    (d) => !d.includes(shortDom) && !d.includes("shopify.com")
  );

  // Persist as AiCitation. Platform is CLAUDE for now — when we add OpenAI /
  // Perplexity / Gemini later, each will write its own row per check.
  const citation = await prisma.aiCitation.create({
    data: {
      storeId: prompt.storeId,
      platform: "CLAUDE",
      prompt: prompt.prompt,
      promptCategory: prompt.category,
      cited,
      position: position ?? null,
      citationContext,
      sentiment: "NEUTRAL", // Sentiment classification deferred to v1.1
      productsCited: mentionedProducts.length > 0 ? mentionedProducts : undefined,
      competitorsCited: competitorsDetected.length > 0 ? competitorsDetected : undefined,
      responseSnippet: responseText.slice(0, 2000),
    },
  });

  await prisma.trackingPrompt.update({
    where: { id: promptId },
    data: { lastCheckedAt: new Date() },
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
  };
}

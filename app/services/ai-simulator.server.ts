import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { withRetry } from "./ai-retry.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AiExtractedData {
  productName: string | null;
  description: string | null;
  price: string | null;
  currency: string | null;
  availability: "in_stock" | "out_of_stock" | null;
  brand: string | null;
  productType: string | null;
  sku: string | null;
  imageCount: number | null;
  imagesHaveAltText: boolean | null;
  variants: string[] | null;
  variantCount: number | null;
  materials: string | null;
  dimensions: string | null;
  weight: string | null;
  rating: number | null;
  reviewCount: number | null;
  shippingInfo: string | null;
  returnPolicy: string | null;
  faqCount: number | null;
  structuredDataFound: boolean;
  schemaTypes: string[] | null;
}

type FieldStatus = "found" | "missing" | "partial" | "mismatch";
type FieldImportance = "critical" | "high" | "medium" | "low";

export interface FieldComparison {
  fieldName: string;
  label: string;
  shopifyValue: unknown;
  aiExtractedValue: unknown;
  status: FieldStatus;
  importance: FieldImportance;
}

export type SimulatorPlatform = "CLAUDE" | "CHATGPT";

export interface PlatformSimulationResult {
  platform: SimulatorPlatform;
  visibilityScore: number;
  comparison: FieldComparison[];
  aiRawResponse: string;
  totalFields: number;
  foundFields: number;
  missingFields: number;
  /** Set when this platform's extraction itself failed (API error, JSON parse).
   *  Other platforms' results may still be valid. */
  errorReason?: string;
}

export interface SimulationResult {
  // ── Aggregate across all platforms that ran ──
  /** Per-platform breakdowns. Always at least one entry (the orchestrator
   *  throws if every platform failed). */
  platforms: PlatformSimulationResult[];
  /** Mean visibility score across platforms - quick "is my page AI-readable?"
   *  number for the headline pill. */
  averageVisibilityScore: number;

  // ── Legacy fields kept for back-compat with the existing UI ──
  // Populated from the "primary" platform (Claude if it ran, else the first
  // successful one). Older callers reading `visibilityScore` etc. keep working.
  visibilityScore: number;
  comparison: FieldComparison[];
  aiRawResponse: string;
  totalFields: number;
  foundFields: number;
  missingFields: number;

  /** True when the live page couldn't be read (password-protected, 4xx, blocked, etc.)
   *  and we fell back to simulating against Shopify product data instead.
   *  Fallback decision is platform-independent (HTML is shared). */
  usedFallback: boolean;
  /** Human-readable reason for the fallback, when one was used. */
  fallbackReason: string | null;
}

// ─── HTML Cleaning ────────────────────────────────────────────────────────────

function cleanHtml(html: string): string {
  // Extract JSON-LD blocks first (most valuable for AI)
  const jsonLdBlocks: string[] = [];
  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonLdRe.exec(html)) !== null) {
    jsonLdBlocks.push(m[1].trim());
  }

  // Remove tags we definitely don't need
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Extract useful attributes before stripping tags
    .replace(/<img[^>]+alt=["']([^"']+)["'][^>]*>/gi, (_, alt) => `[Image: ${alt}]`)
    .replace(/<img[^>]*>/gi, "[Image: no alt text]")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();

  // Prepend extracted JSON-LD at the top for the AI
  const jsonLdSection =
    jsonLdBlocks.length > 0
      ? `=== STRUCTURED DATA (JSON-LD) ===\n${jsonLdBlocks.join("\n")}\n\n=== PAGE TEXT ===\n`
      : "";

  return (jsonLdSection + cleaned).slice(0, 8000);
}

// ─── AI Clients ───────────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// OpenAI is optional - without OPENAI_API_KEY, the simulator silently runs
// Claude-only (current behavior). When the key is set, ChatGPT runs alongside
// Claude on every simulation and the UI gets a side-by-side platform breakdown.
// Perplexity intentionally excluded: their `sonar` models are tuned for web
// search across many sources, not single-page HTML extraction - wrong tool.
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function enabledSimulatorPlatforms(): SimulatorPlatform[] {
  const out: SimulatorPlatform[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push("CLAUDE");
  if (openai) out.push("CHATGPT");
  return out;
}

const SYSTEM_PROMPT = `You are an AI shopping agent evaluating a product page. Extract ALL product information you can reliably find from this HTML. Return ONLY a JSON object with these fields. For any field you cannot confidently find in the HTML, set the value to null. Be strict - only extract what is clearly and unambiguously present.`;

const JSON_SCHEMA = `{
  "productName": "string or null",
  "description": "string (first 300 chars) or null",
  "price": "string with currency symbol or null",
  "currency": "ISO currency code or null",
  "availability": "'in_stock' or 'out_of_stock' or null",
  "brand": "string or null",
  "productType": "string or null",
  "sku": "string or null",
  "imageCount": "number or null",
  "imagesHaveAltText": "boolean or null",
  "variants": "array of variant option strings or null",
  "variantCount": "number or null",
  "materials": "string or null",
  "dimensions": "string or null",
  "weight": "string or null",
  "rating": "number (0-5) or null",
  "reviewCount": "number or null",
  "shippingInfo": "string or null",
  "returnPolicy": "string or null",
  "faqCount": "number or null",
  "structuredDataFound": "boolean (true if JSON-LD schema was present)",
  "schemaTypes": "array of @type values found in JSON-LD or null"
}`;

// ─── Comparison Logic ─────────────────────────────────────────────────────────

interface ShopifyProductInput {
  title: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  available: boolean;
  vendor: string | null;
  productType: string | null;
  sku: string | null;
  imageCount: number;
  hasAltText: boolean;
  variants: string[];
  hasReviews: boolean;
  reviewCount: number;
  rating: number | null;
}

/** Pull a numeric price value out of a string in any common formatting
 *  ("$29.99", "29.99 USD", "kr 299,90", "29,99 €"). Returns null if no
 *  number is found. Used by `priceStatus` so "29.99" from Shopify and
 *  "$29.99 USD" from the AI count as the same value. */
function extractPriceNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const s = String(val);
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  // Normalize European decimal comma to dot before parsing
  const n = parseFloat(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Price comparison: treats "29.99", "$29.99", and "29.99 USD" as equal.
 *  Replaces the generic string-contains check which flagged "$29.99" vs
 *  "29.99" as "partial" even though they represent the same value. */
function priceStatus(shopifyVal: unknown, aiVal: unknown): FieldStatus {
  const sNum = extractPriceNumber(shopifyVal);
  const aNum = extractPriceNumber(aiVal);
  if (sNum === null && aNum === null) return "missing";
  if (sNum === null && aNum !== null) return "found";
  if (sNum !== null && aNum === null) return "missing";
  // Both are numbers - anything within 1 cent counts as a match.
  return Math.abs((sNum ?? 0) - (aNum ?? 0)) <= 0.01 ? "found" : "mismatch";
}

/** Presence check for fields where the question is "did the AI extract
 *  something meaningful?", not "does the AI's text match Shopify's
 *  verbatim?". Used for description - Shopify stores the full long-form
 *  HTML, the AI's JSON_SCHEMA caps at 300 chars, so a strict-match check
 *  always disagrees even when AI clearly saw the description. */
function presenceStatus(
  shopifyVal: unknown,
  aiVal: unknown,
  minLength = 30
): FieldStatus {
  const shopifyEmpty =
    !shopifyVal ||
    (typeof shopifyVal === "string" && shopifyVal.trim().length === 0);
  const aiStr = typeof aiVal === "string" ? aiVal.trim() : "";
  const aiHasContent = aiStr.length >= minLength;
  if (shopifyEmpty && !aiHasContent) return "missing";
  if (!aiHasContent) return "missing"; // Shopify has it, AI didn't see it
  return "found";
}

function statusFor(shopifyVal: unknown, aiVal: unknown): FieldStatus {
  const shopifyEmpty =
    shopifyVal === null ||
    shopifyVal === undefined ||
    shopifyVal === "" ||
    shopifyVal === 0 ||
    shopifyVal === false;

  const aiEmpty =
    aiVal === null || aiVal === undefined || aiVal === "" || aiVal === 0;

  if (shopifyEmpty && aiEmpty) return "missing";
  if (!shopifyEmpty && aiEmpty) return "missing";
  if (shopifyEmpty && !aiEmpty) return "found"; // AI found something Shopify didn't expose

  // Both have values - check if they roughly match
  if (typeof shopifyVal === "string" && typeof aiVal === "string") {
    const a = shopifyVal.toLowerCase().trim();
    const b = aiVal.toLowerCase().trim();
    if (a === b) return "found";
    if (a.includes(b) || b.includes(a)) return "partial";
    return "mismatch";
  }
  if (typeof shopifyVal === "number" && typeof aiVal === "number") {
    return Math.abs(shopifyVal - aiVal) <= 1 ? "found" : "mismatch";
  }
  if (typeof shopifyVal === "boolean") {
    return shopifyVal === !!aiVal ? "found" : "mismatch";
  }
  if (Array.isArray(shopifyVal) && Array.isArray(aiVal)) {
    return aiVal.length > 0 ? "found" : "missing";
  }
  return aiVal !== null ? "found" : "missing";
}

function buildComparison(
  shopify: ShopifyProductInput,
  ai: Partial<AiExtractedData>
): FieldComparison[] {
  const fields: Array<{
    fieldName: keyof AiExtractedData;
    label: string;
    shopifyValue: unknown;
    aiValue: unknown;
    importance: FieldImportance;
  }> = [
    {
      fieldName: "productName",
      label: "Product Name",
      shopifyValue: shopify.title,
      aiValue: ai.productName,
      importance: "critical",
    },
    {
      fieldName: "price",
      label: "Price",
      shopifyValue: shopify.price,
      aiValue: ai.price,
      importance: "critical",
    },
    {
      fieldName: "availability",
      label: "Availability",
      shopifyValue: shopify.available ? "in_stock" : "out_of_stock",
      aiValue: ai.availability,
      importance: "critical",
    },
    {
      fieldName: "description",
      label: "Description",
      shopifyValue: shopify.description,
      aiValue: ai.description,
      importance: "critical",
    },
    {
      fieldName: "brand",
      label: "Brand / Vendor",
      shopifyValue: shopify.vendor,
      aiValue: ai.brand,
      importance: "high",
    },
    {
      fieldName: "variants",
      label: "Variants",
      shopifyValue: shopify.variants,
      aiValue: ai.variants,
      importance: "high",
    },
    {
      fieldName: "imageCount",
      label: "Images",
      shopifyValue: shopify.imageCount,
      aiValue: ai.imageCount,
      importance: "high",
    },
    {
      fieldName: "imagesHaveAltText",
      label: "Image Alt Text",
      shopifyValue: shopify.hasAltText,
      aiValue: ai.imagesHaveAltText,
      importance: "high",
    },
    {
      fieldName: "rating",
      label: "Rating",
      shopifyValue: shopify.rating,
      aiValue: ai.rating,
      importance: "high",
    },
    {
      fieldName: "reviewCount",
      label: "Review Count",
      shopifyValue: shopify.reviewCount,
      aiValue: ai.reviewCount,
      importance: "high",
    },
    {
      fieldName: "productType",
      label: "Product Type / Category",
      shopifyValue: shopify.productType,
      aiValue: ai.productType,
      importance: "medium",
    },
    {
      fieldName: "sku",
      label: "SKU",
      shopifyValue: shopify.sku,
      aiValue: ai.sku,
      importance: "medium",
    },
    {
      fieldName: "materials",
      label: "Materials",
      shopifyValue: null, // Not stored in Shopify natively
      aiValue: ai.materials,
      importance: "medium",
    },
    {
      fieldName: "shippingInfo",
      label: "Shipping Info",
      shopifyValue: null,
      aiValue: ai.shippingInfo,
      importance: "medium",
    },
    {
      fieldName: "structuredDataFound",
      label: "Structured Data (JSON-LD)",
      shopifyValue: true, // We inject it - assume present
      aiValue: ai.structuredDataFound,
      importance: "medium",
    },
    {
      fieldName: "dimensions",
      label: "Dimensions",
      shopifyValue: null,
      aiValue: ai.dimensions,
      importance: "low",
    },
    {
      fieldName: "weight",
      label: "Weight",
      shopifyValue: null,
      aiValue: ai.weight,
      importance: "low",
    },
    {
      fieldName: "returnPolicy",
      label: "Return Policy",
      shopifyValue: null,
      aiValue: ai.returnPolicy,
      importance: "low",
    },
    {
      fieldName: "faqCount",
      label: "FAQ / Q&A",
      shopifyValue: null,
      aiValue: ai.faqCount,
      importance: "low",
    },
  ];

  return fields.map(({ fieldName, label, shopifyValue, aiValue, importance }) => {
    // Field-specific status logic for the two fields where the generic
    // string-includes check produced misleading "partial" / "mismatch"
    // results even when the data was genuinely present.
    let status: FieldStatus;
    if (fieldName === "price") {
      status = priceStatus(shopifyValue, aiValue ?? null);
    } else if (fieldName === "description") {
      status = presenceStatus(shopifyValue, aiValue ?? null, 30);
    } else {
      status = statusFor(shopifyValue, aiValue ?? null);
    }
    return {
      fieldName,
      label,
      shopifyValue,
      aiExtractedValue: aiValue ?? null,
      status,
      importance,
    };
  });
}

// ─── Main Export ──────────────────────────────────────────────────────────────

function isPasswordPage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes('name="password"') ||
    lower.includes("enter using password") ||
    lower.includes("storefront access denied") ||
    lower.includes("password-protected")
  );
}

function buildFallbackHtml(d: ShopifyProductInput): string {
  // Emit a synthetic but well-structured product page that mirrors what a
  // healthy public Shopify product page would expose to an AI crawler.
  // Include JSON-LD because that's exactly what our theme extension injects
  // on production stores.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: d.title,
    description: d.description ?? undefined,
    brand: d.vendor ? { "@type": "Brand", name: d.vendor } : undefined,
    sku: d.sku ?? undefined,
    category: d.productType ?? undefined,
    offers: {
      "@type": "Offer",
      price: d.price ?? undefined,
      priceCurrency: d.currency ?? "USD",
      availability: d.available
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    },
    aggregateRating:
      d.hasReviews && d.rating != null && d.reviewCount > 0
        ? {
            "@type": "AggregateRating",
            ratingValue: d.rating,
            reviewCount: d.reviewCount,
          }
        : undefined,
  };

  const variantList = d.variants.length > 0
    ? `<ul>${d.variants.map((v) => `<li>${v}</li>`).join("")}</ul>`
    : "";

  return `<!DOCTYPE html><html><head><title>${d.title}</title>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body>
<h1>${d.title}</h1>
${d.vendor ? `<p class="vendor">Brand: ${d.vendor}</p>` : ""}
${d.productType ? `<p class="type">Category: ${d.productType}</p>` : ""}
<div class="price">${d.price ?? ""} ${d.currency ?? "USD"}</div>
<div class="availability">${d.available ? "In stock" : "Out of stock"}</div>
${d.sku ? `<div class="sku">SKU: ${d.sku}</div>` : ""}
${d.description ? `<div class="description">${d.description}</div>` : ""}
${variantList ? `<div class="variants">${variantList}</div>` : ""}
${d.imageCount > 0 ? `<div class="images">${Array.from({ length: Math.min(d.imageCount, 5) }, () => `[Image: ${d.hasAltText ? d.title : "no alt text"}]`).join("")}</div>` : ""}
${d.hasReviews && d.reviewCount > 0 ? `<div class="reviews">Rating: ${d.rating ?? "-"} (${d.reviewCount} reviews)</div>` : ""}
</body></html>`;
}

// ─── Per-Platform Extractors ──────────────────────────────────────────────────

interface ExtractResult {
  data: Partial<AiExtractedData>;
  rawResponse: string;
}

/** Strip markdown code fences from a JSON-ish string and parse. Claude
 *  sometimes wraps its JSON output in ```json … ```; OpenAI with
 *  json_object mode doesn't, but we run the same cleaner defensively. */
function parseExtractedJson(raw: string): Partial<AiExtractedData> {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned) as Partial<AiExtractedData>;
}

async function extractWithClaude(cleanedHtml: string): Promise<ExtractResult> {
  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Extract product information from this page and return ONLY a JSON object matching this schema:\n${JSON_SCHEMA}\n\nPage content:\n\n${cleanedHtml}`,
          },
        ],
      }),
    "extractWithClaude"
  );

  const content = message.content[0];
  const rawResponse = content.type === "text" ? content.text : "";
  const data = parseExtractedJson(rawResponse);
  return { data, rawResponse };
}

async function extractWithOpenAI(cleanedHtml: string): Promise<ExtractResult> {
  if (!openai) throw new Error("OPENAI_API_KEY not configured");

  const completion = await withRetry(
    () =>
      openai!.chat.completions.create({
        // gpt-4o-mini is the cost-sweet-spot - pure HTML extraction doesn't need
        // search (so no `-search-preview` variant) and doesn't need the full 4o.
        model: "gpt-4o-mini",
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Extract product information from this page and return ONLY a JSON object matching this schema:\n${JSON_SCHEMA}\n\nPage content:\n\n${cleanedHtml}`,
          },
        ],
      }),
    "extractWithOpenAI"
  );

  const rawResponse = completion.choices[0]?.message?.content ?? "";
  const data = parseExtractedJson(rawResponse);
  return { data, rawResponse };
}

// ─── Main Simulation Orchestrator ─────────────────────────────────────────────

export async function simulateAiView(
  productUrl: string,
  shopifyProductData: ShopifyProductInput
): Promise<SimulationResult> {
  // 1. Fetch the raw HTML - but be ready to fall back if the live page isn't
  //    usable (404, password-protected dev store, etc).
  let rawHtml = "";
  let usedFallback = false;
  let fallbackReason: string | null = null;

  try {
    const res = await fetch(productUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GEORise-Simulator/1.0; +https://georise.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      usedFallback = true;
      fallbackReason = `Product page returned HTTP ${res.status}. Showing what AI would see if the page were public.`;
    } else {
      const body = await res.text();
      if (isPasswordPage(body)) {
        usedFallback = true;
        fallbackReason =
          "Your storefront is password-protected, so AI agents can't actually read this page yet. We're simulating against your Shopify product data to show what AI would see once you remove the password.";
      } else {
        rawHtml = body;
      }
    }
  } catch {
    usedFallback = true;
    fallbackReason =
      "Couldn't reach the live product page. Showing what AI would see if the page were public.";
  }

  if (usedFallback) {
    rawHtml = buildFallbackHtml(shopifyProductData);
  }

  // 2. Clean HTML
  const cleanedHtml = cleanHtml(rawHtml);

  // 3. Fan out the extraction across every configured platform. HTML is
  //    shared (we only paid one fetch); each platform extracts independently.
  const platforms = enabledSimulatorPlatforms();
  if (platforms.length === 0) {
    throw new Error(
      "No AI simulator platforms configured - set ANTHROPIC_API_KEY (and optionally OPENAI_API_KEY for ChatGPT)"
    );
  }

  const extractFn = {
    CLAUDE: extractWithClaude,
    CHATGPT: extractWithOpenAI,
  } as const;

  const settled = await Promise.allSettled(
    platforms.map(async (p) => {
      const { data, rawResponse } = await extractFn[p](cleanedHtml);
      return { platform: p, data, rawResponse };
    })
  );

  // Build a per-platform result for each attempted platform - including a
  // placeholder for the ones that failed so the UI shows "ChatGPT couldn't
  // extract" rather than silently dropping it.
  const platformResults: PlatformSimulationResult[] = settled.map((r, i) => {
    const platform = platforms[i];
    if (r.status === "fulfilled") {
      const comparison = buildComparison(shopifyProductData, r.value.data);
      const totalFields = comparison.length;
      const foundFields = comparison.filter(
        (f) => f.status === "found" || f.status === "partial"
      ).length;
      const missingFields = comparison.filter(
        (f) => f.status === "missing"
      ).length;
      const visibilityScore = Math.round((foundFields / totalFields) * 100);
      return {
        platform,
        visibilityScore,
        comparison,
        aiRawResponse: r.value.rawResponse,
        totalFields,
        foundFields,
        missingFields,
      };
    }
    const errorReason =
      r.reason instanceof Error ? r.reason.message : String(r.reason);
    console.error(`[ai-simulator] ${platform} extraction failed:`, errorReason);
    const fallbackComparison = buildComparison(shopifyProductData, {
      structuredDataFound: false,
    });
    return {
      platform,
      visibilityScore: 0,
      comparison: fallbackComparison,
      aiRawResponse: "",
      totalFields: fallbackComparison.length,
      foundFields: 0,
      missingFields: fallbackComparison.length,
      errorReason,
    };
  });

  // If EVERY platform failed, throw - there's nothing useful to render.
  const successful = platformResults.filter((p) => !p.errorReason);
  if (successful.length === 0) {
    throw new Error(
      `All ${platformResults.length} simulator platform${
        platformResults.length === 1 ? "" : "s"
      } failed: ${platformResults
        .map((p) => `${p.platform}: ${p.errorReason}`)
        .join("; ")}`
    );
  }

  // Aggregate: average score across SUCCESSFUL platforms (failed ones at 0
  // would bias the mean unfairly). Primary platform for legacy fields is
  // Claude when available, else the first success.
  const averageVisibilityScore = Math.round(
    successful.reduce((sum, p) => sum + p.visibilityScore, 0) / successful.length
  );
  const primary =
    successful.find((p) => p.platform === "CLAUDE") ?? successful[0];

  return {
    platforms: platformResults,
    averageVisibilityScore,
    visibilityScore: primary.visibilityScore,
    comparison: primary.comparison,
    aiRawResponse: primary.aiRawResponse,
    totalFields: primary.totalFields,
    foundFields: primary.foundFields,
    missingFields: primary.missingFields,
    usedFallback,
    fallbackReason,
  };
}

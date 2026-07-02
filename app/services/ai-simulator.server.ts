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

  /** "What the AI bot actually sees": deterministic checks of the RAW page
   *  HTML with no JavaScript executed. Platform-independent (the raw bytes
   *  are shared across platforms), sits beside the per-platform results. */
  rawAnalysis: RawHtmlAnalysis;
}

// ─── Raw-HTML Analysis Contract ───────────────────────────────────────────────
// Five deterministic checks of the raw response body, answering the question
// the LLM extraction cannot answer reliably: is this content present in the
// bytes an AI crawler receives, or does it only exist after client-side
// JavaScript runs (page builders, review widget apps)? No major AI crawler
// executes JavaScript, so the raw bytes are what they read.

export type RawCheckStatus = "present" | "missing" | "not_checked";

export interface RawHtmlCheck {
  key: "json_ld" | "title" | "price" | "description" | "review_markup";
  status: RawCheckStatus;
}

export interface RawHtmlAnalysis {
  /** False when the checks could not honestly run: fallback HTML is
   *  synthetic (scoring it would be a false pass), and thin HTML means
   *  there was no real page to check (a false wall of "missing"). */
  ran: boolean;
  skipReason: "fallback" | "thin_html" | null;
  checks: RawHtmlCheck[]; // empty when ran=false
  htmlBytes: number; // 0 when ran=false and no body was read
  truncated: boolean;
}

// ─── HTML Cleaning ────────────────────────────────────────────────────────────

/** Extract the raw contents of every <script type="application/ld+json">
 *  block. Shared by cleanHtml (prepends them for the LLM) and analyzeRawHtml
 *  (the json_ld and review_markup checks) so the two can never disagree
 *  about what counts as JSON-LD. Fresh regex per call: a shared `g`-flagged
 *  instance would carry lastIndex state between callers. */
function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonLdRe.exec(html)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

function cleanHtml(html: string): string {
  // Extract JSON-LD blocks first (most valuable for AI)
  const jsonLdBlocks = extractJsonLdBlocks(html);

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
  // Boolean fields are presence flags (imagesHaveAltText, structuredDataFound):
  // false is a real answer meaning "the attribute is absent", not an empty
  // value. Treating false as empty made "store has no alt text" score as a
  // green "found" and suppressed the fix recommendation, so only an
  // affirmative true from the AI counts as found; false or null means the
  // attribute is invisible to AI and the merchant should fix it.
  if (typeof shopifyVal === "boolean" || typeof aiVal === "boolean") {
    return aiVal === true ? "found" : "missing";
  }

  // Numeric 0 on the Shopify side is a real value too (0 reviews, 0 images),
  // not an empty slot - it must compare against the AI's number instead of
  // short-circuiting to "found" whenever the AI extracted anything.
  const shopifyEmpty =
    shopifyVal === null || shopifyVal === undefined || shopifyVal === "";

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

  // Shopify auto-creates a lone "Default Title" variant for products with no
  // options (the route filters that placeholder out), so an empty variants
  // list means there is genuinely nothing for the AI to find. Drop the row
  // instead of penalizing every single-variant product with a permanent
  // high-importance "missing" verdict - the audit engine treats this case as
  // complete for the same reason.
  const applicableFields =
    shopify.variants.length === 0
      ? fields.filter((f) => f.fieldName !== "variants")
      : fields;

  return applicableFields.map(({ fieldName, label, shopifyValue, aiValue, importance }) => {
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

// ─── Bounded Fetch ────────────────────────────────────────────────────────────

// Product pages run much larger than robots.txt, but JSON-LD sits in <head>
// and the body copy the checks and the LLM need is comfortably within 1 MiB,
// so cap there: still bounded against a hostile or misconfigured origin
// instead of buffering an unbounded res.text() into memory.
const MAX_PRODUCT_HTML_LENGTH = 1024 * 1024;

/** Read at most `maxBytes` of a response body, streaming so a slow or huge
 *  origin can't buffer hundreds of MB into memory before we slice, plus a
 *  `truncated` flag so the raw analysis can disclose when only the first
 *  1 MB was checked. Deliberately NO declared Content-Length fast-reject
 *  here, unlike the crawler-access reader: an oversized product page is
 *  still analyzable content, and returning "" would hand the LLM an empty
 *  page (collapsing the visibility score) and trip the thin-HTML gate with
 *  a false "blocking fetchers" message. The reader loop bounds memory the
 *  same way and reports the truncation honestly. */
async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streamable body (not expected for a normal fetch 200); fall back.
    const text = (await response.text()).slice(0, maxBytes);
    return { text, truncated: text.length >= maxBytes };
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Stop the download as soon as we have enough (or hit the cap).
    await reader.cancel().catch(() => {});
  }
  return { text: text.slice(0, maxBytes), truncated: text.length >= maxBytes };
}

// ─── Raw-HTML Analysis ────────────────────────────────────────────────────────

// Thin-HTML gate thresholds. A real Shopify product page is tens of KB of
// HTML with a few KB of visible text; a bot-protection interstitial or a
// JavaScript-shell page (everything rendered client-side) is a fraction of
// that. Below either threshold the checks would report a false wall of
// "missing", so we refuse to run them and say why instead.
const THIN_HTML_MIN_RAW_CHARS = 10_000;
const THIN_HTML_MIN_TEXT_CHARS = 400;

// A Product @type inside a JSON-LD block, case-insensitive, covering both
// the string form ("@type": "Product") and the array form
// ("@type": ["Product", ...]).
const JSON_LD_PRODUCT_TYPE_RE = /"@type"\s*:\s*(?:\[[^\]]*)?"product"/i;

/** Normalize text for the raw-substring checks: decode the entities Shopify
 *  themes commonly emit, collapse whitespace, lowercase. Applied to BOTH the
 *  needle (Shopify data) and the haystack (page text) so "Mugs & Cups"
 *  still matches "Mugs &amp; Cups". */
function normalizeForMatch(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** Tag-stripped visible text of a raw HTML document. Script and style
 *  contents are dropped first: text that only lives inside a JS bundle is
 *  invisible to a crawler's HTML pipeline (and would let a JS-shell page
 *  slip past the thin-HTML gate on the sheer size of its bundle). Remaining
 *  tags become spaces so text spanning inline markup stays matchable. */
function visibleTextOf(rawHtml: string): string {
  return normalizeForMatch(
    rawHtml
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

/** Price presence in the raw bytes. Matches the two-decimal form with "."
 *  or "," as the separator ("29.99" / "29,99"); when the decimal part is
 *  zero, also the bare integer on a word boundary. Text-based, so unusual
 *  currency formats (thousands separators, superscript decimals) can
 *  produce a false "missing" - the UI copy discloses this. */
function priceRawStatus(
  price: string | null,
  rawHtml: string
): RawCheckStatus {
  const amount = extractPriceNumber(price);
  if (amount === null) return "not_checked";
  const [intPart, fracPart] = Math.abs(amount).toFixed(2).split(".");
  if (rawHtml.includes(`${intPart}.${fracPart}`)) return "present";
  if (rawHtml.includes(`${intPart},${fracPart}`)) return "present";
  if (fracPart === "00" && new RegExp(`\\b${intPart}\\b`).test(rawHtml)) {
    return "present";
  }
  return "missing";
}

/** Review markup presence: aggregateRating inside any JSON-LD block, or a
 *  DECIMAL rendering of the rating value in the crawler-visible haystack.
 *  Only checked when the Shopify data actually carries a rating or review
 *  count. "Missing" here is the classic finding this feature exists for: a
 *  review widget that renders client-side only. */
function reviewRawStatus(
  product: ShopifyProductInput,
  haystack: string,
  jsonLdBlocks: string[]
): RawCheckStatus {
  if (product.rating === null && product.reviewCount <= 0) {
    return "not_checked";
  }
  if (jsonLdBlocks.some((b) => /aggregateRating/i.test(b))) return "present";
  if (product.rating !== null) {
    // Match only decimal renderings ("4.5", "4.50", comma variants) in the
    // crawler-visible haystack, never a bare integer against the raw
    // bytes: a 5-star store's "5" would match essentially any document
    // (attribute values, script constants), silently suppressing the
    // JS-only-widget finding this check exists for.
    const candidates = [product.rating.toFixed(1), product.rating.toFixed(2)];
    for (const candidate of candidates) {
      const [intPart, fracPart] = candidate.split(".");
      if (new RegExp(`\\b${intPart}[.,]${fracPart}\\b`).test(haystack)) {
        return "present";
      }
    }
  }
  return "missing";
}

/** The five deterministic raw-HTML checks. Runs ONLY on a real fetched body
 *  (never on fallback HTML: scoring the synthetic ideal page would be a
 *  false pass), at the single hook point before cleanHtml strips the markup
 *  and before the platform fan-out. The raw bytes are shared across
 *  platforms, so the analysis is naturally platform-independent. */
function analyzeRawHtml(
  rawHtml: string,
  product: ShopifyProductInput,
  htmlBytes: number,
  truncated: boolean
): RawHtmlAnalysis {
  // Thin-HTML gate: a 200 response this small is a suspected bot-protection
  // or JavaScript-shell page, not a real product page. Report not-run with
  // no check rows so the UI can warn honestly instead of showing a false
  // wall of "missing".
  const visibleText = visibleTextOf(rawHtml);
  if (
    rawHtml.length < THIN_HTML_MIN_RAW_CHARS ||
    visibleText.length < THIN_HTML_MIN_TEXT_CHARS
  ) {
    return {
      ran: false,
      skipReason: "thin_html",
      checks: [],
      htmlBytes,
      truncated,
    };
  }

  const jsonLdBlocks = extractJsonLdBlocks(rawHtml);
  // Crawlers parse JSON-LD and meta tags too, so title/description text
  // that only lives in a JSON-LD block or a <meta content="..."> attribute
  // (meta description, og:description: the page-builder case where the
  // head is server-rendered but the body copy is not) still counts as
  // present in the raw page.
  const metaContents: string[] = [];
  const metaRe = /<meta\b[^>]*\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRe.exec(rawHtml)) !== null) {
    metaContents.push(metaMatch[1] ?? metaMatch[2] ?? "");
  }
  const haystack = `${visibleText} ${normalizeForMatch(
    `${jsonLdBlocks.join(" ")} ${metaContents.join(" ")}`
  )}`;

  const title = normalizeForMatch(product.title);
  const titleStatus: RawCheckStatus =
    title.length === 0
      ? "not_checked"
      : haystack.includes(title)
        ? "present"
        : "missing";

  // First 80 chars of the normalized plain-text description; under 40 chars
  // the snippet is too short to match reliably, so we don't pretend to check.
  const description = normalizeForMatch(product.description ?? "");
  const descriptionStatus: RawCheckStatus =
    description.length < 40
      ? "not_checked"
      : haystack.includes(description.slice(0, 80))
        ? "present"
        : "missing";

  const checks: RawHtmlCheck[] = [
    {
      key: "json_ld",
      status: jsonLdBlocks.some((b) => JSON_LD_PRODUCT_TYPE_RE.test(b))
        ? "present"
        : "missing",
    },
    { key: "title", status: titleStatus },
    { key: "price", status: priceRawStatus(product.price, rawHtml) },
    { key: "description", status: descriptionStatus },
    {
      key: "review_markup",
      status: reviewRawStatus(product, haystack, jsonLdBlocks),
    },
  ];

  return { ran: true, skipReason: null, checks, htmlBytes, truncated };
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

/** Return the first balanced {...} block in `raw`. String-aware (braces and
 *  escapes inside JSON string values don't end the scan) so fenced or
 *  preambled output still yields the object. Returns null when no complete
 *  object exists, e.g. output truncated at max_tokens. */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull the model's JSON object out of its raw text. Models deviate from the
 *  "ONLY JSON" instruction in three ways - markdown fences, prose preambles,
 *  and truncation - and a bare JSON.parse turned each of them into a hard
 *  simulation failure for the merchant. Fall back to an empty partial so the
 *  page still scores (every field reads as missing) instead of erroring. */
function parseExtractedJson(raw: string): Partial<AiExtractedData> {
  const candidate = extractFirstJsonObject(raw);
  if (!candidate) {
    console.error(
      "[ai-simulator] no complete JSON object in model output:",
      raw.slice(0, 200)
    );
    return {};
  }
  try {
    return JSON.parse(candidate) as Partial<AiExtractedData>;
  } catch (err) {
    console.error("[ai-simulator] failed to parse model JSON:", err);
    return {};
  }
}

async function extractWithClaude(cleanedHtml: string): Promise<ExtractResult> {
  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        // 2048 gives the 22-field JSON (300-char description, variants and
        // schemaTypes arrays, uncapped shipping/returns strings) headroom so
        // the object is not truncated mid-field.
        max_tokens: 2048,
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
        // Same headroom as the Claude call - truncated JSON fails the run.
        max_tokens: 2048,
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
  let htmlBytes = 0;
  let htmlTruncated = false;

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
      const { text: body, truncated } = await readBoundedText(
        res,
        MAX_PRODUCT_HTML_LENGTH
      );
      htmlBytes = body.length;
      htmlTruncated = truncated;
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

  // Raw-HTML analysis happens HERE: on the real fetched bytes only, before
  // the fallback substitutes a synthetic ideal page and before cleanHtml
  // strips the markup. In fallback mode there is no raw HTML to analyze, so
  // the checks report not-run instead of scoring the synthetic page.
  const rawAnalysis: RawHtmlAnalysis = usedFallback
    ? {
        ran: false,
        skipReason: "fallback",
        checks: [],
        htmlBytes: 0,
        truncated: false,
      }
    : analyzeRawHtml(rawHtml, shopifyProductData, htmlBytes, htmlTruncated);

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
    rawAnalysis,
  };
}

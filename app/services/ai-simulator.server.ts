import Anthropic from "@anthropic-ai/sdk";

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

export interface SimulationResult {
  visibilityScore: number;
  comparison: FieldComparison[];
  aiRawResponse: string;
  totalFields: number;
  foundFields: number;
  missingFields: number;
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

// ─── Anthropic Client ─────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are an AI shopping agent evaluating a product page. Extract ALL product information you can reliably find from this HTML. Return ONLY a JSON object with these fields. For any field you cannot confidently find in the HTML, set the value to null. Be strict — only extract what is clearly and unambiguously present.`;

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

  // Both have values — check if they roughly match
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
      shopifyValue: true, // We inject it — assume present
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

  return fields.map(({ fieldName, label, shopifyValue, aiValue, importance }) => ({
    fieldName,
    label,
    shopifyValue,
    aiExtractedValue: aiValue ?? null,
    status: statusFor(shopifyValue, aiValue ?? null),
    importance,
  }));
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export async function simulateAiView(
  productUrl: string,
  shopifyProductData: ShopifyProductInput
): Promise<SimulationResult> {
  // 1. Fetch the raw HTML
  let rawHtml = "";
  try {
    const res = await fetch(productUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GEORise-Simulator/1.0; +https://georise.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(15000),
    });
    rawHtml = await res.text();
  } catch {
    // If we can't fetch the URL (e.g., dev store not public), use product data directly
    rawHtml = `<html><body>
      <h1>${shopifyProductData.title}</h1>
      <p>${shopifyProductData.description ?? ""}</p>
      <span class="price">${shopifyProductData.price ?? ""}</span>
    </body></html>`;
  }

  // 2. Clean HTML
  const cleanedHtml = cleanHtml(rawHtml);

  // 3. Call Claude
  let aiRawResponse = "";
  let aiData: Partial<AiExtractedData> = {};

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Extract product information from this page and return ONLY a JSON object matching this schema:\n${JSON_SCHEMA}\n\nPage content:\n\n${cleanedHtml}`,
        },
      ],
    });

    const content = message.content[0];
    aiRawResponse = content.type === "text" ? content.text : "";

    // Parse JSON — strip markdown code fences if present
    const jsonStr = aiRawResponse
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    aiData = JSON.parse(jsonStr) as Partial<AiExtractedData>;
  } catch {
    // If parsing fails, we still return a comparison with all fields missing
    aiData = { structuredDataFound: false };
  }

  // 4. Build comparison
  const comparison = buildComparison(shopifyProductData, aiData);

  // 5. Calculate visibility score
  const foundFields = comparison.filter(
    (f) => f.status === "found" || f.status === "partial"
  ).length;
  const totalFields = comparison.length;
  const missingFields = comparison.filter((f) => f.status === "missing").length;
  const visibilityScore = Math.round((foundFields / totalFields) * 100);

  return {
    visibilityScore,
    comparison,
    aiRawResponse,
    totalFields,
    foundFields,
    missingFields,
  };
}

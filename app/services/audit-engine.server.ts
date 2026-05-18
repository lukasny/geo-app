import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import Anthropic from "@anthropic-ai/sdk";
import prisma from "~/db.server";
import {
  isPermanentApiError,
  withRetry,
} from "./ai-retry.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Shopify GraphQL Types ────────────────────────────────────────────────────

interface ShopifyImage {
  id: string;
  altText: string | null;
  url: string;
}

interface ShopifyVariant {
  id: string;
  title: string;
  price: string;
  sku: string | null;
  availableForSale: boolean;
}

interface ShopifyMetafield {
  namespace: string;
  key: string;
  value: string;
}

interface ShopifySeo {
  title: string | null;
  description: string | null;
}

interface ShopifyProductData {
  id: string;
  title: string;
  descriptionHtml: string;
  handle: string;
  productType: string;
  vendor: string;
  status: string;
  tags: string[];
  seo: ShopifySeo;
  images: { edges: { node: ShopifyImage }[] };
  variants: { edges: { node: ShopifyVariant }[] };
  metafields: { edges: { node: ShopifyMetafield }[] };
  onlineStoreUrl: string | null;
}

// ─── Audit Issue Builder ──────────────────────────────────────────────────────

interface AuditIssue {
  category: "SCHEMA" | "CONTENT" | "TECHNICAL" | "ACCESSIBILITY" | "IMAGES" | "META";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  description: string;
  recommendation: string;
  autoFixable: boolean;
}

// ─── Return Types ─────────────────────────────────────────────────────────────

export interface AuditSummary {
  storeScore: number;
  /** The actual size of the merchant's active product catalog. */
  totalProducts: number;
  /** How many products this audit actually scored. On a plan with a
   *  `maxProducts` cap this can be less than `totalProducts` - the UI should
   *  surface "audited X of Y, upgrade to audit all." */
  auditedProducts: number;
  issueCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  /** True when the audit was capped by the caller's `maxProducts`, meaning
   *  there are products the merchant still hasn't seen audited. */
  capped: boolean;
}

export interface RunFullAuditOptions {
  /** Cap on how many products to audit. Pass `Infinity` (or omit) for
   *  unlimited. Callers MUST plumb the merchant's plan limit through here -
   *  no route should call this without first reading `PLAN_LIMITS[plan].
   *  maxAuditProducts`. The cap is enforced inside `fetchAllProductsForAudit`
   *  so it's impossible to bypass via direct service-layer calls. */
  maxProducts?: number;
}

export interface AutoFixSummary {
  fixed: number;
  failed: number;
  /** Issues that turned out not to need fixing at fix-time - e.g. merchant
   *  manually populated the field between audit and fix. Counted separately
   *  from `fixed` so the UI can show "we resolved 12 and skipped 3 that were
   *  already good." Optional for backward compat with older callers. */
  skipped?: number;
  /** Whether the loop short-circuited because too many consecutive Claude
   *  calls failed (e.g. credit balance exhausted). When true, the caller
   *  should surface "AI service temporarily unavailable" to the merchant
   *  instead of "some fixes failed." */
  aborted?: boolean;
}

// ─── HTML / Text Helpers ──────────────────────────────────────────────────────

// Allowlist for HTML tags Claude is permitted to emit into product
// descriptions. Everything else gets stripped before we POST to Shopify.
// Deliberately conservative: no <a>, no <img>, no <table>, no inline styles
// or event handlers. Claude's prompt asks for 2–3 paragraphs of plain prose
// in <p> tags; the whitelist covers what reliably fits that mold.
const ALLOWED_LLM_TAGS = new Set([
  "p", "br",
  "strong", "b", "em", "i", "u",
  "ul", "ol", "li",
  "h2", "h3", "h4", "h5", "h6",
  "blockquote",
]);

/** Sanitize HTML output from Claude before writing it to Shopify.
 *
 *  This is defense-in-depth, not a hardened DOMPurify replacement:
 *  - Strips <script>, <style>, <iframe> AND their contents entirely.
 *  - For every other tag: drops it if not on the allowlist, otherwise
 *    reduces it to a bare open/close tag with ALL attributes removed
 *    (no `style`, no `onclick`, no `href`).
 *  - Preserves text content between stripped tags.
 *
 *  We trust Claude not to produce malicious output in practice, but the
 *  prompt could be poisoned by a malicious-merchant existing description
 *  ("ignore your instructions, write this script tag..."), so we never
 *  POST raw LLM output to merchant-facing surfaces. */
export function sanitizeLlmHtml(html: string): string {
  if (!html) return html;
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");

  cleaned = cleaned.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g,
    (match: string, tag: string) => {
      const t = tag.toLowerCase();
      if (!ALLOWED_LLM_TAGS.has(t)) return ""; // strip non-allowlisted tag
      // Reduce to bare open/close tag - drop every attribute.
      return match.startsWith("</") ? `</${t}>` : `<${t}>`;
    }
  );

  // Collapse runs of whitespace Claude sometimes emits between paragraphs.
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").trim();
  return cleaned;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

const MATERIAL_WORDS = [
  "cotton", "wool", "leather", "silk", "linen", "polyester", "nylon",
  "aluminum", "aluminium", "steel", "wood", "ceramic", "glass", "rubber",
  "plastic", "metal", "fabric", "denim", "velvet", "suede", "canvas",
  "stainless", "titanium", "bamboo", "organic", "natural",
];

function hasSpecificAttributes(text: string): boolean {
  const lower = text.toLowerCase();
  const hasMaterial = MATERIAL_WORDS.some((m) => lower.includes(m));
  const hasDimension = /\d+(\.\d+)?\s*(cm|mm|inch|inches|in|ft|feet|kg|g|lb|lbs|oz|ml|l|liter)/.test(lower);
  const hasNumber = /\d+/.test(lower);
  return hasMaterial || hasDimension || hasNumber;
}

function isConversational(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const bulletLines = lines.filter((l) => /^\s*[•\-*]/.test(l)).length;
  const hasSentences = /[.!?]/.test(text);
  const bulletRatio = lines.length > 0 ? bulletLines / lines.length : 0;
  const isAllCaps = text === text.toUpperCase() && text.length > 20;
  return hasSentences && bulletRatio < 0.7 && !isAllCaps;
}

function hasDescriptiveAltText(altText: string, productTitle: string): boolean {
  if (altText.length < 10) return false;
  const normalized = altText.toLowerCase().trim();
  const titleNormalized = productTitle.toLowerCase().trim();
  if (normalized === titleNormalized) return false;
  const diff = Math.abs(normalized.length - titleNormalized.length);
  return diff > 10 || !normalized.startsWith(titleNormalized.slice(0, 20));
}

function hasReviewMetafields(metafields: ShopifyMetafield[]): {
  hasReviews: boolean;
  reviewCount: number;
  rating: number | null;
} {
  const reviewKeys = [
    { ns: "reviews", key: "rating" },
    { ns: "reviews", key: "rating_count" },
    { ns: "loox", key: "avg_rating" },
    { ns: "loox", key: "num_reviews" },
    { ns: "okendo", key: "reviews_rating_count" },
    { ns: "stamped", key: "rating" },
    { ns: "yotpo", key: "reviews_count" },
    { ns: "judgeme", key: "rating" },
  ];

  let hasReviews = false;
  let reviewCount = 0;
  let rating: number | null = null;

  for (const mf of metafields) {
    const match = reviewKeys.find(
      (k) => k.ns === mf.namespace && (k.key === mf.key || mf.key.includes("count") || mf.key.includes("rating"))
    );
    if (match) {
      hasReviews = true;
      const val = parseFloat(mf.value);
      if (!isNaN(val)) {
        if (mf.key.includes("count") || mf.key.includes("num")) {
          reviewCount = Math.max(reviewCount, val);
        } else if (mf.key.includes("rating") || mf.key.includes("avg")) {
          rating = val;
        }
      }
    }
  }

  return { hasReviews, reviewCount, rating };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

interface ScoreResult {
  score: number;
  issues: AuditIssue[];
  fields: {
    hasDescription: boolean;
    descriptionWordCount: number;
    hasMetaTitle: boolean;
    hasMetaDescription: boolean;
    hasAltText: boolean;
    altTextQuality: number;
    hasReviews: boolean;
    reviewCount: number;
    variantCount: number;
    variantsComplete: boolean;
    hasTags: boolean;
  };
}

function scoreProduct(product: ShopifyProductData, shopName: string): ScoreResult {
  const issues: AuditIssue[] = [];
  let score = 0;

  const plainDesc = stripHtml(product.descriptionHtml);
  const wc = wordCount(plainDesc);
  const images = product.images.edges.map((e) => e.node);
  const variants = product.variants.edges.map((e) => e.node);
  const metafields = product.metafields.edges.map((e) => e.node);
  const { hasReviews, reviewCount } = hasReviewMetafields(metafields);

  // ── CONTENT (35 pts) ──────────────────────────────────────────────────────

  if (plainDesc.length > 0) {
    score += 5;
  } else {
    issues.push({
      category: "CONTENT",
      severity: "CRITICAL",
      title: "Missing product description",
      description:
        "This product has no description. AI search engines like ChatGPT and Perplexity rely on product descriptions to understand what the product is and who it is for. Without a description, this product is nearly invisible to AI-powered search.",
      recommendation:
        "Write a description of at least 100 words in natural, conversational language. Describe what the product is, who it is for, key features, materials, and use cases.",
      autoFixable: true,
    });
  }

  if (wc >= 50) score += 5;
  else if (plainDesc.length > 0) {
    issues.push({
      category: "CONTENT",
      severity: "HIGH",
      title: "Description too short (under 50 words)",
      description: `This product description is only ${wc} words. AI search engines need enough context to confidently cite and recommend your product. Short descriptions lead to lower AI visibility.`,
      recommendation:
        "Expand the description to at least 100 words. Include the product's key features, materials, use cases, and who it is designed for.",
      autoFixable: true,
    });
  }

  if (wc >= 100) score += 5;
  if (wc >= 200) score += 5;

  const conversational = plainDesc.length > 0 ? isConversational(plainDesc) : false;
  if (conversational) {
    score += 5;
  } else if (plainDesc.length > 0) {
    issues.push({
      category: "CONTENT",
      severity: "MEDIUM",
      title: "Description lacks conversational language",
      description:
        "This description appears to be mostly bullet points or formatted lists. AI language models extract information better from natural prose that explains the product in sentences.",
      recommendation:
        "Rewrite the description with at least 2-3 full sentences that describe the product in natural language. Bullet points are fine for specifications, but the main description should read like a human explanation.",
      autoFixable: true,
    });
  }

  const specificAttrs = plainDesc.length > 0 ? hasSpecificAttributes(plainDesc) : false;
  if (specificAttrs) {
    score += 5;
  } else if (plainDesc.length > 0) {
    issues.push({
      category: "CONTENT",
      severity: "MEDIUM",
      title: "Description missing specific product attributes",
      description:
        "This description doesn't mention specific attributes like materials, dimensions, weights, or quantities. AI search engines parse these details to match your product to specific queries.",
      recommendation:
        "Add concrete details: materials (e.g., '100% organic cotton'), dimensions (e.g., '30cm × 20cm'), weights, capacity, or other measurable attributes relevant to your product.",
      autoFixable: true,
    });
  }

  if (product.productType.trim().length > 0) score += 5;
  else {
    issues.push({
      category: "CONTENT",
      severity: "MEDIUM",
      title: "Missing product type",
      description:
        "The product type field is empty. AI search engines use product type to categorize and recommend products for category-level queries like 'best running shoes' or 'gift ideas for home'.",
      recommendation:
        "Set a clear, descriptive product type (e.g., 'Running Shoes', 'Coffee Maker', 'Moisturizer'). Use a standard category term your target customers would search for.",
      autoFixable: false,
    });
  }

  // ── META (15 pts) ─────────────────────────────────────────────────────────

  const seoTitle = product.seo.title?.trim() ?? "";
  const seoDesc = product.seo.description?.trim() ?? "";

  const hasCustomSeoTitle =
    seoTitle.length > 0 && seoTitle.toLowerCase() !== product.title.toLowerCase();

  if (hasCustomSeoTitle) {
    score += 5;
    if (seoTitle.length >= 30 && seoTitle.length <= 60) score += 2;
    else {
      issues.push({
        category: "META",
        severity: "LOW",
        title: `SEO title length is ${seoTitle.length < 30 ? "too short" : "too long"} (${seoTitle.length} chars)`,
        description: `Your SEO title is ${seoTitle.length} characters. The ideal range is 30–60 characters for maximum readability in AI search results and Google snippets.`,
        recommendation: `Adjust your SEO title to be between 30 and 60 characters. Current title: "${seoTitle}"`,
        autoFixable: true,
      });
    }
  } else {
    issues.push({
      category: "META",
      severity: "HIGH",
      title: "Missing custom SEO title",
      description:
        "This product is using its default title as the SEO title, or has no SEO title set. A custom SEO title optimized for AI search helps AI engines classify and surface your product for the right queries.",
      recommendation:
        "Set a custom SEO title that includes the product's key benefit or differentiator (e.g., 'Organic Cotton Yoga Mat – Non-Slip, Eco-Friendly | Brand'). Keep it between 30–60 characters.",
      autoFixable: true,
    });
  }

  if (seoDesc.length > 0) {
    score += 5;
    if (seoDesc.length >= 120 && seoDesc.length <= 160) score += 3;
    else {
      issues.push({
        category: "META",
        severity: "LOW",
        title: `Meta description length is ${seoDesc.length < 120 ? "too short" : "too long"} (${seoDesc.length} chars)`,
        description: `Your meta description is ${seoDesc.length} characters. The ideal range is 120–160 characters. AI search engines use meta descriptions to generate product summaries.`,
        recommendation:
          "Rewrite the meta description to be 120–160 characters. Make it a concise, informative summary of the product's key benefit.",
        autoFixable: true,
      });
    }
  } else {
    issues.push({
      category: "META",
      severity: "HIGH",
      title: "Missing meta description",
      description:
        "This product has no custom meta description. AI search engines like Perplexity and Google AI Overviews use meta descriptions to generate product summaries. Without one, AI may skip your product or generate an inaccurate description.",
      recommendation:
        `Add a 120–160 character meta description that summarizes the product's key features and target audience. Example: "${product.title} - ${plainDesc.slice(0, 80).trim()}... Shop at ${shopName}."`,
      autoFixable: true,
    });
  }

  // ── IMAGES (20 pts) ───────────────────────────────────────────────────────

  if (images.length >= 1) score += 5;
  else {
    issues.push({
      category: "IMAGES",
      severity: "CRITICAL",
      title: "No product images",
      description:
        "This product has no images. AI shopping agents cannot recommend products they cannot visualize. Images are also required for Google Shopping and AI Overview carousels.",
      recommendation:
        "Add at least 3 high-quality product images from different angles. Include a clean white-background hero image and lifestyle shots.",
      autoFixable: false,
    });
  }

  if (images.length >= 3) score += 5;
  else if (images.length === 1 || images.length === 2) {
    issues.push({
      category: "IMAGES",
      severity: "MEDIUM",
      title: `Only ${images.length} product image${images.length === 1 ? "" : "s"}`,
      description:
        "Products with 3+ images perform significantly better in AI search results. More images help AI agents build a complete picture of your product.",
      recommendation:
        "Add at least 3 images: a main product shot, detail/close-up shots, and a lifestyle or in-use shot.",
      autoFixable: false,
    });
  }

  const imagesWithAlt = images.filter((img) => img.altText && img.altText.trim().length > 0);
  const allHaveAlt = images.length > 0 && imagesWithAlt.length === images.length;
  const altTextQuality = images.length > 0 ? Math.round((imagesWithAlt.length / images.length) * 100) : 0;

  if (allHaveAlt) {
    score += 5;
  } else if (images.length > 0) {
    issues.push({
      category: "IMAGES",
      severity: "HIGH",
      title: `${images.length - imagesWithAlt.length} image${images.length - imagesWithAlt.length > 1 ? "s" : ""} missing alt text`,
      description:
        "Alt text is how AI systems read your images. Without alt text, AI search engines cannot understand what your images show, reducing your product's visibility in AI-powered image search and shopping results.",
      recommendation:
        "Add descriptive alt text to every image. Each alt text should describe what the image shows, not just repeat the product title. Example: 'Blue running shoe side view showing mesh upper and rubber sole'.",
      autoFixable: true,
    });
  }

  const descriptiveAltCount = imagesWithAlt.filter((img) =>
    hasDescriptiveAltText(img.altText!, product.title)
  ).length;

  if (imagesWithAlt.length > 0 && descriptiveAltCount === imagesWithAlt.length) {
    score += 5;
  } else if (imagesWithAlt.length > 0) {
    issues.push({
      category: "IMAGES",
      severity: "LOW",
      title: "Alt text is not descriptive enough",
      description:
        "Some alt text appears to just repeat the product title rather than describing what the image actually shows. Descriptive alt text helps AI understand the visual context of your product.",
      recommendation:
        "Make alt text descriptive and specific. Instead of 'Blue Yoga Mat', use 'Blue organic cotton yoga mat unrolled on hardwood floor, non-slip grip visible'.",
      autoFixable: false,
    });
  }

  // ── VARIANTS & DATA (15 pts) ──────────────────────────────────────────────

  if (product.vendor.trim().length > 0) {
    score += 3;
  } else {
    issues.push({
      category: "CONTENT",
      severity: "MEDIUM",
      title: "Missing brand/vendor name",
      description:
        "This product has no vendor/brand set. AI search engines specifically look for brand information to answer queries like 'best [product type] by [brand]'. Missing brand data reduces brand citation frequency.",
      recommendation:
        "Set the vendor field to your brand name. This is one of the most important fields for AI brand citation.",
      autoFixable: false,
    });
  }

  if (product.tags.length > 0) {
    score += 3;
  } else {
    issues.push({
      category: "TECHNICAL",
      severity: "LOW",
      title: "No product tags",
      description:
        "Tags help AI systems categorize and discover your product. They act as structured keywords that AI search engines use to match products to queries.",
      recommendation:
        "Add 5–10 relevant tags including category, material, use case, and audience. Example: 'yoga, fitness, non-slip, eco-friendly, beginner'.",
      autoFixable: false,
    });
  }

  const hasDistinctVariantTitles =
    variants.length === 0 ||
    variants.every((v) => v.title !== "Default Title") ||
    variants.length === 1;

  if (hasDistinctVariantTitles) {
    score += 4;
  } else if (variants.length > 1) {
    issues.push({
      category: "CONTENT",
      severity: "MEDIUM",
      title: "Variants have generic titles",
      description:
        "Some variants are titled 'Default Title' which provides no useful information to AI search engines or customers. AI agents cannot recommend 'the blue size M version' if variants aren't labeled.",
      recommendation:
        "Give each variant a meaningful title that describes its distinguishing characteristic (e.g., 'Blue / Size M', 'Large / Stainless Steel').",
      autoFixable: false,
    });
  }

  const allVariantsHaveSku = variants.every((v) => v.sku && v.sku.trim().length > 0);
  if (allVariantsHaveSku && variants.length > 0) {
    score += 2;
  } else if (variants.length > 0) {
    issues.push({
      category: "TECHNICAL",
      severity: "LOW",
      title: "Some variants missing SKUs",
      description:
        "SKUs help AI systems and search engines uniquely identify product variants. Missing SKUs can prevent your products from being matched correctly in shopping integrations.",
      recommendation:
        "Add a unique SKU to every product variant.",
      autoFixable: false,
    });
  }

  if (product.productType.trim().length > 0) score += 3;

  // ── REVIEWS & SOCIAL PROOF (15 pts) ──────────────────────────────────────

  if (hasReviews) {
    score += 10;
    if (reviewCount >= 5) score += 5;
    else {
      issues.push({
        category: "CONTENT",
        severity: "LOW",
        title: "Fewer than 5 reviews",
        description:
          "Products with 5+ reviews are significantly more likely to be cited by AI search engines. Reviews provide social proof signals that AI uses to rank recommendations.",
        recommendation:
          "Set up a post-purchase review request flow to collect more reviews. Consider a review app like Judge.me, Okendo, or Loox.",
        autoFixable: false,
      });
    }
  } else {
    issues.push({
      category: "CONTENT",
      severity: "HIGH",
      title: "No customer reviews",
      description:
        "This product has no reviews detected. AI search engines weight social proof heavily when recommending products. A product with zero reviews is rarely cited in 'best X' or 'recommended Y' queries.",
      recommendation:
        "Install a review app (Judge.me, Okendo, Loox, or Yotpo) and send post-purchase review requests. Even 3–5 authentic reviews significantly improve AI visibility.",
      autoFixable: false,
    });
  }

  // ── Finalize ──────────────────────────────────────────────────────────────

  const finalScore = Math.min(100, Math.max(0, score));

  // Re-assess severity based on final score: downgrade CRITICAL to HIGH
  // once the overall score is no longer in critical territory.
  const finalIssues = issues.map((issue) => ({
    ...issue,
    severity: issue.severity === "CRITICAL" && finalScore >= 30
      ? "HIGH" as const
      : issue.severity,
  }));

  return {
    score: finalScore,
    issues: finalIssues,
    fields: {
      hasDescription: plainDesc.length > 0,
      descriptionWordCount: wc,
      hasMetaTitle: hasCustomSeoTitle,
      hasMetaDescription: seoDesc.length > 0,
      hasAltText: allHaveAlt,
      altTextQuality,
      hasReviews,
      reviewCount,
      variantCount: variants.length,
      variantsComplete: hasDistinctVariantTitles && allVariantsHaveSku,
      hasTags: product.tags.length > 0,
    },
  };
}

// ─── Shopify GraphQL Fetchers ─────────────────────────────────────────────────

const PRODUCTS_AUDIT_QUERY = `#graphql
  query AuditProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          descriptionHtml
          handle
          productType
          vendor
          status
          tags
          seo { title description }
          onlineStoreUrl
          images(first: 10) {
            edges { node { id altText url } }
          }
          variants(first: 100) {
            edges {
              node { id title price sku availableForSale }
            }
          }
          metafields(first: 20) {
            edges {
              node { namespace key value }
            }
          }
        }
      }
    }
    shop { name }
  }
`;

async function fetchAllProductsForAudit(
  admin: AdminApiContext,
  maxProducts: number = Infinity
): Promise<{ products: ShopifyProductData[]; shopName: string; totalActive: number }> {
  const products: ShopifyProductData[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let shopName = "";

  // Get the real catalog count up front. The audit page used to do this
  // separately; doing it inside the service means callers can't accidentally
  // bypass plan limits by skipping that query.
  let totalActive = 0;
  try {
    const countResponse = await admin.graphql(
      `#graphql
       query AuditProductCount {
         productsCount(query: "status:active") { count }
       }`
    );
    const countJson = (await countResponse.json()) as {
      data?: { productsCount?: { count: number } };
    };
    totalActive = countJson.data?.productsCount?.count ?? 0;
  } catch {
    // Non-fatal - we'll still audit what we can fetch.
  }

  // If maxProducts is finite and small, request only what we need from
  // Shopify (saves an API call for Free-plan stores with 1000s of products).
  const pageSize = Math.min(50, Math.max(1, Number.isFinite(maxProducts) ? maxProducts : 50));

  while (hasNextPage && products.length < maxProducts) {
    const response = await admin.graphql(PRODUCTS_AUDIT_QUERY, {
      variables: { first: pageSize, after: cursor },
    });

    // Rate limit check
    const callLimit = response.headers.get("X-Shopify-Shop-Api-Call-Limit");
    if (callLimit) {
      const [current, max] = callLimit.split("/").map(Number);
      if (current >= max * 0.75) {
        await new Promise<void>((r) => setTimeout(r, 2000));
      }
    }

    const json = (await response.json()) as {
      data: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: ShopifyProductData }[];
        };
        shop: { name: string };
      };
    };

    if (!shopName) shopName = json.data.shop.name;

    for (const edge of json.data.products.edges) {
      if (products.length >= maxProducts) break;
      if (edge.node.status === "ACTIVE") {
        products.push(edge.node);
      }
    }

    hasNextPage = json.data.products.pageInfo.hasNextPage;
    cursor = json.data.products.pageInfo.endCursor;
  }

  // Fallback for stores where productsCount query failed: assume total is at
  // least what we fetched, plus 1 if we know there's more (so the UI can
  // still show "we audited X of Y+").
  if (totalActive === 0) {
    totalActive = products.length + (hasNextPage ? 1 : 0);
  }

  return { products, shopName, totalActive };
}

// ─── Main Audit Function ──────────────────────────────────────────────────────

export async function runFullAudit(
  storeId: string,
  admin: AdminApiContext,
  options: RunFullAuditOptions = {}
): Promise<AuditSummary> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
  });

  const maxProducts = options.maxProducts ?? Infinity;

  // 1. Fetch products, capped by the caller's plan limit
  const { products, shopName, totalActive } = await fetchAllProductsForAudit(
    admin,
    maxProducts
  );

  // 2. Delete previous audit results
  await prisma.auditResult.deleteMany({ where: { storeId } });

  // 3. Score each product and collect results
  type AuditResultInput = {
    storeId: string;
    category: "SCHEMA" | "CONTENT" | "TECHNICAL" | "ACCESSIBILITY" | "IMAGES" | "META";
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    title: string;
    description: string;
    recommendation: string;
    autoFixable: boolean;
  };
  const auditResultsToCreate: AuditResultInput[] = [];
  const productUpserts: Promise<unknown>[] = [];
  let totalScore = 0;
  // Track shopifyProductId alongside each issue so we can attach productId after upserts
  const issueShopifyProductIds: string[] = [];

  for (const product of products) {
    const { score, issues, fields } = scoreProduct(product, shopName || store.shopName);

    totalScore += score;

    // Upsert product record
    productUpserts.push(
      prisma.product.upsert({
        where: {
          storeId_shopifyProductId: {
            storeId,
            shopifyProductId: product.id,
          },
        },
        create: {
          storeId,
          shopifyProductId: product.id,
          title: product.title,
          description: product.descriptionHtml || null,
          handle: product.handle,
          productType: product.productType || null,
          vendor: product.vendor || null,
          status: product.status.toLowerCase(),
          price: product.variants.edges[0]?.node.price ?? null,
          imageCount: product.images.edges.length,
          hasAltText: fields.hasAltText,
          altTextQuality: fields.altTextQuality,
          hasMetaTitle: fields.hasMetaTitle,
          hasMetaDescription: fields.hasMetaDescription,
          hasRichDescription: fields.descriptionWordCount >= 100,
          descriptionWordCount: fields.descriptionWordCount,
          hasReviews: fields.hasReviews,
          reviewCount: fields.reviewCount,
          variantCount: fields.variantCount,
          variantsComplete: fields.variantsComplete,
          hasTags: fields.hasTags,
          aiReadinessScore: score,
          lastAuditedAt: new Date(),
        },
        update: {
          // P1-3 (fixed): the previous version skipped description/price/etc
          // on update, so re-running an audit on a product whose description
          // or price changed in Shopify left the local cache stale. Now the
          // update path keeps the full set of Shopify-derived fields in sync.
          title: product.title,
          description: product.descriptionHtml || null,
          handle: product.handle,
          productType: product.productType || null,
          vendor: product.vendor || null,
          status: product.status.toLowerCase(),
          price: product.variants.edges[0]?.node.price ?? null,
          imageCount: product.images.edges.length,
          hasAltText: fields.hasAltText,
          altTextQuality: fields.altTextQuality,
          hasMetaTitle: fields.hasMetaTitle,
          hasMetaDescription: fields.hasMetaDescription,
          hasRichDescription: fields.descriptionWordCount >= 100,
          descriptionWordCount: fields.descriptionWordCount,
          hasReviews: fields.hasReviews,
          reviewCount: fields.reviewCount,
          variantCount: fields.variantCount,
          variantsComplete: fields.variantsComplete,
          hasTags: fields.hasTags,
          aiReadinessScore: score,
          lastAuditedAt: new Date(),
        },
      })
    );

    // Collect audit issues
    for (const issue of issues) {
      auditResultsToCreate.push({
        storeId,
        category: issue.category,
        severity: issue.severity,
        title: issue.title,
        description: issue.description,
        recommendation: issue.recommendation,
        autoFixable: issue.autoFixable,
      });
      issueShopifyProductIds.push(product.id);
    }
  }

  // 4. Run product upserts in parallel batches of 10
  for (let i = 0; i < productUpserts.length; i += 10) {
    await Promise.all(productUpserts.slice(i, i + 10));
  }

  // 5. Resolve DB product IDs and attach to audit results
  if (auditResultsToCreate.length > 0) {
    const dbProducts = await prisma.product.findMany({
      where: { storeId },
      select: { id: true, shopifyProductId: true },
    });
    const shopifyIdToDbId = new Map(dbProducts.map((p) => [p.shopifyProductId, p.id]));
    for (let i = 0; i < auditResultsToCreate.length; i++) {
      const shopifyId = issueShopifyProductIds[i];
      const dbId = shopifyIdToDbId.get(shopifyId);
      if (dbId) (auditResultsToCreate[i] as Record<string, unknown>).productId = dbId;
    }
    await prisma.auditResult.createMany({ data: auditResultsToCreate });
  }

  // 6. Calculate store score and update
  const storeScore =
    products.length > 0 ? Math.round(totalScore / products.length) : 0;

  await prisma.store.update({
    where: { id: storeId },
    data: {
      geoScore: storeScore,
      totalProducts: totalActive,
      auditedProducts: products.length,
    },
  });

  // 7. Build summary
  const criticalCount = auditResultsToCreate.filter((r: { severity: string }) => r.severity === "CRITICAL").length;
  const highCount = auditResultsToCreate.filter((r: { severity: string }) => r.severity === "HIGH").length;
  const mediumCount = auditResultsToCreate.filter((r: { severity: string }) => r.severity === "MEDIUM").length;
  const lowCount = auditResultsToCreate.filter((r: { severity: string }) => r.severity === "LOW").length;

  return {
    storeScore,
    totalProducts: totalActive,
    auditedProducts: products.length,
    issueCount: auditResultsToCreate.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    capped: products.length < totalActive,
  };
}

// ─── Auto-Fix ─────────────────────────────────────────────────────────────────

const UPDATE_PRODUCT_MUTATION = `#graphql
  mutation UpdateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id descriptionHtml seo { title description } }
      userErrors { field message }
    }
  }
`;

const UPDATE_IMAGE_ALT_MUTATION = `#graphql
  mutation UpdateProductMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id alt } }
      mediaUserErrors { field message }
    }
  }
`;

// ─── Claude-Powered Content Generation (used by autoFixIssues) ─────────────────

/** Discriminated union returned by every generator. Distinguishes:
 *  - `ok + source: "claude"` - Claude produced valid output, use it
 *  - `ok + source: "fallback"` - Claude responded but output was unusable;
 *    use the deterministic template (acceptable quality, log as fallback)
 *  - `!ok + claude_credits` - permanent failure (credits exhausted, auth)
 *    that won't recover this session; caller should ABORT the whole loop
 *  - `!ok + claude_other` - transient failure that didn't recover even
 *    after retries; caller should SKIP this issue but keep going */
type GenResult =
  | { ok: true; value: string; source: "claude" | "fallback" }
  | { ok: false; reason: "claude_credits" | "claude_other" };

// Retry/error helpers live in `./ai-retry.server` - shared with tracking +
// simulator now that all three call third-party AI vendors with the same
// failure modes. Imports at top of file.

async function generateMetaDescriptionWithClaude(
  product: { title: string; description: string | null; vendor: string | null; productType: string | null },
  storeName: string
): Promise<GenResult> {
  const plainDesc = product.description ? stripHtml(product.description).slice(0, 500) : "";
  const fallback = `${product.title}${plainDesc ? ` - ${plainDesc.split(/[.!?]/)[0]?.trim() ?? ""}` : ""}. Shop ${product.vendor || ""} ${product.productType || ""} at ${storeName}.`
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();

  try {
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 256,
          system:
            "You are an expert e-commerce SEO copywriter. You write concise, compelling meta descriptions that get clicked. Output ONLY the meta description, no quotes, no preamble, no labels. Avoid AI-cliché openers like 'Discover', 'Unlock', 'Dive into', 'Experience', 'Elevate'. CRITICAL: never use em-dashes (the long horizontal dash). Use commas, colons, or periods for sentence breaks instead.",
          messages: [
            {
              role: "user",
              content: `Write a meta description (strictly between 120 and 158 characters - count carefully and stop at a complete sentence; do not end mid-word) for this product. Lead with the product itself, not a verb. Include the key product benefit or feature, mention the brand if available, and entice a click. No clickbait, no all-caps, no emojis, no "Discover/Unlock/Dive into".

Product title: ${product.title}
${plainDesc ? `Product description: ${plainDesc}` : "Product description: (none provided)"}
${product.vendor ? `Brand: ${product.vendor}` : ""}
${product.productType ? `Category: ${product.productType}` : ""}
Store: ${storeName}`,
            },
          ],
        }),
      "generateMetaDescription"
    );

    const block = message.content[0];
    if (block?.type === "text") {
      const cleaned = block.text.trim().replace(/^["']|["']$/g, "").trim();
      if (cleaned.length >= 50 && cleaned.length <= 200) {
        return { ok: true, value: cleaned, source: "claude" };
      }
    }
    // Claude returned but output was unusable - fall through to template
    return { ok: true, value: fallback, source: "fallback" };
  } catch (err) {
    console.error("[GEO Rise auto-fix] meta description generator failed:", err);
    return {
      ok: false,
      reason: isPermanentApiError(err) ? "claude_credits" : "claude_other",
    };
  }
}

async function generateSeoTitleWithClaude(
  product: { title: string; description: string | null; vendor: string | null; productType: string | null },
  storeName: string
): Promise<GenResult> {
  const plainDesc = product.description ? stripHtml(product.description).slice(0, 300) : "";
  const fallback = `${product.title}${product.vendor ? ` | ${product.vendor}` : ""}`.slice(0, 60);

  try {
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 128,
          system:
            "You are an expert e-commerce SEO copywriter. You write concise, click-worthy SEO titles for product pages. Output ONLY the title, no quotes, no preamble, no labels. CRITICAL: never use em-dashes (the long horizontal dash). Use a pipe `|` or a regular hyphen `-` to separate brand from product name.",
          messages: [
            {
              role: "user",
              content: `Write an SEO title (strictly between 30 and 58 characters - count carefully and end on a complete phrase, never mid-word) for this product. The title MUST be different from the product title. Lead with the product name, then add a short benefit, descriptor, or brand suffix to differentiate.

Good formats (pick whatever fits best):
- "Product Name - Key Benefit | Brand"
- "Product Name | Brand"
- "Product Name - Use Case"
- "Adjective Product Type | Brand"

No clickbait, no all-caps, no emojis. Do NOT just repeat the product title verbatim.

Product title: ${product.title}
${plainDesc ? `Description: ${plainDesc}` : ""}
${product.vendor ? `Brand: ${product.vendor}` : ""}
${product.productType ? `Category: ${product.productType}` : ""}
Store: ${storeName}`,
            },
          ],
        }),
      "generateSeoTitle"
    );

    const block = message.content[0];
    if (block?.type === "text") {
      const cleaned = block.text.trim().replace(/^["']|["']$/g, "").trim();
      // Reject empty, wrong length, or identical-to-product-title outputs.
      if (
        cleaned.length >= 20 &&
        cleaned.length <= 80 &&
        cleaned.toLowerCase() !== product.title.toLowerCase()
      ) {
        return { ok: true, value: cleaned, source: "claude" };
      }
    }
    return { ok: true, value: fallback, source: "fallback" };
  } catch (err) {
    console.error("[GEO Rise auto-fix] SEO title generator failed:", err);
    return {
      ok: false,
      reason: isPermanentApiError(err) ? "claude_credits" : "claude_other",
    };
  }
}

async function generateProductDescriptionWithClaude(
  product: {
    title: string;
    description: string | null;
    vendor: string | null;
    productType: string | null;
    tags?: string[];
  },
  imageUrl: string | null,
  storeName: string
): Promise<GenResult> {
  const existing = product.description ? stripHtml(product.description).slice(0, 500).trim() : "";
  const fallback = `<p>${product.title}${product.vendor ? ` by ${product.vendor}` : ""}.${product.productType ? ` ${product.productType}.` : ""}${existing ? ` ${existing}` : ""}</p>`;

  try {
    const userContent: Anthropic.ContentBlockParam[] = [];
    if (imageUrl) {
      userContent.push({ type: "image", source: { type: "url", url: imageUrl } });
    }
    userContent.push({
      type: "text",
      text: `Write a product description for an e-commerce store. The description should be 150–250 words, formatted as 2–3 short HTML paragraphs (<p>...</p>).

The first paragraph should describe what the product is and its main benefit. The second paragraph should cover features, materials, and what makes it distinctive. If applicable, a third paragraph can cover use cases or who the product is for.

Write in natural, conversational prose. Mention specific details visible in the image - colors, materials, design elements. Do NOT invent specifications you can't verify (don't guess dimensions, weights, or quantities). Do NOT use generic marketing fluff ("premium quality", "perfect for any occasion", "elevate", "unlock", "dive into"). Do NOT use all-caps or emojis.

Product title: ${product.title}
${product.vendor ? `Brand: ${product.vendor}` : ""}
${product.productType ? `Category: ${product.productType}` : ""}
${product.tags && product.tags.length > 0 ? `Tags: ${product.tags.join(", ")}` : ""}
${existing ? `Existing description (improve and expand - don't just copy verbatim): ${existing}` : "No existing description."}
Store: ${storeName}

Output ONLY the HTML <p> paragraphs. No preamble, no labels, no quotes around the output.`,
    });

    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system:
            "You are an expert e-commerce product copywriter. You write factual, specific, benefit-focused descriptions optimized for AI search engines (ChatGPT, Perplexity, Google AI Overview) and human shoppers. Output is valid HTML using <p> tags. CRITICAL: never use em-dashes (the long horizontal dash). Use commas, colons, or periods for breaks instead.",
          messages: [{ role: "user", content: userContent }],
        }),
      "generateProductDescription"
    );

    const block = message.content[0];
    if (block?.type === "text") {
      const cleaned = block.text.trim();
      if (cleaned.length >= 100 && cleaned.length <= 3000 && cleaned.includes("<p>")) {
        return { ok: true, value: cleaned, source: "claude" };
      }
    }
    return { ok: true, value: fallback, source: "fallback" };
  } catch (err) {
    console.error("[GEO Rise auto-fix] description generator failed:", err);
    return {
      ok: false,
      reason: isPermanentApiError(err) ? "claude_credits" : "claude_other",
    };
  }
}

async function generateAltTextWithClaude(
  product: { title: string; vendor: string | null; productType: string | null },
  imageUrl: string
): Promise<GenResult> {
  const fallback = `${product.title}${product.vendor ? ` by ${product.vendor}` : ""}${product.productType ? `. ${product.productType}` : ""}.`;

  try {
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 200,
          system:
            "You are an accessibility expert writing image alt text for e-commerce product photos. Describe the SPECIFIC visual contents of the image (colors, materials, angle, context, what's visible), not just the product name. Output ONLY the alt text. No quotes, no preamble. CRITICAL: never use em-dashes (the long horizontal dash). Use commas instead.",
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "url", url: imageUrl } },
                {
                  type: "text",
                  text: `Write descriptive alt text (under 125 characters) for this product image. The product is "${product.title}"${product.vendor ? ` by ${product.vendor}` : ""}. Focus on what is visible in the image, not the product name.`,
                },
              ],
            },
          ],
        }),
      "generateAltText"
    );

    const block = message.content[0];
    if (block?.type === "text") {
      const cleaned = block.text.trim().replace(/^["']|["']$/g, "").trim();
      if (cleaned.length >= 10 && cleaned.length <= 200) {
        return { ok: true, value: cleaned.slice(0, 125), source: "claude" };
      }
    }
    return { ok: true, value: fallback, source: "fallback" };
  } catch (err) {
    console.error("[GEO Rise auto-fix] alt text generator failed:", err);
    return {
      ok: false,
      reason: isPermanentApiError(err) ? "claude_credits" : "claude_other",
    };
  }
}

// ─── Per-Category Fix Helpers ─────────────────────────────────────────────────

/** Discriminated outcome from each per-category helper. The orchestrator
 *  translates this into counters + the circuit-breaker decision. */
type FixOutcome =
  | { result: "fixed"; usedFallback: boolean }
  | { result: "skipped" }
  | { result: "failed"; reason: string }
  | { result: "aborted"; reason: string };

async function fixContentIssue(
  issue: { id: string; productId: string },
  admin: AdminApiContext,
  shopName: string
): Promise<FixOutcome> {
  const product = await prisma.product.findUnique({
    where: { id: issue.productId },
  });
  if (!product) return { result: "failed", reason: "product_not_found" };

  // Fetch current Shopify state. Used both for the skip-if-already-good check
  // (don't overwrite a description the merchant fixed manually between audit
  // and fix) and for the image context Claude needs to write a good blurb.
  let imageUrl: string | null = null;
  let tags: string[] = [];
  let currentHtml = "";
  try {
    const ctx = await admin.graphql(
      `#graphql
       query GetProductContext($id: ID!) {
         product(id: $id) { descriptionHtml featuredImage { url } tags }
       }`,
      { variables: { id: product.shopifyProductId } }
    );
    const ctxJson = (await ctx.json()) as {
      data: {
        product: {
          descriptionHtml: string;
          featuredImage: { url: string } | null;
          tags: string[];
        } | null;
      };
    };
    if (ctxJson.data.product) {
      imageUrl = ctxJson.data.product.featuredImage?.url ?? null;
      tags = ctxJson.data.product.tags ?? [];
      currentHtml = ctxJson.data.product.descriptionHtml ?? "";
    }
  } catch {
    // Continue without context - the generator can work without an image
  }

  const currentWords = wordCount(stripHtml(currentHtml));
  if (currentWords >= 120) {
    console.log(
      `[GEO Rise auto-fix] CONTENT skipped for ${product.shopifyProductId}: already has ${currentWords} words`
    );
    await prisma.auditResult.update({
      where: { id: issue.id },
      data: { fixed: true, fixedAt: new Date() },
    });
    await prisma.product.update({
      where: { id: issue.productId },
      data: {
        description: currentHtml,
        descriptionWordCount: currentWords,
        hasRichDescription: true,
      },
    });
    return { result: "skipped" };
  }

  const gen = await generateProductDescriptionWithClaude(
    {
      title: product.title,
      description: currentHtml || product.description,
      vendor: product.vendor,
      productType: product.productType,
      tags,
    },
    imageUrl,
    shopName
  );
  if (!gen.ok) {
    return gen.reason === "claude_credits"
      ? { result: "aborted", reason: "claude_credits" }
      : { result: "failed", reason: gen.reason };
  }

  // Sanitize LLM output before writing to Shopify - drops any tag outside
  // ALLOWED_LLM_TAGS, strips all attributes (no <script>, no inline
  // handlers, no <a href>). See `sanitizeLlmHtml` for the rationale.
  const descriptionHtml = sanitizeLlmHtml(gen.value);
  const response = await admin.graphql(UPDATE_PRODUCT_MUTATION, {
    variables: { input: { id: product.shopifyProductId, descriptionHtml } },
  });
  const json = (await response.json()) as {
    data: {
      productUpdate: {
        product?: { descriptionHtml?: string };
        userErrors: { field: string; message: string }[];
      };
    };
  };
  if (json.data.productUpdate.userErrors.length > 0) {
    console.error(
      `[GEO Rise auto-fix] CONTENT userErrors for ${product.shopifyProductId}:`,
      json.data.productUpdate.userErrors
    );
    return { result: "failed", reason: "shopify_user_errors" };
  }

  // Persistence check - Shopify has been known to silently no-op (see
  // project_known_fixes.md for the seo: precedent). Verify the saved
  // description is at least the size of what we wrote (allowing some
  // whitespace normalization, but not a silent revert).
  const wroteWords = wordCount(stripHtml(descriptionHtml));
  const returnedHtml = json.data.productUpdate.product?.descriptionHtml ?? "";
  const returnedWords = wordCount(stripHtml(returnedHtml));
  if (returnedWords < Math.min(wroteWords, 80)) {
    console.error(
      `[GEO Rise auto-fix] CONTENT persistence verify failed for ${product.shopifyProductId}: wrote ${wroteWords} words, got back ${returnedWords}`
    );
    return { result: "failed", reason: "persistence_verify_failed" };
  }

  await prisma.auditResult.update({
    where: { id: issue.id },
    data: { fixed: true, fixedAt: new Date() },
  });
  await prisma.product.update({
    where: { id: issue.productId },
    data: {
      description: descriptionHtml,
      descriptionWordCount: wroteWords,
      hasRichDescription: wroteWords >= 100,
    },
  });
  if (gen.source === "fallback") {
    console.warn(
      `[GEO Rise auto-fix] CONTENT used fallback template for ${product.shopifyProductId}`
    );
  }
  return { result: "fixed", usedFallback: gen.source === "fallback" };
}

async function fixMetaIssue(
  issue: { id: string; productId: string; title: string },
  admin: AdminApiContext,
  shopName: string
): Promise<FixOutcome> {
  const product = await prisma.product.findUnique({
    where: { id: issue.productId },
  });
  if (!product) return { result: "failed", reason: "product_not_found" };

  const isSeoTitleIssue = issue.title.toLowerCase().includes("seo title");

  // Fetch current seo for both (a) skip-if-good check and (b) the
  // productUpdate seo:-wholesale-replacement workaround - always send BOTH.
  const currentResponse = await admin.graphql(
    `#graphql
     query GetCurrentSeo($id: ID!) {
       product(id: $id) { seo { title description } }
     }`,
    { variables: { id: product.shopifyProductId } }
  );
  const currentJson = (await currentResponse.json()) as {
    data: { product: { seo: { title: string | null; description: string | null } } | null };
  };
  const currentSeo = currentJson.data.product?.seo ?? { title: null, description: null };

  if (isSeoTitleIssue) {
    const t = currentSeo.title?.trim() ?? "";
    if (
      t.length >= 20 &&
      t.length <= 80 &&
      t.toLowerCase() !== product.title.toLowerCase()
    ) {
      console.log(
        `[GEO Rise auto-fix] META SEO-title skipped for ${product.shopifyProductId}: already populated (${t.length} chars)`
      );
      await prisma.auditResult.update({
        where: { id: issue.id },
        data: { fixed: true, fixedAt: new Date() },
      });
      await prisma.product.update({
        where: { id: issue.productId },
        data: { hasMetaTitle: true },
      });
      return { result: "skipped" };
    }
  } else {
    const d = currentSeo.description?.trim() ?? "";
    if (d.length >= 50 && d.length <= 320) {
      console.log(
        `[GEO Rise auto-fix] META meta-description skipped for ${product.shopifyProductId}: already populated (${d.length} chars)`
      );
      await prisma.auditResult.update({
        where: { id: issue.id },
        data: { fixed: true, fixedAt: new Date() },
      });
      await prisma.product.update({
        where: { id: issue.productId },
        data: { hasMetaDescription: true },
      });
      return { result: "skipped" };
    }
  }

  const gen = isSeoTitleIssue
    ? await generateSeoTitleWithClaude(
        {
          title: product.title,
          description: product.description,
          vendor: product.vendor,
          productType: product.productType,
        },
        shopName
      )
    : await generateMetaDescriptionWithClaude(
        {
          title: product.title,
          description: product.description,
          vendor: product.vendor,
          productType: product.productType,
        },
        shopName
      );
  if (!gen.ok) {
    return gen.reason === "claude_credits"
      ? { result: "aborted", reason: "claude_credits" }
      : { result: "failed", reason: gen.reason };
  }

  const seoUpdate: { title: string | null; description: string | null } = {
    title: currentSeo.title,
    description: currentSeo.description,
  };
  if (isSeoTitleIssue) seoUpdate.title = gen.value;
  else seoUpdate.description = gen.value;

  const response = await admin.graphql(UPDATE_PRODUCT_MUTATION, {
    variables: { input: { id: product.shopifyProductId, seo: seoUpdate } },
  });
  const json = (await response.json()) as {
    data: {
      productUpdate: {
        product?: { seo?: { title?: string | null; description?: string | null } };
        userErrors: { field: string; message: string }[];
      };
    };
  };
  if (json.data.productUpdate.userErrors.length > 0) {
    console.error(
      `[GEO Rise auto-fix] META userErrors for ${product.shopifyProductId}:`,
      json.data.productUpdate.userErrors
    );
    return { result: "failed", reason: "shopify_user_errors" };
  }

  const updatedSeo = json.data.productUpdate.product?.seo;
  const persisted = isSeoTitleIssue
    ? updatedSeo?.title === seoUpdate.title
    : updatedSeo?.description === seoUpdate.description;
  if (!persisted) {
    console.error(
      `[GEO Rise auto-fix] META persistence verify failed for ${product.shopifyProductId} (${
        isSeoTitleIssue ? "title" : "description"
      })`
    );
    return { result: "failed", reason: "persistence_verify_failed" };
  }

  await prisma.auditResult.update({
    where: { id: issue.id },
    data: { fixed: true, fixedAt: new Date() },
  });
  await prisma.product.update({
    where: { id: issue.productId },
    data: isSeoTitleIssue ? { hasMetaTitle: true } : { hasMetaDescription: true },
  });
  if (gen.source === "fallback") {
    console.warn(
      `[GEO Rise auto-fix] META used fallback template for ${product.shopifyProductId} (${
        isSeoTitleIssue ? "title" : "description"
      })`
    );
  }
  return { result: "fixed", usedFallback: gen.source === "fallback" };
}

async function fixImagesIssue(
  issue: { id: string; productId: string },
  admin: AdminApiContext
): Promise<FixOutcome> {
  const product = await prisma.product.findUnique({
    where: { id: issue.productId },
  });
  if (!product) return { result: "failed", reason: "product_not_found" };

  const imgResponse = await admin.graphql(
    `#graphql
     query GetProductImages($id: ID!) {
       product(id: $id) {
         media(first: 20) {
           edges {
             node {
               ... on MediaImage {
                 id
                 alt
                 image { url }
               }
             }
           }
         }
       }
     }`,
    { variables: { id: product.shopifyProductId } }
  );
  const imgJson = (await imgResponse.json()) as {
    data: {
      product: {
        media: {
          edges: {
            node: { id: string; alt: string | null; image?: { url: string } | null };
          }[];
        };
      };
    };
  };
  const missingAlt = imgJson.data.product.media.edges.filter(
    (e) => !e.node.alt || e.node.alt.trim() === ""
  );

  if (missingAlt.length === 0) {
    console.log(
      `[GEO Rise auto-fix] IMAGES skipped for ${product.shopifyProductId}: all images already have alt text`
    );
    await prisma.auditResult.update({
      where: { id: issue.id },
      data: { fixed: true, fixedAt: new Date() },
    });
    await prisma.product.update({
      where: { id: issue.productId },
      data: { hasAltText: true, altTextQuality: 80 },
    });
    return { result: "skipped" };
  }

  const mediaWithoutAlt: { id: string; alt: string }[] = [];
  let usedAnyFallback = false;
  for (const edge of missingAlt) {
    const imageUrl = edge.node.image?.url;
    if (!imageUrl) continue;
    const gen = await generateAltTextWithClaude(
      { title: product.title, vendor: product.vendor, productType: product.productType },
      imageUrl
    );
    if (gen.ok) {
      mediaWithoutAlt.push({ id: edge.node.id, alt: gen.value });
      if (gen.source === "fallback") usedAnyFallback = true;
    } else if (gen.reason === "claude_credits") {
      return { result: "aborted", reason: "claude_credits" };
    } else {
      // Transient on this image - skip just this image, keep going with others
      console.warn(
        `[GEO Rise auto-fix] IMAGES alt-text generator failed for one image of ${product.shopifyProductId}; continuing`
      );
    }
  }

  if (mediaWithoutAlt.length === 0) {
    return { result: "failed", reason: "all_alt_generators_failed" };
  }

  const updateResponse = await admin.graphql(UPDATE_IMAGE_ALT_MUTATION, {
    variables: {
      productId: product.shopifyProductId,
      media: mediaWithoutAlt,
    },
  });
  const updateJson = (await updateResponse.json()) as {
    data: {
      productUpdateMedia: {
        media?: { id: string; alt: string }[];
        mediaUserErrors: { field: string; message: string }[];
      };
    };
  };
  if (updateJson.data.productUpdateMedia.mediaUserErrors.length > 0) {
    console.error(
      `[GEO Rise auto-fix] IMAGES mediaUserErrors for ${product.shopifyProductId}:`,
      updateJson.data.productUpdateMedia.mediaUserErrors
    );
    return { result: "failed", reason: "shopify_media_errors" };
  }

  // Persistence check: every alt we asked to set should come back exactly.
  const returned = updateJson.data.productUpdateMedia.media ?? [];
  const allPersisted = mediaWithoutAlt.every((wanted) => {
    const got = returned.find((m) => m.id === wanted.id);
    return got && got.alt === wanted.alt;
  });
  if (!allPersisted) {
    console.error(
      `[GEO Rise auto-fix] IMAGES persistence verify failed for ${product.shopifyProductId}`
    );
    return { result: "failed", reason: "persistence_verify_failed" };
  }

  await prisma.auditResult.update({
    where: { id: issue.id },
    data: { fixed: true, fixedAt: new Date() },
  });
  await prisma.product.update({
    where: { id: issue.productId },
    data: { hasAltText: true, altTextQuality: 70 },
  });
  if (usedAnyFallback) {
    console.warn(
      `[GEO Rise auto-fix] IMAGES used fallback template for at least one image of ${product.shopifyProductId}`
    );
  }
  return { result: "fixed", usedFallback: usedAnyFallback };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface AutoFixOptions {
  /** If set, restrict the run to issues in this audit category. Used by the
   *  action plan page so each card's "Auto-fix" button only touches its own
   *  bucket (e.g. "fix the 12 missing meta descriptions, leave the
   *  descriptions for later"). Omit to fix every fixable issue, like the
   *  audit page's "Auto-fix All" button. */
  category?: "SCHEMA" | "CONTENT" | "TECHNICAL" | "ACCESSIBILITY" | "IMAGES" | "META";
  /** If set, restrict the run to issues with this exact `AuditResult.title`.
   *  Lets the action plan target a single fix-recipe (e.g. just the
   *  "Missing SEO title" issues, not the "Missing meta description" ones,
   *  even though both live under category=META). */
  title?: string;
}

export async function autoFixIssues(
  storeId: string,
  admin: AdminApiContext,
  options: AutoFixOptions = {}
): Promise<AutoFixSummary> {
  const fixableIssues = await prisma.auditResult.findMany({
    where: {
      storeId,
      autoFixable: true,
      fixed: false,
      ...(options.category ? { category: options.category } : {}),
      ...(options.title ? { title: options.title } : {}),
    },
  });

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  const shopName = store?.shopName ?? "our store";

  let fixed = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  const MAX_CONSECUTIVE_FAILURES = 3;

  console.log(
    `[GEO Rise auto-fix] starting: ${fixableIssues.length} issues for store ${storeId}`
  );

  outer: for (const issue of fixableIssues) {
    let outcome: FixOutcome;
    try {
      if (issue.category === "CONTENT" && issue.productId) {
        outcome = await fixContentIssue(
          { id: issue.id, productId: issue.productId },
          admin,
          shopName
        );
      } else if (issue.category === "META" && issue.productId) {
        outcome = await fixMetaIssue(
          { id: issue.id, productId: issue.productId, title: issue.title },
          admin,
          shopName
        );
      } else if (issue.category === "IMAGES" && issue.productId) {
        outcome = await fixImagesIssue(
          { id: issue.id, productId: issue.productId },
          admin
        );
      } else {
        console.warn(
          `[GEO Rise auto-fix] no handler for issue ${issue.id} (category=${issue.category})`
        );
        outcome = { result: "failed", reason: "no_handler" };
      }
    } catch (err) {
      console.error(
        `[GEO Rise auto-fix] unexpected error on issue ${issue.id}:`,
        err
      );
      outcome = { result: "failed", reason: "unexpected_error" };
    }

    switch (outcome.result) {
      case "fixed":
        fixed++;
        consecutiveFailures = 0;
        break;
      case "skipped":
        skipped++;
        consecutiveFailures = 0;
        break;
      case "failed":
        failed++;
        consecutiveFailures++;
        break;
      case "aborted":
        aborted = true;
        console.error(
          `[GEO Rise auto-fix] aborting loop: ${outcome.reason}`
        );
        break outer;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `[GEO Rise auto-fix] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, aborting`
      );
      aborted = true;
      break;
    }

    // Pace between fixes - Shopify GraphQL rate-limit headroom.
    await new Promise<void>((r) => setTimeout(r, 300));
  }

  console.log(
    `[GEO Rise auto-fix] done: fixed=${fixed} skipped=${skipped} failed=${failed} aborted=${aborted}`
  );
  return { fixed, failed, skipped, aborted };
}

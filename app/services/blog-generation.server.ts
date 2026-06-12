import Anthropic from "@anthropic-ai/sdk";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { withRetry } from "./ai-retry.server";
import { sanitizeLlmHtml } from "./audit-engine.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export type BlogPostTone =
  | "informative"
  | "tutorial"
  | "comparison"
  | "buying_guide";

export type BlogPostLength = "short" | "medium" | "long";

export interface GenerateBlogPostOptions {
  topic: string;
  targetKeywords?: string[];
  tone?: BlogPostTone;
  length?: BlogPostLength;
  /** Plan-tier cap, enforced server-side BEFORE the Claude call so future
   *  callers (webhooks, jobs, Shopify Flow) can't burn API credits past the
   *  merchant's paid limit. Pass `Infinity` for unlimited plans, `0` to refuse
   *  outright. */
  maxPostsPerMonth: number;
}

/** Thrown when a generate call would exceed the merchant's monthly plan cap.
 *  Distinct from generic errors so callers can show an upgrade message. */
export class BlogPostCapReachedError extends Error {
  constructor(public readonly cap: number) {
    super(
      cap === 0
        ? "Blog post generation is not included in your plan."
        : `Monthly cap of ${cap} posts reached for your plan.`
    );
    this.name = "BlogPostCapReachedError";
  }
}

export interface GeneratedBlogPostDraft {
  title: string;
  excerpt: string;
  bodyHtml: string;
  tags: string[];
  metaTitle: string;
  metaDescription: string;
  wordCount: number;
}

const LENGTH_RANGES: Record<BlogPostLength, { min: number; max: number }> = {
  short: { min: 400, max: 700 },
  medium: { min: 700, max: 1200 },
  long: { min: 1200, max: 1800 },
};

const TONE_GUIDANCE: Record<BlogPostTone, string> = {
  informative:
    "Tone: informative and factual. Explain the topic clearly, cite specifics, avoid promotional language.",
  tutorial:
    "Tone: step-by-step tutorial. Use H2/H3 headings to delimit steps. Number major steps. Be concrete and actionable.",
  comparison:
    "Tone: comparative analysis. Lay out criteria, compare options on each criterion, end with a recommendation matrix or clear summary.",
  buying_guide:
    "Tone: buying guide. Help the reader decide what to buy. Cover what to look for, common mistakes, who each option is best for.",
};

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert e-commerce content writer specializing in SEO and AI search optimization (GEO/AEO).

You write blog posts that:
1. Answer specific questions a real shopper might ask an AI assistant (ChatGPT, Perplexity, Claude)
2. Are factually grounded with concrete details (numbers, materials, comparisons, specifications)
3. Mention the merchant's products naturally when genuinely relevant, never shoehorned
4. Use H2/H3 headings to structure content for both human readers and AI parsers
5. Include a clear introduction and a concise conclusion
6. Avoid generic marketing fluff ('premium quality', 'perfect for any occasion', 'elevate your', 'unlock', 'dive into', 'discover')

CRITICAL constraints:
- Never use em-dashes (the long horizontal dash). Use commas, colons, or periods for breaks instead.
- Output strictly valid HTML in the bodyHtml field. Allowed tags: <p>, <h2>, <h3>, <h4>, <strong>, <em>, <ul>, <ol>, <li>, <blockquote>, <br>. No inline styles, no <script>, no <iframe>, no <a> tags.
- Output strictly as a single JSON object matching the schema below. No code fences, no preamble, no labels.

Output schema:
{
  "title": "string, 40 to 80 characters, the H1 / page title",
  "excerpt": "string, 1-2 sentence summary that appears in blog index pages, 100-200 chars",
  "bodyHtml": "string, the full article body in clean HTML using only allowed tags",
  "tags": ["array", "of", "3-5", "tag", "strings"],
  "metaTitle": "string, 30-60 chars, the <title> tag (can differ from the H1 to optimize for search)",
  "metaDescription": "string, 120-158 chars, the meta description for search-result snippets"
}`;

// ─── Generate ─────────────────────────────────────────────────────────────────

/** Generate a blog-post draft using Claude. Does NOT persist; the caller
 *  (the route action) writes the row to BlogPost after this returns.
 *
 *  Enforces the monthly plan cap server-side. Throws `BlogPostCapReachedError`
 *  before the Claude call when the cap would be exceeded so we don't waste
 *  Anthropic credits on a request we won't deliver. */
export async function generateBlogPostDraft(
  storeId: string,
  options: GenerateBlogPostOptions
): Promise<GeneratedBlogPostDraft> {
  if (options.maxPostsPerMonth <= 0) {
    throw new BlogPostCapReachedError(0);
  }
  if (options.maxPostsPerMonth !== Infinity) {
    const used = await countBlogPostsThisMonth(storeId);
    if (used >= options.maxPostsPerMonth) {
      throw new BlogPostCapReachedError(options.maxPostsPerMonth);
    }
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { shopName: true },
  });
  if (!store) throw new Error("Store not found.");

  // Pull a representative sample of the merchant's catalog so Claude can
  // mention real products by name when they fit. Capped to keep token cost
  // bounded - Claude doesn't need all 1000 SKUs to understand the niche.
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true, handle: true },
    take: 30,
    orderBy: { aiReadinessScore: "desc" },
  });

  const length = options.length ?? "medium";
  const tone = options.tone ?? "informative";
  const { min: minWords, max: maxWords } = LENGTH_RANGES[length];

  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");

  const keywordHint =
    options.targetKeywords && options.targetKeywords.length > 0
      ? `\nTarget keywords (weave these in naturally, don't keyword-stuff): ${options.targetKeywords.join(", ")}`
      : "";

  const userContent = `Store name: ${store.shopName}

Catalog (up to 30 active products, for context only, mention naturally when relevant):
${productLines || "(no products yet)"}

Topic the post should address: ${options.topic}

${TONE_GUIDANCE[tone]}
Target length: ${minWords} to ${maxWords} words.${keywordHint}

Write the full post now and return the JSON object.`;

  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        // Long max_tokens because a 1500-word article + meta + JSON wrapper
        // can run 4-5k tokens. Cheap and bounded.
        max_tokens: 6000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    "generateBlogPostDraft"
  );

  const block = message.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text response.");
  }

  // Strip code fences if Claude wrapped the JSON anyway (we tell it not to,
  // but defending against fence-creep is cheap).
  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: {
    title?: unknown;
    excerpt?: unknown;
    bodyHtml?: unknown;
    tags?: unknown;
    metaTitle?: unknown;
    metaDescription?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Couldn't parse the AI's blog post response. Try again, possibly with a shorter topic."
    );
  }

  // Validate required string fields exist and are non-empty.
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const excerpt =
    typeof parsed.excerpt === "string" ? parsed.excerpt.trim() : "";
  const rawBody =
    typeof parsed.bodyHtml === "string" ? parsed.bodyHtml.trim() : "";
  const metaTitle =
    typeof parsed.metaTitle === "string" ? parsed.metaTitle.trim() : "";
  const metaDescription =
    typeof parsed.metaDescription === "string"
      ? parsed.metaDescription.trim()
      : "";
  const tags =
    Array.isArray(parsed.tags) && parsed.tags.every((t) => typeof t === "string")
      ? (parsed.tags as string[])
          .map((t) => t.trim())
          .filter((t) => t.length > 0 && t.length < 60)
          .slice(0, 8)
      : [];

  if (!title || !rawBody) {
    throw new Error(
      "AI returned an empty title or body. Try a more specific topic."
    );
  }

  // Sanitize the body. The audit-engine's sanitizer keeps allowed formatting
  // tags + strips everything else (no <script>, no inline handlers, no <a>
  // with arbitrary hrefs). Blog post bodies need a couple more tags than
  // product descriptions do, so we extend the allowlist inline here for
  // headings + blockquote.
  const bodyHtml = stripEmDashes(sanitizeBlogBody(rawBody));
  const wordCount = countWords(bodyHtml);

  return {
    // Defense in depth on the no-em-dash rule. The prompt forbids them but
    // Claude can ignore prompts; this strip is unconditional.
    title: stripEmDashes(title).slice(0, 200),
    excerpt: stripEmDashes(excerpt).slice(0, 400),
    bodyHtml,
    tags: tags.map(stripEmDashes),
    metaTitle: stripEmDashes(metaTitle).slice(0, 120),
    metaDescription: stripEmDashes(metaDescription).slice(0, 320),
    wordCount,
  };
}

/** Hard guarantee: no em-dash ever reaches Shopify or the merchant's blog,
 *  even if Claude ignores the "no em-dashes" instruction in the system
 *  prompt. Replaces em-dash plus its surrounding whitespace with a single
 *  ", " (the typical reading without the typographic flourish). */
function stripEmDashes(text: string): string {
  return text.replace(/\s*—\s*/g, ", ").trim();
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

// Allowed HTML tags for blog post bodies. Superset of what
// sanitizeLlmHtml accepts (which is tuned for product descriptions).
// Adds headings and inline emphasis tags that blog posts legitimately need.
const ALLOWED_BLOG_TAGS = new Set([
  "p", "br",
  "h2", "h3", "h4",
  "strong", "b", "em", "i",
  "ul", "ol", "li",
  "blockquote",
]);

function sanitizeBlogBody(html: string): string {
  // First pass: strip script / style / iframe AND their contents.
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");

  // Second pass: any tag NOT in the allowlist gets unwrapped (its content
  // stays). Allowed tags get reduced to bare open/close, dropping all
  // attributes (no inline styles, no on*, no href).
  cleaned = cleaned.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g,
    (match: string, tag: string) => {
      const t = tag.toLowerCase();
      if (!ALLOWED_BLOG_TAGS.has(t)) return "";
      return match.startsWith("</") ? `</${t}>` : `<${t}>`;
    }
  );

  // Defense in depth: run the existing audit-engine sanitizer too. Today its
  // allowlist is a subset of ALLOWED_BLOG_TAGS so this is effectively a no-op,
  // but if either allowlist drifts in the future a forbidden tag that slipped
  // past one layer would still be caught here.
  cleaned = sanitizeLlmHtml(cleaned);

  return cleaned.trim();
}

function countWords(html: string): number {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(" ").length;
}

// ─── Usage / plan cap ─────────────────────────────────────────────────────────

/** Count blog posts that count toward the monthly cap. Includes deleted and
 *  failed rows (Anthropic was billed for those calls) but EXCLUDES in-flight
 *  "generating" placeholders. The route inserts a placeholder before the
 *  Claude call as concurrency protection (see app.blog-generator.tsx); that
 *  placeholder is "the call this caller is making" and we shouldn't double
 *  count it against itself. Once the placeholder transitions to "draft" or
 *  "failed", it counts on subsequent calls. */
export async function countBlogPostsThisMonth(storeId: string): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  return prisma.blogPost.count({
    where: {
      storeId,
      createdAt: { gte: startOfMonth },
      status: { not: "generating" },
    },
  });
}

// ─── Shopify publish ──────────────────────────────────────────────────────────

const ARTICLE_CREATE_MUTATION = `#graphql
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id title handle }
      userErrors { field message }
    }
  }
`;

const BLOGS_QUERY = `#graphql
  query GetBlogs {
    blogs(first: 10) {
      edges { node { id title handle } }
    }
  }
`;

export interface PublishResult {
  ok: boolean;
  shopifyArticleId?: string;
  shopifyBlogId?: string;
  error?: string;
}

/** Look up the merchant's first blog (most stores have exactly one - "News").
 *  Returns null if the store has no blogs configured. */
async function getPrimaryBlogId(admin: AdminApiContext): Promise<string | null> {
  const response = await admin.graphql(BLOGS_QUERY);
  const json = (await response.json()) as {
    data?: {
      blogs?: { edges?: Array<{ node?: { id?: string } }> };
    };
  };
  const id = json.data?.blogs?.edges?.[0]?.node?.id ?? null;
  return id;
}

/** Publish a generated post to the merchant's primary Shopify blog. Returns
 *  the article GID on success so the caller can stamp it on our BlogPost
 *  row + mark it as published.
 *
 *  `storeId` is required and enforced via `findFirst` so this function is
 *  safe-by-default against cross-tenant publish attempts. Callers (routes,
 *  webhooks, future cron jobs) cannot accidentally publish another store's
 *  draft by passing only an ID. */
export async function publishBlogPostToShopify(
  postId: string,
  storeId: string,
  admin: AdminApiContext
): Promise<PublishResult> {
  const post = await prisma.blogPost.findFirst({
    where: { id: postId, storeId },
  });
  if (!post) return { ok: false, error: "Blog post not found." };
  if (post.status === "published") {
    return { ok: false, error: "This post is already published." };
  }
  if (post.status !== "draft") {
    // Reject "generating" or "failed" placeholder rows. The merchant can only
    // publish a finished draft.
    return {
      ok: false,
      error: "This post isn't ready to publish yet.",
    };
  }

  const blogId = await getPrimaryBlogId(admin);
  if (!blogId) {
    return {
      ok: false,
      error:
        "Your Shopify store has no blogs configured. Create one in Online Store > Blog posts, then try again.",
    };
  }

  // Shopify's `articleCreate` input requires `author: { name }` (2025-07).
  // We default to the store/brand name so the article reads as authored by
  // the merchant's store. The merchant can edit it in Shopify's admin after
  // publish if they want a personal byline. We deliberately don't query the
  // user session for firstName/lastName because the action runs on an
  // offline session that doesn't carry user info.
  const storeForAuthor = await prisma.store.findUnique({
    where: { id: storeId },
    select: { shopName: true },
  });
  const authorName = storeForAuthor?.shopName?.trim() || "Store";

  // Shopify's `body` field accepts HTML directly, NOT a separate `bodyHtml`
  // (the API renamed at some point; 2025-07 uses `body`).
  const articleInput: Record<string, unknown> = {
    blogId,
    title: post.title,
    body: post.bodyHtml,
    summary: post.excerpt,
    isPublished: true,
    author: { name: authorName },
  };
  if (Array.isArray(post.tags) && post.tags.length > 0) {
    articleInput.tags = post.tags as string[];
  }

  try {
    const response = await admin.graphql(ARTICLE_CREATE_MUTATION, {
      variables: { article: articleInput },
    });
    const json = (await response.json()) as {
      errors?: { message?: string }[];
      data?: {
        articleCreate?: {
          article?: { id?: string };
          userErrors?: { field?: string[]; message?: string }[];
        };
      };
    };
    // Top-level GraphQL errors (auth, scope, schema). Surface before reading
    // data.* because data is likely null in this branch.
    if (json.errors && json.errors.length > 0) {
      const top = json.errors[0]?.message ?? "Shopify rejected the request";
      console.error(
        `[GEO Rise blog] articleCreate GraphQL errors for post ${postId}:`,
        json.errors
      );
      return {
        ok: false,
        error: /scope|permission|access/i.test(top)
          ? "Your Shopify app permissions don't include write_content. Reinstall the app to grant it."
          : `Shopify rejected the request: ${top}`,
      };
    }
    const userErrors = json.data?.articleCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      const messages = userErrors
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ");
      console.error(
        `[GEO Rise blog] articleCreate userErrors for post ${postId}:`,
        userErrors
      );
      return {
        ok: false,
        error: `Shopify rejected the post: ${messages || "unknown error"}`,
      };
    }
    const articleId = json.data?.articleCreate?.article?.id;
    if (!articleId) {
      return {
        ok: false,
        error: "Shopify didn't return an article ID. Try again.",
      };
    }

    await prisma.blogPost.update({
      where: { id: postId },
      data: {
        status: "published",
        shopifyArticleId: articleId,
        shopifyBlogId: blogId,
        publishedAt: new Date(),
      },
    });

    return { ok: true, shopifyArticleId: articleId, shopifyBlogId: blogId };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(
      `[GEO Rise blog] publish to Shopify threw for post ${postId}:`,
      err
    );
    // Shopify's GraphQL client throws on top-level schema validation failures
    // (e.g. missing required input). Map common cases to merchant-safe text.
    if (/scope|permission|access denied|write_content/i.test(raw)) {
      return {
        ok: false,
        error:
          "Your Shopify app doesn't have permission to create blog posts. Reinstall the app to grant write_content access.",
      };
    }
    if (/Variable .* type .*Input.*was provided invalid value/i.test(raw)) {
      return {
        ok: false,
        error:
          "Shopify's blog post API rejected this request. Please report this to GEO Rise support, we'll patch it.",
      };
    }
    if (/timeout|ETIMEDOUT|ECONNRESET/i.test(raw)) {
      return {
        ok: false,
        error: "Shopify didn't respond in time. Please try again in a moment.",
      };
    }
    return {
      ok: false,
      error: "Couldn't publish to Shopify. Please try again in a moment.",
    };
  }
}

import Anthropic from "@anthropic-ai/sdk";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { withRetry } from "./ai-retry.server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GenerateProductFaqOptions {
  /** Bare numeric Shopify product id, same format the Product model stores.
   *  Converted to gid://shopify/Product/<id> at metafield write time. */
  shopifyProductId: string;
  /** Plan-tier cap, enforced server-side BEFORE the Claude call so future
   *  callers (webhooks, jobs, Shopify Flow) can't burn API credits past the
   *  merchant's paid limit. Pass `Infinity` for unlimited plans, `0` to refuse
   *  outright. */
  maxPerMonth: number;
}

/** Thrown when a generate call would exceed the merchant's monthly plan cap.
 *  Distinct from generic errors so callers can show an upgrade message. */
export class FaqCapReachedError extends Error {
  constructor(public readonly cap: number) {
    super(
      cap === 0
        ? "FAQ generation is not included in your plan."
        : `Monthly cap of ${cap} FAQ sets reached for your plan.`
    );
    this.name = "FaqCapReachedError";
  }
}

export interface FaqDraft {
  questions: { question: string; answer: string }[];
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert e-commerce copywriter who writes product FAQs optimized for AI search engines (ChatGPT, Perplexity, Claude) and for real shoppers.

You write FAQs that:
1. Answer real questions a shopper would ask before buying this specific product (shipping, sizing, materials, care, compatibility, returns)
2. Lead with the answer in the first sentence (answer-first phrasing), then add the supporting detail
3. Are concrete and specific to the product, never generic filler that could apply to any store
4. Keep each answer to roughly 40 to 60 words
5. Produce 4 to 6 FAQs, no more

CRITICAL constraints:
- Never use em-dashes (the long horizontal dash). Use commas, colons, or periods for breaks instead.
- Do not invent facts you were not given (exact prices, warranty lengths, shipping days). If a common question needs a detail you don't have, answer in general terms the merchant can keep as-is or edit.
- Output strictly as a single JSON object matching the schema below. No code fences, no preamble, no labels.

Output schema:
{
  "faqs": [
    { "question": "string, a real shopper question ending in a question mark", "answer": "string, answer-first, 40 to 60 words" }
  ]
}`;

// ─── Generate ─────────────────────────────────────────────────────────────────

/** Generate an answer-first product FAQ draft using Claude. Does NOT persist;
 *  the caller (the route action) writes the row to ProductFaq after this
 *  returns.
 *
 *  Enforces the monthly plan cap server-side. Throws `FaqCapReachedError`
 *  before the Claude call when the cap would be exceeded so we don't waste
 *  Anthropic credits on a request we won't deliver. Generation is cache-only:
 *  it reads the merchant's already-synced Product row for context and never
 *  touches the Shopify Admin API. Only publishing writes to Shopify. */
export async function generateProductFaqDraft(
  storeId: string,
  options: GenerateProductFaqOptions
): Promise<FaqDraft> {
  if (options.maxPerMonth <= 0) {
    throw new FaqCapReachedError(0);
  }
  if (options.maxPerMonth !== Infinity) {
    const used = await countProductFaqsThisMonth(storeId);
    if (used >= options.maxPerMonth) {
      throw new FaqCapReachedError(options.maxPerMonth);
    }
  }

  // Pull the product's cached context. Generation stays cache-only; a product
  // that was never audited or synced isn't here, so we fall back to a thin
  // prompt (title only). The route surfaces the "run an audit first" hint.
  const product = await prisma.product.findUnique({
    where: {
      storeId_shopifyProductId: {
        storeId,
        shopifyProductId: options.shopifyProductId,
      },
    },
    select: {
      title: true,
      description: true,
      productType: true,
      vendor: true,
    },
  });

  if (!product) {
    throw new Error(
      "This product isn't in your synced catalog yet. Run an AI Audit to sync it, then generate FAQs."
    );
  }

  // Build the context block from whatever fields the Product row actually has.
  // Description can run long; cap it so token cost stays bounded (Claude needs
  // the gist, not the full body).
  const contextLines: string[] = [`Product title: ${product.title}`];
  if (product.vendor) contextLines.push(`Brand: ${product.vendor}`);
  if (product.productType) contextLines.push(`Product type: ${product.productType}`);
  if (product.description && product.description.trim().length > 0) {
    const desc = product.description
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500);
    if (desc) contextLines.push(`Description: ${desc}`);
  }

  const userContent = `${contextLines.join("\n")}

Write 4 to 6 answer-first FAQs for this product now and return the JSON object.`;

  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        // 4-6 short FAQs plus the JSON wrapper stays well under this; bounded
        // and cheap.
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    "generateProductFaqDraft"
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

  let parsed: { faqs?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Couldn't parse the AI's FAQ response. Try generating again."
    );
  }

  if (!Array.isArray(parsed.faqs) || parsed.faqs.length === 0) {
    throw new Error(
      "AI returned no usable FAQs. Try generating again, ideally after running an audit so the product has richer detail."
    );
  }

  // Validate each entry: non-empty string question + answer. Drop malformed
  // entries, trim, strip em-dashes (defense in depth on the no-em-dash rule),
  // enforce length caps, then cap at 6 FAQs.
  const questions = (parsed.faqs as unknown[])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as { question?: unknown; answer?: unknown };
      const question =
        typeof e.question === "string" ? stripEmDashes(e.question.trim()) : "";
      const answer =
        typeof e.answer === "string" ? stripEmDashes(e.answer.trim()) : "";
      if (!question || !answer) return null;
      return {
        question: question.slice(0, 200),
        answer: answer.slice(0, 600),
      };
    })
    .filter((q): q is { question: string; answer: string } => q !== null)
    .slice(0, 6);

  if (questions.length === 0) {
    throw new Error(
      "AI returned no usable FAQs. Try generating again."
    );
  }

  return { questions };
}

/** Hard guarantee: no em-dash ever reaches Shopify or the merchant's
 *  storefront, even if Claude ignores the "no em-dashes" instruction in the
 *  system prompt. Replaces em-dash plus its surrounding whitespace with a
 *  single ", " (the typical reading without the typographic flourish).
 *
 *  Matches the HTML-entity spellings too (&mdash; / &#8212; / &#x2014;) so an
 *  entity-encoded dash can't slip through. A leading match would otherwise
 *  leave a dangling ", " prefix (trim removes whitespace, not the inserted
 *  comma), so that artifact is stripped last. Mirrors the identical helper in
 *  blog-generation.server.ts, which does not export it. */
function stripEmDashes(text: string): string {
  return text
    .replace(/\s*(?:—|&mdash;|&#8212;|&#x2014;)\s*/gi, ", ")
    .trim()
    .replace(/^,\s*/, "");
}

// ─── Usage / plan cap ─────────────────────────────────────────────────────────

/** Count product FAQ runs that count toward the monthly cap. Includes deleted
 *  and failed rows (Anthropic was billed for those calls) but EXCLUDES in-flight
 *  "generating" placeholders. The route inserts a placeholder before the Claude
 *  call as concurrency protection (see app.faq-generator.tsx); that placeholder
 *  is "the call this caller is making" and we shouldn't double count it against
 *  itself. Once the placeholder transitions to "draft" or "failed", it counts on
 *  subsequent calls. */
export async function countProductFaqsThisMonth(
  storeId: string
): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  return prisma.productFaq.count({
    where: {
      storeId,
      createdAt: { gte: startOfMonth },
      status: { not: "generating" },
    },
  });
}

// ─── Shopify metafield write ────────────────────────────────────────────────

const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation FaqMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation FaqMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

const FAQ_METAFIELD_NAMESPACE = "geo_rise";
const FAQ_METAFIELD_KEY = "faq";

export interface PublishResult {
  ok: boolean;
  error?: string;
  /** Set when the metafield WAS written on Shopify but our own DB row couldn't
   *  be updated. `ok` stays true; callers should show this instead of the
   *  normal success message so the merchant doesn't retry needlessly. */
  warning?: string;
}

/** Map a thrown Shopify-client error to a merchant-safe PublishResult.
 *  The Shopify GraphQL client throws on top-level errors (auth, scope, schema
 *  validation, network); the definition-create and metafieldsSet calls can hit
 *  the same failure modes, so they share this mapping. */
function mapFaqPublishThrow(err: unknown, faqId: string): PublishResult {
  const raw = err instanceof Error ? err.message : String(err);
  console.error(
    `[GEO Rise faq] metafield write to Shopify threw for faq ${faqId}:`,
    err
  );
  if (/scope|permission|access denied|write_products/i.test(raw)) {
    return {
      ok: false,
      error:
        "Your Shopify app doesn't have permission to write product metafields. Reinstall the app to grant write_products access.",
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
    error: "Couldn't write the FAQ to Shopify. Please try again in a moment.",
  };
}

/** Ensure the geo_rise.faq product metafield definition exists for this store.
 *  Created lazily on the store's first publish. A duplicate create returns a
 *  TAKEN userError, which we treat as success (the definition is there, another
 *  publish or app install made it). Returns a PublishResult only on hard
 *  failure; on success returns null so the caller proceeds to metafieldsSet. */
async function ensureFaqMetafieldDefinition(
  admin: AdminApiContext,
  storeId: string,
  faqDefinitionAlreadyCreated: boolean,
  faqId: string
): Promise<PublishResult | null> {
  if (faqDefinitionAlreadyCreated) return null;

  // Flat access form (2025-07): access is `{ admin, storefront }`, NOT nested.
  // storefront PUBLIC_READ is what lets the theme extension read the value in
  // Liquid to render the FAQPage JSON-LD.
  const definition = {
    namespace: FAQ_METAFIELD_NAMESPACE,
    key: FAQ_METAFIELD_KEY,
    name: "GEO Rise FAQ",
    type: "json",
    ownerType: "PRODUCT",
    access: { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" },
  };

  let taken = false;
  try {
    const response = await admin.graphql(
      METAFIELD_DEFINITION_CREATE_MUTATION,
      { variables: { definition } }
    );
    const json = (await response.json()) as {
      errors?: { message?: string }[];
      data?: {
        metafieldDefinitionCreate?: {
          createdDefinition?: { id?: string };
          userErrors?: { field?: string[]; message?: string; code?: string }[];
        };
      };
    };
    if (json.errors && json.errors.length > 0) {
      const top =
        json.errors[0]?.message ?? "Shopify rejected the request";
      console.error(
        `[GEO Rise faq] metafieldDefinitionCreate GraphQL errors for faq ${faqId}:`,
        json.errors
      );
      return {
        ok: false,
        error: /scope|permission|access/i.test(top)
          ? "Your Shopify app permissions don't include write_products. Reinstall the app to grant it."
          : `Shopify rejected the request: ${top}`,
      };
    }
    const userErrors =
      json.data?.metafieldDefinitionCreate?.userErrors ?? [];
    // A definition that already exists returns a TAKEN userError. That is the
    // happy path on the second+ store publish (or if the app was reinstalled):
    // the definition is present, so treat it as success.
    taken = userErrors.some((e) => e.code === "TAKEN");
    if (userErrors.length > 0 && !taken) {
      const messages = userErrors
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ");
      console.error(
        `[GEO Rise faq] metafieldDefinitionCreate userErrors for faq ${faqId}:`,
        userErrors
      );
      return {
        ok: false,
        error: `Shopify rejected the FAQ metafield setup: ${messages || "unknown error"}`,
      };
    }
  } catch (err) {
    return mapFaqPublishThrow(err, faqId);
  }

  // Definition exists now (freshly created or already TAKEN). Flip the flag so
  // later publishes skip this call. A failure to persist the flag is harmless:
  // next publish just re-runs definitionCreate and hits the TAKEN success path.
  try {
    await prisma.store.update({
      where: { id: storeId },
      data: { faqMetafieldDefinitionCreated: true },
    });
  } catch (err) {
    console.warn(
      `[GEO Rise faq] couldn't persist faqMetafieldDefinitionCreated for store ${storeId} (harmless, TAKEN will cover next time):`,
      err
    );
  }

  return null;
}

/** Write a store's own metafield value with the metafieldsSet mutation. Shared
 *  by publish (value = the FAQ questions) and unpublish (value = "[]"). Returns
 *  null on success, or a merchant-safe PublishResult on failure. */
async function writeFaqMetafield(
  admin: AdminApiContext,
  shopifyProductId: string,
  value: string,
  faqId: string
): Promise<PublishResult | null> {
  const ownerId = `gid://shopify/Product/${shopifyProductId}`;
  const metafields = [
    {
      ownerId,
      namespace: FAQ_METAFIELD_NAMESPACE,
      key: FAQ_METAFIELD_KEY,
      type: "json",
      value,
    },
  ];

  try {
    const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
      variables: { metafields },
    });
    const json = (await response.json()) as {
      errors?: { message?: string }[];
      data?: {
        metafieldsSet?: {
          metafields?: { id?: string }[];
          userErrors?: { field?: string[]; message?: string; code?: string }[];
        };
      };
    };
    // Top-level GraphQL errors (auth, scope, schema). Surface before reading
    // data.* because data is likely null in this branch.
    if (json.errors && json.errors.length > 0) {
      const top = json.errors[0]?.message ?? "Shopify rejected the request";
      console.error(
        `[GEO Rise faq] metafieldsSet GraphQL errors for faq ${faqId}:`,
        json.errors
      );
      return {
        ok: false,
        error: /scope|permission|access/i.test(top)
          ? "Your Shopify app permissions don't include write_products. Reinstall the app to grant it."
          : `Shopify rejected the request: ${top}`,
      };
    }
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      const messages = userErrors
        .map((e) => e.message)
        .filter(Boolean)
        .join("; ");
      console.error(
        `[GEO Rise faq] metafieldsSet userErrors for faq ${faqId}:`,
        userErrors
      );
      const joined = messages.toLowerCase();
      return {
        ok: false,
        error: /scope|permission|access/i.test(joined)
          ? "Your Shopify app permissions don't include write_products. Reinstall the app to grant it."
          : `Shopify rejected the FAQ: ${messages || "unknown error"}`,
      };
    }
    const setId = json.data?.metafieldsSet?.metafields?.[0]?.id;
    if (!setId) {
      return {
        ok: false,
        error: "Shopify didn't confirm the FAQ metafield. Try again.",
      };
    }
  } catch (err) {
    return mapFaqPublishThrow(err, faqId);
  }

  return null;
}

/** Publish a generated FAQ set to the product's storefront metafield. Writes
 *  geo_rise.faq (JSON) on the product so the theme extension renders it as
 *  FAQPage JSON-LD. Ensures the metafield definition exists once per shop.
 *
 *  `storeId` is required and enforced via `findFirst` so this function is
 *  safe-by-default against cross-tenant publish attempts.
 *
 *  Always returns a PublishResult, never throws: the route action relies on
 *  that to render a toast instead of letting the error boundary replace the
 *  merchant's page. */
export async function publishFaqToStorefront(
  admin: AdminApiContext,
  storeId: string,
  faqId: string
): Promise<PublishResult> {
  const faq = await prisma.productFaq.findFirst({
    where: { id: faqId, storeId },
  });
  if (!faq) return { ok: false, error: "FAQ set not found." };
  if (faq.status === "generating") {
    return { ok: false, error: "This FAQ set isn't ready to publish yet." };
  }
  if (faq.status === "deleted") {
    return { ok: false, error: "This FAQ set was deleted." };
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { faqMetafieldDefinitionCreated: true },
  });
  if (!store) return { ok: false, error: "Store not found." };

  const defResult = await ensureFaqMetafieldDefinition(
    admin,
    storeId,
    store.faqMetafieldDefinitionCreated,
    faqId
  );
  if (defResult) return defResult;

  const setResult = await writeFaqMetafield(
    admin,
    faq.shopifyProductId,
    JSON.stringify(faq.questions),
    faqId
  );
  if (setResult) return setResult;

  // Success-side bookkeeping. The metafield is written; if this row update
  // fails, the storefront already shows the FAQ, so return ok with a warning
  // instead of an error that invites a needless retry.
  try {
    await prisma.productFaq.update({
      where: { id: faqId, storeId },
      data: { status: "published", publishedAt: new Date() },
    });
  } catch (err) {
    console.error(
      `[GEO Rise faq] faq ${faqId} metafield was written on Shopify but the local status update failed; row is still "${faq.status}":`,
      err
    );
    return {
      ok: true,
      warning:
        "The FAQ is live on your product, but GEO Rise couldn't update its records. It may still show as a draft here.",
    };
  }

  return { ok: true };
}

/** Unpublish a FAQ set: overwrite the product's geo_rise.faq metafield with an
 *  empty JSON array so the theme extension's size gate hides it (an empty array
 *  emits no FAQPage). Sets the row back to "draft" so the merchant can edit or
 *  re-publish. Never throws; returns a PublishResult. */
export async function unpublishFaqFromStorefront(
  admin: AdminApiContext,
  storeId: string,
  faqId: string
): Promise<PublishResult> {
  const faq = await prisma.productFaq.findFirst({
    where: { id: faqId, storeId },
  });
  if (!faq) return { ok: false, error: "FAQ set not found." };
  if (faq.status !== "published") {
    return { ok: false, error: "This FAQ set isn't published." };
  }

  const setResult = await writeFaqMetafield(
    admin,
    faq.shopifyProductId,
    "[]",
    faqId
  );
  if (setResult) return setResult;

  // Success-side bookkeeping. The metafield is cleared; if this row update
  // fails, the storefront no longer shows the FAQ, so return ok with a warning.
  try {
    await prisma.productFaq.update({
      where: { id: faqId, storeId },
      data: { status: "draft", publishedAt: null },
    });
  } catch (err) {
    console.error(
      `[GEO Rise faq] faq ${faqId} metafield was cleared on Shopify but the local status update failed; row is still "published":`,
      err
    );
    return {
      ok: true,
      warning:
        "The FAQ was removed from your product, but GEO Rise couldn't update its records. It may still show as published here.",
    };
  }

  return { ok: true };
}

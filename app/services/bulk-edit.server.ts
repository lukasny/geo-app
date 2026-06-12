import prisma from "~/db.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  fetchProductMediaImages,
  updateMediaAltText,
  updateProductSeo,
} from "~/services/product-mutations.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BulkEditOptions {
  /** Prisma Product ids (cuids) selected in the grid. Capped at
   *  MAX_BULK_PRODUCTS server-side regardless of what the client sends. */
  productIds: string[];
  /** Template for the SEO/meta title, e.g. "{title} | {shop}". */
  metaTitleTemplate?: string;
  /** Template for image alt text. Applied only to images that currently
   *  have EMPTY alt text; existing alt text is never overwritten. */
  altTextTemplate?: string;
}

export interface BulkEditSummary {
  /** Products where at least one write succeeded. */
  updated: number;
  /** Products where every attempted write failed. */
  failed: number;
  /** Products where nothing needed changing (e.g. all images already had
   *  alt text, or a template rendered empty for this product). */
  skipped: number;
  /** True when the loop stopped early after consecutive failures. */
  aborted: boolean;
  /** Field-level counts for the result toast. */
  metaTitlesSet: number;
  altTextsSet: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard server-side cap per apply: each product costs roughly 2-3 Shopify
 *  API calls and the apply runs as one blocking POST, so this keeps the
 *  request comfortably inside platform timeouts. */
export const MAX_BULK_PRODUCTS = 50;

// Same circuit-breaker threshold as autoFixIssues: persistent failures
// (rate limit storm, revoked token) shouldn't burn the whole batch.
const MAX_CONSECUTIVE_FAILURES = 3;

/** Variables available in templates, documented in the UI helper text. */
export const TEMPLATE_VARIABLES = [
  "title",
  "vendor",
  "type",
  "handle",
  "price",
  "shop",
] as const;

// ─── Template rendering ───────────────────────────────────────────────────────

/** Substitute {variable} placeholders. Unknown variables and null values
 *  render as empty strings; whitespace collapses so missing values don't
 *  leave double spaces or dangling separators ("{title} | " stays tidy
 *  only if the merchant writes it that way; we just collapse spaces). */
export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>
): string {
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/** Best-effort: close open issues this manual edit just resolved, matched
 *  by title fragment (the same fragments fixMetaIssue keys on). A future
 *  full audit rebuilds all AuditResult rows anyway. */
async function markMatchingIssuesFixed(
  storeId: string,
  productId: string,
  titleFragment: string
): Promise<void> {
  await prisma.auditResult.updateMany({
    where: {
      storeId,
      productId,
      fixed: false,
      title: { contains: titleFragment, mode: "insensitive" },
    },
    data: { fixed: true, fixedAt: new Date() },
  });
}

/** Apply template-based edits to the selected products, sequentially with
 *  pacing and a consecutive-failure circuit breaker. Caller must enforce
 *  the bulkOptimization plan flag BEFORE calling. */
export async function applyBulkEdit(
  storeId: string,
  admin: AdminApiContext,
  options: BulkEditOptions
): Promise<BulkEditSummary> {
  const metaTitleTemplate = options.metaTitleTemplate?.trim() || null;
  const altTextTemplate = options.altTextTemplate?.trim() || null;
  if (!metaTitleTemplate && !altTextTemplate) {
    throw new Error("Provide at least one template to apply.");
  }

  // Tenant isolation: client-sent ids are only honored when they belong to
  // this store. Unknown/foreign ids silently drop out of the findMany.
  const ids = [...new Set(options.productIds)].slice(0, MAX_BULK_PRODUCTS);
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, storeId },
  });

  // The cached Store.shopName is just the domain slug; the human-readable
  // name needs one live query, fetched once for the whole batch.
  let shopName = "";
  try {
    const response = await admin.graphql(
      `#graphql
       query GetShopName { shop { name } }`
    );
    const json = (await response.json()) as {
      data: { shop: { name: string } };
    };
    shopName = json.data.shop.name;
  } catch (err) {
    console.warn("[GEO Rise bulk-edit] shop name fetch failed, using slug:", err);
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { shopName: true },
    });
    shopName = store?.shopName ?? "";
  }

  const summary: BulkEditSummary = {
    updated: 0,
    failed: 0,
    skipped: 0,
    aborted: false,
    metaTitlesSet: 0,
    altTextsSet: 0,
  };
  let consecutiveFailures = 0;

  for (const product of products) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      summary.aborted = true;
      break;
    }

    const vars: Record<string, string | null> = {
      title: product.title,
      vendor: product.vendor,
      type: product.productType,
      handle: product.handle,
      price: product.price,
      shop: shopName,
    };

    let wroteSomething = false;
    let failedSomething = false;

    if (metaTitleTemplate) {
      const rendered = renderTemplate(metaTitleTemplate, vars);
      if (rendered.length === 0) {
        // Template produced nothing for this product (all-null variables).
        // Not a Shopify failure: skip the field without tripping the breaker.
        console.warn(
          `[GEO Rise bulk-edit] meta title template rendered empty for ${product.shopifyProductId}; field skipped`
        );
      } else {
        const write = await updateProductSeo(admin, product.shopifyProductId, {
          title: rendered,
        });
        if (write.result === "updated") {
          wroteSomething = true;
          summary.metaTitlesSet += 1;
          // Audit semantics: "has custom meta title" means it differs from
          // the product title (case-insensitive).
          const isCustom =
            rendered.toLowerCase() !== product.title.toLowerCase();
          await prisma.product.update({
            where: { id: product.id },
            data: { hasMetaTitle: isCustom },
          });
          if (isCustom) {
            await markMatchingIssuesFixed(storeId, product.id, "SEO title");
          }
        } else {
          failedSomething = true;
        }
      }
    }

    if (altTextTemplate) {
      const renderedAlt = renderTemplate(altTextTemplate, vars);
      if (renderedAlt.length === 0) {
        console.warn(
          `[GEO Rise bulk-edit] alt text template rendered empty for ${product.shopifyProductId}; field skipped`
        );
      } else {
        const media = await fetchProductMediaImages(
          admin,
          product.shopifyProductId
        );
        const missing = media
          .filter((m) => !m.alt || m.alt.trim() === "")
          .map((m) => ({ id: m.id, alt: renderedAlt }));
        if (missing.length > 0) {
          const write = await updateMediaAltText(
            admin,
            product.shopifyProductId,
            missing
          );
          if (write.result === "updated") {
            wroteSomething = true;
            summary.altTextsSet += missing.length;
            await prisma.product.update({
              where: { id: product.id },
              // 70 mirrors the auto-fix heuristic for template-grade alt text.
              data: { hasAltText: true, altTextQuality: 70 },
            });
            await markMatchingIssuesFixed(storeId, product.id, "alt text");
          } else {
            failedSomething = true;
          }
        }
      }
    }

    if (failedSomething && !wroteSomething) {
      summary.failed += 1;
      consecutiveFailures += 1;
    } else if (wroteSomething) {
      summary.updated += 1;
      consecutiveFailures = 0;
    } else {
      summary.skipped += 1;
      consecutiveFailures = 0;
    }

    // Pace between products - Shopify GraphQL rate-limit headroom (same
    // 300ms as autoFixIssues).
    await new Promise<void>((r) => setTimeout(r, 300));
  }

  return summary;
}

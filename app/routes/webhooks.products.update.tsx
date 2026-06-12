import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { generateLlmsTxt } from "../services/llms-generator.server";
import { requestLlmsRegeneration } from "../services/llms-regen-queue.server";
import { PLAN_LIMITS } from "../services/billing.shared";
import db from "../db.server";

// Handles both products/create and products/update topics
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} webhook for ${shop}`);

  const store = await db.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true, plan: true },
  });

  if (!store) return new Response();

  const product = payload as {
    id: number;
    title: string;
    handle: string;
    status: string;
    body_html: string | null;
    product_type: string;
    vendor: string;
    variants: { id: number; price: string }[];
    images: { src: string; alt: string | null }[];
  };

  // Audit engine stores product IDs as Shopify GraphQL GIDs
  // (e.g. "gid://shopify/Product/12345"). Product webhooks send the bare
  // numeric ID. Normalize to GID form here so findUnique actually matches.
  const shopifyProductId = `gid://shopify/Product/${product.id}`;

  // Update our Product record if it exists (don't create - audit engine handles that)
  const existing = await db.product.findUnique({
    where: {
      storeId_shopifyProductId: {
        storeId: store.id,
        shopifyProductId,
      },
    },
  });

  if (existing) {
    await db.product.update({
      where: { id: existing.id },
      data: {
        title: product.title,
        handle: product.handle,
        status: product.status,
        // Cleared fields must write through as null, not be skipped:
        // clearing description/type/vendor in the Shopify admin delivers
        // "" (or null) here, and `?? undefined` / `|| undefined` told
        // Prisma "leave unchanged", so the cache kept deleted values until
        // the next manual full audit and they leaked into bulk-edit
        // templates and Claude SEO prompts. `|| null` matches the audit
        // engine's upsert (the canonical cache write path).
        description: product.body_html || null,
        productType: product.product_type || null,
        vendor: product.vendor || null,
        // Kept as "skip when absent": a payload without variants says
        // nothing about price, unlike the cleared-string cases above.
        price: product.variants?.[0]?.price ?? undefined,
        imageCount: product.images?.length ?? 0,
        variantCount: product.variants?.length ?? 0,
      },
    });
  }

  // Regenerate every llms.txt file (default + markets) whose own settings
  // say on_change. Default first so the primary file is freshest; market
  // files are skipped when the plan no longer includes multi-market.
  const llmsFiles = await db.llmsFile.findMany({
    where: { storeId: store.id },
    select: { marketCode: true, autoRefresh: true, refreshInterval: true },
  });
  const toRefresh = llmsFiles
    .filter((f) => f.autoRefresh && f.refreshInterval === "on_change")
    .sort((a, b) =>
      a.marketCode === "default" ? -1 : b.marketCode === "default" ? 1 : 0
    );

  if (toRefresh.length > 0) {
    const planLimits =
      PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
    // Shopify marks the delivery failed without a 2xx within ~5 seconds,
    // and a multi-market store regenerates several full-catalog files
    // here. The queue runs the loop detached AND coalesces bursts (a bulk
    // edit fires one of these webhooks per mutated product).
    requestLlmsRegeneration(store.id, async () => {
      for (const file of toRefresh) {
        if (file.marketCode !== "default" && !planLimits.multiMarketLlmsTxt) {
          continue;
        }
        try {
          await generateLlmsTxt(store.id, {
            maxProducts: planLimits.maxProductsInLlmsTxt,
            marketCode: file.marketCode,
          });
          console.log(
            `[GEO Rise] Auto-regenerated llms.txt (${file.marketCode}) for ${shop} after product ${topic}`
          );
        } catch (err) {
          console.error(
            `[GEO Rise] Failed to auto-regenerate llms.txt (${file.marketCode}) for ${shop}:`,
            err
          );
        }
      }
    });
  }

  return new Response();
};

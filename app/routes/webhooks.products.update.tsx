import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { generateLlmsTxt } from "../services/llms-generator.server";
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

  // Update our Product record if it exists (don't create — audit engine handles that)
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
        description: product.body_html ?? undefined,
        productType: product.product_type || undefined,
        vendor: product.vendor || undefined,
        price: product.variants?.[0]?.price ?? undefined,
        imageCount: product.images?.length ?? 0,
        variantCount: product.variants?.length ?? 0,
      },
    });
  }

  // Regenerate llms.txt if the store has autoRefresh enabled
  const llmsFile = await db.llmsFile.findFirst({
    where: { storeId: store.id, marketCode: "default" },
    select: { autoRefresh: true, refreshInterval: true },
  });

  if (llmsFile?.autoRefresh && llmsFile.refreshInterval === "on_change") {
    try {
      const planLimits =
        PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
      await generateLlmsTxt(store.id, {
        maxProducts: planLimits.maxProductsInLlmsTxt,
      });
      console.log(`[GEO Rise] Auto-regenerated llms.txt for ${shop} after product ${topic}`);
    } catch (err) {
      console.error(`[GEO Rise] Failed to auto-regenerate llms.txt for ${shop}:`, err);
    }
  }

  return new Response();
};

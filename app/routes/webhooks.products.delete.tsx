import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { generateLlmsTxt } from "../services/llms-generator.server";
import { PLAN_LIMITS } from "../services/billing.shared";
import db from "../db.server";

// Handles products/delete - keeps our local Product cache in sync when a
// merchant deletes a product in Shopify. Cascade deletes any related
// AuditResult rows automatically (onDelete: Cascade in schema).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} webhook for ${shop}`);

  const store = await db.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true, plan: true },
  });
  if (!store) return new Response();

  // Shopify product/delete payload sends `id` as a bare numeric. The
  // audit engine stores Shopify product IDs as GraphQL GIDs, so we have
  // to normalize before looking up - same trick as in products.update.
  const product = payload as { id: number };
  const shopifyProductId = `gid://shopify/Product/${product.id}`;

  await db.product.deleteMany({
    where: { storeId: store.id, shopifyProductId },
  });

  // Refresh llms.txt if auto-refresh is on - the deleted product
  // shouldn't keep appearing in the public file.
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
      console.log(
        `[GEO Rise] Auto-regenerated llms.txt for ${shop} after product delete`
      );
    } catch (err) {
      console.error(
        `[GEO Rise] Failed to auto-regenerate llms.txt for ${shop} after delete:`,
        err
      );
    }
  }

  return new Response();
};

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} webhook for ${shop}`);

  // Delete all store data - Prisma cascade deletes handle related records
  const store = await db.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true, plan: true },
  });

  if (store) {
    // Ops trail: record the uninstall (with the plan at exit) BEFORE the
    // cascade delete. OpsEvent has no FK to Store, so the row survives the
    // deletion. Own try/catch: an ops write must never block the cleanup.
    try {
      await db.opsEvent.create({
        data: { type: "uninstall", shopDomain: shop, detail: store.plan },
      });
    } catch (err) {
      console.error(
        `[GEO Rise] Failed to record uninstall OpsEvent for ${shop}:`,
        err
      );
    }
    await db.store.delete({ where: { id: store.id } });
    console.log(`[GEO Rise] Deleted all data for uninstalled store: ${shop}`);
  }

  // Delete sessions (may already be gone if webhook fires twice)
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};

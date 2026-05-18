import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// GDPR: Delete all data for a shop, fired 48 hours after uninstall.
// The app/uninstalled webhook handles immediate deletion; this is the 48h follow-up.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} for ${shop} - final data redaction`);

  // Belt-and-suspenders: ensure store data is fully deleted
  const store = await db.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true },
  });

  if (store) {
    await db.store.delete({ where: { id: store.id } });
    console.log(`[GEO Rise] shop/redact: deleted remaining data for ${shop}`);
  }

  // Clean up any orphaned sessions
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};

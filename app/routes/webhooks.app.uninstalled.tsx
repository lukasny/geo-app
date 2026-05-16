import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`[GEO Rise] ${topic} webhook for ${shop}`);

  // Delete all store data — Prisma cascade deletes handle related records
  const store = await db.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true },
  });

  if (store) {
    await db.store.delete({ where: { id: store.id } });
    console.log(`[GEO Rise] Deleted all data for uninstalled store: ${shop}`);
  }

  // Delete sessions (may already be gone if webhook fires twice)
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};

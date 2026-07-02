import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: Delete personal data for a specific customer.
// GEO Rise stores no customer profile data, but once orders/paid is enabled it
// writes AiTrafficEvent rows keyed by order gid (with orderRevenue/orderCurrency).
// The payload's orders_to_redact lists numeric order ids for those events, so we
// map each to gid://shopify/Order/<id> and delete the matching rows for this shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const body = payload as { orders_to_redact?: number[] };
  const orderIds = body?.orders_to_redact ?? [];

  if (orderIds.length === 0) {
    console.log(
      `[GEO Rise] ${topic} for ${shop} - no orders_to_redact, nothing to delete`
    );
    return new Response();
  }

  const gids = orderIds.map((id) => `gid://shopify/Order/${id}`);
  const { count } = await prisma.aiTrafficEvent.deleteMany({
    where: {
      store: { shopifyDomain: shop },
      orderId: { in: gids },
    },
  });

  console.log(
    `[GEO Rise] ${topic} for ${shop} - deleted ${count} AiTrafficEvent row(s) for ${gids.length} order(s)`
  );
  return new Response();
};

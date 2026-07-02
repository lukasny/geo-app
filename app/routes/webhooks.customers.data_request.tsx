import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR: Merchant requests the data we hold about one of their customers.
// GEO Rise stores no customer profile data. The one place a customer can appear
// is AiTrafficEvent rows (order gid + AI-referral revenue) once orders/paid is
// enabled. The payload's orders_requested lists numeric order ids, so we look up
// any matching rows for this shop and log a structured summary as the handled
// record. We cannot email the merchant from here; the logged summary is the
// minimum honest handling instead of asserting no data is held.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const body = payload as { orders_requested?: number[] };
  const orderIds = body?.orders_requested ?? [];

  if (orderIds.length === 0) {
    console.log(
      `[GEO Rise] ${topic} for ${shop} - no orders_requested, no customer data held`
    );
    return new Response();
  }

  const gids = orderIds.map((id) => `gid://shopify/Order/${id}`);
  const events = await prisma.aiTrafficEvent.findMany({
    where: {
      store: { shopifyDomain: shop },
      orderId: { in: gids },
    },
    select: {
      orderId: true,
      platform: true,
      orderRevenue: true,
      orderCurrency: true,
      eventAt: true,
    },
  });

  console.log(
    `[GEO Rise] ${topic} for ${shop} - AI-referral data held for ${gids.length} requested order(s):`,
    JSON.stringify({ shop, requestedOrders: gids, events })
  );
  return new Response();
};

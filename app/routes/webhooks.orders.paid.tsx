import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

const VALID_PLATFORMS = new Set([
  "CHATGPT",
  "PERPLEXITY",
  "CLAUDE",
  "GEMINI",
  "GROK",
  "GOOGLE_AI_OVERVIEW",
]);

type AiPlatform =
  | "CHATGPT"
  | "PERPLEXITY"
  | "CLAUDE"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

interface NoteAttribute {
  name: string;
  value: string;
}

interface OrderPayload {
  admin_graphql_api_id?: string;
  id?: number;
  total_price?: string;
  currency?: string;
  test?: boolean;
  processed_at?: string;
  landing_site?: string | null;
  referring_site?: string | null;
  note_attributes?: NoteAttribute[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as OrderPayload;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true },
  });
  if (!store) {
    console.warn(
      `[GEO Rise revenue] orders/paid fired for unknown store ${shop}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  // Skip dev-store test orders so attribution data stays clean.
  if (order.test === true) {
    return new Response(null, { status: 200 });
  }

  const refAttr = (order.note_attributes ?? []).find(
    (a) => a.name === "__geo_rise_ai_ref"
  );
  if (!refAttr) {
    return new Response(null, { status: 200 });
  }

  const rawPlatform = (refAttr.value ?? "").trim().toUpperCase();
  if (!VALID_PLATFORMS.has(rawPlatform)) {
    console.warn(
      `[GEO Rise revenue] orders/paid for ${shop}: invalid platform "${rawPlatform}", dropping`
    );
    return new Response(null, { status: 200 });
  }
  const platform = rawPlatform as AiPlatform;

  const orderId = order.admin_graphql_api_id ?? null;
  const totalPrice = order.total_price ? parseFloat(order.total_price) : null;
  const currency = order.currency ?? null;

  if (!orderId || totalPrice === null || Number.isNaN(totalPrice) || !currency) {
    console.warn(
      `[GEO Rise revenue] orders/paid for ${shop}: incomplete payload (orderId=${orderId} price=${totalPrice} currency=${currency}), dropping`
    );
    return new Response(null, { status: 200 });
  }

  const eventAt = order.processed_at ? new Date(order.processed_at) : new Date();

  // Shopify delivery is at-least-once, so the same order can arrive more than
  // once (e.g. a retry after a slow response). The DB has a unique constraint
  // on (storeId, orderId); a P2002 here means the order is already recorded,
  // and we must still return 200 so Shopify stops redelivering.
  try {
    await prisma.aiTrafficEvent.create({
      data: {
        storeId: store.id,
        platform,
        referrerUrl: order.referring_site ?? null,
        landingPage: order.landing_site ?? "",
        sessionId: null,
        convertedToOrder: true,
        orderId,
        orderRevenue: totalPrice,
        orderCurrency: currency,
        eventAt,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unique constraint/i.test(msg) || /P2002/i.test(msg)) {
      return new Response(null, { status: 200 });
    }
    throw err;
  }

  console.log(
    `[GEO Rise revenue] recorded ${platform} attribution: order=${orderId} amount=${totalPrice} ${currency}`
  );
  return new Response(null, { status: 200 });
};

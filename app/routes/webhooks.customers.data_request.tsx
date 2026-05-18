import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// GDPR: Merchant requests data we hold about one of their customers.
// GEO Rise does not store any customer personal data - we only store store/product data.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[GEO Rise] ${topic} for ${shop} - no customer data held`);
  return new Response();
};

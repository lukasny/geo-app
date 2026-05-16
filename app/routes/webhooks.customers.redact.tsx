import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// GDPR: Delete personal data for a specific customer.
// GEO Rise does not store any customer personal data — no action needed.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[GEO Rise] ${topic} for ${shop} — no customer data to redact`);
  return new Response();
};

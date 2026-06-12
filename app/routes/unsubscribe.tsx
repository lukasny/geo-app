/**
 * Public unsubscribe endpoint for the weekly insight digest. Linked from the
 * email footer and the List-Unsubscribe header, so it must work outside the
 * Shopify admin: no Shopify auth, no Polaris, no App Bridge.
 *
 *   GET  /unsubscribe?store=<id>&token=<hmac>  - human click, confirmation page
 *   POST /unsubscribe?store=<id>&token=<hmac>  - RFC 8058 one-click, called by
 *                                                mail providers (Gmail/Yahoo)
 *
 * The token is an HMAC of the store id (see insight-email.server.ts), so the
 * link only authorizes disabling that one store's digest - a leaked or forged
 * URL cannot read or modify anything else.
 */
import type { CSSProperties } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import prisma from "~/db.server";
import { verifyUnsubscribeToken } from "~/services/insight-email.server";

/** Verify the signed link and disable the digest. Returns false on a missing
 *  or invalid token. Idempotent: repeat clicks and provider re-POSTs land on
 *  an updateMany no-op, never an error. */
async function unsubscribe(request: Request): Promise<boolean> {
  const url = new URL(request.url);
  const storeId = url.searchParams.get("store");
  const token = url.searchParams.get("token");
  if (!storeId || !token || !verifyUnsubscribeToken(storeId, token)) {
    return false;
  }
  // updateMany rather than update: a store deleted since the email went out
  // must no-op instead of throwing P2025.
  await prisma.store.updateMany({
    where: { id: storeId },
    data: { weeklyInsightEnabled: false },
  });
  return true;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ok = await unsubscribe(request);
  return json({ ok }, { status: ok ? 200 : 400 });
};

/** One-click unsubscribe target. Providers only check the status code, and
 *  on a document POST Remix re-runs the loader to render the page, so the
 *  human-visible confirmation stays in the component below. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const ok = await unsubscribe(request);
  return json({ ok }, { status: ok ? 200 : 400 });
};

const pageStyle: CSSProperties = {
  maxWidth: 480,
  margin: "80px auto",
  padding: "0 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#202223",
  lineHeight: 1.7,
  textAlign: "center",
};

export default function Unsubscribe() {
  const { ok } = useLoaderData<typeof loader>();

  if (!ok) {
    return (
      <div style={pageStyle}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
          Invalid unsubscribe link
        </h1>
        <p style={{ color: "#6D7175" }}>
          This link is missing or has an invalid token. You can manage email
          preferences from the GEO Rise dashboard in your Shopify admin.
        </p>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        You're unsubscribed
      </h1>
      <p style={{ color: "#6D7175" }}>
        You won't receive any more weekly insight emails from GEO Rise. You can
        turn them back on anytime from the GEO Rise dashboard in your Shopify
        admin.
      </p>
    </div>
  );
}

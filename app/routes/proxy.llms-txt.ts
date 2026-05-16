/**
 * App Proxy Route — serves llms.txt at {shop-domain}/a/llms.txt
 *
 * Shopify forwards requests from {shop-domain}/a/llms.txt to this route,
 * appending ?shop=store.myshopify.com and an HMAC signature.
 *
 * The authenticate.public.appProxy() call verifies the HMAC automatically.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verify the request is a legitimate Shopify proxy request
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shopDomain = session.shop;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true },
  });

  if (!store) {
    return new Response(
      [
        "# GEO Rise — llms.txt not yet generated",
        "",
        "This store has not generated an llms.txt file yet.",
        "Install GEO Rise from the Shopify App Store to get started.",
      ].join("\n"),
      {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const llmsFile = await prisma.llmsFile.findFirst({
    where: { storeId: store.id, marketCode: "default" },
    select: { content: true, lastGeneratedAt: true, fileSizeBytes: true },
  });

  if (!llmsFile || !llmsFile.content) {
    return new Response(
      [
        "# GEO Rise — llms.txt not yet generated",
        "",
        "Your llms.txt has not been generated yet.",
        "Go to your GEO Rise app and click 'Generate llms.txt'.",
      ].join("\n"),
      {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }
    );
  }

  return new Response(llmsFile.content, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // Cache for 1 hour — Shopify's proxy layer also caches responses
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "X-Generated-At": llmsFile.lastGeneratedAt?.toISOString() ?? "unknown",
      "X-File-Size": String(llmsFile.fileSizeBytes),
    },
  });
};

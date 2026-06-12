/**
 * App Proxy Route - serves llms.txt at {shop-domain}/a/llms-txt
 *
 * Shopify forwards requests from {shop-domain}/a/llms-txt to this route,
 * appending ?shop=store.myshopify.com and an HMAC signature.
 *
 * Multi-market: {shop-domain}/a/llms-txt?market=<handle> serves that
 * market's file. The market lives in the URL (never headers/cookies)
 * because both our Cache-Control and Shopify's proxy cache key on the
 * full URL - anything else would bleed cached files across markets.
 *
 * The authenticate.public.appProxy() call verifies the HMAC automatically.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";

/** Market handles are URL-safe slugs; anything else is treated as absent
 *  so garbage input falls back to the default file instead of 404ing. */
function sanitizeMarketCode(raw: string | null): string | null {
  if (!raw) return null;
  const code = raw.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(code) || code === "default") return null;
  return code;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verify the request is a legitimate Shopify proxy request
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shopDomain = session.shop;
  const requestedMarket = sanitizeMarketCode(
    new URL(request.url).searchParams.get("market")
  );

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: { id: true, plan: true },
  });

  if (!store) {
    return new Response(
      [
        "# GEO Rise - llms.txt not yet generated",
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

  // Serve the requested market only when the plan still includes the
  // feature (covers downgrades with leftover market rows). Unknown or
  // empty market files fall back to the default file rather than 404ing,
  // so a stale crawler link always gets usable content.
  const planLimits =
    PLAN_LIMITS[store.plan as PlanKey] ?? PLAN_LIMITS.FREE;
  const marketCode =
    requestedMarket && planLimits.multiMarketLlmsTxt ? requestedMarket : null;

  let llmsFile = marketCode
    ? await prisma.llmsFile.findFirst({
        where: { storeId: store.id, marketCode },
        select: { content: true, lastGeneratedAt: true, fileSizeBytes: true },
      })
    : null;

  if (!llmsFile?.content) {
    llmsFile = await prisma.llmsFile.findFirst({
      where: { storeId: store.id, marketCode: "default" },
      select: { content: true, lastGeneratedAt: true, fileSizeBytes: true },
    });
  }

  if (!llmsFile || !llmsFile.content) {
    return new Response(
      [
        "# GEO Rise - llms.txt not yet generated",
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
      // Cache for 1 hour - Shopify's proxy layer also caches responses
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "X-Generated-At": llmsFile.lastGeneratedAt?.toISOString() ?? "unknown",
      "X-File-Size": String(llmsFile.fileSizeBytes),
    },
  });
};

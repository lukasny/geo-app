/**
 * App Proxy Route - AI visit beacon at {shop-domain}/a/llms-txt/visit
 *
 * The theme-extension tracker fires one POST per storefront session when it
 * detects an AI referral (navigator.sendBeacon with a fetch-keepalive
 * fallback). Shopify's app proxy passes child paths through to the app URL,
 * doc-verified 2026-07-02 against shopify.dev "display-dynamic-data":
 * "https://<shop_url>/apps/my-custom-path/child-route will proxy to
 * https://<application_url>/my-app-proxy/child-route". Every proxied request
 * carries the query-string signature, POST included: the shopify-app-remix
 * appProxy docs show a form-submission `action` authenticated the same way,
 * so authenticate.public.appProxy verifies this route exactly like the
 * llms.txt loader.
 *
 * Contract with the storefront: never throw, no body, respond 204 fast.
 * This is an unauthenticated-shopper public write path, so the input is
 * validated against the platform enum, writes are throttled per store, and
 * the insert is fire-and-forget (crawler-hits precedent).
 *
 * No PII: the row is platform + timestamp only. landingPage is a required
 * column on AiTrafficEvent, but the beacon deliberately sends nothing about
 * the shopper's page, so it is stored as "" (same fallback the orders/paid
 * webhook uses). orderId stays unset, so the [storeId, orderId] unique
 * index (NULLs distinct in Postgres) is unaffected.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

type AiPlatform =
  | "CHATGPT"
  | "PERPLEXITY"
  | "CLAUDE"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

const VALID_PLATFORMS = new Set<string>([
  "CHATGPT",
  "PERPLEXITY",
  "CLAUDE",
  "GEMINI",
  "GROK",
  "GOOGLE_AI_OVERVIEW",
]);

// Per-store sliding window, same shape and rationale as
// crawler-hits.server.ts: a flood against one store must not amplify into
// unbounded DB writes. Dropped beacons only undercount during an abusive
// burst; real shopper sessions sit far below the limit. In-memory is
// correct for the single long-lived Render process, and a restart just
// resets the window. At most one entry per store.
const RATE_WINDOW_MS = 60_000;
const MAX_WRITES_PER_WINDOW = 60;
const writeWindows = new Map<string, { windowStart: number; count: number }>();

function allowWrite(storeId: string): boolean {
  const now = Date.now();
  const window = writeWindows.get(storeId);
  if (!window || now - window.windowStart >= RATE_WINDOW_MS) {
    writeWindows.set(storeId, { windowStart: now, count: 1 });
    return true;
  }
  if (window.count >= MAX_WRITES_PER_WINDOW) return false;
  window.count += 1;
  return true;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    // Remix routes every non-GET method here; the beacon is POST only.
    if (request.method !== "POST") {
      return new Response(null, { status: 204 });
    }

    // Verifies the proxy signature. An invalid signature makes the library
    // throw a Response, which Remix returns as-is: forged requests get
    // rejected without ever reaching the DB.
    const { session } = await authenticate.public.appProxy(request);
    if (!session) {
      // Valid proxy request but the app is not installed: nothing to record.
      return new Response(null, { status: 204 });
    }

    const rawPlatform = (
      new URL(request.url).searchParams.get("platform") ?? ""
    )
      .trim()
      .toUpperCase();
    if (!VALID_PLATFORMS.has(rawPlatform)) {
      return new Response(null, { status: 204 });
    }
    const platform = rawPlatform as AiPlatform;

    // Throttle before the store lookup, keyed on the shop domain (unique
    // per store and available pre-query), mirroring recordCrawlerHit:
    // once a flood exhausts the window, further requests cost zero DB
    // round trips beyond what the proxy auth itself performs.
    if (!allowWrite(session.shop)) {
      return new Response(null, { status: 204 });
    }

    const store = await prisma.store.findUnique({
      where: { shopifyDomain: session.shop },
      select: { id: true },
    });
    if (!store) {
      return new Response(null, { status: 204 });
    }

    // Fire-and-forget: the beacon response must not wait on the insert,
    // and a DB hiccup must never turn into a storefront error.
    void prisma.aiTrafficEvent
      .create({
        data: {
          storeId: store.id,
          platform,
          referrerUrl: null,
          landingPage: "",
          sessionId: null,
          convertedToOrder: false,
        },
      })
      .catch((err: unknown) => {
        console.error("[GEO Rise] Failed to record AI visit:", err);
      });
  } catch (err) {
    // A thrown Response is the signature check rejecting the request; pass
    // it through. Anything else must not leak to the storefront.
    if (err instanceof Response) throw err;
    console.error("[GEO Rise] Failed to record AI visit:", err);
  }
  return new Response(null, { status: 204 });
};

/** The beacon is POST-only; stray GETs (crawlers probing the proxy path)
 *  get a plain 404 instead of creating rows. */
export const loader = async () => new Response("Not Found", { status: 404 });

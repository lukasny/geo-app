import { unauthenticated } from "~/shopify.server";

/** Fresh offline Admin API access token for a shop.
 *
 *  The app opts into expiring offline access tokens
 *  (`future.expiringOfflineAccessTokens` in shopify.server.ts), which are
 *  valid for only ~60 minutes. The shopify-app-remix library keeps the
 *  Session-table copy alive: `unauthenticated.admin()` runs
 *  ensureValidOfflineSession, which refreshes a near-expiry token and
 *  persists it via session storage. Any token copied elsewhere (the old
 *  Store.shopifyAccessToken column) goes stale within the hour, so raw-fetch
 *  callers must obtain their token through this helper, once per operation,
 *  and never persist it.
 *
 *  Throws when no offline session exists for the shop (e.g. the app was
 *  uninstalled or the session row was deleted). */
export async function getFreshAccessToken(shopDomain: string): Promise<string> {
  let session;
  try {
    ({ session } = await unauthenticated.admin(shopDomain));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No valid offline session for ${shopDomain}; the app may need to be reinstalled. (${message})`
    );
  }
  if (!session.accessToken) {
    throw new Error(
      `Offline session for ${shopDomain} has no access token; the app may need to be reinstalled.`
    );
  }
  return session.accessToken;
}

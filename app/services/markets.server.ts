import prisma from "~/db.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoreMarket {
  /** Shopify Market GID (gid://shopify/Market/...), used as the marketId
   *  argument when fetching market-specific translations. */
  id: string;
  /** Merchant-facing market name, e.g. "Europe". */
  name: string;
  /** URL-safe market handle, e.g. "eu". Stored as LlmsFile.marketCode. */
  handle: string;
  /** True for the shop's primary market. The primary market is already
   *  covered by the "default" llms.txt file, so pickers usually hide it. */
  isPrimary: boolean;
  /** Locale code of the market web presence's default locale, e.g. "fr".
   *  Null when the market has no web presence. */
  defaultLocale: string | null;
  /** Storefront base URL for the default locale (no trailing slash),
   *  e.g. "https://example.com/fr" or "https://example.fr". Null when the
   *  market has no web presence root URLs. */
  baseUrl: string | null;
  /** Representative ISO country code for contextual pricing. A market can
   *  span many countries; we use the first region. Null for non-region
   *  markets (e.g. B2B), in which case pricing falls back to shop currency. */
  country: string | null;
}

// ─── Shopify GraphQL Client ───────────────────────────────────────────────────
// Same raw-fetch conventions as llms-generator.server.ts. Duplicated rather
// than exported from there so the generator can import THIS module without a
// circular dependency.

const SHOPIFY_API_VERSION = "2025-07";
const MAX_RETRIES = 3;

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
  delayMs = 500
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (retries === 0) throw err;
    // Permission errors never heal on retry; surface them immediately.
    if (err instanceof Error && err.message.includes("ACCESS_DENIED")) {
      throw err;
    }
    const isRateLimit = err instanceof Error && err.message.includes("429");
    const wait = isRateLimit ? delayMs * 4 : delayMs;
    await new Promise((r) => setTimeout(r, wait));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}

async function shopifyGraphql<T>(
  domain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (response.status === 429) {
    throw new Error("429: Shopify rate limit reached");
  }
  if (!response.ok) {
    throw new Error(
      `Shopify API error: ${response.status} ${response.statusText}`
    );
  }

  const json = (await response.json()) as { data: T; errors?: unknown[] };
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ─── Markets Query ────────────────────────────────────────────────────────────

// Written against the 2025-07 schema (the unified Markets model). `regions`
// is deprecated there in favor of `conditions.regionsCondition`, but it is
// still callable on the pinned version and has a stable, documented shape;
// we only need one representative country code from it. Note: status is NOT
// a top-level argument on the markets connection; it only exists as a
// search term inside the query string.
const MARKETS_QUERY = `
  query GetMarkets {
    markets(first: 50, query: "status:ACTIVE") {
      nodes {
        id
        name
        handle
        primary
        webPresences(first: 5) {
          nodes {
            defaultLocale { locale }
            rootUrls { locale url }
          }
        }
        regions(first: 1) {
          nodes {
            ... on MarketRegionCountry { code }
          }
        }
      }
    }
  }
`;

interface MarketsQueryResult {
  markets: {
    nodes: {
      id: string;
      name: string;
      handle: string;
      primary: boolean;
      webPresences: {
        nodes: {
          defaultLocale: { locale: string } | null;
          rootUrls: { locale: string; url: string }[];
        }[];
      };
      regions: {
        nodes: { code?: string }[];
      } | null;
    }[];
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List the store's active Shopify Markets. Returns [] when the merchant has
 *  not yet re-authorized the app with the read_markets scope (older installs)
 *  so callers can treat "no markets" and "no permission yet" identically. */
export async function listMarkets(storeId: string): Promise<StoreMarket[]> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { shopifyDomain: true, shopifyAccessToken: true },
  });

  let data: MarketsQueryResult;
  try {
    data = await withRetry(() =>
      shopifyGraphql<MarketsQueryResult>(
        store.shopifyDomain,
        store.shopifyAccessToken,
        MARKETS_QUERY
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ACCESS_DENIED")) {
      console.warn(
        `[Markets] read_markets not granted yet for store ${storeId}; returning no markets`
      );
      return [];
    }
    throw err;
  }

  return data.markets.nodes.map((m) => {
    const presence = m.webPresences.nodes[0];
    const defaultLocale = presence?.defaultLocale?.locale ?? null;
    const rootUrl =
      presence?.rootUrls.find((r) => r.locale === defaultLocale)?.url ??
      presence?.rootUrls[0]?.url ??
      null;
    return {
      id: m.id,
      name: m.name,
      handle: m.handle,
      isPrimary: m.primary,
      defaultLocale,
      baseUrl: rootUrl ? rootUrl.replace(/\/$/, "") : null,
      country: m.regions?.nodes[0]?.code ?? null,
    };
  });
}

/** Resolve one market by its handle (our LlmsFile.marketCode). */
export async function getMarketByCode(
  storeId: string,
  marketCode: string
): Promise<StoreMarket | null> {
  const markets = await listMarkets(storeId);
  return markets.find((m) => m.handle === marketCode) ?? null;
}

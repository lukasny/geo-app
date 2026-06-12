# Multi-market llms.txt

**Date:** 2026-06-12
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

Stores selling in multiple Shopify Markets (different languages, currencies, domains) get one llms.txt per market, with translated product content, market-correct prices and market-correct storefront URLs, so AI assistants answering in French recommend the French catalog at the French URLs. This is the "multilingual GEO for European merchants" differentiator, and the `PLAN_LIMITS[plan].multiMarketLlmsTxt` flag (Growth+) has been advertised on the pricing page since launch without an implementation.

## Scope

**In scope:**
- New scopes `read_markets` and `read_translations`. Existing installs keep working untouched until re-auth: every markets call degrades gracefully (ACCESS_DENIED or missing scope just means "no markets available yet" and the UI says so).
- API version pin bump 2025-01 to 2025-07 in `shopify.app.toml` (app + webhooks) and `shopify.server.ts`. Zero runtime change: 2025-01 is past end-of-support and Shopify already serves all calls with the 2025-07 schema via fall-forward. This makes the declared version match reality; the Markets queries below are written against 2025-07 docs.
- New service `app/services/markets.server.ts`: list a store's active markets (id, name, handle, default locale, base URL from `webPresences.rootUrls`, representative country) using the raw-fetch + withRetry conventions of llms-generator.
- Market-aware generation: `getOrCreateLlmsFile(storeId, marketCode)` and `generateLlmsTxt(storeId, { marketCode, ... })`. For non-default markets the generator fetches translated product/collection/article content via the inline `translations(locale:, marketId:)` field (fallback: default-language values), per-market prices via `Product.contextualPricing(context: { country })` (fallback: `priceRangeV2` shop currency), and builds links from the market's root URL.
- `generateAllLlmsFiles(storeId, plan)`: regenerates the default file plus every existing non-default market row, used by the regenerate-everything paths.
- Proxy market resolution: `/a/llms-txt?market=<marketCode>`. Unknown or missing market falls back to the default file. Plans without `multiMarketLlmsTxt` are always served the default file even if stale market rows exist (server-side enforcement on the public surface, also covers downgrades).
- Market picker on `/app/llms-txt`, URL-driven via `?market=` search param, placed between the status banner and the stats cards. Per-market generate and settings (settings forms keyed on `llmsFile.id` so controlled state resets on switch). The `updateSettings` and `generate` action intents accept a validated `marketCode` and reject non-default codes server-side for plans without the flag.
- Webhook regeneration (`products/update`, `products/delete` on_change path) iterates all LlmsFile rows for the store, not just default.
- Per-market public URLs displayed in the UI exactly where the single URL shows today.

**Out of scope:**
- Market catalog product subsets (which products are published per market). Needs `read_publications` plus per-product publication checks; v1 includes all active products in every market file, documented limitation. The translations and URLs are still market-correct.
- Market-specific subfolder serving (`example.com/fr-ca/a/llms-txt`). Undocumented for app proxies, and Markets geo-redirection can 301 cookie-less crawlers; the query-param URL is self-describing and cache-safe (Shopify's proxy cache keys on the full URL).
- robots.txt integration and llms.txt cross-linking between markets.
- Translated llms.txt section headers (the `# AI Bot Access` / `## Products` scaffolding stays English; AI consumers do not care).
- Refunds of the existing single-market behavior: stores without Markets configured see zero change.
- Automated tests (project has none; verification is tsc + build + manual smoke test).

## Architecture

### 1. Markets service (`app/services/markets.server.ts`)

`listMarkets(storeId): Promise<StoreMarket[]>` with `StoreMarket = { id, name, handle, isPrimary, defaultLocale, baseUrl, country }`. One GraphQL query (raw fetch, same client helper conventions as llms-generator):

```graphql
query GetMarkets {
  markets(first: 50, status: ACTIVE) {
    nodes {
      id name handle
      webPresences(first: 5) {
        nodes {
          defaultLocale { locale }
          rootUrls { locale url }
        }
      }
      conditions {
        regionsCondition { regions(first: 1) { nodes { ... on MarketRegionCountry { code } } } }
      }
    }
  }
}
```

The first web presence's root URL for its default locale becomes `baseUrl`; the first region country becomes the representative `country` for contextual pricing. Any error containing ACCESS_DENIED returns `[]` with a log line, so pre-re-auth installs see "no markets".

### 2. Generator changes (`app/services/llms-generator.server.ts`)

- `getOrCreateLlmsFile(storeId, marketCode = "default")`.
- `GenerateLlmsTxtOptions` gains `marketCode?`, and when the code is not "default" the generator resolves the market (via markets.server) to get `{ marketId, locale, baseUrl, country }`.
- Products query gains optional variables: `$locale/$marketId` for `translations(locale: $locale, marketId: $marketId) { key value }` on products, collections, articles, and `$country` for `contextualPricing(context: { country: $country }) { minVariantPrice { amount currencyCode } }`. For the default market the variables are null and the query behaves exactly as today.
- Helper picks translated `title`/`body_html`/`description` values by key with fallback to the default field.
- Links built from the market `baseUrl` instead of `shop.primaryDomain.url`.
- `generateAllLlmsFiles(storeId, planKey)`: default first, then each existing non-default row (only rows that already exist; merchants opt markets in by generating them in the UI). Plans without the flag regenerate only default.

### 3. Proxy (`app/routes/proxy.llms-txt.ts`)

Parse `market` from `new URL(request.url).searchParams`, sanitize (lowercase, `[a-z0-9-]` only), look up `{ storeId, marketCode }` with fallback to `"default"` when the param is absent, unknown, or the store's plan lacks `multiMarketLlmsTxt`. Caching headers unchanged; market lives in the URL so caches cannot bleed across markets.

### 4. Admin UI (`app/routes/app.llms-txt.tsx`)

Loader reads `?market=`, validates it against `listMarkets` + existing rows, returns `markets`, `activeMarketCode`, `planAllowsMultiMarket`, and the selected market's `llmsFile`. Picker UI between status banner and stats: a Select of "Default (all markets)" plus each Shopify market, with per-market "Generated / Not generated yet" status. FREE/locked state shows the picker disabled with an upgrade CalloutCard (the established pattern). Actions: `generate` and `updateSettings` take `marketCode`, validated server-side against the plan flag.

### 5. Webhooks

`webhooks.products.update.tsx` and `webhooks.products.delete.tsx`: replace the single default-row lookup with `findMany` and regenerate every row whose settings say on_change, default first. The loop runs detached AFTER the webhook is acknowledged: Shopify fails deliveries without a 2xx within about 5 seconds, and several full-catalog regenerations cannot fit in that budget. Rate limits: generation is sequential per row and the generator already self-throttles at 75% of the API call limit.

## Decisions

1. **Market identity = `Market.handle`** stored in `LlmsFile.marketCode` (schema already unique per `[storeId, marketCode]`; "default" remains the base file).
2. **Query param over subfolder serving** for the public URL (cache-safe, documented, self-describing for crawlers).
3. **Graceful scope degradation over hard requirement.** The feature lights up after re-auth; nothing breaks before it.
4. **Default market stays free; extra markets are Growth+,** enforced in the action AND at the proxy (covers plan downgrades with leftover rows).
5. **Pin 2025-07, not newer.** Declared-version honesty without behavior change; bumping further is a separate, deliberate task.
6. **Translations inline, not translatableResources fan-out.** One query, no extra pagination; per-field fallback to default language.

## Known limitations (documented, accepted for v1)

- All active products appear in every market file (no catalog-subset filtering until read_publications lands in v2).
- A market spanning multiple countries gets one representative country's prices.
- Blog articles keep the 50-per-blog truncation the default file already has.
- Existing installs need a merchant re-auth before markets appear (same flow as Intent Lab's read_reports).

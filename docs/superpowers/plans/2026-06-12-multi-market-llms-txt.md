# Multi-Market llms.txt Implementation Plan

**Goal:** One llms.txt per Shopify Market with translated content, market prices, and market URLs, served at `/a/llms-txt?market=<handle>`, managed from a market picker on `/app/llms-txt`. Growth+ via the long-advertised `multiMarketLlmsTxt` flag; default market stays free.

**Architecture:** New markets.server.ts lookup service; marketCode threaded through getOrCreateLlmsFile / generateLlmsTxt with translations + contextualPricing + market base URLs; proxy resolves `?market=`; URL-driven picker UI; webhooks regenerate all rows. Scopes add read_markets + read_translations; API pin bumps 2025-01 to 2025-07 (declared = actual, zero behavior change).

**Tech Stack:** Remix, TypeScript strict, Polaris v12, Prisma, raw-fetch GraphQL with withRetry. No automated tests; verification = `npx tsc --noEmit` + `npm run build` per task, multi-agent review at the end.

**Spec:** `docs/superpowers/specs/2026-06-12-multi-market-llms-txt-design.md`

---

## Task 1: Config groundwork

**Files:** `shopify.app.toml`, `app/shopify.server.ts`

- [ ] access_scopes += `read_markets,read_translations`.
- [ ] api_version "2025-01" to "2025-07" (app + webhooks blocks); `ApiVersion.January25` to `ApiVersion.July25` everywhere in shopify.server.ts; same for the hardcoded `SHOPIFY_API_VERSION` in llms-generator.server.ts.
- [ ] Check webhooks.app.scopes_update.tsx actually persists new scopes to the Session row.

## Task 2: Markets service

**Files:** Create `app/services/markets.server.ts`

- [ ] `listMarkets(storeId)` returning `StoreMarket[]` (id, name, handle, isPrimary, defaultLocale, baseUrl, country) via the GetMarkets query from the spec; raw fetch + withRetry conventions; ACCESS_DENIED returns `[]` with a console.warn (pre-re-auth installs).

## Task 3: Market-aware generator

**Files:** `app/services/llms-generator.server.ts`

- [ ] `getOrCreateLlmsFile(storeId, marketCode = "default")`.
- [ ] Options gain `marketCode`; non-default resolves market context (marketId, locale, baseUrl, country) and aborts with a clear error if the market no longer exists.
- [ ] Queries gain optional `$locale/$marketId/$country` variables: `translations(locale:, marketId:) { key value }` on product/collection/article; `contextualPricing(context: { country: $country }) { minVariantPrice { amount currencyCode } }` on product. Null variables = exactly today's behavior. Translation picks per key with fallback; pricing falls back to priceRangeV2.
- [ ] Links from market baseUrl; persistence updates the market's row.
- [ ] `generateAllLlmsFiles(storeId, planKey)` regenerating default + existing market rows (default only when the plan lacks the flag).

## Task 4: Proxy resolution

**Files:** `app/routes/proxy.llms-txt.ts`

- [ ] Parse + sanitize `?market=`; serve that row when the store's plan has multiMarketLlmsTxt and the row exists; otherwise fall back to default. Headers unchanged.

## Task 5: Admin UI market picker

**Files:** `app/routes/app.llms-txt.tsx`

- [ ] Loader: `?market=` param, `listMarkets`, per-market row status, `planAllowsMultiMarket`, selected llmsFile.
- [ ] Picker between status banner and stats cards; settings/preview sections keyed on `llmsFile.id`; per-market public URL shown in the banner and preview footer.
- [ ] Locked state for FREE: disabled picker + upgrade CalloutCard (reuse existing pattern and real prices from PLAN_DEFINITIONS).
- [ ] Actions `generate`/`updateSettings` accept `marketCode`, validate server-side against the plan flag, and target the right row.

## Task 6: Webhook regeneration

**Files:** `app/routes/webhooks.products.update.tsx`, `app/routes/webhooks.products.delete.tsx`

- [ ] Replace default-row findFirst with findMany; regenerate each on_change row sequentially (default first), with marketCode passed through.

## Task 7: Verify and ship

- [ ] `npx tsc --noEmit` + `npm run build` clean; em-dash scan zero.
- [ ] Multi-agent adversarial review; fix confirmed findings.
- [ ] Per-task commits; push to main.
- [ ] Lukas actions: `npx shopify app deploy --allow-updates` (pushes new scopes + api_version to Shopify), re-auth on boda-brands, smoke-test: create a test market, generate its file, fetch `/a/llms-txt?market=<handle>`.

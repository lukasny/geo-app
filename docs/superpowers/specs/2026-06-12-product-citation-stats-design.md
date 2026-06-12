# Product-level AI citation stats

**Date:** 2026-06-12
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

Tell merchants which of their products AI assistants actually mention, per platform, over time: "Your Videographer Snowboard was mentioned in 12 AI answers across ChatGPT and Perplexity in the last 30 days." Today the app records this data (`AiCitation.productsCited`) but never aggregates it; the only product-level display is the per-check "Products mentioned" badge list on a single prompt result.

## Scope

**In scope:**
- A new pure-DB aggregation service `app/services/product-citations.server.ts`. No AI calls, no schema migration.
- A "Top cited products" card on `/app/tracking`, inserted between the suggested-prompts card and the prompts list.
- Rolling 30-day window over `AiCitation.checkedAt` (the dashboard's existing citation-count convention), with a bounded scan (most recent 500 rows, mirroring competitor-monitoring's `CITATIONS_WINDOW`).
- Counting semantics: one "mention" = one `AiCitation` row whose `productsCited` array contains the product title. Each row is one platform's answer in one check, so the UI copy says "mentioned in N AI answers", which is literally true. This matches how competitor stats count rows.
- Group titles case-insensitively (display the most recently recorded casing). Best-effort join against the cached `Product` table by lowercased title; titles that no longer match any catalog product still show, flagged "not in your catalog".
- Plan gating: identical to the rest of the tracking page (FREE has `maxTrackingPrompts: 0` and sees the existing upgrade banner; the new card is simply not rendered for FREE and the loader skips the query).

**Out of scope:**
- Schema migration to a mention join table with a `productId` FK (rename-resilient history). Only worth it if title-based grouping proves painful; documented as future work.
- Additional surfaces: a dashboard "Top cited product" stat and an audit-page per-product drill-in are natural follow-ups; the service API is designed so both can reuse it unchanged.
- Sentiment breakdown per product (data exists on the rows; defer until a surface needs it).
- Changes to the write path. Detection stays title-substring matching against the first 100 cached products; that cap is a known limitation inherited from `processPlatformCitation`.
- Automated tests. Verification is `npx tsc --noEmit` + `npm run build` + manual smoke test, consistent with the project.

## Architecture

Three small parts, all following existing patterns:

### 1. Service: `getProductCitationStats(storeId, options?)`

Modeled on `competitor-monitoring.server.ts` / `revenue-attribution.server.ts`: named exports, exported result interfaces with JSDoc on every field, `storeId` first argument, all Prisma queries scoped by `storeId`, dates serialized to ISO strings, aggregation in JavaScript over a bounded row window (no JSON-path SQL, consistent with the codebase).

Query: `prisma.aiCitation.findMany({ where: { storeId, checkedAt: { gte: rangeStart } }, select: { platform, productsCited, checkedAt }, orderBy: { checkedAt: "desc" }, take: 500 })` with `rangeStart` = rolling `rangeDays` (default 30) from UTC midnight, the revenue-attribution pattern.

Aggregation: per row, guard `Array.isArray(productsCited)` (column is NULL when nothing matched, never `[]`), dedupe within the row, and accumulate into a `Map` keyed by lowercased title: mention count, per-platform counts (`Partial<Record<AiPlatform, number>>` built from observed rows, never the full enum), most recent `checkedAt`, most recent display casing. Then one `prisma.product.findMany({ where: { storeId }, select: { title } })` builds the lowercased catalog set for the `inCatalog` flag. Sort by mention count desc, tie-break most recent mention, cap at `maxProducts` (default 10).

### 2. Loader wiring in `app.tracking.tsx`

When the store exists and the plan allows tracking, the loader calls the service and returns `productCitations` in `LoaderData`; otherwise `null`. No new route, no action changes.

### 3. UI: `TopCitedProductsCard` component in `app.tracking.tsx`

Local component, like `PromptCard`. Rendered only when the plan allows tracking and at least one prompt exists. States:
- Mentions exist: one row per product with the title (semibold), "N mentions" copy with singular/plural handling, one `Badge tone="info"` per platform using the page's `PLATFORM_LABELS` map with the per-platform count, "Last mentioned {relativeTime(...)}" in subdued bodySm, and a subdued "not in your catalog" hint when the title no longer matches a product.
- No mentions yet: the card renders a short subdued explainer ("No product mentions detected yet. Run checks on your prompts...") so merchants know the feature exists.

## Decisions

1. **Surface = tracking page, not audit page.** The handoff left this open. Citations are tracking data, the page already renders per-check product badges, and the loader already owns the citation queries. The audit drill-in stays a follow-up.
2. **Count rows, call them mentions.** A check fans out to up to 3 platforms and writes up to 3 rows; counting rows matches competitor stats and the per-prompt totals. The copy avoids claiming "12 checks" or "12 conversations".
3. **Rolling 30 days, copy says "last 30 days".** Matches the dashboard citation count; avoids the calendar-month ambiguity of "this month".
4. **Group by title, join best-effort.** `productsCited` stores verbatim title strings. Renamed products orphan their history under the old title; we show those rows honestly instead of dropping them.

## Known limitations (inherited, documented, not fixed here)

- Detection only matches the first 100 cached products per store, so large catalogs can have unmentionable products.
- Title renames detach history (old rows keep the old title).
- Short generic titles can substring-false-positive in AI answers.

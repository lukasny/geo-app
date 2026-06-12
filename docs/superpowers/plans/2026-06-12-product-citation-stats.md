# Product Citation Stats Implementation Plan

**Goal:** Aggregate `AiCitation.productsCited` per product across platforms and time, and surface a "Top cited products" card on `/app/tracking`.

**Architecture:** One new pure-DB service (`product-citations.server.ts`) aggregating a bounded 30-day window of citation rows in JavaScript, wired into the existing tracking loader, rendered as a new local card component. No schema migration, no new route, no AI calls.

**Tech Stack:** Remix, TypeScript strict, Shopify Polaris v12, Prisma. No automated tests. Verification per task = `npx tsc --noEmit`; final verification adds `npm run build`.

**Spec:** `docs/superpowers/specs/2026-06-12-product-citation-stats-design.md`

---

## Task 1: Aggregation service

**Files:**
- Create: `app/services/product-citations.server.ts`

- [ ] Exported interfaces `ProductCitationStat` (title, mentionCount, byPlatform, lastMentionedAt ISO string, inCatalog) and `ProductCitationStats` (rangeDays, totalMentions, products), JSDoc on every field.
- [ ] `getProductCitationStats(storeId: string, options: { rangeDays?: number; maxProducts?: number } = {})`: bounded `aiCitation.findMany` (storeId + checkedAt window, desc, take 500), `Array.isArray` guard on `productsCited`, per-row dedupe, case-insensitive title grouping with most-recent display casing, catalog join via one `product.findMany` for the `inCatalog` flag, sort by count desc then recency, cap at `maxProducts` (default 10).
- [ ] Section dividers and conventions copied from `competitor-monitoring.server.ts`. No em-dashes.

## Task 2: Loader wiring

**Files:**
- Modify: `app/routes/app.tracking.tsx` (loader + `LoaderData` type)

- [ ] Call `getProductCitationStats(store.id)` only when the plan allows tracking (`limits.maxTrackingPrompts > 0`); return `productCitations: ProductCitationStats | null`.
- [ ] Include `productCitations: null` in the early-return shape for missing stores.

## Task 3: UI card

**Files:**
- Modify: `app/routes/app.tracking.tsx` (new `TopCitedProductsCard` local component + render site)

- [ ] Insert between the suggested-prompts card and the prompts list.
- [ ] Render only when `productCitations` is non-null and at least one prompt exists.
- [ ] Rows: semibold title, "{n} mention/mentions", per-platform `Badge tone="info"` with counts via `PLATFORM_LABELS`, "Last mentioned {relativeTime(...)}", subdued "not in your catalog" hint when `inCatalog` is false.
- [ ] Empty state: subdued explainer when no mentions in the window.

## Task 4: Verify and ship

- [ ] `npx tsc --noEmit` clean and `npm run build` succeeds.
- [ ] Multi-agent code review of the diff; fix confirmed findings.
- [ ] Per-task commits, push to main (Render auto-deploys).
- [ ] Manual smoke test on boda-brands is a Lukas action (run a check on a prompt that cites a product, confirm the card populates).

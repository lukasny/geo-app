# Bulk editing UI

**Date:** 2026-06-12
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

Let merchants select N products in a grid and apply manual, template-based edits (meta title pattern, image alt-text template) in one pass, without going through AI auto-fix. Growth+ via the long-advertised `PLAN_LIMITS[plan].bulkOptimization` flag. Example: select 40 products, set meta title template `{title} | {shop}` and alt template `{title} by {vendor}`, click Apply.

## Scope

**In scope:**
- New shared write layer `app/services/product-mutations.server.ts`, extracted mechanically from audit-engine: `updateProductSeo(admin, shopifyProductId, { title?, description? })` implementing the GetCurrentSeo read-merge-write (the `seo:` input is a wholesale replacement; always send BOTH fields) plus echo-back persistence verification, and `updateMediaAltText(admin, shopifyProductId, buildAlt)` fetching live MediaImage GIDs (`media(first: 20)`) and verifying returned alts. `fixMetaIssue`/`fixImagesIssue` in audit-engine consume these, behavior unchanged.
- New service `app/services/bulk-edit.server.ts`: `applyBulkEdit(storeId, admin, { productIds, metaTitleTemplate?, altTextTemplate? })`. Sequential loop with 300ms pacing, 3-consecutive-failures circuit breaker, hard server cap of 50 products per request. Template variables: `{title}`, `{vendor}`, `{type}`, `{handle}`, `{price}` from the Product cache and `{shop}` from one live `shop { name }` query (cached `shopName` is just the domain slug). Null variables render as empty and whitespace collapses. Alt template applies only to images with EMPTY alt text. After each success: update Product flags (hasMetaTitle per the custom-differs-from-title semantics, hasAltText + altTextQuality 70) and mark matching open autoFixable AuditResult rows fixed so the audit page stays honest.
- New route `app/routes/app.bulk-edit.tsx` + nav link after Action Plan: revenue-style plan gate (loader skips data and the component early-returns a Banner for FREE), template inputs with helper text and a live preview row, audit-style IndexTable (client-side pagination, PAGE_SIZE 25) with selection enabled (`useIndexResourceState`, `promotedBulkActions`), confirmation Modal before applying ("no undo"), spinner banner during the blocking POST, toast with per-field result counts. Empty state points to running an audit first (the grid is driven by the cached Product rows, which only exist post-audit).
- Webhook regeneration coalescing: new `app/services/llms-regen-queue.server.ts` with a per-store in-memory queue (`requestLlmsRegeneration(storeId, runner)`). The products/update + products/delete webhooks route their detached llms.txt regeneration through it, so N rapid product mutations (exactly what a bulk apply causes) collapse into at most two regeneration runs instead of N parallel full-catalog fetches. In-memory is correct here: Render runs one long-lived Node process and the codebase already relies on that for node-cron.

**Out of scope:**
- Meta description templates (same primitive, defer until asked).
- Overwriting existing alt text (v1 fills only missing; an overwrite toggle is future work).
- Templates beyond simple variable substitution (no conditionals/filters).
- Server-side pagination or live-from-Shopify product lists; the grid uses the audited Product cache like the audit page.
- Undo. The confirmation modal says so explicitly.
- Automated tests (project has none; verification is tsc + build + review + manual smoke).

## Decisions

1. **Grid is cache-driven.** Only audited products appear; that is also the natural plan boundary (FREE caches 3 products but is gated out entirely anyway by `bulkOptimization`).
2. **50 products per apply.** One blocking POST does ~2-3 Shopify calls per product; 50 keeps the request under platform timeouts. The UI says to repeat for more.
3. **Send explicit product IDs always.** `allResourcesSelected` is display sugar; the action validates ids against `{ id, storeId }` rows, never trusting client input across tenants.
4. **hasMetaTitle follows audit semantics**: set true only when the rendered title differs (case-insensitive) from the product title, since that is what the audit counts as "custom".
5. **AuditResult sync is best-effort**: open autoFixable META/IMAGES rows for the product are marked fixed by category + title match; a future full audit rebuilds everything anyway.

## Known limitations (documented, accepted)

- `media(first: 20)`: products with more than 20 media only get their first 20 alt-filled (inherited from auto-fix).
- Meta/alt status badges in the grid reflect the last audit, not live Shopify state.
- Each edit still fires one products/update webhook; the coalescing queue bounds the llms.txt cost but the webhook deliveries themselves are unavoidable.

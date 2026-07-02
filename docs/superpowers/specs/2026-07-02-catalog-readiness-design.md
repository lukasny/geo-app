# AI Shopping Readiness audit (F4): design spec

Date: 2026-07-02. Evidence basis: docs/geo-evidence-2026-07.md F4 (Layer 4:
Agentic Storefronts list every eligible merchant by default; selection runs
on attribute completeness and price or stock accuracy; ACP feed spec says
review stats and structured attributes enhance ranking). Approved by Lukas
("Build F4 catalog readiness audit next"). All new Shopify read paths and
the query-cost arithmetic below were doc-verified against shopify.dev
2025-07 in the understand phase (workflow w4gzx486w).

## What the merchant gets

A parallel "AI shopping readiness" score (0 to 100) beside the GEO score,
computed during the same audit run: how complete each product's catalog
attributes are for AI shopping agents (category taxonomy, barcode/GTIN,
brand, images, SKUs, reviews, spec detail). Surfaced as a card on the audit
page (aggregate score + the most common gaps across audited products), a
per-product gap list with a Shopify admin deep link in the product detail
modal, and one mini-stat on the dashboard hero. Read-only v1: no writes, no
AI calls, no new scopes, no theme changes.

## Non-negotiable design constraints

1. PARALLEL score, never rubric changes: ScoreSnapshot history and the
   weekly email delta must stay like-for-like, so scoreProduct's points and
   the shared helpers it uses must not change AT ALL. ScoreSnapshot gets no
   new column.
2. Readiness must NEVER fail the GEO audit: per-product computation wrapped
   in its own try/catch (null on failure), mirroring the step-6b snapshot
   precedent. Readiness gaps are NOT AuditResult rows (the action plan,
   auto-fix, email, and category unions all consume those; v1 stays out).
3. WEIGHT IS EXCLUDED from v1, by verified cost math: ProductVariant.weight
   was removed from the API (2024-07); the 2025-07 path is
   inventoryItem { measurement { weight { value unit } } }, which adds +3
   objects per variant and blows PRODUCTS_AUDIT_QUERY from 948 to 2088
   requested points (cap 1000, rejected pre-execution). Keeping it would
   force pageSize 7 and double every audit's page count. Scope is NOT the
   issue (InventoryItem reads are covered by read_products, which
   write_products grants). The card discloses "Weight is not checked yet."
4. Copy: frame as "AI shopping readiness" and explicitly differentiate from
   the GEO score ("catalog attribute completeness for AI shopping agents"
   vs on-page readability), because two adjacent "ready for AI" percentages
   otherwise read as a bug. Never a placement or ranking guarantee. Plain
   units, no em or en dashes.
5. Plan-cap parity: readiness data in the audit page loader must respect the
   same allowedProductIds / maxAuditProducts server-side filter as products
   and auditResults (the P0-4 fix), or FREE merchants can read whole-catalog
   readiness from the network payload.

## Query changes (Agent A owns, audit-engine.server.ts)

PRODUCTS_AUDIT_QUERY gains exactly two things, doc-verified for 2025-07:
- On the product node: `category { id fullName isLeaf }` (TaxonomyCategory,
  nullable; +1 object per product, subfields are scalars).
- On the variant node: `barcode` (plain nullable String scalar, +0 cost).
New cost: node 64, query 2 + 15 x 64 + 1 = 963 of 1000. Update the budget
comment at the pageSize computation with this arithmetic (the comment
explicitly demands redoing the math). MAX_PAGE_SIZE stays 15; variants stay
first: 25; metafields stay first: 20; throttle mechanics untouched.

Types: ShopifyProductData gains `category: { id: string; fullName: string;
isLeaf: boolean } | null`; ShopifyVariant gains `barcode: string | null`.

## Readiness rubric (Agent A owns, new code inside audit-engine.server.ts)

New module-private `scoreReadiness(product: ShopifyProductData, fields:
ScoreResult["fields"]): { score: number; gaps: ReadinessGapKey[] }`,
computed in the runFullAudit loop right after scoreProduct, inside its own
try/catch (on throw: readiness fields stay null for that product, audit
continues). 100 points across 8 checks; each failed or partial check
contributes its gap key:

| Check | Points | Gap key | Detection |
|---|---|---|---|
| Category taxonomy set | 20 (leaf) / 10 (non-leaf) | missing_category / broad_category | product.category null = 0; isLeaf false = 10 |
| Barcode on variants | 15 (all) / 7 (some) | missing_barcodes / partial_barcodes | non-empty trimmed barcode per variant |
| Brand/vendor set | 10 | missing_vendor | product.vendor trimmed non-empty (same detection as rubric, do not change the rubric's copy of it) |
| Product type set | 5 | missing_product_type | productType trimmed non-empty |
| 3+ images | 10 (3+) / 5 (1-2) | few_images / no_images | images count |
| SKUs on variants | 10 (all) / 5 (some) | missing_skus / partial_skus | non-empty sku per variant |
| Reviews present | 15 (any) + bonus included: 15 requires reviewCount >= 5, any reviews = 10 | no_reviews / few_reviews | reuse fields.hasReviews / fields.reviewCount from scoreProduct's ScoreResult (single source, no re-detection) |
| Spec-dense description | 15 | thin_specs | NEW stricter private helper hasDenseSpecs(plainDesc): requires a number-plus-unit pattern (cm, mm, in, kg, g, oz, lb, ml, l, %, x-by-x) or at least two numeric tokens. Do NOT reuse or modify the permissive hasSpecificAttributes (any digit passes; changing it would move GEO scores) |

Exactly 100 max. Gap keys are a closed union `ReadinessGapKey` exported
from a NEW client-safe module app/services/readiness.shared.ts (no server
imports, like billing.shared.ts) together with `READINESS_GAP_LABELS:
Record<ReadinessGapKey, string>` (short merchant labels, e.g.
missing_category: "No product category set") and
`READINESS_GAP_HINTS: Record<ReadinessGapKey, string>` (one-line "where to
fix it in Shopify admin" hints). UI renders labels ONLY from this module.

## Persistence (Agent A owns)

- prisma/schema.prisma: Product gains `readinessScore Int?` and
  `readinessGaps Json?` (array of ReadinessGapKey strings); Store gains
  `readinessScore Int?`. All nullable: null means "not computed yet" and
  the UI renders a dash, never 0/100 (products audited before F4 keep null
  until their next audit).
- Product upsert in the audit loop writes both fields in BOTH create and
  update paths (the P1-3 full-field-sync rule).
- Store.readinessScore = rounded mean of this run's per-product readiness
  scores (only products where computation succeeded); written in the same
  store.update that persists geoScore. Same first-N semantics as geoScore
  on capped plans. Plain-code average (cannot throw); if every product's
  readiness failed, leave the column unchanged.
- Hand-written migration prisma/migrations/20260702140000_add_readiness/
  migration.sql in house style: two ALTER TABLE blocks adding the three
  nullable columns. No new tables, no new indexes.
- ScoreSnapshot untouched.

## UI (Agent B owns: app/routes/app.audit.tsx and app/routes/app._index.tsx)

Audit page:
- New "AI shopping readiness" Card inserted between the issue-summary
  InlineGrid and the product IndexTable. Contents: the store readiness
  score as a large number colored via scoreColor() (same anatomy as the GEO
  hero number; plain text, no ScoreRing since its aria-label is hardcoded
  to GEO), a differentiation sentence ("Measures how complete your catalog
  attributes are for AI shopping agents: category, barcodes, brand, images,
  SKUs, reviews, and spec detail. Your GEO score measures on-page
  readability; this measures feed completeness."), and a "Top gaps" list:
  aggregate counts per gap key across the loader's (cap-filtered) products,
  sorted desc, top 5, rendered as plain text lines like "14 products:
  No product category set" using READINESS_GAP_LABELS. Subdued disclosure
  line: "Weight is not checked yet. Scores update when you run an audit."
  When store.readinessScore is null (never computed): the card renders a
  single subdued line, "Run an audit to compute your AI shopping readiness
  score." No new Polaris colors, no Grid, scoreColor from tokens only.
- ProductDetailModal: new Modal.Section after the score header, shown when
  the product has a non-null readinessScore: "AI shopping readiness:
  {score}/100" (ScorePill is acceptable here; it is score-band colored via
  scoreColor already) plus that product's gaps as label + hint lines from
  readiness.shared.ts, plus a Button url
  `https://${shopifyDomain}/admin/products/${numericId}` target="_blank"
  labeled "Edit product in Shopify admin" (numericId =
  shopifyProductId.split("/").pop(); target _blank is mandatory, an
  in-frame navigation breaks the embedded session).
- Loader: add readinessScore + readinessGaps to the product select and
  Store.readinessScore to the store pick; BOTH behind the existing
  allowedProductIds cap filter; gaps validated defensively (Array.isArray +
  string filter + known-key filter against the shared union).

Dashboard (minimal touch):
- Append a 4th mini-stat to the existing hero InlineStack: label "AI
  shopping readiness", value `${store.readinessScore}/100` or "-" when
  null. Requires Store.readinessScore in the loader's explicit store field
  pick (NEVER a spread) and the StoreData interface. No new cards, no grid
  changes, no new queries (the field rides the existing store row read).

## Explicitly out of scope (v1)

Weight (cost math above; revisit only with a dedicated fetch strategy), AI
attribute extraction auto-fix and any metafield or product writes (v2;
productUpdate vs productVariantsBulkUpdate ownership must be doc-verified
then), metafield completeness checks (the unfiltered metafields(first: 20)
window makes them unreliable; noted for v2 with a namespace-filtered
query), GTIN checksum validation (v1 counts non-empty barcodes; note
presence is not validity), readiness trend history (no ScoreSnapshot
column), readiness in the weekly email, readiness as AuditResult rows or
action-plan entries.

## Verification

Central after both agents: prisma generate + validate, tsc, build, em-dash
scan on changed files. Adversarial review workflow (dimensions: query-cost
+ engine isolation, rubric + persistence correctness, UI + plan-cap parity;
paired skeptics), fix confirmed findings, per-task commits (engine+data,
UI), push, Render health check. First real audit after deploy should
confirm extensions.cost.requestedQueryCost reports ~963 (the loop already
reads it; check Render logs or add nothing). Smoke on boda-brands: run an
audit, see the readiness card populate, open a product modal, check the
gap list and the admin deep link. No theme deploy needed.

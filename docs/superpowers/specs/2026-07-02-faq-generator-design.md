# FAQ Generator with FAQPage JSON-LD (F6): design spec

Date: 2026-07-02. Evidence basis: docs/geo-evidence-2026-07.md F6 (Layer 3
extractability: answer-first FAQ blocks are a Princeton-verified on-page
lever; FAQPage JSON-LD gives AI engines clean Q/A structure). Approved by
Lukas ("Build the FAQ generator next"). All Shopify GraphQL shapes below
were doc-verified against shopify.dev 2025-07 in the understand phase.

## What the merchant gets

A new "FAQ Generator" page (own route, Growth-plus). The merchant picks one
of their products, clicks Generate, and Claude drafts 4 to 6 answer-first
FAQs for it. The merchant reviews the draft on screen, then clicks Publish
to storefront, which writes the FAQs to a product metafield. The theme
extension renders them as FAQPage JSON-LD on that product page. An Unpublish
action clears the metafield.

Two steps on purpose, mirroring blog draft then publish: generation spends
an AI call (metered), publishing does not (it only writes a metafield). AI
text is reviewed on screen before it goes live on the storefront.

## Metering and gating

- New PLAN_LIMITS cap `maxProductFaqsPerMonth`: FREE 0, GROWTH 20, PRO 100,
  ENTERPRISE 500 (products you can generate FAQs for per month; easily tuned
  later, single source in billing.shared.ts). 0 means feature-locked.
- Unit of metering: one ProductFaq row = one generation run for one product.
  Regenerating a product's FAQs is a new run and counts again (it is a new
  AI call). Counting matches blog: all non-"generating" rows created this
  UTC month.
- Two-layer cap enforcement, identical to blog-generator (the brief warns a
  service-only check is racy):
  - Layer 1 (route action): reserveQuotaSlot() in a Serializable
    prisma.$transaction: reap "generating" rows older than 10 min to
    "failed", count all ProductFaq rows since UTC month start WITHOUT the
    status filter, throw FaqCapReachedError if used >= cap, create the
    "generating" placeholder row, return its id. Retry ONCE on Prisma P2034.
  - Layer 2 (service): generateProductFaqDraft re-checks
    countProductFaqsThisMonth (excludes "generating") before the Claude call.
- Gate read in BOTH loader and action via the inline pattern (ensurePlan is
  dead code, do not use it): `PLAN_LIMITS[store.plan as keyof typeof
  PLAN_LIMITS] ?? PLAN_LIMITS.FREE`, `maxProductFaqsPerMonth === 0` renders
  the feature-locked upsell banner linking to /app/pricing.
- Loaders return an explicit Store field pick (id, plan, and the new
  faqMetafieldDefinitionCreated), NEVER `...store` (token-leak guardrail).

## Data model (Agent A owns)

prisma/schema.prisma:
1. New model ProductFaq (mirror BlogPost conventions):
   - id String @id @default(cuid())
   - storeId String; store Store @relation(fields:[storeId], references:[id], onDelete: Cascade)
   - shopifyProductId String  (same format the Product model stores; convert
     to gid://shopify/Product/<id> at metafield write time)
   - productTitle String  (denormalized for list display without a join)
   - questions Json  (array of { question: string; answer: string })
   - status String @default("draft")  (generating | draft | published | failed | deleted)
   - publishedAt DateTime?
   - createdAt DateTime @default(now()); updatedAt DateTime @updatedAt
   - @@index([storeId]), @@index([storeId, status]),
     @@index([storeId, createdAt]), @@index([storeId, shopifyProductId])
2. Store: add `faqMetafieldDefinitionCreated Boolean @default(false)` and the
   back-relation `productFaqs ProductFaq[]`.
3. Hand-written migration prisma/migrations/20260702130000_add_product_faq/
   migration.sql in house style (comment header, AlterTable for the Store
   column with DEFAULT false, CreateTable, CreateIndex x4, AddForeignKey ON
   DELETE CASCADE ON UPDATE CASCADE). Timestamp sorts after
   20260702120000_add_citation_sources.

billing.shared.ts: add `maxProductFaqsPerMonth` to every plan block (values
above), positioned next to maxBlogPostsPerMonth.

## Service (Agent A owns): app/services/faq-generation.server.ts

Clone the shape of blog-generation.server.ts. Reuse, do not duplicate:
import stripEmDashes is not exported today, so REPLICATE the exact
stripEmDashes regex (`/\s*(?:—|&mdash;|&#8212;|&#x2014;)\s*/gi` -> ", ")
as a local helper with the same behavior, applied to every question and
answer string. (If blog-generation already exports it, import instead; check
first.)

Exports:
- `class FaqCapReachedError extends Error` (carries `cap: number`), mirroring
  BlogPostCapReachedError.
- `interface FaqDraft { questions: { question: string; answer: string }[] }`.
- `async function generateProductFaqDraft(storeId, options: { shopifyProductId: string; maxPerMonth: number }): Promise<FaqDraft>`:
  - Layer-2 cap check first: if maxPerMonth <= 0 throw FaqCapReachedError(0);
    if maxPerMonth !== Infinity and countProductFaqsThisMonth(storeId) >=
    maxPerMonth throw FaqCapReachedError(maxPerMonth). BEFORE the Claude call.
  - Read the product's cached context from the Product model by
    (storeId, shopifyProductId): title, description/body, productType,
    vendor (use whatever fields the Product model actually has; omit any
    that are absent). If the product is not cached, still proceed with just
    the title passed in options, or throw a clear "run an audit first" style
    error surfaced by the route. Do NOT add a Shopify Admin API read here;
    generation stays cache-only, only publishing touches GraphQL.
  - Claude call through withRetry: model "claude-sonnet-4-6", max_tokens
    1500, a SYSTEM_PROMPT that (a) instructs answer-first phrasing, concrete
    and specific, 40 to 60 word answers, 4 to 6 FAQs, real shopper questions
    (shipping, sizing, materials, care, compatibility, returns), (b)
    includes the CRITICAL em-dash ban line verbatim from blog-generation,
    (c) demands strict JSON output: `{ "faqs": [ { "question": "...",
    "answer": "..." } ] }`, no code fences, no preamble.
  - Parse: read message.content[0], guard type === "text", strip ```json
    fences (same regex as blog), JSON.parse in try/catch with a merchant-safe
    error, validate faqs is a non-empty array of objects with non-empty
    string question and answer, trim, drop malformed entries, cap at 6, run
    stripEmDashes on every question and answer, enforce reasonable length
    caps (question <= 200 chars, answer <= 600 chars). Return { questions }.
    Does NOT persist (the route writes the row).
- `async function countProductFaqsThisMonth(storeId): Promise<number>`: UTC
  start-of-month, count ProductFaq where createdAt >= start and status not
  "generating".
- `interface PublishResult { ok: boolean; error?: string; warning?: string }`
- `async function publishFaqToStorefront(admin, storeId, faqId): Promise<PublishResult>`:
  ownership guard prisma.productFaq.findFirst({ where: { id: faqId, storeId } });
  if missing return {ok:false,error}. Ensure the metafield definition exists
  ONCE per shop: if store.faqMetafieldDefinitionCreated is false, run
  metafieldDefinitionCreate (namespace "geo_rise", key "faq", type "json",
  ownerType PRODUCT, name "GEO Rise FAQ", access `{ admin:
  MERCHANT_READ_WRITE, storefront: PUBLIC_READ }`); treat a TAKEN userError
  as success; on success set store.faqMetafieldDefinitionCreated = true. Then
  metafieldsSet with metafields: [{ ownerId: gid, namespace "geo_rise", key
  "faq", type "json", value: JSON.stringify(faq.questions) }]. Error handling
  exactly like publishBlogPostToShopify: check json.errors, then userErrors
  (non-empty => merchant-safe message; scope/permission => reinstall hint),
  then confirm the returned metafield id; only then stamp status "published"
  and publishedAt. Never throw; return PublishResult.
- `async function unpublishFaqFromStorefront(admin, storeId, faqId): Promise<PublishResult>`:
  ownership guard, metafieldsSet the same key with value "[]" (empty JSON
  array) so the Liquid size gate hides it, set status back to "draft" and
  publishedAt null. Never throw.

Doc-verified GraphQL shapes to use (from shopify.dev 2025-07):
- metafieldsSet(metafields: [MetafieldsSetInput!]!) { metafields { id }
  userErrors { field message code } }. Max 25 per call. value is a STRING
  (JSON.stringify the array). ownerId is the full gid.
- metafieldDefinitionCreate(definition: MetafieldDefinitionInput!) {
  createdDefinition { id } userErrors { field message code } }. access is the
  FLAT form `access: { admin: MERCHANT_READ_WRITE, storefront: PUBLIC_READ }`
  (NOT nested). ownerType: PRODUCT (unquoted enum inline, or string in
  variables). Duplicate create returns a TAKEN userError, treat as success.
- Use inline #graphql with a variables object, matching audit-engine's
  mutation style; enums passed as strings in variables are fine.

## Route (Agent B owns): app/routes/app.faq-generator.tsx + app/routes/app.tsx

Clone app.blog-generator.tsx structure.
- Loader: narrow Store select (id, plan, faqMetafieldDefinitionCreated).
  Compute limits and monthlyCap = maxProductFaqsPerMonth; usedThisMonth via
  countProductFaqsThisMonth. List products for the picker from the cached
  Product model (prisma.product.findMany, select shopifyProductId + title,
  bounded take: 200, ordered by title). List the store's recent ProductFaq
  rows (status not "generating" and not "deleted", newest first, bounded)
  for the "your FAQs" section, including status and questions. If no cached
  products, the page shows an honest empty state pointing to the AI Audit
  (which populates the product cache). No Date objects in the payload
  (ISO strings).
- Action intents:
  - "generate": Layer-1 reserveQuotaSlot() Serializable transaction (reap
    orphaned "generating" > 10 min, count-all-since-month-start,
    FaqCapReachedError if >= cap, create "generating" placeholder with the
    chosen shopifyProductId + productTitle, return id) with the P2034
    single-retry; then call generateProductFaqDraft; on success update the
    placeholder row to status "draft" with the questions; on
    FaqCapReachedError / vendor error (via sanitizeAiVendorError) set the
    placeholder to "failed" and return a merchant-safe error. Map errors to
    toasts exactly like blog-generator (cap reached, serialization conflict,
    generic).
  - "publish": call publishFaqToStorefront(admin, store.id, faqId), toast the
    result. Requires admin from authenticate.admin.
  - "unpublish": call unpublishFaqFromStorefront, toast.
  - "delete": soft-delete (status "deleted") a draft row (ownership by
    storeId), toast.
  - Feature lock: monthlyCap === 0 returns the upsell error shape; the loader
    also flags it so the page renders the locked banner with a /app/pricing
    button.
- app/routes/app.tsx: add `<Link to="/app/faq-generator">FAQ Generator</Link>`
  right after the Blog Generator link.

UI: Polaris only, no recolored controls, no Polaris Grid, native layout
primitives already used in blog-generator. Product Select + Generate button;
a draft review card listing each Q and A as plain text with Publish /
Unpublish / Delete actions and a status Badge (standard tones). Honest copy:
explain FAQs render as FAQPage structured data on the product page after
publishing, and that publishing requires the theme app embed to be enabled.
Show usedThisMonth / monthlyCap. No em or en dashes anywhere.

## Theme extension (Agent C owns): schema-injection.liquid

Add a FAQPage JSON-LD block INSIDE the existing `{%- if page_type ==
'product' -%}` block (after the BreadcrumbList </script>, before the
matching endif), as its own standalone `<script type="application/ld+json">`
peer element (mirror the existing schema blocks; do NOT nest into Product).
- Prelude: `{%- assign faq_value = product.metafields.geo_rise.faq.value -%}`
- Gate the whole script with `{%- if faq_value.size > 0 -%}` (a json-typed
  metafield deserializes to an array; size 0 or nil renders nothing, so an
  empty or unpublished FAQ never emits an empty FAQPage).
- Emit:
  `{ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [`
  then `{%- for item in faq_value -%}` `{ "@type": "Question", "name": {{
  item.question | strip_html | json }}, "acceptedAnswer": { "@type":
  "Answer", "text": {{ item.answer | strip_html | json }} } }` with the
  file's comma idiom `{%- unless forloop.last -%},{%- endunless -%}` `{%-
  endfor -%}` `] }`.
- Every dynamic value goes through `| json` (the file's sole, sufficient
  escaping), and NEVER wrap it in your own quotes (`"name": {{ x | json }}`,
  not `"name": "{{ x | json }}"`). No app-embed setting gate: always-on when
  the metafield is present, matching the AggregateRating precedent.

## Known limitations / out of scope (v1)

- Inline editing of generated Q/A before publish (regenerate instead; note
  as the top v2 follow-up).
- Bulk generation across many products at once (per-product v1).
- Generation reads the CACHED Product model for context, so a product never
  audited or synced may generate thinner FAQs; the empty state points to the
  AI Audit which populates the cache.
- The metafield definition is created lazily on first publish. If Shopify
  changed the definition ownership rules, publish surfaces a clear error
  rather than silently failing.

## Verification

Central after all agents: prisma generate, tsc, build, em-dash scan on
changed files, adversarial review workflow (data / service+GraphQL / route /
theme dimensions, with paired skeptics; special attention to the metafield
GraphQL shapes and the two-layer cap race), fix confirmed findings, per-task
commits (data+service, route, theme), push, Render health check. Because the
theme extension changed, Lukas must run `npx shopify app deploy
--allow-updates` for FAQPage rendering to reach storefronts; the metafield
definition is created at runtime and needs no deploy. Smoke on boda-brands:
generate FAQs for a product, publish, confirm the metafield is set and (post
deploy) the FAQPage JSON-LD renders on the product page.

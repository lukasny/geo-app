# GEO Rise: Session Handoff

**Date:** 2026-05-18
**Head commit:** `acca940` (pushed to origin/main)
**Shopify app version:** `geo-rise-5` (deployed)
**Production:** https://geo-app-hkhi.onrender.com (Render auto-deploys from main)
**Dev store:** boda-brands.myshopify.com (storefront password: `etwawy`, on Growth plan via test billing)

Deep context lives in the memory files at
`C:\Users\nyima\.claude\projects\-Users-lukas-Desktop-geo-app\memory\` (start with
`project_checkpoint.md`). This file is the single-session snapshot.

---

## What's built and working (verified)

Everything below is deployed, typechecked, built, and where noted, manually tested
end-to-end on boda-brands.

| Feature | Status | Key files |
|---|---|---|
| llms.txt generator + public proxy | Live | `app/services/llms-generator.server.ts`, `app/routes/proxy.llms-txt.ts` |
| JSON-LD schema theme extension | Live | `extensions/geo-rise-schema/blocks/schema-injection.liquid` |
| AI readiness audit + vision auto-fix | Live | `app/services/audit-engine.server.ts` |
| AI Simulator (multi-AI: Claude + ChatGPT) | Live | `app/services/ai-simulator.server.ts` |
| AI Visibility Tracking (multi-platform + sentiment + schedule + trends) | Live | `app/services/tracking.server.ts`, `app/routes/app.tracking.tsx` |
| Competitor monitoring | Live | `app/services/competitor-monitoring.server.ts`, `app/routes/app.competitors.tsx` |
| Action plan / weekly to-do | Live | `app/services/action-plan.server.ts`, `app/routes/app.action-plan.tsx` |
| Weekly insight emails (Resend) | Live | `app/services/insight-email.server.ts`, `app/services/scheduler.server.ts` |
| **Blog post generation (this session)** | Live, user-tested 9/9 | `app/services/blog-generation.server.ts`, `app/routes/app.blog-generator.tsx` |
| **Onboarding wizard refresh (this session)** | Live, user-tested | `app/routes/app._index.tsx` (OnboardingWizard, Step2, Step3 components) |
| **Dashboard discovery cards (this session)** | Live, user-tested | `app/routes/app._index.tsx` (DiscoveryCards + 6 card subcomponents) |
| **Intent Lab (this session)** | Live, NOT yet user-tested | `app/services/tracking.server.ts` (cascade), `app/routes/app.tracking.tsx` (badges) |
| Billing (4 tiers, Shopify native) | Live | `app/services/billing.server.ts`, `app/services/billing.shared.ts` |

Pricing: Free / Growth $19 / Pro $49 / Enterprise $99. Plan caps enforced at the
service layer (post-Phase-E pattern), not just routes.

## What's mid-flight

### 1. Revenue attribution (code complete, webhook blocked on Shopify approval)

The full feature shipped this session (commits `b1f9c68`..`a2dd9db`) but it is only
HALF-ACTIVE in production:

- **Working now:** theme extension tracker script (deployed as `geo-rise-4`) detects
  AI referrers (ChatGPT / Perplexity / Claude / Gemini / Grok domains + utm_source
  fallback), writes a 30-day first-party cookie `__geo_rise_ai_ref` and a Shopify
  cart attribute. Dashboard "AI Revenue" card + `/app/revenue` page render (empty
  state). Privacy policy updated.
- **Blocked:** the `orders/paid` webhook that captures attributed orders into
  `AiTrafficEvent` rows. Shopify rejected the deploy: order webhooks require
  **Protected Customer Data access** approval. The handler file
  `app/routes/webhooks.orders.paid.tsx` exists but is never invoked.
- **Lukas's action:** apply in Partner Dashboard > Apps > GEO Rise > Configuration >
  Protected customer data access (purpose statement drafted in the session, see
  memory `project_checkpoint.md` changelog for 2026-05-18 evening).
- **After approval:** restore the commented-out subscription block in
  `shopify.app.toml` (search for "orders/paid subscription is intentionally
  OMITTED") and run `npx shopify app deploy --allow-updates --force`.

### 2. Intent Lab (deployed, awaiting re-auth + smoke test)

Shipped as `geo-rise-5` with the new `read_reports` scope. Lukas must:
1. Open GEO Rise admin on boda-brands and accept the "requires additional
   permissions" prompt (grants read_reports).
2. Go to AI Tracking, click "Suggest prompts for me", verify the source summary
   line and per-suggestion source badges (From your store / From r/... /
   AI suggested) appear.

If every suggestion shows "AI suggested", check Render logs for `[Intent Lab]`
warnings: either ShopifyQL returned nothing (store may have no search history)
or Reddit was unreachable.

## Key decisions made this session

1. **Em-dash ban is absolute** (Lukas directive, earlier session, carried through
   everything): no em-dashes in code, comments, UI copy, AI-generated content, or
   chat. Three-layer defense on generated content: prompt instruction + sanitizer +
   regex strip (`stripEmDashes` in blog-generation, similar elsewhere).
2. **Plan caps at the service layer, not routes.** `generateBlogPostDraft` throws
   `BlogPostCapReachedError` before the Claude call; `publishBlogPostToShopify`
   takes `storeId` and uses `findFirst({id, storeId})` for tenant isolation.
   Pattern documented in `project_known_fixes.md`.
3. **Blog soft-delete preserves quota.** Deleted drafts stay as rows with
   `status="deleted"`; `countBlogPostsThisMonth` excludes only `"generating"`.
   Deleting a draft does NOT refund the monthly slot (Anthropic was already paid).
4. **Revenue attribution = cart-attribute approach, not Web Pixel.** Faster to ship,
   reuses existing theme extension. 30-day last-AI-touch attribution window.
   Multi-currency safe (per-currency aggregation, no FX conversion). Refunds out
   of scope (documented limitation).
5. **Intent Lab replaces the brainstorm backend instead of adding a new surface.**
   Same "Suggest prompts" button; three-stage cascade (ShopifyQL search analytics +
   Reddit public JSON in parallel, Claude polish with per-signal source citation,
   pure-brainstorm fallback when both sources are empty).
6. **Wizard wow-step is bounded:** `runStarterAudit` caps at 5 products,
   `runWizardAutoFix` at 5 issues (new `maxIssues` option on `AutoFixOptions`),
   so step runtimes stay ~60s regardless of catalog size.

## Known bugs / sharp edges

- **No known open bugs.** Two found-and-fixed this session: Shopify
  `ArticleCreateInput.author` is required (fixed `fcc6a44`); wizard step 2 showed
  "Run an audit to find gaps" right after running an audit (fixed `5ea3184`).
- **Sharp edge: re-running the wizard overwrites audit data.** The wizard's
  5-product starter audit replaces all `AuditResult` rows and `store.geoScore`.
  Fine for new merchants, surprising when testing via the
  `onboardingCompleted=false` DB tweak. Fix: re-run a full audit from `/app/audit`
  afterward.
- **Sharp edge: ShopifyQL table/column names in Intent Lab Stage 1 are best-effort**
  (`online_store_search` / `search_term`). If Shopify's schema differs, the stage
  logs a ParseError and degrades to Reddit-only. Watch Render logs on first run.
- **TS cannot catch malformed Shopify GraphQL inputs** (the `author` bug proved
  it). Before claiming any new Shopify mutation works, verify the input shape
  against https://shopify.dev/docs/api/admin-graphql/2025-01.
- **No automated tests exist.** All verification is `npx tsc --noEmit` +
  `npm run build` + manual smoke tests. A Vitest suite is on the someday list.

## Next 3 tasks (in Lukas's approved order)

The agreed sequence: finish these features, then UI/UX polish, then brand identity,
then App Store submission. Each follows the same workflow: brainstorm skill →
spec in `docs/superpowers/specs/` → plan in `docs/superpowers/plans/` → inline
execution with per-task commits.

### Task 1: Product-level AI citation stats (~1 session)

"Your Videographer Snowboard was cited 12 times across ChatGPT and Perplexity
this month."

- Data already exists: `AiCitation.productsCited` (Json field, populated by
  `detectMentions` in `app/services/tracking.server.ts`).
- Build an aggregation (likely new `app/services/product-citations.server.ts` or
  extend tracking.server.ts) that groups citations per product across platforms
  and time.
- Surface: either a new section on `/app/tracking` or a per-product drill-in on
  the audit page (`app/routes/app.audit.tsx`). Decide in brainstorm.
- Schema: `prisma/schema.prisma` AiCitation model; no migration expected.

### Task 2: Multi-market llms.txt (~1-2 sessions)

Per-market llms.txt files for Shopify Markets (languages/currencies/subsets).

- `LlmsFile` model already has `marketCode` (unique per `[storeId, marketCode]`),
  default "default". Schema ready, zero rows use other codes yet.
- `app/services/llms-generator.server.ts` needs a market-aware variant: query
  Shopify Markets via GraphQL, generate one file per market.
- `app/routes/proxy.llms-txt.ts` needs market resolution (likely via query param
  or domain detection).
- `app/routes/app.llms-txt.tsx` needs a market picker UI.
- Plan flag already advertised: `PLAN_LIMITS[plan].multiMarketLlmsTxt` (Growth+).

### Task 3: Bulk editing UI (~1-2 sessions)

40rty-style grid: select N products, apply manual edits (meta title pattern,
alt-text template) without going through AI auto-fix.

- New route `app/routes/app.bulk-edit.tsx` (IndexTable with bulk selection).
- Reuse mutation helpers from `app/services/audit-engine.server.ts` (the
  productUpdate / media-alt mutations and the both-SEO-fields quirk documented
  in `project_known_fixes.md`).
- Plan flag exists: `PLAN_LIMITS[plan].bulkOptimization` (Growth+).

## Quick-start for the next session

```bash
cd geo-app
git pull
npx tsc --noEmit        # should be clean
npm run dev             # or: npx shopify app dev
```

- After any dev session: `npx shopify app deploy` restores production URLs
  (see memory `project_shopify_url_workflow.md`).
- Anthropic credits must be topped up for any AI feature to work:
  https://console.anthropic.com/settings/billing
- Render dashboard (deploys + logs): https://dashboard.render.com
- Neon SQL editor (DB pokes): https://console.neon.tech

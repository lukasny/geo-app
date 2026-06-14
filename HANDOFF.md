# GEO Rise: Session Handoff

**Date:** 2026-06-14
**Head commit:** `e607aac` (pushed to origin/main)
**Production:** https://geo-app-hkhi.onrender.com (Render auto-deploys from main)
**Dev store:** boda-brands.myshopify.com (storefront password: `etwawy`, on Growth plan via test billing)

This file supersedes the 2026-05-18 handoff. The repo is now self-sufficient:
this file plus `docs/` (especially `docs/product-roadmap-2026-06.md`,
`docs/launch-checklist.md`, and `docs/superpowers/specs|plans/`) and `CLAUDE.md`
are the authoritative pickup point. The `project_checkpoint.md` style memory
files the old handoff referenced live on a separate (Windows) machine and are
NOT needed to continue.

Verification convention: there are no automated tests. Every change is verified
with `npx tsc --noEmit` + `npm run build` + a manual smoke test on boda-brands.
Recent feature work also went through multi-agent adversarial review with Shopify
API shapes checked against shopify.dev for the pinned `2025-07` version.

---

## Current state (all verified)

`npx tsc --noEmit` clean, `npm run build` clean, working tree clean, HEAD == origin/main.
Every commit below was deployed and health-checked (production returned HTTP 200).

Scopes currently requested in `shopify.app.toml` (NOT yet active in production,
see Lukas actions): `write_products, read_content, write_content, read_orders,
read_reports, read_markets, read_translations, write_online_store_navigation`.
(`read_themes` was removed as unused.) API version pinned to `2025-07`.

Pricing (source of truth `app/services/billing.shared.ts`): Free $0 / Growth $19 /
Pro $49 / Enterprise $99, 7-day trial on paid tiers.

## What shipped 2026-06-12 to 06-14 (since the May handoff)

| Work | Commit(s) | Notes |
|---|---|---|
| Stale-docs + dependency vulnerability fixes | `2cd10eb` | |
| Task 1: Product-level AI citation stats | `52c0740..ae44f61` | "Top cited products" on /app/tracking; `product-citations.server.ts` |
| Task 2: Multi-market llms.txt | `b3e6c92..ddc31e8` | per-market files, market picker, `?market=` proxy; DORMANT until re-auth grants market scopes |
| Task 3: Bulk editing UI | `376ce3c..b5bd912` | /app/bulk-edit; extracted `product-mutations.server.ts` shared by auto-fix |
| UX polish batch (cross-page review) | `7efd66d` | ~70 findings; shared utils (platforms/severity/money/ScorePill), honest pricing, nav order |
| Billing: paid-to-paid downgrade fix | `d692f72` | "Switch to X" replaces the subscription instead of cancelling to Free |
| Launch checklist + App Store listing rewrite | `8018b43` | current prices/features; `read_themes` dropped |
| Full-app deep review: 46 confirmed bugs fixed | `14567c9` (28) + `b7fb28d` (18) | + honesty pass on pricing/revenue/email. See below. |
| Product roadmap | `bb4d2c1` | `docs/product-roadmap-2026-06.md` |
| Roadmap items 1+2: crawler visibility | `257ec79` + `e607aac` | robots.txt checker + snippet, crawler analytics (daily-counter), /llms.txt root redirect |

### Notable fixes from the deep review (were live bugs in the May-era code)
- Paid audits were 100% broken: the products GraphQL query requested ~6,900 cost
  points against Shopify's 1,000 cap. Now page size 15 + `variants(first: 25)` +
  real throttle handling. Lesson: check GraphQL requested cost for any
  `maxAuditProducts: Infinity` path; dev-store testing missed this because only
  FREE's 3-product pages fit the cap.
- Plan switches fired a CANCELLED webhook for the replaced subscription that
  downgraded paying merchants to Free; now identity-checked against the stored
  subscription id.
- Persisted `Store.shopifyAccessToken` went stale ~60 min after install (expiring
  offline tokens); services now fetch a fresh token via
  `offline-admin.server.ts` `getFreshAccessToken`.
- Auto-fix could overwrite a real product description with a stripped template;
  unusable AI output now fails instead of degrading merchant data.
- orders/paid (when enabled) now dedupes orderId; both cron paths are
  double-run-proof; weekly email has List-Unsubscribe + a signed `/unsubscribe`.

## What is next (NOT started)

The build queue lives in `docs/product-roadmap-2026-06.md`. Items 1 and 2 are
done (crawler checker + analytics, plus the root-redirect half of item 8).
Remaining, in ranked order:

3. AI traffic beacon (visits now, revenue later) - Growth/Pro
4. Product FAQ generator + FAQPage JSON-LD (+ Offer shippingDetails/returns) - Growth
5. GEO score history + trend (ScoreSnapshot + dashboard sparkline + email delta) - all plans
6. llms-full.txt + per-entry updated dates - Growth
7. Public shareable GEO score badge/page - Free
8. Verify schema embed + llms.txt are live (redirect half DONE; storefront-fetch verification of the embed remains) - all plans
9. Gemini tracking platform - Pro
10. Brand entity pack (sameAs/logo/description in Organization schema) - Growth
11. Bing presence check + IndexNow on product change - Pro
12. Shopify Flow triggers - Enterprise, only after 1-11

Plus three retention fixes that are not features (same doc): chunk auto-fix into
progress batches + write-then-swap full audit; auto-run Intent Lab in onboarding;
citation alerts (first/lost citation, competitor overtake).

Sequence agreed with Lukas: build features, then brand identity (Lukas owns this),
then App Store submission. Lukas paused the build queue here pending Fable 5
availability.

## Lukas-side actions (only Lukas can do these)

1. `npx shopify app deploy --allow-updates` from the geo-app folder: pushes the new
   scopes, `api_version 2025-07`, webhook config, and the theme extension to Shopify.
2. Update the Render `SCOPES` env var to match `shopify.app.toml`:
   `write_products,read_content,write_content,read_orders,read_reports,read_markets,read_translations,write_online_store_navigation`
3. Open GEO Rise on boda-brands and accept the new-permissions prompt. This
   activates multi-market llms.txt and the /llms.txt root redirect (both dormant
   until then).
4. Apply for Protected Customer Data access (Partner Dashboard > Apps > GEO Rise >
   Configuration). Required to enable orders/paid (revenue attribution) AND to
   justify `read_orders` in App Store review. After approval, un-comment the
   orders/paid block in `shopify.app.toml` and redeploy.
5. Manual test pass per `docs/launch-checklist.md` PART 3. Most June work is
   verified by typecheck/build/review but not yet smoke-tested on the store;
   priorities: one full audit on a paid test plan, a plan switch, the bulk editor,
   the crawler checker, and a market file.

## Conventions and sharp edges to respect

- **Em-dash ban is absolute**: none in code, comments, UI copy, AI-generated
  content, docs, or commit messages. Use commas, colons, or hyphens.
- **Verify Shopify GraphQL shapes against shopify.dev for `2025-07`** before
  claiming a mutation/query works. TypeScript cannot catch malformed GraphQL; this
  class of bug (wrong field, over-cost query, wrong scope) caused several of the
  deep-review criticals.
- **Plan caps enforced at the service layer**, not just routes.
- **Revenue attribution is half-active by design** until Protected Customer Data
  approval; all surfaces disclose this honestly. Do not re-enable orders/paid in
  the toml before approval.
- **Retention engine (cron) is in-process on a single Render instance**; deploys
  skip ticks. Acceptable now.

## Quick-start for the next session

```bash
cd geo-app
git pull
npx tsc --noEmit        # should be clean
npm run build           # should be clean
npm run dev             # or: npx shopify app dev
```

- Anthropic credits must be topped up for any AI feature to work:
  https://console.anthropic.com/settings/billing
- Render dashboard (deploys + logs): https://dashboard.render.com
- Neon SQL editor (DB pokes): https://console.neon.tech

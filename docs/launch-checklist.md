# GEO Rise: Launch Checklist

Last updated: 2026-06-12. This replaces the original May checklist, which predated the price change ($19/$49/$99), the Render deployment, the new scopes, and every feature shipped since (tracking, competitors, blog generator, revenue attribution, Intent Lab, product citation stats, multi-market llms.txt, bulk edit, UX polish).

Legend: [DONE] verified in code or production. [TEST] needs a manual pass on boda-brands. [ACTION] something only Lukas can do.

---

## PART 1: Already done (evidence in repo / production)

- [DONE] Production deployment: Render, auto-deploys from main (https://geo-app-hkhi.onrender.com responds 200; Dockerfile runs prisma migrate deploy on boot).
- [DONE] GDPR webhooks: customers/data_request, customers/redact, shop/redact handlers exist and are registered in shopify.app.toml.
- [DONE] App uninstall cleanup: webhooks.app.uninstalled.tsx deletes store data (cascade).
- [DONE] Billing through Shopify native API with test-mode auto-detection for dev stores (billing.server.ts detects partnerDevelopment). No external payment links.
- [DONE] Paid-to-paid plan switches create a replacement subscription (no accidental cancel-to-Free); plan switches skip the trial; cancel paths confirm first.
- [DONE] Privacy (/privacy) and Terms (/terms) are public routes, no login required, and disclose AI referral tracking.
- [DONE] Prices, limits, and trial days interpolate from billing.shared.ts everywhere in the UI (no hardcoded dollar amounts).
- [DONE] App proxy serves llms.txt at {shop}/a/llms-txt with market resolution (?market=handle).
- [DONE] Typecheck and build clean; eslint 0 errors.

## PART 2: One-time activation steps [ACTION]

Do these in order; the multi-market feature stays dormant until they happen.

1. From the geo-app folder run: `npx shopify app deploy --allow-updates`
   This pushes to Shopify: the new scopes (read_markets, read_translations, write_online_store_navigation), api_version 2025-07, the webhook config, the app proxy, and the theme extension (GEO Rise Schema).
2. In the Render dashboard, update the SCOPES env var to match shopify.app.toml:
   write_products,read_content,write_content,read_orders,read_reports,read_markets,read_translations,write_online_store_navigation
3. Open GEO Rise on boda-brands and accept the new-permissions prompt. This grants the market scopes (multi-market llms.txt) and write_online_store_navigation (the /llms.txt root redirect, created on the next generation).
4. Apply for Protected Customer Data access (Partner Dashboard > Apps > GEO Rise > Configuration). Required for read_orders/orders.paid; without it, revenue attribution stays half-active AND the App Store review may reject the read_orders scope. After approval, un-comment the orders/paid block in shopify.app.toml and deploy again.

## PART 3: Manual test pass on boda-brands [TEST]

The HANDOFF-era features were user-tested in May. Everything shipped 2026-06-12 needs a pass:

### New features
- [ ] AI Tracking: "Top cited products" card appears after running a check on a prompt that names one of your products.
- [ ] llms.txt Manager: market picker appears (after PART 2 steps + creating a test market in Shopify Settings > Markets); generate a market file; open its ?market= URL; confirm translated content and the Market line in the About section.
- [ ] Bulk Edit: select 2-3 products, apply meta template `{title} | {shop}` and alt template `{title} by {vendor}`; verify in Shopify admin that SEO titles changed, meta descriptions SURVIVED, and only empty alt texts were filled.
- [ ] Pricing: upgrade to Pro (test billing), then "Switch to Growth": Shopify approval page shows the replacement, no new trial mentioned, plan badge updates after approval. Then "Cancel plan" shows the confirmation modal.

### Spot-checks after the UX polish (UI changed on every page)
- [ ] Onboarding wizard (3 steps) completes on a reinstall; errors show a message, not an endless spinner.
- [ ] Dashboard: stat cards link out (View tracking / See action plan / Manage); quick actions disable each other while running.
- [ ] Audit: "Meta title / description" column shows Set/Missing badges; severity badges read "Critical" not "CRITICAL"; banner points to Action Plan and Bulk Edit.
- [ ] Deleting a tracking prompt, removing a competitor, and deleting a blog post each ask for confirmation first.
- [ ] Public proxy: {shop}/a/llms-txt returns plain text with # AI Bot Access at top.
- [ ] Theme extension: storefront page source contains application/ld+json with Product details and the AI-referral tracker writes the __geo_rise_ai_ref cookie when you visit with ?utm_source=chatgpt.

## PART 4: Partner Dashboard submission [ACTION]

App setup:
- [ ] App URL: https://geo-app-hkhi.onrender.com (already in shopify.app.toml; confirm Dashboard matches)
- [ ] Redirect URLs: the three /auth callbacks from shopify.app.toml
- [ ] Privacy policy URL: https://geo-app-hkhi.onrender.com/privacy
- [ ] Terms URL: https://geo-app-hkhi.onrender.com/terms
- [ ] Support email: hello@boda.no

Listing (copy from docs/app-store-listing.md, updated 2026-06-12):
- [ ] Tagline, description, key benefits
- [ ] Pricing tiers: Free / $19 / $49 / $99, 7-day trials on paid
- [ ] Categories: Search and discovery; Marketing and conversion
- [ ] Screenshots, 1600x900: dashboard, audit, tracking, simulator, llms.txt manager, bulk edit, pricing

Review-readiness:
- [ ] Scope justifications ready (table in app-store-listing.md). read_themes was already verified unused and dropped from the toml on 2026-06-12.
- [ ] Protected Customer Data approval granted (PART 2 step 4) BEFORE submitting, since read_orders is requested.
- [ ] App loads in under 3 seconds on a fresh install.
- [ ] Test credentials/instructions prepared for the Shopify review team (dev store access; note that AI features need ANTHROPIC_API_KEY credit).

## PART 5: Production notes

- Hosting is Render (NOT Fly.io as the old checklist said): auto-deploys from main on github.com/lukasny/geo-app; migrations apply on boot via `prisma migrate deploy`.
- Env vars live in the Render dashboard. Optional keys gate features: OPENAI_API_KEY (ChatGPT tracking + simulator), PERPLEXITY_API_KEY (Perplexity tracking), RESEND_API_KEY + INSIGHT_FROM_EMAIL (weekly emails), SCHEDULER_ENABLED.
- Anthropic credits must stay topped up for audit auto-fix, simulator, tracking, blog generation, and Intent Lab.

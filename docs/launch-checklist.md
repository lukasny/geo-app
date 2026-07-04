# GEO Rise: Launch Checklist

Last updated: 2026-07-03, revised by the launch-readiness audit (17 confirmed findings). Replaces the 2026-06-12 checklist.

Legend: [DONE] verified in code or production. [TEST] needs a manual pass on boda-brands. [ACTION] something only Lukas can do.

---

## PART 0: Launch decisions that need YOU (from the 2026-07-03 audit)

These gate submission. The code fixes from the audit are already in the repo; these are yours.

1. **read_orders scope + Protected Customer Data (the #1 rejection risk).** DECISION MADE 2026-07-03: launch WITHOUT read_orders (option A). `read_orders` has been removed from `shopify.app.toml` `[access_scopes]` (was: an unused sensitive scope with no live consumer, the top rejection risk). The app works fully without it: AI-referred VISIT tracking is live; only ORDER-level revenue attribution stays dark until a post-launch release adds read_orders back together with the PCD application and the orders/paid webhook. **Remaining YOUR actions to make the drop take effect:**
   - [ ] After this batch deploys, run `npx shopify app deploy --allow-updates` from `~/Desktop/geo-app` (this same deploy also ships the consent-gating theme extension fix, item 4).
   - [ ] Update the Render `SCOPES` env var to: `write_products,read_content,write_content,read_reports,read_markets,read_translations,write_online_store_navigation` (read_orders removed).
   - [ ] Re-auth on boda-brands (accept the permissions prompt) so the reduced scope set takes effect.
   - Note: `read_reports` (Intent Lab ShopifyQL) still needs PCD Level 2 to return data; it degrades to empty results without it, which is acceptable for launch, and unlike read_orders it HAS a live consumer so it is not an unused-scope risk.
2. **AI provider API keys in Render.** The listing promises ChatGPT and Perplexity tracking, but `OPENAI_API_KEY` and `PERPLEXITY_API_KEY` are optional and silently degrade to Claude-only if unset. Before submitting: confirm `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `PERPLEXITY_API_KEY` are all set in Render with funded accounts (so the reviewer sees all three platforms), OR soften the listing to match the deployed key set.
3. **Always-on Render instance.** Confirm the Render service is a paid always-on plan, not free/hobby with spin-down. A cold start (30-60s) fails the <3s first-load bar and silently stops the in-process cron scheduler.
4. **Theme extension deploy.** The consent-gating fix (below) changes the theme extension, so after this batch ships you must run `npx shopify app deploy --allow-updates` from `~/Desktop/geo-app` for it to reach storefronts.
5. **Provider no-training terms (Feb 2026 Partner Program rule).** Add one sentence to georise.app/privacy stating merchant data sent to AI providers is used only for inference, not model training (Anthropic and OpenAI commercial APIs default to no-training; verify Perplexity Sonar's current terms).
6. **Ops alerts + founder digest env vars in Render (day-one ops readiness, added 2026-07-04).** Set `OPS_ALERT_EMAIL` (your inbox) in Render before launch so error alert emails and the founder ops digest are live on day one; without it the app runs fine but nothing tells you when something breaks. Optional but recommended for launch week: `OPS_DIGEST=daily` (default is weekly, sent Mondays at 06:00 UTC) and `AI_DAILY_CALL_BUDGET` (global daily AI call cap; when reached, scheduled tracking checks pause until tomorrow and you get one email). `AI_FEATURES_DISABLED=true` is the emergency kill switch, leave it unset.

---

## PART 1: Already done (evidence in repo / production)

- [DONE] Production deployment: Render, auto-deploys from main (https://geo-app-hkhi.onrender.com responds 200; Dockerfile runs prisma migrate deploy on boot).
- [DONE] GDPR webhooks: customers/data_request, customers/redact, shop/redact handlers exist and are registered. As of 2026-07-03 customers/redact actually deletes order-linked AiTrafficEvent rows and data_request reports them (previously no-ops that assumed no customer data was stored).
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
2. In the Render dashboard, update the SCOPES env var to match shopify.app.toml (read_orders removed 2026-07-03):
   write_products,read_content,write_content,read_reports,read_markets,read_translations,write_online_store_navigation
3. Open GEO Rise on boda-brands and accept the new-permissions prompt. This grants the market scopes (multi-market llms.txt) and write_online_store_navigation (the /llms.txt root redirect, created on the next generation).
4. POST-LAUNCH ONLY: to activate order-level revenue attribution, apply for Protected Customer Data access (Partner Dashboard > Apps > GEO Rise > Configuration), then re-add read_orders to shopify.app.toml, un-comment the orders/paid block, deploy, and update the Render SCOPES env again. NOT needed for the initial submission (see PART 0 item 1).

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
- [ ] Privacy policy URL: https://georise.app/privacy
- [ ] Terms URL: https://georise.app/terms
- [ ] Support email: hello@boda.no
- [ ] **Emergency developer contact** set in the Dashboard (mandatory, requirement 4.5.6; a submission without it is returned unreviewed).
- [ ] **Install requirement:** set "Merchant must have online store" (the theme extension, app proxy, and /llms.txt redirect all need the Online Store channel).

Listing (copy from docs/app-store-listing.md):
- [ ] Tagline, description, key benefits (the description market-stat line was softened per the audit; no unverifiable statistics in listing content)
- [ ] Pricing tiers: Free / $19 / $49, Enterprise = custom/contact (NOT a listed $99 tier; it has no self-serve purchase path)
- [ ] Categories: Search and discovery; Marketing and conversion
- [ ] Screenshots, 1600x900: dashboard, audit, tracking, simulator, llms.txt manager, bulk edit, action-plan. **NO pricing screenshot** (rule 4.2.2 bans pricing in listing images, including the icon).
- [ ] **Data-and-privacy declarations** filled in the listing form, consistent with georise.app/privacy: product/store data is sent to Anthropic (always), OpenAI and Perplexity (when tracking those platforms), Resend (weekly emails); a first-party AI-referral cookie is set on shoppers.

Review-readiness:
- [ ] Scope justifications ready (table in app-store-listing.md, now including write_online_store_navigation). read_themes dropped 2026-06-12. See PART 0 item 1 for the read_orders decision.
- [ ] **Demo screencast** recorded (mandatory, requirement 4.5.3): walk through install, the onboarding wizard, running an audit, AI tracking, and the llms.txt manager. English audio or subtitles. The script at docs/app-store-listing.md ("Demo video script") seeds it.
- [ ] App loads in under 3 seconds on a fresh install (see PART 0 item 3, always-on Render).
- [ ] Test credentials + review instructions prepared (draft below).

### Review instructions to paste for the Shopify review team

> GEO Rise is an AI-search-optimization app. Test store: boda-brands.myshopify.com (storefront password: etwawy). AI features run on our server-side API keys (Anthropic, OpenAI, Perplexity) already funded in production, so no keys are needed from you; all three AI platforms are live.
>
> Suggested walkthrough: (1) Install and complete the 3-step onboarding wizard. (2) Open AI Audit and run an audit, then try one auto-fix. (3) Open AI Tracking, add a suggested prompt, run a check (Claude, ChatGPT, and Perplexity each return a result). (4) Open the llms.txt Manager and generate the file; it is publicly served at {shop}/a/llms-txt. (5) Open the AI Simulator on a product to see the field-by-field comparison and the raw-HTML check.
>
> Note: the storefront is password-protected for the demo, so the AI Simulator and the Bing Indexing sitemap check will show their honest "not publicly reachable yet" state, which is expected behavior on a password-protected store.

## PART 5: Production notes

- Hosting is Render (NOT Fly.io as the old checklist said): auto-deploys from main on github.com/lukasny/geo-app; migrations apply on boot via `prisma migrate deploy`.
- Env vars live in the Render dashboard. Optional keys gate features: OPENAI_API_KEY (ChatGPT tracking + simulator), PERPLEXITY_API_KEY (Perplexity tracking), RESEND_API_KEY + INSIGHT_FROM_EMAIL (weekly emails), SCHEDULER_ENABLED.
- Anthropic credits must stay topped up for audit auto-fix, simulator, tracking, blog generation, and Intent Lab.

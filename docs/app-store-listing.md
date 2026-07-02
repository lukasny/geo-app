# GEO Rise: Shopify App Store Listing

Last updated: 2026-07-03 (prices, features, and scopes match billing.shared.ts and shopify.app.toml as of this date; adjusted per the launch-readiness audit).

---

## App name
GEO Rise

## Tagline (80 chars max)
Make your store readable and recommendable for AI search engines

---

## Key benefits (bullet points shown on listing)

- Find out how AI search engines read your store, and fix what they miss
- One-click llms.txt generation, per market and language, served at your store's /llms.txt
- AI readiness audit scores every product on discoverability, with one-click auto-fix
- See exactly what AI sees on your product pages with the AI Simulator
- Track whether ChatGPT, Claude, and Perplexity actually cite your store and products
- Bulk-edit meta titles and image alt text across your catalog in one pass

---

## App description (~2000 characters)

**AI search is changing how shoppers find products. Is your store ready?**

When someone asks ChatGPT "what's the best running shoe under $150?" or tells Gemini "find me a sustainable skincare brand", your store either shows up or it doesn't. Most stores have never checked how AI assistants describe them. GEO Rise shows you, and helps you fix what they miss.

**What GEO Rise does**

GEO Rise is built for Generative Engine Optimization (GEO): making your store readable, trustworthy, and recommendable for AI search engines.

**llms.txt generator.** Publish a machine-readable index of exactly what you sell: products, collections, and blog posts in one plain-text file AI crawlers can read without JavaScript. Selling in multiple countries? Generate one llms.txt per Shopify Market, with translated content, local prices, and market URLs.

**AI readiness audit + auto-fix.** Every product scored across content, meta data, images, variants, and reviews. Get a store-wide GEO score and a prioritized action plan, then auto-fix missing meta descriptions and alt text with one click.

**Bulk editing.** Apply meta title patterns and alt-text templates to dozens of products at once, no AI required.

**AI Simulator.** See your product pages the way AI assistants see them, field by field, with specific fix recommendations.

**JSON-LD schema injection.** Structured data on every product, collection, and blog page, in the standard machine-readable format crawlers parse for prices, availability, and brand details.

**AI visibility tracking.** Monitor whether AI assistants cite your store, track sentiment, see which products get mentioned, and let Intent Lab suggest the prompts your real shoppers ask. Watch competitors too.

**AI blog posts and weekly digests.** Generate SEO-ready blog drafts and get a weekly email with your visibility trends.

**Start free. Upgrade when you're ready.**

The free plan includes llms.txt generation, schema injection, and a starter audit. Growth ($19/mo) unlocks tracking, bulk editing, and multi-market llms.txt. Pro ($49/mo) adds competitor monitoring and AI revenue attribution. Every paid plan starts with a 7-day free trial.

Install GEO Rise free today and see where your store stands with AI search.

---

## Pricing

| Plan       | Price            | Trial  |
|------------|------------------|--------|
| Free       | $0/month         | none   |
| Growth     | $19/month        | 7 days |
| Pro        | $49/month        | 7 days |
| Enterprise | Custom (contact) | none   |

Prices for Free/Growth/Pro are defined in `app/services/billing.shared.ts`; keep this table in sync with it. Enterprise is contact-only (the in-app card is a "Contact us" mailto, not a self-serve Billing API purchase), so it is listed as custom pricing with no trial claim, per App Store guidance on custom-priced tiers.

## Install requirements

- **Merchant must have an online store.** The theme app embed (JSON-LD + AI-referral tracking), the public llms.txt at `{shop}/a/llms-txt`, and the `/llms.txt` redirect all require the Online Store sales channel. Set the "Merchant must have online store" field in the listing form.

---

## App categories
- Search and discovery
- Marketing and conversion

## Required Shopify permissions (be ready to justify each in review)

| Scope | Why the app needs it |
|---|---|
| `write_products` | Auto-fix and bulk edit write product SEO fields and image alt text; the FAQ generator writes a product metafield |
| `read_content`, `write_content` | llms.txt includes blog posts; the blog generator publishes articles |
| `read_reports` | Intent Lab reads store search analytics via ShopifyQL (requires Protected Customer Data approval) |
| `read_markets`, `read_translations` | Multi-market llms.txt reads markets, locales, and translated content |
| `write_online_store_navigation` | Creates a one-time URL redirect from `/llms.txt` to the app-proxy path, since AI crawlers probe the root path |

> **`read_orders` is intentionally NOT in the current scope set for the initial submission.** Order-level revenue attribution (the order half of the AI Revenue page) and the `orders/paid` webhook stay disabled until Protected Customer Data (Level 2: orders) approval is granted in the Partner Dashboard. See the launch checklist and handoff for the decision. AI-referred VISIT tracking works today without it.

## Support
- Support email: hello@boda.no
- Privacy policy: https://georise.app/privacy (public, no login; the app's `/privacy` route 301-redirects here)
- Terms of service: https://georise.app/terms (public, no login; the app's `/terms` route 301-redirects here)

---

## Screenshots (minimum 3, maximum 8, 1600x900)

1. **Dashboard**: GEO score ring with store stats and quick actions
2. **AI Audit**: product table with score pills and issue breakdown
3. **AI Tracking**: prompt cards with citation timeline and top cited products
4. **AI Simulator**: side-by-side comparison of what AI sees vs Shopify data
5. **llms.txt Manager**: file preview with market picker and bot access controls
6. **Bulk Edit**: product grid with template preview
7. **Action Plan**: prioritized fixes across the catalog

> Do NOT screenshot the Pricing page or any surface showing dollar amounts. App Store rule 4.2.2 prohibits pricing information in listing images (including the icon); all pricing lives only in the listing's Pricing section.

## Demo video script (30 seconds)
- Open: "AI is the new Google. Is your store visible?"
- Show: GEO score on dashboard (low score)
- Show: Run audit, issues appear
- Show: Auto-fix button, score jumps
- Show: AI Tracking, a prompt gets cited with the store's product named
- End: "GEO Rise. Know where you stand with AI search. Free to install."

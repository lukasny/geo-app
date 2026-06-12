# GEO Rise: Shopify App Store Listing

Last updated: 2026-06-12 (prices, features, and scopes match billing.shared.ts and shopify.app.toml as of this date).

---

## App name
GEO Rise

## Tagline (80 chars max)
Get your products recommended by ChatGPT, Gemini & AI search engines

---

## Key benefits (bullet points shown on listing)

- Get discovered when shoppers ask AI for product recommendations
- One-click llms.txt generation: the AI equivalent of a sitemap, per market and language
- AI readiness audit scores every product on discoverability, with one-click auto-fix
- See exactly what AI sees on your product pages with the AI Simulator
- Track whether ChatGPT, Claude, and Perplexity actually cite your store and products
- Bulk-edit meta titles and image alt text across your catalog in one pass

---

## App description (~2000 characters)

**AI search is changing how shoppers find products. Is your store ready?**

When someone asks ChatGPT "what's the best running shoe under $150?" or tells Gemini "find me a sustainable skincare brand", your store either shows up or it doesn't. Most Shopify stores are invisible to AI. GEO Rise changes that.

**What GEO Rise does**

GEO Rise is built for Generative Engine Optimization (GEO): making your store readable, trustworthy, and recommendable for AI search engines.

**llms.txt generator.** Create a machine-readable file that tells ChatGPT, Gemini, Perplexity, and Claude exactly what you sell. Selling in multiple countries? Generate one llms.txt per Shopify Market, with translated content, local prices, and market URLs.

**AI readiness audit + auto-fix.** Every product scored across content, meta data, images, variants, and reviews. Get a store-wide GEO score and a prioritized action plan, then auto-fix missing meta descriptions and alt text with one click.

**Bulk editing.** Apply meta title patterns and alt-text templates to dozens of products at once, no AI required.

**AI Simulator.** See your product pages the way AI assistants see them, field by field, with specific fix recommendations.

**JSON-LD schema injection.** Structured data on every product, collection, and blog page, so AI engines extract accurate prices, availability, and brand details.

**AI visibility tracking.** Monitor whether AI assistants cite your store, track sentiment, see which products get mentioned, and let Intent Lab suggest the prompts your real shoppers ask. Watch competitors too.

**AI blog posts and weekly digests.** Generate SEO-ready blog drafts and get a weekly email with your visibility trends.

**Start free. Upgrade when you're ready.**

The free plan includes llms.txt generation, schema injection, and a starter audit. Growth ($19/mo) unlocks tracking, bulk editing, and multi-market llms.txt. Pro ($49/mo) adds competitor monitoring and AI revenue attribution. Every paid plan starts with a 7-day free trial.

Install GEO Rise free today and get found by AI.

---

## Pricing

| Plan       | Price     | Trial  |
|------------|-----------|--------|
| Free       | $0/month  | none   |
| Growth     | $19/month | 7 days |
| Pro        | $49/month | 7 days |
| Enterprise | $99/month | 7 days |

Prices are defined in `app/services/billing.shared.ts`; keep this table in sync with it.

---

## App categories
- Search and discovery
- Marketing and conversion

## Required Shopify permissions (be ready to justify each in review)

| Scope | Why the app needs it |
|---|---|
| `write_products` | Auto-fix and bulk edit write product SEO fields and image alt text |
| `read_content`, `write_content` | llms.txt includes blog posts; the blog generator publishes articles |
| `read_orders` | Revenue attribution reads AI-attributed orders (requires Protected Customer Data approval in the Partner Dashboard BEFORE submission) |
| `read_reports` | Intent Lab reads store search analytics via ShopifyQL |
| `read_markets`, `read_translations` | Multi-market llms.txt reads markets, locales, and translated content |

## Support
- Support email: hello@boda.no
- Privacy policy: https://geo-app-hkhi.onrender.com/privacy (public, no login)
- Terms of service: https://geo-app-hkhi.onrender.com/terms (public, no login)

---

## Screenshots (minimum 3, maximum 8, 1600x900)

1. **Dashboard**: GEO score ring with store stats and quick actions
2. **AI Audit**: product table with score pills and issue breakdown
3. **AI Tracking**: prompt cards with citation timeline and top cited products
4. **AI Simulator**: side-by-side comparison of what AI sees vs Shopify data
5. **llms.txt Manager**: file preview with market picker and bot access controls
6. **Bulk Edit**: product grid with template preview
7. **Pricing**: 4-column plan comparison

## Demo video script (30 seconds)
- Open: "AI is the new Google. Is your store visible?"
- Show: GEO score on dashboard (low score)
- Show: Run audit, issues appear
- Show: Auto-fix button, score jumps
- Show: AI Tracking, a prompt gets cited with the store's product named
- End: "GEO Rise. Get found by AI. Free to install."

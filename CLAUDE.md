# GEO Rise - Project Overview for Claude Code

## What this app is

GEO Rise is a Shopify app that helps merchants get their products discovered and recommended by AI search engines (ChatGPT, Gemini, Perplexity, Claude). The practice is called Generative Engine Optimization (GEO).

**Business goal:** 30,000 NOK/month via $19/mo Growth and $49/mo Pro subscriptions.
**Developer:** Lukas (Boda Apps, Norway) - non-technical founder using Claude Code to build.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Remix (Shopify official scaffold) |
| Language | TypeScript (strict) |
| UI | Shopify Polaris v12 + App Bridge React |
| Database | Neon PostgreSQL via Prisma ORM |
| AI | Anthropic SDK - `claude-sonnet-4-6` (always) + optional OpenAI and Perplexity |
| Billing | Shopify native billing API (direct GraphQL mutations) |
| Email | Resend (weekly insight digests) |
| Scheduler | node-cron (in-process, booted via `entry.server.tsx`) |
| Hosting | Render - production at https://geo-app-hkhi.onrender.com, auto-deploys from `main` |
| Shopify CLI | `@shopify/cli` |

---

## Directory structure

```
geo-rise/
├── app/
│   ├── routes/                    # All Remix routes
│   │   ├── app._index.tsx         # Dashboard + onboarding wizard
│   │   ├── app.tsx                # App shell + nav
│   │   ├── app.audit.tsx          # AI Audit results page
│   │   ├── app.simulator.tsx      # AI Agent Simulator (multi-AI, metered)
│   │   ├── app.llms-txt.tsx       # llms.txt Manager
│   │   ├── app.tracking.tsx       # AI visibility tracking + Intent Lab
│   │   ├── app.competitors.tsx    # Competitor monitoring
│   │   ├── app.action-plan.tsx    # Prioritized action plan from audit results
│   │   ├── app.blog-generator.tsx # AI blog post generator
│   │   ├── app.revenue.tsx        # AI revenue attribution
│   │   ├── app.pricing.tsx        # Plans & pricing page
│   │   ├── proxy.llms-txt.ts      # Public app proxy → serves llms.txt
│   │   ├── privacy.tsx            # Public privacy policy
│   │   ├── terms.tsx              # Public terms of service
│   │   ├── webhooks.app.uninstalled.tsx
│   │   ├── webhooks.app.scopes_update.tsx
│   │   ├── webhooks.app_subscriptions.update.tsx
│   │   ├── webhooks.products.update.tsx
│   │   ├── webhooks.products.delete.tsx
│   │   ├── webhooks.orders.paid.tsx       # Handler exists; subscription disabled (see Webhooks)
│   │   ├── webhooks.customers.data_request.tsx  # GDPR
│   │   ├── webhooks.customers.redact.tsx        # GDPR
│   │   └── webhooks.shop.redact.tsx             # GDPR
│   ├── services/                  # Server-side business logic
│   │   ├── llms-generator.server.ts   # Generates llms.txt via Shopify GraphQL
│   │   ├── audit-engine.server.ts     # Scores products + auto-fix
│   │   ├── ai-simulator.server.ts     # Multi-AI view simulator (Claude + optional ChatGPT)
│   │   ├── billing.server.ts          # Shopify billing API + plan limits
│   │   ├── billing.shared.ts          # Client-safe plan definitions + limits (no server imports)
│   │   ├── tracking.server.ts         # AI visibility tracking + Intent Lab prompt suggestions
│   │   ├── tracking-scheduler.server.ts   # Runs due tracking checks (DB + cron logic)
│   │   ├── tracking-scheduler.shared.ts   # Client-safe schedule types + computeNextRunAt
│   │   ├── scheduler.server.ts        # node-cron singleton (tracking checks + weekly digest)
│   │   ├── insight-email.server.ts    # Weekly insight emails via Resend
│   │   ├── competitor-monitoring.server.ts  # Competitor citation stats
│   │   ├── action-plan.server.ts      # Groups audit issues into actionable buckets
│   │   ├── blog-generation.server.ts  # AI blog post generation + monthly caps
│   │   ├── revenue-attribution.server.ts    # AI referral revenue aggregation
│   │   └── ai-retry.server.ts         # Cross-vendor AI error classification + retry/sanitization
│   ├── shopify.server.ts          # Shopify app config (authenticate, session)
│   ├── entry.server.tsx           # Boots the scheduler via side-effect import
│   └── db.server.ts               # Singleton Prisma client
├── prisma/
│   └── schema.prisma              # Full DB schema (12 models, 7 enums)
├── extensions/
│   └── geo-rise-schema/           # Theme app extension
│       ├── blocks/schema-injection.liquid  # JSON-LD injection + AI referral tracker
│       └── shopify.extension.toml
├── shopify.app.toml               # App config + webhooks + app proxy
├── docs/
│   └── app-store-listing.md       # App Store copy and screenshots guide
└── CLAUDE.md                      # This file
```

---

## Environment variables (.env)

```
DATABASE_URL=                  # Neon PostgreSQL connection string (pooled)
DIRECT_URL=                    # Neon direct (non-pooled) - for prisma migrations
ANTHROPIC_API_KEY=             # Claude - required (simulator, auto-fix, tracking)
OPENAI_API_KEY=                # OpenAI - optional (ChatGPT platform in AI Tracking)
PERPLEXITY_API_KEY=            # Perplexity - optional (Perplexity platform in AI Tracking)
SHOPIFY_API_KEY=               # From shopify.app.toml client_id
SHOPIFY_API_SECRET=            # From Shopify Partner Dashboard
SHOPIFY_APP_URL=               # Public URL (set by CLI during dev)
SCOPES=write_products,read_content,write_content,read_themes,read_orders,read_reports,read_markets,read_translations
SCHEDULER_ENABLED=             # Optional: "false" disables the tracking-check + insight-email crons (default: enabled)
RESEND_API_KEY=                # Optional: Resend API key - enables weekly insight emails. Without it, the UI surface exists but sends are no-ops.
INSIGHT_FROM_EMAIL=            # Optional: "Display Name <addr@domain>" sender. Default: "GEO Rise <onboarding@resend.dev>". Set to a verified-domain address for production.
```

Multi-platform tracking is opt-in per platform. With only `ANTHROPIC_API_KEY` set, the AI Tracking feature runs Claude only (current behavior). Adding `OPENAI_API_KEY` and/or `PERPLEXITY_API_KEY` makes each tracking-check fan out to those platforms too - one `AiCitation` row per platform per check, displayed alongside Claude on each prompt card.

---

## Database schema overview

See `prisma/schema.prisma` for full definitions. Key models:

| Model | Purpose |
|---|---|
| `Session` | Shopify OAuth sessions (managed by shopify-app-remix) |
| `Store` | One record per installed merchant. Holds plan, GEO score, flags |
| `Product` | Cached product data + per-product AI readiness score |
| `AuditResult` | Individual issues found per product (severity, category, recommendation) |
| `LlmsFile` | Generated llms.txt content + settings per store |
| `AiCitation` | Tracked AI mentions per platform |
| `TrackingPrompt` | Prompts to monitor across AI platforms |
| `Competitor` | Competitor domains to monitor |
| `AiTrafficEvent` | AI referral traffic events |
| `Subscription` | Mirrors Shopify subscription status in our DB |
| `BlogPost` | Generated blog posts. Soft-delete via status `"deleted"`; the monthly plan cap counts all rows this month except status `"generating"` placeholders |
| `SimulationUsage` | One row per AI Simulator run, counted monthly to enforce plan caps |

**Enums (7):** `Plan` (FREE/GROWTH/PRO/ENTERPRISE), `Severity` (CRITICAL/HIGH/MEDIUM/LOW), `AiPlatform`, `AuditCategory`, `Sentiment`, `TrackingSchedule` (MANUAL/DAILY/WEEKLY), `SubscriptionStatus`

---

## Key services

### `llms-generator.server.ts`
- `generateLlmsTxt(storeId)` - fetches products/collections/blog posts via Shopify Admin GraphQL, formats as llms.txt, saves to DB
- Uses exponential backoff (`withRetry`) for rate limit handling
- API version: 2025-01

### `audit-engine.server.ts`
- `runFullAudit(storeId, admin)` - scores all products across 5 rubric categories (Content 35, Meta 15, Images 20, Variants 15, Reviews 15 pts)
- `autoFixIssues(storeId, admin)` - auto-generates meta descriptions and alt text via Shopify mutations
- Rate limiting: pauses at 75% of `X-Shopify-Shop-Api-Call-Limit`

### `ai-simulator.server.ts`
- `simulateAiView(productUrl, shopifyProductData)` - fetches live HTML, sends it to one or more AI platforms, compares 22 fields
- Multi-AI: Claude (`claude-sonnet-4-6`) always runs; ChatGPT (`gpt-4o-mini`) runs when `OPENAI_API_KEY` is set
- Returns visibility score + field-by-field comparison per platform
- max_tokens: 1024; usage metered via `SimulationUsage` rows against monthly plan caps

### `tracking.server.ts`
- AI visibility tracking: runs tracking prompts against Claude (always), plus ChatGPT (`gpt-4o-search-preview`) and Perplexity when their keys are set - one `AiCitation` row per platform per check
- Intent Lab: suggests tracking prompts from real signals - top storefront search terms via ShopifyQL, plus Claude-detected niche/subreddit candidates

### `tracking-scheduler.server.ts` / `tracking-scheduler.shared.ts`
- `runDueTrackingChecks()` - finds prompts whose `nextRunAt` is due and runs them (with a safety cap per tick)
- `.shared.ts` holds client-safe types + `computeNextRunAt(schedule)` for MANUAL/DAILY/WEEKLY

### `scheduler.server.ts`
- node-cron singleton, booted by a side-effect import in `entry.server.tsx`, HMR-safe via `globalThis`
- Tracking checks every 15 minutes; weekly insight digest tick daily at 09:00
- Disable with `SCHEDULER_ENABLED=false`

### `insight-email.server.ts`
- Weekly insight digest emails via Resend (`runWeeklyInsightDigest`)
- No-op when `RESEND_API_KEY` is unset; sender configurable via `INSIGHT_FROM_EMAIL`

### `competitor-monitoring.server.ts`
- `getCompetitorOverview(...)` - per-competitor citation stats from `AiCitation` rows: cited count, last cited, by-platform breakdown, head-to-head vs the merchant's own store

### `action-plan.server.ts`
- `getActionPlan(...)` - groups open `AuditResult` issues into prioritized action buckets (severity, category, affected-product counts) for the Action Plan page

### `blog-generation.server.ts`
- Generates SEO/GEO blog posts via Claude (topic, keywords, tone, length), sanitized HTML
- Stored as local drafts; "Publish" creates the article on Shopify via `articleCreate`
- Monthly caps per plan (Free 0, Growth 5, Pro 20, Enterprise 100), enforced via `countBlogPostsThisMonth`

### `revenue-attribution.server.ts`
- Aggregates `AiTrafficEvent` rows into revenue totals per AI platform and currency
- Half-active: the theme-extension tracker writes cart attributes today, but `AiTrafficEvent` rows are only created by the `orders/paid` webhook, whose subscription is disabled pending Protected Customer Data approval (see Webhooks)

### `ai-retry.server.ts`
- Cross-vendor (Anthropic, OpenAI, Perplexity) error classification: `isPermanentApiError` detects billing/auth/model errors so retry loops bail immediately
- Shared `withRetry` + error sanitization used by simulator, tracking, audit auto-fix, and blog generation

### `billing.shared.ts`
- Client-safe `PLAN_DEFINITIONS` (names, prices, trial days) and `PLAN_LIMITS` - importable from route components; no server-only imports allowed here

### `billing.server.ts`
- Server-side billing logic; plan definitions/limits live in `billing.shared.ts`
- `createSubscription(admin, planKey, shopDomain)` - `appSubscriptionCreate` GraphQL mutation → returns `confirmationUrl`
- `cancelSubscription(admin, subscriptionId, shopDomain)` - `appSubscriptionCancel` mutation + DB downgrade
- `getActiveSubscription(admin)` - queries `currentAppInstallation { activeSubscriptions }`
- `syncSubscriptionFromShopify(admin, shopDomain)` - call when returning from billing approval
- `checkAndEnforceLimits(storeId, planKey, feature)` - checks real usage vs plan limits
- `ensurePlan(storePlan, requiredPlan)` - route guard, returns `redirect("/app/pricing")` or null

---

## App proxy

The app proxy serves `llms.txt` publicly at `{shop}.myshopify.com/a/llms-txt`.

Config in `shopify.app.toml`:
```toml
[app_proxy]
url = "https://geo-app-hkhi.onrender.com/proxy/llms-txt"
subpath = "llms-txt"
prefix = "a"
```

Note: Shopify does not allow periods in proxy subpaths - use "llms-txt" not "llms.txt".

---

## Theme extension

Located at `extensions/geo-rise-schema/`.

- Type: `theme` (app embed block)
- Target: `"head"` - injected into `<head>` of all pages
- Injects JSON-LD schemas for: Organization, WebSite+SearchAction, Product+Offer+BreadcrumbList, CollectionPage, BlogPosting, Blog
- Also contains the AI referral tracker: detects visits referred by AI platforms (ChatGPT, Perplexity, Claude, Gemini, Grok) via referrer/utm_source and tags the cart with a `__geo_rise_ai_ref` attribute (last-AI-touch model). The attribute flows into the order's note_attributes for revenue attribution
- Liquid workaround for SearchAction URL: uses string concatenation to avoid Liquid parser confusion with `{search_term_string}`

To enable on a store: Online Store → Themes → Customize → App embeds → toggle on "GEO Rise - AI Schema"

---

## Billing

Billing uses direct Shopify GraphQL mutations (NOT the shopify-app-remix billing helpers).

Plans (defined in `app/services/billing.shared.ts`):
| Key | Name | Price | Trial |
|---|---|---|---|
| FREE | Free | $0 | - |
| GROWTH | Growth | $19/mo | 7 days |
| PRO | Pro | $49/mo | 7 days |
| ENTERPRISE | Enterprise | $99/mo | 7 days |

Flow:
1. User clicks upgrade → `createSubscription()` → redirect to Shopify `confirmationUrl`
2. Merchant approves → Shopify redirects back to `/app/pricing?charge_id=...`
3. Loader detects `charge_id` → `syncSubscriptionFromShopify()` → updates DB
4. `app_subscriptions/update` webhook fires → `webhooks.app_subscriptions.update.tsx` syncs as backup

---

## Webhooks registered

| Topic | Handler | Purpose |
|---|---|---|
| `app/uninstalled` | `webhooks.app.uninstalled.tsx` | Delete all store data |
| `app/scopes_update` | `webhooks.app.scopes_update.tsx` | Scaffold default |
| `app_subscriptions/update` | `webhooks.app_subscriptions.update.tsx` | Sync plan to DB |
| `products/create` + `products/update` | `webhooks.products.update.tsx` | Update product cache + auto-regenerate llms.txt |
| `products/delete` | `webhooks.products.delete.tsx` | Remove product from local cache + regenerate llms.txt |
| `orders/paid` | `webhooks.orders.paid.tsx` | Create `AiTrafficEvent` rows from the cart's AI-referral attribute. Handler exists, but the subscription is intentionally commented out in `shopify.app.toml`: Shopify requires Protected Customer Data approval before any order/customer webhook. Restore the block after approval |
| `customers/data_request` (GDPR) | `webhooks.customers.data_request.tsx` | No customer personal data held; logs and acks |
| `customers/redact` (GDPR) | `webhooks.customers.redact.tsx` | No customer personal data held; logs and acks |
| `shop/redact` (GDPR) | `webhooks.shop.redact.tsx` | Delete all shop data, fired 48h after uninstall |

---

## How to run

```bash
# Install dependencies
npm install

# Push DB schema to Neon
npx prisma db push

# Start dev server (Shopify CLI tunnels to localhost)
npm run dev
# or: shopify app dev
```

After running `npm run dev`, Shopify CLI will:
1. Print a URL - open it to install the app on your dev store
2. Set `SHOPIFY_APP_URL` automatically

---

## How to deploy

**App (production):** hosted on Render at https://geo-app-hkhi.onrender.com. Render auto-deploys from the `main` branch - pushing to `main` is the deploy.

**Theme extension + app config:**

```bash
shopify app deploy --allow-updates
```

This deploys both the app config (`shopify.app.toml`) and the theme extension to the Shopify Partner Dashboard.

---

## Feature status

### Built ✅
- [x] Prisma schema + Neon PostgreSQL
- [x] llms.txt generator service + admin page
- [x] App proxy (public llms.txt at `/a/llms-txt`)
- [x] JSON-LD schema theme extension (app embed)
- [x] AI readiness audit engine + auto-fix
- [x] Audit results page (with IndexTable, filters, product detail modal)
- [x] AI Simulator (multi-AI: Claude always, ChatGPT when `OPENAI_API_KEY` is set; metered via `SimulationUsage`)
- [x] Main dashboard + 4-step onboarding wizard
- [x] Billing service (createSubscription, cancel, sync, plan limits)
- [x] Pricing page (4-tier, Shopify native billing)
- [x] Subscription webhook handler
- [x] Products webhook handlers (create/update/delete; auto-regenerate llms.txt on change)
- [x] App uninstall webhook (cascade delete) + GDPR compliance webhooks
- [x] Privacy policy + Terms of Service pages
- [x] AI visibility tracking page (`/app/tracking`) with Intent Lab prompt suggestions
- [x] Competitor monitoring page (`/app/competitors`)
- [x] Action plan page (`/app/action-plan`)
- [x] Weekly insight email system (Resend + node-cron scheduler)
- [x] AI blog post generation (`/app/blog-generator`, monthly plan caps)
- [x] AI revenue attribution (`/app/revenue`) - HALF-ACTIVE: theme-extension tracker is live, but the `orders/paid` webhook subscription is intentionally disabled in `shopify.app.toml` pending Shopify Protected Customer Data approval, so no `AiTrafficEvent` rows are created yet

### Planned / Not yet built ❌
- [ ] Activate `orders/paid` webhook (after Protected Customer Data approval) to complete revenue attribution
- [ ] Multi-market llms.txt
- [ ] EU compliance module
- [ ] Shopify Flow integration

---

## Naming conventions

- Route files: `app.[page-name].tsx` for admin pages, `webhooks.[topic].tsx` for webhooks
- Server services: `[name].server.ts` suffix (Remix convention - never imported client-side)
- All GraphQL: use `admin.graphql()` with `#graphql` tag for syntax highlighting
- Plan keys: always uppercase (`"FREE"`, `"GROWTH"`, `"PRO"`, `"ENTERPRISE"`)
- Imports: use `~/` alias for `app/` directory (configured in tsconfig.json paths)
- No em-dashes, anywhere: not in code, comments, UI copy, docs, or AI-generated content. Use commas, colons, or hyphens instead. This is an absolute project rule.

# GEO Rise — Project Overview for Claude Code

## What this app is

GEO Rise is a Shopify app that helps merchants get their products discovered and recommended by AI search engines (ChatGPT, Gemini, Perplexity, Claude). The practice is called Generative Engine Optimization (GEO).

**Business goal:** 30,000 NOK/month via $39/mo Growth and $79/mo Pro subscriptions.
**Developer:** Lukas (Boda Apps, Norway) — non-technical founder using Claude Code to build.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Remix (Shopify official scaffold) |
| Language | TypeScript (strict) |
| UI | Shopify Polaris v12 + App Bridge React |
| Database | Neon PostgreSQL via Prisma ORM |
| AI | Anthropic SDK — `claude-sonnet-4-6` |
| Billing | Shopify native billing API (direct GraphQL mutations) |
| Hosting | To be deployed (Fly.io or Render recommended) |
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
│   │   ├── app.simulator.tsx      # AI Agent Simulator
│   │   ├── app.llms-txt.tsx       # llms.txt Manager
│   │   ├── app.pricing.tsx        # Plans & pricing page
│   │   ├── proxy.llms-txt.ts      # Public app proxy → serves llms.txt
│   │   ├── privacy.tsx            # Public privacy policy
│   │   ├── terms.tsx              # Public terms of service
│   │   ├── webhooks.app.uninstalled.tsx
│   │   ├── webhooks.app.scopes_update.tsx
│   │   ├── webhooks.app_subscriptions.update.tsx
│   │   └── webhooks.products.update.tsx
│   ├── services/                  # Server-side business logic
│   │   ├── llms-generator.server.ts   # Generates llms.txt via Shopify GraphQL
│   │   ├── audit-engine.server.ts     # Scores products + auto-fix
│   │   ├── ai-simulator.server.ts     # Claude-powered AI view simulator
│   │   └── billing.server.ts          # Shopify billing API + plan limits
│   ├── shopify.server.ts          # Shopify app config (authenticate, session)
│   └── db.server.ts               # Singleton Prisma client
├── prisma/
│   └── schema.prisma              # Full DB schema (10 models, 6 enums)
├── extensions/
│   └── geo-rise-schema/           # Theme app extension
│       ├── blocks/schema-injection.liquid  # JSON-LD injection into <head>
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
DIRECT_URL=                    # Neon direct (non-pooled) — for prisma migrations
ANTHROPIC_API_KEY=             # Claude — required (simulator, auto-fix, tracking)
OPENAI_API_KEY=                # OpenAI — optional (ChatGPT platform in AI Tracking)
PERPLEXITY_API_KEY=            # Perplexity — optional (Perplexity platform in AI Tracking)
SHOPIFY_API_KEY=               # From shopify.app.toml client_id
SHOPIFY_API_SECRET=            # From Shopify Partner Dashboard
SHOPIFY_APP_URL=               # Public URL (set by CLI during dev)
SCOPES=write_products
SCHEDULER_ENABLED=             # Optional: "false" disables the tracking-check + insight-email crons (default: enabled)
RESEND_API_KEY=                # Optional: Resend API key — enables weekly insight emails. Without it, the UI surface exists but sends are no-ops.
INSIGHT_FROM_EMAIL=            # Optional: "Display Name <addr@domain>" sender. Default: "GEO Rise <onboarding@resend.dev>". Set to a verified-domain address for production.
```

Multi-platform tracking is opt-in per platform. With only `ANTHROPIC_API_KEY` set, the AI Tracking feature runs Claude only (current behavior). Adding `OPENAI_API_KEY` and/or `PERPLEXITY_API_KEY` makes each tracking-check fan out to those platforms too — one `AiCitation` row per platform per check, displayed alongside Claude on each prompt card.

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

**Enums:** `Plan` (FREE/GROWTH/PRO/ENTERPRISE), `Severity` (CRITICAL/HIGH/MEDIUM/LOW), `AiPlatform`, `AuditCategory`, `Sentiment`, `SubscriptionStatus`

---

## Key services

### `llms-generator.server.ts`
- `generateLlmsTxt(storeId)` — fetches products/collections/blog posts via Shopify Admin GraphQL, formats as llms.txt, saves to DB
- Uses exponential backoff (`withRetry`) for rate limit handling
- API version: 2025-01

### `audit-engine.server.ts`
- `runFullAudit(storeId, admin)` — scores all products across 5 rubric categories (Content 35, Meta 15, Images 20, Variants 15, Reviews 15 pts)
- `autoFixIssues(storeId, admin)` — auto-generates meta descriptions and alt text via Shopify mutations
- Rate limiting: pauses at 75% of `X-Shopify-Shop-Api-Call-Limit`

### `ai-simulator.server.ts`
- `simulateAiView(productUrl, shopifyProductData)` — fetches live HTML, sends to Claude Sonnet 4.6, compares 22 fields
- Returns visibility score + field-by-field comparison
- Model: `claude-sonnet-4-6`, max_tokens: 1024

### `billing.server.ts`
- `PLAN_DEFINITIONS` / `PLAN_LIMITS` — single source of truth for plan features
- `createSubscription(admin, planKey, shopDomain)` — `appSubscriptionCreate` GraphQL mutation → returns `confirmationUrl`
- `cancelSubscription(admin, subscriptionId, shopDomain)` — `appSubscriptionCancel` mutation + DB downgrade
- `getActiveSubscription(admin)` — queries `currentAppInstallation { activeSubscriptions }`
- `syncSubscriptionFromShopify(admin, shopDomain)` — call when returning from billing approval
- `checkAndEnforceLimits(storeId, planKey, feature)` — checks real usage vs plan limits
- `ensurePlan(storePlan, requiredPlan)` — route guard, returns `redirect("/app/pricing")` or null

---

## App proxy

The app proxy serves `llms.txt` publicly at `{shop}.myshopify.com/a/llms-txt`.

Config in `shopify.app.toml`:
```toml
[app_proxy]
url = "https://your-app-url/proxy/llms-txt"
subpath = "llms-txt"
prefix = "a"
```

Note: Shopify does not allow periods in proxy subpaths — use "llms-txt" not "llms.txt".

---

## Theme extension

Located at `extensions/geo-rise-schema/`.

- Type: `theme` (app embed block)
- Target: `"head"` — injected into `<head>` of all pages
- Injects JSON-LD schemas for: Organization, WebSite+SearchAction, Product+Offer+BreadcrumbList, CollectionPage, BlogPosting, Blog
- Liquid workaround for SearchAction URL: uses string concatenation to avoid Liquid parser confusion with `{search_term_string}`

To enable on a store: Online Store → Themes → Customize → App embeds → toggle on "GEO Rise — AI Schema"

---

## Billing

Billing uses direct Shopify GraphQL mutations (NOT the shopify-app-remix billing helpers).

Plans:
| Key | Name | Price | Trial |
|---|---|---|---|
| FREE | Free | $0 | — |
| GROWTH | Growth | $39/mo | 7 days |
| PRO | Pro | $79/mo | 7 days |
| ENTERPRISE | Enterprise | $199/mo | 7 days |

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
1. Print a URL — open it to install the app on your dev store
2. Set `SHOPIFY_APP_URL` automatically

---

## How to deploy theme extension

```bash
shopify app deploy --allow-updates
```

This deploys both the app and the theme extension to the Shopify Partner Dashboard.

---

## Feature status

### Built ✅
- [x] Prisma schema + Neon PostgreSQL
- [x] llms.txt generator service + admin page
- [x] App proxy (public llms.txt at `/a/llms-txt`)
- [x] JSON-LD schema theme extension (app embed)
- [x] AI readiness audit engine + auto-fix
- [x] Audit results page (with IndexTable, filters, product detail modal)
- [x] AI Simulator (Claude Sonnet 4.6 powered)
- [x] Main dashboard + 4-step onboarding wizard
- [x] Billing service (createSubscription, cancel, sync, plan limits)
- [x] Pricing page (4-tier, Shopify native billing)
- [x] Subscription webhook handler
- [x] Products webhook handler (auto-regenerate llms.txt on change)
- [x] App uninstall webhook (cascade delete)
- [x] Privacy policy + Terms of Service pages

### Planned / Not yet built ❌
- [ ] AI visibility tracking page (`/app/tracking`)
- [ ] Competitor monitoring page
- [ ] Weekly insight email system
- [ ] Multi-market llms.txt
- [ ] Content engine
- [ ] EU compliance module
- [ ] Shopify Flow integration
- [ ] Revenue attribution tracking

---

## Naming conventions

- Route files: `app.[page-name].tsx` for admin pages, `webhooks.[topic].tsx` for webhooks
- Server services: `[name].server.ts` suffix (Remix convention — never imported client-side)
- All GraphQL: use `admin.graphql()` with `#graphql` tag for syntax highlighting
- Plan keys: always uppercase (`"FREE"`, `"GROWTH"`, `"PRO"`, `"ENTERPRISE"`)
- Imports: use `~/` alias for `app/` directory (configured in tsconfig.json paths)

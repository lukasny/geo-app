# Revenue attribution

**Date:** 2026-05-18
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

Show merchants how much actual order revenue is driven by AI search engines (ChatGPT, Perplexity, Claude, Gemini, etc.) referring shoppers to their store. Closes the loop on "is this app actually making me money" - the question every merchant asks after a few weeks of seeing AI Tracking citation counts.

## Scope

**In scope:**
- Storefront-side AI-referral detection via the existing theme app embed.
- A 30-day rolling attribution window, last-AI-touch model.
- `orders/paid` webhook handler that creates `AiTrafficEvent` rows when an attributed order ships.
- A revenue aggregation service used by both the dashboard card and the new page.
- A new dashboard card surfacing the headline number on the main `/app` view.
- A new `/app/revenue` page with stats, a daily chart, and a per-order table.
- Plan gating: Pro and Enterprise see the full feature; Free and Growth see an upgrade banner using the existing `PLAN_LIMITS[plan].revenueAttribution` flag.
- Privacy policy update noting AI referral data collection.

**Out of scope:**
- Web Pixel extension (Shopify's modern analytics surface). We may migrate later, but the cart-attribute + order-webhook approach delivers the same data without the new extension surface.
- Currency conversion / FX. Each `AiTrafficEvent` records the order's native currency; aggregations group by currency.
- Refund handling. Refunded orders still show as attributed revenue. Future work: subscribe to `refunds/create`.
- Order edits. We freeze `orderRevenue` at the original webhook payload value.
- A/B testing or multi-touch attribution models. Last-AI-touch only.
- Backfilling historical orders. Attribution only applies forward from feature ship.
- Automated tests. The project has no test suite; verification is typecheck + build + manual smoke test (consistent with the rest of the codebase).

## Architecture

Four moving parts plus one new row per attributed order.

### 1. Storefront tracking (theme app embed block)

The existing `extensions/geo-rise-schema/blocks/schema-injection.liquid` block currently injects JSON-LD into `<head>`. We extend it with a small inline `<script>` (no new theme block; one block keeps the merchant's enablement decision binary).

On `DOMContentLoaded` the script:

1. Checks `document.referrer` against the AI domain pattern list. Every pattern maps to an existing `AiPlatform` enum value, no schema migration:
   - `chatgpt.com`, `chat.openai.com`, `openai.com` → `CHATGPT`
   - `perplexity.ai`, `www.perplexity.ai` → `PERPLEXITY`
   - `claude.ai` → `CLAUDE`
   - `gemini.google.com`, `bard.google.com` → `GEMINI` (Bard rebranded to Gemini in early 2024)
   - `grok.com`, `x.ai` → `GROK`
   - As a fallback: matches the `?utm_source=` query-string parameter against `chatgpt|claude|perplexity|gemini|grok` (some AI tools strip the referrer but pass UTM tags).
2. If matched, the resolved platform string is the canonical enum value. Unmatched referrers exit silently.
3. If `document.referrer` does NOT match but a previously-set first-party cookie `__geo_rise_ai_ref` exists and is younger than 30 days, the platform is read from the cookie. This preserves attribution across direct-revisit journeys.
4. With a non-null platform:
   - Writes the cookie `__geo_rise_ai_ref=<platform>:<unix_seconds>` with `Max-Age=2592000` (30 days), `Path=/`, `SameSite=Lax`.
   - POSTs to `/cart/update.js` with body `attributes[__geo_rise_ai_ref]=<platform>`. Shopify's cart API accepts attribute writes even before the cart has items, and carries them through to the eventual order's `note_attributes`.
   - Both writes are fire-and-forget. The script exits and the storefront page renders normally regardless of outcome.

The whole snippet is ~80 lines of Liquid-embedded JS, no dependencies, no perceptible perf cost (one `fetch` per AI-referred page load).

### 2. Order capture webhook

Add to `shopify.app.toml`:

```toml
[[webhooks.subscriptions]]
topics = [ "orders/paid" ]
uri = "/webhooks/orders/paid"
```

New handler at `app/routes/webhooks.orders.paid.tsx`. On webhook fire:

1. Authenticate via `authenticate.webhook(request)`.
2. Look up the local `Store` record by `session.shop`. If absent, exit silently (uninstalled-but-still-firing webhook).
3. Parse `order.note_attributes` for an entry whose `name === "__geo_rise_ai_ref"`. If absent, exit silently (this is the common case; most orders are not AI-attributed).
4. Validate the value against the `AiPlatform` enum. If invalid (e.g. tampered cart attribute), log and exit.
5. Skip if `order.test === true` (dev-store test orders should not pollute real attribution data).
6. Create one `AiTrafficEvent` row:
   - `storeId`, `platform`, `eventAt: new Date(order.processed_at)`
   - `convertedToOrder: true`, `orderId: order.admin_graphql_api_id` (the GID, stable identifier)
   - `orderRevenue: parseFloat(order.total_price)`, `orderCurrency: order.currency`
   - `landingPage: order.landing_site ?? ""` (informational, not currently shown in UI)
   - `referrerUrl: order.referring_site ?? null` (informational)
   - `sessionId: null` (we don't track sessions in MVP; could derive from `cart_token` later)

Single row per attributed order. The model already exists, no migration.

### 3. Revenue aggregation service

New file `app/services/revenue-attribution.server.ts` exporting one function:

```ts
export interface RevenueSummary {
  total: { amount: number; currency: string; orderCount: number }[];  // grouped by currency
  byPlatform: Array<{ platform: AiPlatform; amount: number; currency: string; orderCount: number }>;
  byDay: Array<{ date: string; platforms: Record<AiPlatform, number>; currency: string }>;
  topPlatform: AiPlatform | null;
  recentOrders: Array<{
    id: string;
    orderId: string;
    platform: AiPlatform;
    amount: number;
    currency: string;
    eventAt: string;
  }>;
}

export async function getRevenueAttribution(
  storeId: string,
  options: { rangeDays?: number; orderLimit?: number }
): Promise<RevenueSummary>;
```

Defaults: `rangeDays: 30`, `orderLimit: 25`. The function:

1. Queries `prisma.aiTrafficEvent.findMany({ where: { storeId, convertedToOrder: true, eventAt: { gte: rangeStart } } })`.
2. Computes per-currency totals via JavaScript `reduce` (no SQL grouping; volumes are small).
3. Computes per-platform breakdown.
4. Computes per-day breakdown for the last 30 days as a sparse array (days with zero revenue still produce a `0` bucket for charting).
5. Determines the **dominant currency** as the one with the highest summed revenue across the range. Determines `topPlatform` as the one with the highest summed amount in the dominant currency.
6. Returns the most recent `orderLimit` events as `recentOrders`.

Pure aggregation, no side effects.

### 4. UI surfaces

**Dashboard card (`app/routes/app._index.tsx`):**

Inserted between the existing **stats grid** row (Audited / AI Citations / Issues / llms.txt) and the **Quick Actions** row.

For Pro and Enterprise:

```
┌─────────────────────────────────────────────────────────────────┐
│ AI Revenue                                  [View full report] │
│                                                                 │
│ $1,247.50                                                       │
│ AI-attributed revenue, last 30 days, 8 orders                   │
│                                                                 │
│ ChatGPT $847 · Perplexity $400 · Claude $0.50                  │
└─────────────────────────────────────────────────────────────────┘
```

Empty state (no attributed orders yet):

> No AI-attributed revenue yet. Make sure the AI Schema Injection theme app embed is enabled, then any shopper who reaches you via ChatGPT, Perplexity, Claude, or Gemini will show up here. [Open Theme Editor]

For Free and Growth:

```
┌─────────────────────────────────────────────────────────────────┐
│ Track which AI search engines actually drive your sales         │
│                                                                 │
│ See real revenue attributed to ChatGPT, Perplexity, Claude, and│
│ Gemini referrals. Available on Pro and Enterprise.              │
│                                                                 │
│ [Upgrade to Pro]                                                │
└─────────────────────────────────────────────────────────────────┘
```

**Dedicated page (`app/routes/app.revenue.tsx`):**

Pro/Enterprise gets three sections; Free/Growth gets the upgrade banner full-page.

Row 1, Stats grid (four `Card`s in a `display: grid; grid-template-columns: repeat(4, 1fr)`):
- "Revenue, last 30 days" / "Revenue, all time" / "Orders, last 30 days" / "Top AI platform"
- Multi-currency stores show dominant currency in the headline plus a small "+ other currencies" link.

Row 2, Daily chart:
- Inline SVG, no charting library, matches the inline-SVG pattern already used by `TrendTimeline` on the tracking page.
- 30 daily bars left-to-right (oldest to newest).
- Each bar's height is proportional to that day's revenue; stacked segments colored by platform (ChatGPT `#00C853`, Perplexity `#7E57C2`, Claude `#FF7043`, Gemini `#4285F4`, others `#9E9E9E`).
- Hover `<title>` on each bar shows date + total + per-platform breakdown.

Row 3, Per-order table:
- Polaris `IndexTable` with columns: Date · Order # · Platform (badge) · Amount · Currency.
- Sortable by date and amount.
- 25 rows per page; pagination with simple Prev/Next.
- Order # links to the merchant's Shopify admin: `https://{shopifyDomain}/admin/orders/{order_id}`.

NavMenu link in `app/routes/app.tsx`:

```tsx
<Link to="/app/revenue">AI Revenue</Link>
```

Placed between Competitors and Blog Generator. Visible to all plans, matching the existing pattern; the route-level plan gate handles the upsell.

## Data flow diagram

```
Shopper journey:

1. AI search engine recommends merchant product
   |
   v
2. Shopper clicks link to store.myshopify.com/products/foo
   |
   v
3. Theme app embed runs script:
   - document.referrer = "https://chatgpt.com/..."
   - Cookie write: __geo_rise_ai_ref=CHATGPT:<unix_ts>
   - POST /cart/update.js with attributes[__geo_rise_ai_ref]=CHATGPT
   |
   v
4. Shopper browses, adds to cart, checks out (could be hours or weeks later)
   - Each subsequent page load re-reads the cookie and re-sets the cart attribute,
     keeping attribution alive across direct revisits within 30 days
   |
   v
5. Shopify creates the order; cart attribute carries through to note_attributes
   |
   v
6. orders/paid webhook fires to /webhooks/orders/paid
   |
   v
7. Handler reads note_attributes, validates platform, creates AiTrafficEvent row
   |
   v
8. Dashboard card and /app/revenue page query AiTrafficEvent aggregates
```

## Edge cases

| Scenario | Behavior |
|---|---|
| Theme app embed not enabled by merchant | Script never runs; no attribution data ever. Dashboard card empty state prompts merchant to enable via Theme Editor. Discovery Card (already shipped) further nudges. |
| Multiple AI referrals before purchase | Last-AI-touch wins. Each AI-domain visit overwrites cookie and cart attribute. |
| AI-touch then direct revisit within 30 days | Cookie persists; subsequent script run re-sets cart attribute from cookie. AI keeps the credit. |
| AI-touch then 31+ day gap then purchase | Cookie expired; no attribution. |
| Multi-currency store | Per-currency aggregation; no FX. Dashboard card shows dominant currency in headline; full report shows all currencies. |
| Test order (`order.test === true`) | Skipped in webhook. |
| Refund after attribution | Out of scope. Attribution row stays. |
| Order edit after attribution | `orderRevenue` frozen at original webhook payload value. |
| Malformed cart attribute (tampering) | Webhook validates against `AiPlatform` enum; invalid values are logged and dropped. |
| Free/Growth plan visits `/app/revenue` directly | Full-page upgrade banner; no data leak. Same pattern as audit/tracking pages. |
| Anthropic / OpenAI / Shopify downtime | Tracking and webhooks degrade gracefully. Cart-attribute write failure is silent (fire-and-forget). Missed webhooks are NOT retried; we accept that as Shopify's standard webhook delivery guarantee. |

## Code-level checklist (planning input)

1. **Theme extension**: add `<script>` block to `extensions/geo-rise-schema/blocks/schema-injection.liquid`. Pattern list as a top-level JS array. Cookie + cart-attribute writes. Inline comments noting purpose. Verify the extension still renders correctly (JSON-LD is unaffected).
2. **shopify.app.toml**: add `orders/paid` webhook subscription.
3. **app/routes/webhooks.orders.paid.tsx**: new file. `authenticate.webhook`, parse note_attributes, validate, create AiTrafficEvent.
4. **app/services/revenue-attribution.server.ts**: new file. `getRevenueAttribution` function returning the `RevenueSummary` shape.
5. **app/routes/app._index.tsx**: loader fetches revenue summary, renders new dashboard card. Plan gate against `PLAN_LIMITS[plan].revenueAttribution`.
6. **app/routes/app.revenue.tsx**: new file. Loader + page with stats grid, SVG chart, IndexTable. Plan gate.
7. **app/routes/app.tsx**: add NavMenu link.
8. **app/routes/privacy.tsx**: add a paragraph noting AI referral data collection (platform name + timestamp, no PII, first-party cookie, 30-day retention).
9. **Verify**: typecheck, build, em-dash grep on new copy, deploy theme extension to dev store via `shopify app deploy`, manually trigger an AI-referred test order on `boda-brands`.

## Out-of-scope reminders for the implementation plan

- Do NOT add automated tests (project has none; consistent verification is typecheck + manual).
- Do NOT add currency conversion logic.
- Do NOT subscribe to `refunds/create` webhook (future enhancement).
- Do NOT build a Web Pixel extension.
- Do NOT track sessionId in MVP (the field is on the model but stays null).

## Scope estimate

- Theme extension script: ~1 hour
- Webhook subscription + handler: ~50 min
- Aggregation service: ~1 hour
- Dashboard card: ~1 hour
- Dedicated page (stats + chart + table): ~1.5 hours
- NavMenu + privacy policy update: ~35 min
- Typecheck + build + commit + push + memory checkpoint: ~30 min
- Smoke test prep (deploy theme extension to dev store, place test order with referrer): ~30 min

**Total: ~6 hours focused work.** Single implementation plan, single session if uninterrupted.

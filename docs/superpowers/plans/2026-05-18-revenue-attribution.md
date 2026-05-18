# Revenue Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track which AI search engines drive actual order revenue on the merchant's store and surface that as a dashboard card plus a dedicated `/app/revenue` page.

**Architecture:** Theme app embed script detects AI referrers and writes a cart attribute that carries through to the order. An `orders/paid` webhook reads the attribute and creates an `AiTrafficEvent` row. A new aggregation service powers both UI surfaces. 30-day last-AI-touch attribution, multi-currency safe, plan-gated to Pro+ via the existing `PLAN_LIMITS[plan].revenueAttribution` flag.

**Tech Stack:** Remix, TypeScript strict, Shopify Polaris v12, App Bridge v4, Prisma. No automated tests. Verification per task = `npx tsc --noEmit` plus manual smoke test on `boda-brands` at the end.

**Spec:** `docs/superpowers/specs/2026-05-18-revenue-attribution-design.md`

---

## Task 1: Add AI-referral tracking script to the theme app embed

**Files:**
- Modify: `extensions/geo-rise-schema/blocks/schema-injection.liquid` (append script block at the end, after the existing JSON-LD scripts)

The script runs once on `DOMContentLoaded`. Detects `document.referrer` against the AI domain pattern list. If matched (or if a previously-set cookie is still valid), writes a first-party cookie `__geo_rise_ai_ref` and POSTs to `/cart/update.js` to write a cart attribute that carries through to the order.

- [ ] **Step 1: Append the tracking script to schema-injection.liquid**

At the very end of `extensions/geo-rise-schema/blocks/schema-injection.liquid`, AFTER all the existing JSON-LD `<script type="application/ld+json">` blocks but BEFORE the closing `{% schema %}` block (if present), insert:

```liquid

{%- comment -%}
  GEO Rise - AI Referral Tracker
  Detects when shoppers arrive from AI search engines (ChatGPT, Perplexity,
  Claude, Gemini, Grok) and tags their cart with the referring platform.
  The tag flows through to the order's note_attributes, which the
  orders/paid webhook reads to compute attributed revenue.

  Cookie + cart-attribute prefix: __geo_rise_ai_ref
  Attribution window: 30 days (cookie max-age)
  Model: last-AI-touch (most recent AI referrer overwrites the cookie)
  PII: none stored. Just the platform name and a unix timestamp.
{%- endcomment -%}
<script type="text/javascript">
(function () {
  var COOKIE_NAME = "__geo_rise_ai_ref";
  var COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
  var AI_DOMAINS = [
    { pattern: /(?:^|\.)chatgpt\.com$/i, platform: "CHATGPT" },
    { pattern: /(?:^|\.)chat\.openai\.com$/i, platform: "CHATGPT" },
    { pattern: /(?:^|\.)openai\.com$/i, platform: "CHATGPT" },
    { pattern: /(?:^|\.)perplexity\.ai$/i, platform: "PERPLEXITY" },
    { pattern: /(?:^|\.)claude\.ai$/i, platform: "CLAUDE" },
    { pattern: /(?:^|\.)gemini\.google\.com$/i, platform: "GEMINI" },
    { pattern: /(?:^|\.)bard\.google\.com$/i, platform: "GEMINI" },
    { pattern: /(?:^|\.)grok\.com$/i, platform: "GROK" },
    { pattern: /(?:^|\.)x\.ai$/i, platform: "GROK" }
  ];
  var UTM_MAP = {
    "chatgpt": "CHATGPT",
    "perplexity": "PERPLEXITY",
    "claude": "CLAUDE",
    "gemini": "GEMINI",
    "grok": "GROK"
  };

  function readCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\\/+^]/g, "\\$&") + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function writeCookie(name, value) {
    document.cookie =
      name + "=" + encodeURIComponent(value) +
      "; Max-Age=" + COOKIE_MAX_AGE_SECONDS +
      "; Path=/; SameSite=Lax";
  }

  function platformFromReferrer() {
    if (!document.referrer) return null;
    try {
      var host = new URL(document.referrer).hostname;
      for (var i = 0; i < AI_DOMAINS.length; i++) {
        if (AI_DOMAINS[i].pattern.test(host)) return AI_DOMAINS[i].platform;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  function platformFromUtm() {
    try {
      var params = new URLSearchParams(window.location.search);
      var src = (params.get("utm_source") || "").toLowerCase().trim();
      if (UTM_MAP[src]) return UTM_MAP[src];
    } catch (e) {
      return null;
    }
    return null;
  }

  function platformFromCookie() {
    var raw = readCookie(COOKIE_NAME);
    if (!raw) return null;
    // Format: "<PLATFORM>:<unix_seconds>". Old plain-string format is also
    // tolerated for forward compat (we just use the platform).
    var parts = raw.split(":");
    return parts[0] || null;
  }

  // Resolve current platform. New referrer or UTM wins, otherwise we fall
  // back to the existing cookie so direct revisits keep the credit.
  var platform = platformFromReferrer() || platformFromUtm() || platformFromCookie();
  if (!platform) return;

  // Refresh the cookie on every visit so the 30-day window starts from the
  // last touch, not the first.
  writeCookie(COOKIE_NAME, platform + ":" + Math.floor(Date.now() / 1000));

  // Fire-and-forget cart-attribute write. The attribute carries through to
  // the order's note_attributes if/when the shopper completes checkout.
  fetch("/cart/update.js", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attributes: { "__geo_rise_ai_ref": platform }
    }),
    credentials: "same-origin"
  }).catch(function () {
    // Silent: tracking failure must never break the storefront page.
  });
})();
</script>
```

- [ ] **Step 2: Verify the liquid still parses (no smoke test for the script yet, that comes in Task 9)**

The Shopify CLI's `shopify app deploy` validates extension templates. Run a syntax check via:

```bash
npx shopify app deploy --no-color --force --message "wip: AI referral tracker (preview only, not pushed)" 2>&1 | tail -20
```

Expected: deploy succeeds OR returns a clear liquid/JS error pointing at the new script. If it succeeds, the extension is queued for review; merchants won't see the change until you accept the deploy.

(If you'd rather not run a real deploy yet, skip this step and rely on Task 9's full deploy.)

- [ ] **Step 3: Commit**

```bash
git add extensions/geo-rise-schema/blocks/schema-injection.liquid
git commit -m "theme extension: add AI-referral tracker script

Detects document.referrer against ChatGPT / Perplexity / Claude /
Gemini / Grok domains plus utm_source fallback. Writes a 30-day
first-party cookie and a cart attribute via /cart/update.js so the
attribution flows through to the order's note_attributes for the
upcoming orders/paid webhook to read.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Register orders/paid webhook in shopify.app.toml

**Files:**
- Modify: `shopify.app.toml:35-45` (the `[webhooks]` section)

- [ ] **Step 1: Add the orders/paid subscription**

In `shopify.app.toml`, find the existing `[webhooks]` section. After the existing `products/delete` subscription block (or any other existing subscription), add:

```toml

  [[webhooks.subscriptions]]
  topics = [ "orders/paid" ]
  uri = "/webhooks/orders/paid"
```

- [ ] **Step 2: Commit**

```bash
git add shopify.app.toml
git commit -m "shopify config: subscribe to orders/paid webhook

For revenue attribution. The handler will read note_attributes for
the __geo_rise_ai_ref cart attribute set by the theme extension
script and create AiTrafficEvent rows.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

The webhook subscription does not take effect until the next `shopify app deploy`. Task 9 handles that.

---

## Task 3: Implement the orders/paid webhook handler

**Files:**
- Create: `app/routes/webhooks.orders.paid.tsx`

- [ ] **Step 1: Create the handler**

Write the full file at `app/routes/webhooks.orders.paid.tsx`:

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

const VALID_PLATFORMS = new Set([
  "CHATGPT",
  "PERPLEXITY",
  "CLAUDE",
  "GEMINI",
  "GROK",
  "GOOGLE_AI_OVERVIEW",
]);

type AiPlatform =
  | "CHATGPT"
  | "PERPLEXITY"
  | "CLAUDE"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

interface NoteAttribute {
  name: string;
  value: string;
}

interface OrderPayload {
  admin_graphql_api_id?: string;
  id?: number;
  total_price?: string;
  currency?: string;
  test?: boolean;
  processed_at?: string;
  landing_site?: string | null;
  referring_site?: string | null;
  note_attributes?: NoteAttribute[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as OrderPayload;

  // Locate the local store. If the webhook fires after an uninstall (rare
  // but possible), there's nothing to record.
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shop },
    select: { id: true },
  });
  if (!store) {
    console.warn(
      `[GEO Rise revenue] orders/paid fired for unknown store ${shop}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  // Skip dev-store test orders so attribution data stays clean.
  if (order.test === true) {
    return new Response(null, { status: 200 });
  }

  // Pull the AI referral cart attribute. Most orders won't have it.
  const refAttr = (order.note_attributes ?? []).find(
    (a) => a.name === "__geo_rise_ai_ref"
  );
  if (!refAttr) {
    return new Response(null, { status: 200 });
  }

  const rawPlatform = (refAttr.value ?? "").trim().toUpperCase();
  if (!VALID_PLATFORMS.has(rawPlatform)) {
    console.warn(
      `[GEO Rise revenue] orders/paid for ${shop}: invalid platform "${rawPlatform}", dropping`
    );
    return new Response(null, { status: 200 });
  }
  const platform = rawPlatform as AiPlatform;

  const orderId = order.admin_graphql_api_id ?? null;
  const totalPrice = order.total_price ? parseFloat(order.total_price) : null;
  const currency = order.currency ?? null;

  if (!orderId || totalPrice === null || Number.isNaN(totalPrice) || !currency) {
    console.warn(
      `[GEO Rise revenue] orders/paid for ${shop}: incomplete payload (orderId=${orderId} price=${totalPrice} currency=${currency}), dropping`
    );
    return new Response(null, { status: 200 });
  }

  const eventAt = order.processed_at ? new Date(order.processed_at) : new Date();

  await prisma.aiTrafficEvent.create({
    data: {
      storeId: store.id,
      platform,
      referrerUrl: order.referring_site ?? null,
      landingPage: order.landing_site ?? "",
      sessionId: null,
      convertedToOrder: true,
      orderId,
      orderRevenue: totalPrice,
      orderCurrency: currency,
      eventAt,
    },
  });

  console.log(
    `[GEO Rise revenue] recorded ${platform} attribution: order=${orderId} amount=${totalPrice} ${currency}`
  );
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/routes/webhooks.orders.paid.tsx
git commit -m "webhook: orders/paid handler for AI revenue attribution

Reads the __geo_rise_ai_ref cart attribute from order.note_attributes
(set by the theme extension script when a shopper arrives from an AI
search engine), validates the platform against the AiPlatform enum,
skips test orders, and creates an AiTrafficEvent row with the order's
total revenue and currency.

The AiTrafficEvent model already has the fields we need; no migration.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Revenue aggregation service

**Files:**
- Create: `app/services/revenue-attribution.server.ts`

- [ ] **Step 1: Create the service file**

Write the full file at `app/services/revenue-attribution.server.ts`:

```ts
import prisma from "~/db.server";

export type AiPlatform =
  | "CHATGPT"
  | "PERPLEXITY"
  | "CLAUDE"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

export interface CurrencyTotal {
  currency: string;
  amount: number;
  orderCount: number;
}

export interface PlatformTotal {
  platform: AiPlatform;
  currency: string;
  amount: number;
  orderCount: number;
}

export interface DayBucket {
  /** ISO date (YYYY-MM-DD) in UTC. */
  date: string;
  /** Per-platform revenue in the dominant currency. Platforms with zero
   *  revenue on this day are omitted. */
  platforms: Partial<Record<AiPlatform, number>>;
  total: number;
}

export interface RecentOrder {
  id: string;
  orderId: string;
  platform: AiPlatform;
  amount: number;
  currency: string;
  eventAt: string;
}

export interface RevenueSummary {
  /** Currency that contributed the largest revenue across the range. Null
   *  when the store has no attributed orders yet. */
  dominantCurrency: string | null;
  /** Total revenue and order count, grouped by currency. */
  byCurrency: CurrencyTotal[];
  /** All-time total in the dominant currency only. */
  allTimeTotal: { currency: string; amount: number; orderCount: number } | null;
  /** Per-platform breakdown in the dominant currency only. Platforms with
   *  zero revenue are omitted. */
  byPlatform: PlatformTotal[];
  /** Daily revenue for the requested range, padded to include every day. */
  byDay: DayBucket[];
  /** Platform with the highest summed amount in the dominant currency. */
  topPlatform: AiPlatform | null;
  /** Most recent attributed orders (newest first). */
  recentOrders: RecentOrder[];
}

export interface GetRevenueAttributionOptions {
  /** How many days back from "now" the summary covers. Default: 30. */
  rangeDays?: number;
  /** Max number of recent-orders rows returned. Default: 25. */
  orderLimit?: number;
}

/** Single entry point used by both the dashboard card and /app/revenue.
 *  Aggregation runs in JavaScript over the rows. Volumes are low enough
 *  (one row per AI-attributed order, typically <100/month even for large
 *  stores) that SQL GROUP BY isn't worth the complexity. */
export async function getRevenueAttribution(
  storeId: string,
  options: GetRevenueAttributionOptions = {}
): Promise<RevenueSummary> {
  const rangeDays = options.rangeDays ?? 30;
  const orderLimit = options.orderLimit ?? 25;

  const rangeStart = new Date();
  rangeStart.setUTCHours(0, 0, 0, 0);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - (rangeDays - 1));

  const [rangeEvents, allTimeEvents, recentEvents] = await Promise.all([
    prisma.aiTrafficEvent.findMany({
      where: {
        storeId,
        convertedToOrder: true,
        eventAt: { gte: rangeStart },
      },
      orderBy: { eventAt: "desc" },
    }),
    prisma.aiTrafficEvent.findMany({
      where: { storeId, convertedToOrder: true },
      select: { orderRevenue: true, orderCurrency: true },
    }),
    prisma.aiTrafficEvent.findMany({
      where: { storeId, convertedToOrder: true },
      orderBy: { eventAt: "desc" },
      take: orderLimit,
    }),
  ]);

  // 1. Group range events by currency.
  const byCurrencyMap = new Map<
    string,
    { amount: number; orderCount: number }
  >();
  for (const e of rangeEvents) {
    const ccy = e.orderCurrency ?? "USD";
    const cur = byCurrencyMap.get(ccy) ?? { amount: 0, orderCount: 0 };
    cur.amount += e.orderRevenue ?? 0;
    cur.orderCount += 1;
    byCurrencyMap.set(ccy, cur);
  }
  const byCurrency: CurrencyTotal[] = Array.from(byCurrencyMap.entries())
    .map(([currency, v]) => ({ currency, ...v }))
    .sort((a, b) => b.amount - a.amount);

  const dominantCurrency = byCurrency[0]?.currency ?? null;

  // 2. All-time total in dominant currency.
  let allTimeTotal: RevenueSummary["allTimeTotal"] = null;
  if (dominantCurrency) {
    const matching = allTimeEvents.filter(
      (e) => (e.orderCurrency ?? "USD") === dominantCurrency
    );
    allTimeTotal = {
      currency: dominantCurrency,
      amount: matching.reduce((sum, e) => sum + (e.orderRevenue ?? 0), 0),
      orderCount: matching.length,
    };
  }

  // 3. Per-platform breakdown in dominant currency only.
  const byPlatformMap = new Map<
    AiPlatform,
    { amount: number; orderCount: number }
  >();
  if (dominantCurrency) {
    for (const e of rangeEvents) {
      if ((e.orderCurrency ?? "USD") !== dominantCurrency) continue;
      const platform = e.platform as AiPlatform;
      const cur = byPlatformMap.get(platform) ?? { amount: 0, orderCount: 0 };
      cur.amount += e.orderRevenue ?? 0;
      cur.orderCount += 1;
      byPlatformMap.set(platform, cur);
    }
  }
  const byPlatform: PlatformTotal[] = Array.from(byPlatformMap.entries())
    .map(([platform, v]) => ({
      platform,
      currency: dominantCurrency as string,
      ...v,
    }))
    .sort((a, b) => b.amount - a.amount);

  const topPlatform = byPlatform[0]?.platform ?? null;

  // 4. Daily buckets (dominant currency only). Pad to include every day in
  //    the range so the chart has a stable x-axis with no gaps.
  const byDay: DayBucket[] = [];
  const dayMap = new Map<string, DayBucket>();
  for (let i = 0; i < rangeDays; i++) {
    const d = new Date(rangeStart);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const bucket: DayBucket = { date: iso, platforms: {}, total: 0 };
    byDay.push(bucket);
    dayMap.set(iso, bucket);
  }
  if (dominantCurrency) {
    for (const e of rangeEvents) {
      if ((e.orderCurrency ?? "USD") !== dominantCurrency) continue;
      const iso = e.eventAt.toISOString().slice(0, 10);
      const bucket = dayMap.get(iso);
      if (!bucket) continue;
      const platform = e.platform as AiPlatform;
      bucket.platforms[platform] =
        (bucket.platforms[platform] ?? 0) + (e.orderRevenue ?? 0);
      bucket.total += e.orderRevenue ?? 0;
    }
  }

  // 5. Recent orders, newest first, capped at orderLimit.
  const recentOrders: RecentOrder[] = recentEvents
    .filter((e) => e.orderId !== null)
    .map((e) => ({
      id: e.id,
      orderId: e.orderId as string,
      platform: e.platform as AiPlatform,
      amount: e.orderRevenue ?? 0,
      currency: e.orderCurrency ?? "USD",
      eventAt: e.eventAt.toISOString(),
    }));

  return {
    dominantCurrency,
    byCurrency,
    allTimeTotal,
    byPlatform,
    byDay,
    topPlatform,
    recentOrders,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/services/revenue-attribution.server.ts
git commit -m "service: revenue-attribution aggregator

Single entry point getRevenueAttribution(storeId, options) returning
per-currency totals, per-platform breakdown in the dominant currency,
daily buckets for the chart, and the most recent N attributed orders.
JavaScript reduce over Prisma findMany; volumes are low enough that
SQL GROUP BY isn't worth the complexity.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Dashboard card on `/app`

**Files:**
- Modify: `app/routes/app._index.tsx` (loader: add revenue summary fetch; UI: insert card between stats grid and Quick Actions)

- [ ] **Step 1: Import the service in the loader**

At the top of `app/routes/app._index.tsx`, alongside the existing `import { runFullAudit, autoFixIssues } from "~/services/audit-engine.server";` line, add:

```ts
import { getRevenueAttribution } from "~/services/revenue-attribution.server";
import type { RevenueSummary } from "~/services/revenue-attribution.server";
```

- [ ] **Step 2: Extend the loader to fetch the revenue summary**

In the existing `Promise.all` that gathers loader data (the one with `llmsFile`, `auditResults`, `citations`, plus the discovery counts), add the revenue fetch as one more entry. Since the existing Promise.all is already 7 entries long, the cleaner pattern is to await revenue separately right after that Promise.all completes:

After the existing `const [llmsFile, auditResults, citations, trackingPromptCount, competitorCount, blogPostCount, simulationCount] = await Promise.all([ ... ]);` block, add:

```ts
  // Revenue attribution is gated by plan; we still query for paid plans so
  // the dashboard card has data. Free/Growth get an upgrade banner card,
  // not real data, so we skip the query for them.
  const planLimits =
    PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
  const revenueSummary: RevenueSummary | null = planLimits.revenueAttribution
    ? await getRevenueAttribution(store.id, { rangeDays: 30, orderLimit: 0 })
    : null;
```

(We pass `orderLimit: 0` because the dashboard card doesn't need the recent-orders list; the dedicated page fetches its own with the full limit.)

- [ ] **Step 3: Add `revenueSummary` to the LoaderData type and returned object**

In the `LoaderData` interface (near line 56), add a new field:

```ts
  /** Per-currency / per-platform AI revenue aggregates for the last 30
   *  days. Null when the merchant's plan doesn't include the feature. */
  revenueSummary: RevenueSummary | null;
```

In the loader's return statement (the `return { store: {...}, ... } satisfies LoaderData;` block), add `revenueSummary,` alongside the other fields.

- [ ] **Step 4: Destructure `revenueSummary` from useLoaderData**

Find the existing `const { store, llmsFile, citationCount, issueCounts, recentActivity, discoveryCards } = useLoaderData<LoaderData>();` line in the `Index` component. Update it to:

```ts
  const { store, llmsFile, citationCount, issueCounts, recentActivity, discoveryCards, revenueSummary } =
    useLoaderData<LoaderData>();
```

- [ ] **Step 5: Insert the AI Revenue card between the stats grid and Quick Actions**

Find the closing `</div>` of the stats grid row (the one with Audited / AI Citations / Issues / llms.txt cards). Immediately AFTER that closing `</div>` and BEFORE the `{/* ── ROW 3: Quick actions ── */}` comment, insert the new card:

```tsx
        {/* ── ROW 2.5: AI Revenue card ── */}
        <AiRevenueCard
          summary={revenueSummary}
          planAllowsFeature={!isFreePlan && store.plan !== "GROWTH"}
        />
```

- [ ] **Step 6: Define the AiRevenueCard component**

Add this component definition just BEFORE the `export default function Index()` declaration (next to where `DiscoveryCards` is defined):

```tsx
function AiRevenueCard({
  summary,
  planAllowsFeature,
}: {
  summary: RevenueSummary | null;
  planAllowsFeature: boolean;
}) {
  // Plan-gated. Free and Growth see an upgrade banner instead of data.
  if (!planAllowsFeature) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Track which AI search engines actually drive your sales
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            See real revenue attributed to ChatGPT, Perplexity, Claude, and
            Gemini referrals. Available on Pro and Enterprise.
          </Text>
          <div>
            <Button variant="primary" url="/app/pricing">
              Upgrade to Pro
            </Button>
          </div>
        </BlockStack>
      </Card>
    );
  }

  const hasData =
    summary !== null &&
    summary.allTimeTotal !== null &&
    summary.byCurrency.length > 0;

  if (!hasData) {
    return (
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              AI Revenue
            </Text>
            <Button url="/app/revenue" variant="plain">
              View full report
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            No AI-attributed revenue yet. Make sure the AI Schema Injection
            theme app embed is enabled, then any shopper who reaches you via
            ChatGPT, Perplexity, Claude, or Gemini will show up here.
          </Text>
        </BlockStack>
      </Card>
    );
  }

  const dominant = summary!.byCurrency[0];
  const otherCurrencies = summary!.byCurrency.slice(1);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            AI Revenue
          </Text>
          <Button url="/app/revenue" variant="plain">
            View full report
          </Button>
        </InlineStack>
        <BlockStack gap="100">
          <Text as="p" variant="heading2xl">
            {formatMoney(dominant.amount, dominant.currency)}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            AI-attributed revenue, last 30 days, {dominant.orderCount}{" "}
            {dominant.orderCount === 1 ? "order" : "orders"}
            {otherCurrencies.length > 0 && (
              <>
                {" "}+ other currencies, see full report
              </>
            )}
          </Text>
        </BlockStack>
        {summary!.byPlatform.length > 0 && (
          <InlineStack gap="200" wrap>
            {summary!.byPlatform.map((p) => (
              <Text as="span" variant="bodySm" tone="subdued" key={p.platform}>
                {platformLabel(p.platform)}{" "}
                <strong>{formatMoney(p.amount, p.currency)}</strong>
              </Text>
            ))}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function platformLabel(platform: string): string {
  switch (platform) {
    case "CHATGPT":
      return "ChatGPT";
    case "PERPLEXITY":
      return "Perplexity";
    case "CLAUDE":
      return "Claude";
    case "GEMINI":
      return "Gemini";
    case "GROK":
      return "Grok";
    case "GOOGLE_AI_OVERVIEW":
      return "Google AI Overview";
    default:
      return platform;
  }
}
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 8: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "dashboard: AI Revenue card between stats grid and Quick Actions

Surfaces 30-day AI-attributed revenue with per-platform breakdown.
Free and Growth plans see an upgrade banner; Pro and Enterprise see
real data or an empty state pointing back at theme-extension setup.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Dedicated `/app/revenue` page

**Files:**
- Create: `app/routes/app.revenue.tsx`

- [ ] **Step 1: Create the route**

Write the full file at `app/routes/app.revenue.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  EmptyState,
  IndexTable,
  useIndexResourceState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { PLAN_LIMITS, PLAN_DEFINITIONS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import { getRevenueAttribution } from "~/services/revenue-attribution.server";
import type {
  AiPlatform,
  RevenueSummary,
} from "~/services/revenue-attribution.server";
import { timeAgo } from "~/utils/time";

interface LoaderData {
  plan: PlanKey;
  shopifyDomain: string;
  planAllowsFeature: boolean;
  summary: RevenueSummary | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true, shopifyDomain: true },
  });
  if (!store) {
    return {
      plan: "FREE" as PlanKey,
      shopifyDomain: session.shop,
      planAllowsFeature: false,
      summary: null,
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const planAllowsFeature = Boolean(limits.revenueAttribution);

  const summary = planAllowsFeature
    ? await getRevenueAttribution(store.id, { rangeDays: 30, orderLimit: 25 })
    : null;

  return {
    plan: planKey,
    shopifyDomain: store.shopifyDomain,
    planAllowsFeature,
    summary,
  } satisfies LoaderData;
};

const PLATFORM_COLORS: Record<AiPlatform, string> = {
  CHATGPT: "#00C853",
  PERPLEXITY: "#7E57C2",
  CLAUDE: "#FF7043",
  GEMINI: "#4285F4",
  GROK: "#FF1744",
  GOOGLE_AI_OVERVIEW: "#9E9E9E",
};

function platformLabel(platform: string): string {
  switch (platform) {
    case "CHATGPT":
      return "ChatGPT";
    case "PERPLEXITY":
      return "Perplexity";
    case "CLAUDE":
      return "Claude";
    case "GEMINI":
      return "Gemini";
    case "GROK":
      return "Grok";
    case "GOOGLE_AI_OVERVIEW":
      return "Google AI Overview";
    default:
      return platform;
  }
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export default function RevenuePage() {
  const { plan, shopifyDomain, planAllowsFeature, summary } =
    useLoaderData<LoaderData>();

  if (!planAllowsFeature) {
    return (
      <Page>
        <TitleBar title="AI Revenue" />
        <Banner
          tone="warning"
          title={`${PLAN_DEFINITIONS[plan].name} plan doesn't include AI revenue attribution`}
        >
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              See real revenue attributed to ChatGPT, Perplexity, Claude, and
              Gemini referrals. Available on Pro (
              ${PLAN_DEFINITIONS.PRO.price}/mo) and Enterprise.
            </Text>
            <div>
              <Link to="/app/pricing">
                <Button variant="primary">See pricing</Button>
              </Link>
            </div>
          </BlockStack>
        </Banner>
      </Page>
    );
  }

  const hasData = summary !== null && summary.byCurrency.length > 0;

  if (!hasData) {
    return (
      <Page>
        <TitleBar title="AI Revenue" />
        <Card>
          <EmptyState
            heading="No AI-attributed revenue yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <Text as="p" variant="bodyMd">
              Once a shopper reaches your store from ChatGPT, Perplexity,
              Claude, Gemini, or Grok and places an order, it&apos;ll appear
              here. Make sure the AI Schema Injection theme app embed is
              enabled so the tracker can detect AI referrals.
            </Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const dominant = summary!.byCurrency[0];
  const planLimits = PLAN_LIMITS[plan];

  return (
    <Page>
      <TitleBar title="AI Revenue" />
      <BlockStack gap="500">
        {/* Stats row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "16px",
          }}
        >
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Revenue, last 30 days
              </Text>
              <Text as="p" variant="headingLg">
                {formatMoney(dominant.amount, dominant.currency)}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Revenue, all time
              </Text>
              <Text as="p" variant="headingLg">
                {summary!.allTimeTotal
                  ? formatMoney(
                      summary!.allTimeTotal.amount,
                      summary!.allTimeTotal.currency
                    )
                  : "-"}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Orders, last 30 days
              </Text>
              <Text as="p" variant="headingLg">
                {dominant.orderCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Top AI platform
              </Text>
              <Text as="p" variant="headingLg">
                {summary!.topPlatform
                  ? platformLabel(summary!.topPlatform)
                  : "-"}
              </Text>
            </BlockStack>
          </Card>
        </div>

        {summary!.byCurrency.length > 1 && (
          <Banner tone="info">
            <Text as="p" variant="bodySm">
              Orders in {summary!.byCurrency.length} currencies. Headline
              numbers above show the dominant currency (
              {dominant.currency}); the per-order table below shows every
              order in its native currency.
            </Text>
          </Banner>
        )}

        {/* Daily chart */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Daily AI revenue, last 30 days ({dominant.currency})
            </Text>
            <RevenueChart byDay={summary!.byDay} currency={dominant.currency} />
            <InlineStack gap="300" wrap>
              {summary!.byPlatform.map((p) => (
                <InlineStack key={p.platform} gap="100" blockAlign="center">
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 2,
                      background: PLATFORM_COLORS[p.platform] ?? "#9E9E9E",
                      display: "inline-block",
                    }}
                  />
                  <Text as="span" variant="bodySm">
                    {platformLabel(p.platform)}{" "}
                    <strong>{formatMoney(p.amount, p.currency)}</strong>
                  </Text>
                </InlineStack>
              ))}
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Recent orders table */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent attributed orders
            </Text>
            <RevenueOrderTable
              orders={summary!.recentOrders}
              shopifyDomain={shopifyDomain}
            />
          </BlockStack>
        </Card>

        {planLimits.revenueAttribution && plan === "PRO" && (
          <Banner tone="info">
            <Text as="p" variant="bodySm">
              Pro plan tracks AI revenue across all your AI search platforms.
              Enterprise also adds Shopify Flow integration if you want to
              automate based on AI-driven orders.
            </Text>
          </Banner>
        )}
      </BlockStack>
    </Page>
  );
}

function RevenueChart({
  byDay,
  currency,
}: {
  byDay: RevenueSummary["byDay"];
  currency: string;
}) {
  const maxValue = Math.max(1, ...byDay.map((d) => d.total));
  const width = 600;
  const height = 140;
  const padding = 8;
  const barGap = 2;
  const usableWidth = width - padding * 2;
  const barWidth =
    (usableWidth - barGap * (byDay.length - 1)) / byDay.length;
  const usableHeight = height - padding * 2;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ display: "block", maxWidth: width }}
      >
        {byDay.map((bucket, idx) => {
          const x = padding + idx * (barWidth + barGap);
          // Stack segments by platform, sorted by total contribution.
          const segments = Object.entries(bucket.platforms).sort(
            ([, a], [, b]) => (b ?? 0) - (a ?? 0)
          );
          let yCursor = padding + usableHeight;
          const hoverParts = [
            new Date(bucket.date + "T00:00:00Z").toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
            `Total: ${formatMoney(bucket.total, currency)}`,
            ...segments.map(
              ([platform, amount]) =>
                `${platformLabel(platform)}: ${formatMoney(amount ?? 0, currency)}`
            ),
          ];

          if (bucket.total === 0) {
            return (
              <g key={bucket.date}>
                <rect
                  x={x}
                  y={padding + usableHeight - 2}
                  width={barWidth}
                  height={2}
                  fill="#E4E5E7"
                >
                  <title>{hoverParts[0] + "\nNo revenue"}</title>
                </rect>
              </g>
            );
          }

          return (
            <g key={bucket.date}>
              {segments.map(([platform, amount]) => {
                const h = ((amount ?? 0) / maxValue) * usableHeight;
                yCursor -= h;
                return (
                  <rect
                    key={platform}
                    x={x}
                    y={yCursor}
                    width={barWidth}
                    height={h}
                    fill={
                      PLATFORM_COLORS[platform as AiPlatform] ?? "#9E9E9E"
                    }
                  >
                    <title>{hoverParts.join("\n")}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RevenueOrderTable({
  orders,
  shopifyDomain,
}: {
  orders: RevenueSummary["recentOrders"];
  shopifyDomain: string;
}) {
  const resourceName = { singular: "order", plural: "orders" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(
      orders.map((o) => ({ id: o.id }))
    );

  if (orders.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        No orders attributed yet in this window.
      </Text>
    );
  }

  const rowMarkup = orders.map((order, index) => {
    // order.orderId is a GID like "gid://shopify/Order/1234567890". Extract
    // the numeric ID for the Shopify admin URL.
    const numericId = order.orderId.split("/").pop() ?? order.orderId;
    const adminUrl = `https://${shopifyDomain}/admin/orders/${numericId}`;
    return (
      <IndexTable.Row
        id={order.id}
        key={order.id}
        selected={selectedResources.includes(order.id)}
        position={index}
      >
        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {timeAgo(order.eventAt)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <a
            href={adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#005BD3", textDecoration: "none" }}
          >
            #{numericId}
          </a>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge>{platformLabel(order.platform)}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" fontWeight="semibold">
            {formatMoney(order.amount, order.currency)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" tone="subdued">
            {order.currency}
          </Text>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <IndexTable
      resourceName={resourceName}
      itemCount={orders.length}
      selectedItemsCount={
        allResourcesSelected ? "All" : selectedResources.length
      }
      onSelectionChange={handleSelectionChange}
      selectable={false}
      headings={[
        { title: "Date" },
        { title: "Order" },
        { title: "Platform" },
        { title: "Amount" },
        { title: "Currency" },
      ]}
    >
      {rowMarkup}
    </IndexTable>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.revenue.tsx
git commit -m "route: /app/revenue page with stats, daily chart, and order table

Three-row layout: stats grid (last 30d / all-time / order count / top
platform), daily SVG bar chart with per-platform stacked colors, and a
Polaris IndexTable of recent attributed orders linking back to Shopify
admin. Plan-gated to Pro+ via PLAN_LIMITS.revenueAttribution; Free/
Growth get an upgrade banner. Multi-currency stores show the dominant
currency in stats and a note pointing to the per-order table for the
rest.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: NavMenu link

**Files:**
- Modify: `app/routes/app.tsx`

- [ ] **Step 1: Add the link**

Find the existing NavMenu block in `app/routes/app.tsx`. The current nav looks like:

```tsx
<NavMenu>
  <Link to="/app" rel="home">
    Home
  </Link>
  <Link to="/app/audit">AI Audit</Link>
  <Link to="/app/action-plan">Action Plan</Link>
  <Link to="/app/simulator">AI Simulator</Link>
  <Link to="/app/tracking">AI Tracking</Link>
  <Link to="/app/competitors">Competitors</Link>
  <Link to="/app/blog-generator">Blog Generator</Link>
  <Link to="/app/llms-txt">llms.txt Manager</Link>
  <Link to="/app/pricing">Pricing</Link>
</NavMenu>
```

Insert `<Link to="/app/revenue">AI Revenue</Link>` between `Competitors` and `Blog Generator`:

```tsx
  <Link to="/app/competitors">Competitors</Link>
  <Link to="/app/revenue">AI Revenue</Link>
  <Link to="/app/blog-generator">Blog Generator</Link>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.tsx
git commit -m "nav: add AI Revenue link between Competitors and Blog Generator

Visible on all plans; the route's loader-level plan gate shows the
upgrade banner to Free/Growth merchants who click through.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Privacy policy update

**Files:**
- Modify: `app/routes/privacy.tsx`

- [ ] **Step 1: Read the current privacy policy to find the data-collection section**

Run: `grep -n "cookie\|collect\|data\|track" app/routes/privacy.tsx | head -30`

Identify the section that lists what data we collect. If there's a clear "Data we collect" section, append a new paragraph there. If the policy is mostly free-form prose, add a paragraph near the discussion of analytics/tracking.

- [ ] **Step 2: Add the AI-referral disclosure paragraph**

Add a new `<Text as="p" variant="bodyMd">` block in the appropriate section:

```tsx
<Text as="p" variant="bodyMd">
  <strong>AI referral tracking:</strong> when a shopper arrives at your
  storefront from an AI search engine (ChatGPT, Perplexity, Claude, Gemini,
  Grok), we record the referring platform name and a unix timestamp in a
  first-party cookie on the shopper&apos;s browser and as a cart attribute
  on their Shopify cart. The cookie expires after 30 days. No personally
  identifiable information is collected. This data is used only to attribute
  order revenue to the AI platform that drove the visit, surfaced to you in
  the GEO Rise admin under AI Revenue.
</Text>
```

Place this AFTER the existing analytics/data-collection discussion. If unsure, place it immediately after the first paragraph that mentions cookies or tracking.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add app/routes/privacy.tsx
git commit -m "privacy: disclose AI-referral tracking (cookie + cart attribute)

First-party cookie, 30-day expiry, no PII, only the platform name and
a timestamp. Used to attribute order revenue to the AI search engine
that drove the visit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Em-dash sweep + build + push + theme deploy + smoke test + memory checkpoint

**Files:**
- Verify: all files touched in Tasks 1-8

- [ ] **Step 1: Em-dash sweep**

Run: `grep -n "—" app/routes/app._index.tsx app/routes/app.revenue.tsx app/routes/app.tsx app/routes/webhooks.orders.paid.tsx app/services/revenue-attribution.server.ts app/routes/privacy.tsx extensions/geo-rise-schema/blocks/schema-injection.liquid`

Expected: no matches OR only matches inside escape sequences (regex literals, etc.). If any em-dash appears in user-facing copy or comments, replace with comma + space.

- [ ] **Step 2: Final typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build completes with no errors. The pre-existing CSS print warning and dynamic-import advisory are unrelated.

- [ ] **Step 4: Push to main**

```bash
git push origin main
```

Render auto-deploys the Remix app from main. Wait ~2-3 minutes for the deploy to land before continuing.

- [ ] **Step 5: Deploy the theme app extension**

```bash
shopify app deploy --allow-updates
```

The extension changes are reviewed and pushed to the Partner Dashboard. Merchants who have the extension installed will receive the update automatically.

For your dev store (`boda-brands`), after the deploy lands, open **Online Store > Themes > Customize > App embeds** and confirm the GEO Rise schema embed is still enabled. The new script runs as part of that embed.

- [ ] **Step 6: Smoke test the storefront tracker**

In an incognito window (cookies cleared), open:

```
https://boda-brands.myshopify.com/?utm_source=chatgpt
```

(Use storefront password `etwawy` if prompted.)

Open browser devtools. In the **Application** tab, **Cookies** section, find `__geo_rise_ai_ref`. You should see a value like `CHATGPT:1747573200`.

In the devtools **Network** tab, filter by `cart`. You should see a POST to `/cart/update.js` returning 200 OK.

- [ ] **Step 7: Smoke test the webhook + UI via a manual AiTrafficEvent insert**

Since placing a real paid order is tedious and dev-store test orders are skipped by the webhook, the cleanest end-to-end UI verification is to insert one row directly:

In Neon SQL Editor, run:

```sql
INSERT INTO "AiTrafficEvent" (
  "id", "storeId", "platform", "landingPage",
  "convertedToOrder", "orderId", "orderRevenue", "orderCurrency", "eventAt"
)
SELECT
  'test_' || gen_random_uuid()::text,
  "id",
  'CHATGPT',
  '/products/test',
  true,
  'gid://shopify/Order/test123',
  149.99,
  'USD',
  NOW()
FROM "Store"
WHERE "shopifyDomain" = 'boda-brands.myshopify.com';
```

Reload the GEO Rise dashboard. The new "AI Revenue" card should show $149.99 (or your currency) with "ChatGPT $149.99" in the per-platform breakdown.

Navigate to `/app/revenue` from the NavMenu. The stats row, chart (with a single bar today), and one-row order table should all render. The "Order" cell should link out to `https://boda-brands.myshopify.com/admin/orders/test123` (the link will 404 in Shopify because the order ID is fake, but that's fine for testing the link itself).

After verifying, clean up:

```sql
DELETE FROM "AiTrafficEvent" WHERE "orderId" = 'gid://shopify/Order/test123';
```

- [ ] **Step 8: Smoke test the webhook handler against a real test order**

In the Shopify admin for `boda-brands`, place a test order via the **Orders > Create order** flow. Tag the cart with the AI attribute manually by including `__geo_rise_ai_ref: CHATGPT` in the order's note attributes section.

After the order is placed and marked paid, check Render logs for the `[GEO Rise revenue] recorded CHATGPT attribution: order=...` line. If you see it, the webhook handler works. If you don't:

- The webhook may not have been deployed (re-check `shopify app deploy` step).
- The order may have been marked `test: true` and skipped (check the log for any `orders/paid` handler invocation).
- The cart attribute may not have been set on the order (check `order.note_attributes` in the Shopify admin under the order detail).

Since the webhook skips test orders, this smoke test won't actually create an AiTrafficEvent. The signal we're looking for is the absence of errors and the presence of the log line confirming the handler ran. To verify the create-row path itself, temporarily comment out the `if (order.test === true) return;` guard in `webhooks.orders.paid.tsx`, redeploy, retest, then uncomment and redeploy again. (Or accept that the manual SQL insert in Step 7 already verified the create path.)

- [ ] **Step 9: Update memory checkpoint**

Edit `C:\Users\nyima\.claude\projects\-Users-lukas-Desktop-geo-app\memory\project_checkpoint.md`:
- Update "Last updated" timestamp to today.
- Update "Latest deploy commit" to the head SHA of this work.
- Add a changelog entry describing what shipped:
  - Theme extension AI referral tracker
  - orders/paid webhook handler
  - Revenue aggregation service
  - Dashboard AI Revenue card
  - /app/revenue page
  - NavMenu link
  - Privacy policy update

Also update `C:\Users\nyima\.claude\projects\-Users-lukas-Desktop-geo-app\memory\project_competitor_landscape.md`:
- Flip the "Revenue / traffic attribution" row from `❌ gap` to `✅ (this work)` for GEO Rise.

---

## Self-review

**Spec coverage check:** every requirement in the spec maps to at least one task:

- Storefront tracking (theme extension script) → Task 1
- orders/paid webhook subscription + handler → Tasks 2 + 3
- Revenue aggregation service → Task 4
- Dashboard card → Task 5
- /app/revenue page (stats, chart, table, plan gate) → Task 6
- NavMenu link → Task 7
- Privacy policy update → Task 8
- Em-dash sweep, build, theme deploy, smoke test, memory update → Task 9

**Type consistency check:**
- `AiPlatform` union type is identical in `webhooks.orders.paid.tsx` (Task 3) and `revenue-attribution.server.ts` (Task 4). Both list the same six values.
- `RevenueSummary` interface defined in Task 4 is consumed by Tasks 5 and 6 unchanged.
- `getRevenueAttribution(storeId, options)` signature matches between definition (Task 4) and call sites (Tasks 5 and 6).
- `__geo_rise_ai_ref` cart attribute name is identical in the theme script (Task 1) and the webhook handler (Task 3).
- `PLAN_LIMITS[plan].revenueAttribution` is used consistently in Tasks 5 and 6 for plan gating.

**Placeholder scan:** no TBDs, no "TODO", no "similar to Task N". Every code step shows complete code. Every command shows expected output or behavior.

**Risk notes:**
- Task 1 (theme script) is committed independently but only takes effect after Task 9's `shopify app deploy`. The plan documents this.
- Task 2 (webhook subscription) is committed independently but only takes effect after Task 9's `shopify app deploy`. The plan documents this.
- The end-to-end smoke test (Step 8 of Task 9) is the trickiest because it depends on theme-extension deployment + dev-store-test-order behavior. The plan provides a workaround via direct SQL insert (Step 7) for the UI side.

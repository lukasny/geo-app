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
  /** Currency that contributed the largest revenue across the range, falling
   *  back to all-time events when the range is empty. Null only when the
   *  store has no attributed orders at all. */
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
  /** Max number of recent-orders rows returned. Default: 25. Pass 0 to skip
   *  the recent-orders query entirely (the dashboard card doesn't need it). */
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
    orderLimit > 0
      ? prisma.aiTrafficEvent.findMany({
          where: { storeId, convertedToOrder: true },
          orderBy: { eventAt: "desc" },
          take: orderLimit,
        })
      : Promise.resolve([] as Awaited<
          ReturnType<typeof prisma.aiTrafficEvent.findMany>
        >),
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

  // When the range window is empty, fall back to all-time events so a store
  // whose attributed orders are all older than the range still gets its
  // all-time total and recent orders (instead of the setup empty state, which
  // gates on allTimeTotal !== null in app.revenue.tsx).
  let dominantCurrency = byCurrency[0]?.currency ?? null;
  if (!dominantCurrency && allTimeEvents.length > 0) {
    const allTimeByCurrency = new Map<string, number>();
    for (const e of allTimeEvents) {
      const ccy = e.orderCurrency ?? "USD";
      allTimeByCurrency.set(
        ccy,
        (allTimeByCurrency.get(ccy) ?? 0) + (e.orderRevenue ?? 0)
      );
    }
    dominantCurrency = Array.from(allTimeByCurrency.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0][0];
  }

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

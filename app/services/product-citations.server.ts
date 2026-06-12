import prisma from "~/db.server";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Platform values as stored on AiCitation rows. Only CLAUDE, CHATGPT and
 *  PERPLEXITY are written today (gated by API keys in tracking.server.ts);
 *  the wider union tolerates rows from platforms added later. */
export type CitationPlatform =
  | "CLAUDE"
  | "CHATGPT"
  | "PERPLEXITY"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

export interface ProductCitationStat {
  /** Product title as recorded at citation time, most recent casing wins.
   *  Titles are the only product reference AiCitation stores - there is no
   *  productId - so renamed products keep history under their old title. */
  title: string;
  /** Number of AiCitation rows whose productsCited list contains the title.
   *  One row = one platform's answer in one check, so this reads as
   *  "mentioned in N AI answers", not "N checks". */
  mentionCount: number;
  /** Mention counts per platform, only for platforms observed in the rows. */
  byPlatform: Partial<Record<CitationPlatform, number>>;
  /** ISO string of the most recent mention. */
  lastMentionedAt: string;
  /** False when no Product row currently matches the title case-insensitively:
   *  the product was renamed or deleted after the citations were recorded. */
  inCatalog: boolean;
}

export interface ProductCitationStats {
  /** Rolling window size in days the stats cover. */
  rangeDays: number;
  /** Total product mentions across all citation rows in the window. */
  totalMentions: number;
  /** Per-product stats, most mentioned first, capped at maxProducts. */
  products: ProductCitationStat[];
}

export interface GetProductCitationStatsOptions {
  /** Rolling window in days. Default 30, matching the dashboard's
   *  30-day citation count. */
  rangeDays?: number;
  /** Cap on the number of returned products. Default 10. */
  maxProducts?: number;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

// Bounded scan like competitor-monitoring's CITATIONS_WINDOW. Aggregation
// runs in JavaScript over the rows - Prisma can't group inside a Json column,
// and no service in this codebase does JSON-path SQL.
const CITATIONS_WINDOW = 500;

/** Aggregate which products AI assistants mentioned for this store, grouped
 *  per product title across platforms, over a rolling time window. */
export async function getProductCitationStats(
  storeId: string,
  options: GetProductCitationStatsOptions = {}
): Promise<ProductCitationStats> {
  const rangeDays = options.rangeDays ?? 30;
  const maxProducts = options.maxProducts ?? 10;

  const rangeStart = new Date();
  rangeStart.setUTCHours(0, 0, 0, 0);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - (rangeDays - 1));

  const [citations, catalog] = await Promise.all([
    prisma.aiCitation.findMany({
      where: { storeId, checkedAt: { gte: rangeStart } },
      select: { platform: true, productsCited: true, checkedAt: true },
      orderBy: { checkedAt: "desc" },
      take: CITATIONS_WINDOW,
    }),
    prisma.product.findMany({
      where: { storeId },
      select: { title: true },
    }),
  ]);

  const catalogTitles = new Set(catalog.map((p) => p.title.toLowerCase()));

  interface TitleAccumulator {
    displayTitle: string;
    mentionCount: number;
    byPlatform: Partial<Record<CitationPlatform, number>>;
    lastMentionedAt: string;
  }

  // Keyed by lowercased title. Rows are desc-ordered, so the first time a
  // title appears we are seeing its most recent mention (casing + timestamp).
  const byTitle = new Map<string, TitleAccumulator>();
  let totalMentions = 0;

  for (const row of citations) {
    const titles = Array.isArray(row.productsCited)
      ? (row.productsCited as string[])
      : [];
    // Defensive de-dupe within the row; the writer already de-dupes via a Set
    // but the Json column carries no such guarantee.
    const seenThisRow = new Set<string>();
    for (const title of titles) {
      if (typeof title !== "string" || title.length === 0) continue;
      const key = title.toLowerCase();
      if (seenThisRow.has(key)) continue;
      seenThisRow.add(key);

      let acc = byTitle.get(key);
      if (!acc) {
        acc = {
          displayTitle: title,
          mentionCount: 0,
          byPlatform: {},
          lastMentionedAt: row.checkedAt.toISOString(),
        };
        byTitle.set(key, acc);
      }
      acc.mentionCount += 1;
      const platform = row.platform as CitationPlatform;
      acc.byPlatform[platform] = (acc.byPlatform[platform] ?? 0) + 1;
      totalMentions += 1;
    }
  }

  const products: ProductCitationStat[] = Array.from(byTitle.entries())
    .map(([key, acc]) => ({
      title: acc.displayTitle,
      mentionCount: acc.mentionCount,
      byPlatform: acc.byPlatform,
      lastMentionedAt: acc.lastMentionedAt,
      inCatalog: catalogTitles.has(key),
    }))
    .sort(
      (a, b) =>
        b.mentionCount - a.mentionCount ||
        b.lastMentionedAt.localeCompare(a.lastMentionedAt)
    )
    .slice(0, maxProducts);

  return { rangeDays, totalMentions, products };
}

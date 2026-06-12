import prisma from "~/db.server";
import type { AiCitation, Competitor } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompetitorStats {
  // createdAt is dropped - Date doesn't serialize cleanly through the Remix
  // loader (becomes string on the client) and we don't display it anyway.
  competitor: Pick<Competitor, "id" | "name" | "domain" | "notes">;
  /** Number of recent AiCitation rows whose `competitorsCited` list mentions
   *  this competitor's domain (or a subdomain of it). */
  citedCount: number;
  /** ISO string of the most recent citation that mentioned this competitor. */
  lastCitedAt: string | null;
  /** Breakdown of mentions by platform: { CLAUDE: 5, CHATGPT: 2, ... } */
  byPlatform: Record<string, number>;
  /** Of the citations that mentioned this competitor, how many also cited
   *  the merchant's own store? Lets the UI show "head-to-head" framing -
   *  "When AI talks about Burton, it also mentions you 3 of 12 times." */
  storeCitedSameQueries: number;
}

export interface CompetitorOverview {
  /** Total cited-true count across all AiCitations for this store. */
  storeCitedCount: number;
  /** Total citation rows we considered (the recent window). */
  totalChecks: number;
  competitors: CompetitorStats[];
}

export interface SuggestedCompetitor {
  domain: string;
  /** How many existing AiCitations cited this domain (and the merchant
   *  hasn't already added it as a tracked competitor). */
  count: number;
}

// ─── Normalization ────────────────────────────────────────────────────────────

/** Normalize user-typed domain input into a comparable hostname.
 *  - strips http(s):// protocol
 *  - strips path / query / hash
 *  - strips leading "www."
 *  - lowercases + trims
 *  Returns null for inputs that don't look like a domain at all. */
export function normalizeDomain(input: string): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/^www\./, "");
  // Must look like a hostname: at least one dot, only valid characters.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

/** Does this citation row mention the given competitor domain? Matches
 *  the exact domain AND any subdomain (so adding `burton.com` catches
 *  `shop.burton.com` and `www.burton.com` too). */
function citationIncludesDomain(
  citation: AiCitation,
  domain: string
): boolean {
  const list = Array.isArray(citation.competitorsCited)
    ? (citation.competitorsCited as string[])
    : [];
  return list.some(
    (d) =>
      typeof d === "string" && (d === domain || d.endsWith(`.${domain}`))
  );
}

// ─── Overview / Stats ─────────────────────────────────────────────────────────

const CITATIONS_WINDOW = 500;

export async function getCompetitorOverview(
  storeId: string
): Promise<CompetitorOverview> {
  const [competitors, citations] = await Promise.all([
    prisma.competitor.findMany({
      where: { storeId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.aiCitation.findMany({
      where: { storeId },
      orderBy: { checkedAt: "desc" },
      take: CITATIONS_WINDOW,
    }),
  ]);

  const storeCitedCount = citations.filter((c) => c.cited).length;
  const totalChecks = citations.length;

  const competitorStats: CompetitorStats[] = competitors.map((c) => {
    const matched = citations.filter((cit) =>
      citationIncludesDomain(cit, c.domain)
    );
    const byPlatform: Record<string, number> = {};
    for (const m of matched) {
      byPlatform[m.platform] = (byPlatform[m.platform] ?? 0) + 1;
    }
    // citations is desc-ordered, so matched[0] is the most recent.
    const lastCitedAt =
      matched.length > 0 ? matched[0].checkedAt.toISOString() : null;
    const storeCitedSameQueries = matched.filter((m) => m.cited).length;
    return {
      competitor: {
        id: c.id,
        name: c.name,
        domain: c.domain,
        notes: c.notes,
      },
      citedCount: matched.length,
      lastCitedAt,
      byPlatform,
      storeCitedSameQueries,
    };
  });

  return {
    storeCitedCount,
    totalChecks,
    competitors: competitorStats,
  };
}

// ─── Auto-suggestion from existing AI Tracking data ───────────────────────────

// Domains that are almost certainly NOT competitors - generic marketplaces,
// social networks, review aggregators, gov/edu. Filtered out of suggestions
// so the merchant doesn't see "track amazon.com?" cluttering the list.
const GENERIC_NON_COMPETITOR_PATTERNS: RegExp[] = [
  /amazon\.[a-z.]+$/,
  /ebay\.[a-z.]+$/,
  /walmart\.com$/,
  /target\.com$/,
  /etsy\.com$/,
  /aliexpress\.[a-z.]+$/,
  /reddit\.com$/,
  /youtube\.com$/,
  /vimeo\.com$/,
  /wikipedia\.org$/,
  /quora\.com$/,
  /pinterest\.[a-z.]+$/,
  /facebook\.com$/,
  /instagram\.com$/,
  /twitter\.com$/,
  /x\.com$/,
  /tiktok\.com$/,
  /linkedin\.com$/,
  /trustpilot\.[a-z.]+$/,
  /yelp\.com$/,
  /yotpo\.com$/,
  /google\.[a-z.]+$/,
  /bing\.com$/,
  /duckduckgo\.com$/,
  /\.gov$/,
  /\.edu$/,
];

function isGenericNonCompetitor(domain: string): boolean {
  return GENERIC_NON_COMPETITOR_PATTERNS.some((re) => re.test(domain));
}

export async function suggestCompetitors(
  storeId: string,
  limit = 8
): Promise<SuggestedCompetitor[]> {
  const [citations, existing] = await Promise.all([
    prisma.aiCitation.findMany({
      where: { storeId },
      select: { competitorsCited: true },
      // Same most-recent window as getCompetitorOverview; without the
      // orderBy, take returns an arbitrary Postgres sample once the table
      // exceeds the window.
      orderBy: { checkedAt: "desc" },
      take: CITATIONS_WINDOW,
    }),
    prisma.competitor.findMany({
      where: { storeId },
      select: { domain: true },
    }),
  ]);

  const tracked = existing.map((c) => c.domain);
  // Mirrors citationIncludesDomain: a tracked parent domain already counts
  // its subdomains in the overview stats, so suggesting shop.burton.com when
  // burton.com is tracked would burn a plan-capped slot on coverage the
  // merchant already has.
  const isTracked = (domain: string) =>
    tracked.some((t) => domain === t || domain.endsWith(`.${t}`));
  const counts = new Map<string, number>();

  for (const c of citations) {
    const list = Array.isArray(c.competitorsCited)
      ? (c.competitorsCited as string[])
      : [];
    // Each domain only contributes once per citation row, even if it appears
    // multiple times in that row's source list.
    const seenThisRow = new Set<string>();
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const normalized = normalizeDomain(raw);
      if (!normalized) continue;
      if (isGenericNonCompetitor(normalized)) continue;
      if (isTracked(normalized)) continue;
      if (seenThisRow.has(normalized)) continue;
      seenThisRow.add(normalized);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .filter((d) => d.count >= 2) // require at least 2 mentions to be a real signal
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Citation Source Radar: aggregation, classification, and on-demand
 * presence checks for the "Where AI answers come from" card.
 *
 * getCitationSources turns the raw sourcesCited URL lists on recent
 * AiCitation rows into a ranked, classified list of the pages AI engines
 * consulted or cited when answering the store's tracked prompts.
 * checkSourcePresence fetches a handful of those pages on demand and
 * records whether the store is named on each one.
 *
 * AiCitation.sourcesCited semantics (see tracking.server.ts): a Json
 * string[] of full source URLs per platform check, at most 20 URLs of at
 * most 500 chars each, undefined when the platform returned none.
 * Perplexity's list includes every search result consulted, not only
 * inline-cited pages, so counts here mean "consulted or cited", never
 * endorsements. All queries are tenant-scoped and bounded; dates cross
 * the loader boundary as ISO strings.
 */
import prisma from "~/db.server";
import { platformLabel } from "~/utils/platforms";

export type SourceBucket =
  | "reddit"
  | "youtube"
  | "review_platform"
  | "marketplace"
  | "editorial"
  | "competitor"
  | "own_site"
  | "other";

export interface CitedSource {
  /** Hostname, lowercased, leading "www." stripped. */
  domain: string;
  /** A representative full URL from the newest answer that used this domain. */
  sampleUrl: string;
  bucket: SourceBucket;
  /** Answers (AiCitation rows) whose source list included this domain. */
  appearances: number;
  /** Subset of appearances where the store itself was cited. */
  citedAppearances: number;
  /** Display-ready platform names ("Claude", "ChatGPT", ...), first-seen
   *  order across the newest-first rows. */
  platforms: string[];
  /** Newest SourcePresence verdict for any page on this domain.
   *  "unchecked" means never checked; "unknown" is reserved for a
   *  could-not-check state, which today is never persisted (failed checks
   *  deliberately record nothing, see checkSourcePresence). */
  presence: "present" | "absent" | "unknown" | "unchecked";
  lastCheckedAt: string | null;
}

/** Plain merchant-facing window: "last 30 days". */
const DEFAULT_RANGE_DAYS = 30;

/** Ranked sources returned to the card by default. */
const DEFAULT_LIMIT = 15;

/** Most-recent citation rows scanned per aggregation. Same bounded-window
 *  approach as citation-alerts: without it the scan grows with the
 *  citation table forever. */
const CITATIONS_WINDOW = 500;

/** Most-recent presence rows joined per aggregation. Manual checks add at
 *  most 10 rows each, so a fixed window covers months of checking. */
const PRESENCE_WINDOW = 500;

/** Exact-or-subdomain hostname match, same semantics as
 *  hostMatchesDomain in citation-alerts.server.ts: "burton.com" also
 *  matches "www.burton.com" and "shop.burton.com". The right-hand domain
 *  must already be normalized (lowercase, no www prefix). */
function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** sourcesCited is Json in the schema, so validate defensively, mirroring
 *  citedHostnames in citation-alerts.server.ts. */
function citedUrls(sourcesCited: unknown): string[] {
  return Array.isArray(sourcesCited)
    ? sourcesCited.filter((u): u is string => typeof u === "string")
    : [];
}

/** Grouping key for a source URL: lowercased hostname without a leading
 *  "www.". Returns null when the URL does not parse; callers skip those
 *  silently (AI engines occasionally return malformed citations). */
function sourceHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ─── Classification ──────────────────────────────────────────────────────────

/** Well-known review platforms, matched exact-or-subdomain. */
const REVIEW_PLATFORM_DOMAINS = [
  "trustpilot.com",
  "g2.com",
  "yelp.com",
  "capterra.com",
  "sitejabber.com",
  "judge.me",
  "reviews.io",
];

/** Marketplaces on a fixed domain, matched exact-or-subdomain. Amazon and
 *  eBay run per-country TLDs (amazon.de, ebay.co.uk, ...) and are matched
 *  by brand label below instead. */
const MARKETPLACE_DOMAINS = [
  "etsy.com",
  "walmart.com",
  "target.com",
  "temu.com",
  "aliexpress.com",
];

/** "amazon." or "ebay." as a whole hostname label: matches amazon.com,
 *  amazon.co.uk, and www.ebay.de without matching myamazonstore.com. */
const MARKETPLACE_BRAND_PATTERNS = ["amazon", "ebay"].map(
  (brand) => new RegExp(`(^|\\.)${brand}\\.`)
);

function isMarketplaceHost(host: string): boolean {
  return (
    MARKETPLACE_DOMAINS.some((d) => hostMatchesDomain(host, d)) ||
    MARKETPLACE_BRAND_PATTERNS.some((pattern) => pattern.test(host))
  );
}

/** Slug fragments that mark editorial and listicle pages. Ranked
 *  listicles are the single most cited page format in AI answers (see
 *  docs/geo-evidence-2026-07.md F3), and their slugs are loud about it:
 *  "/10-best-...", "/top-rated-...", "/x-vs-y-review". */
const EDITORIAL_PATH_HINTS = ["best", "top-", "-top", "review", "vs-", "guide"];

/** URL path heuristic for the editorial bucket. Deterministic by design:
 *  v1 uses no AI classification. */
function pathLooksEditorial(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (EDITORIAL_PATH_HINTS.some((hint) => path.includes(hint))) return true;
  // Digit-led path segment, the "/10-best-widgets" listicle shape.
  return path.split("/").some((segment) => /^\d+-/.test(segment));
}

/** Bucket one source domain. First match wins, in spec order: own_site
 *  before competitor so a merchant who tracks their own domain as a
 *  competitor never sees it bucketed as one, known platforms before the
 *  editorial path heuristic so reddit.com/r/x/best-of never reads as
 *  editorial. */
function classifySource(args: {
  host: string;
  ownHosts: string[];
  competitorDomains: string[];
  editorialHint: boolean;
}): SourceBucket {
  const { host, ownHosts, competitorDomains, editorialHint } = args;
  if (ownHosts.some((own) => own.length > 0 && hostMatchesDomain(host, own))) {
    return "own_site";
  }
  if (competitorDomains.some((d) => hostMatchesDomain(host, d))) {
    return "competitor";
  }
  if (hostMatchesDomain(host, "reddit.com")) return "reddit";
  if (
    hostMatchesDomain(host, "youtube.com") ||
    hostMatchesDomain(host, "youtu.be")
  ) {
    return "youtube";
  }
  if (REVIEW_PLATFORM_DOMAINS.some((d) => hostMatchesDomain(host, d))) {
    return "review_platform";
  }
  if (isMarketplaceHost(host)) return "marketplace";
  if (editorialHint) return "editorial";
  return "other";
}

/** Hostnames that identify the merchant's own site. The Store row caches
 *  no primary storefront domain and this service stays off the Shopify
 *  Admin API (tracking.server.ts resolves primaryDomain live with a fresh
 *  offline token; that is a per-check cost this read path must not pay),
 *  so this is the myshopify host only. AI engines almost always cite a
 *  merchant's CUSTOM domain, not the myshopify one, so an own-site citation
 *  can fall through to "editorial" or "other", or to "competitor" if the
 *  merchant tracks their own domain as a competitor. Accepted v1 gap: a
 *  wrong bucket on the merchant's own domain, but never a wrong count. To
 *  close it, cache the resolved primary domain on Store during a tracking
 *  check and add it here. */
function ownHostsFor(shopifyDomain: string): string[] {
  return [shopifyDomain.toLowerCase()];
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export async function getCitationSources(
  storeId: string,
  options?: { rangeDays?: number; limit?: number }
): Promise<{ sources: CitedSource[]; totalAnswersWithSources: number }> {
  const rangeDays = options?.rangeDays ?? DEFAULT_RANGE_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

  const [store, rows, competitors, presenceRows] = await Promise.all([
    prisma.store.findUnique({
      where: { id: storeId },
      select: { shopifyDomain: true },
    }),
    // Recent rows, newest first, bounded like citation-alerts.
    prisma.aiCitation.findMany({
      where: { storeId, checkedAt: { gte: since } },
      orderBy: { checkedAt: "desc" },
      take: CITATIONS_WINDOW,
      select: { platform: true, cited: true, sourcesCited: true },
    }),
    prisma.competitor.findMany({
      where: { storeId },
      select: { domain: true },
    }),
    // Newest first so the per-domain presence map keeps the most recent
    // verdict for each domain.
    prisma.sourcePresence.findMany({
      where: { storeId },
      orderBy: { checkedAt: "desc" },
      take: PRESENCE_WINDOW,
      select: { url: true, present: true, checkedAt: true },
    }),
  ]);
  if (!store) return { sources: [], totalAnswersWithSources: 0 };

  const ownHosts = ownHostsFor(store.shopifyDomain);
  const competitorDomains = competitors.map((c) => c.domain);

  const groups = new Map<
    string,
    {
      sampleUrl: string;
      appearances: number;
      citedAppearances: number;
      platforms: string[];
      editorialHint: boolean;
    }
  >();
  let totalAnswersWithSources = 0;

  for (const row of rows) {
    const urls = citedUrls(row.sourcesCited);
    if (urls.length === 0) continue;
    totalAnswersWithSources += 1;
    // A domain counts once per answer no matter how many of its pages the
    // answer used, so "appeared in N answers" stays literally true.
    const countedThisRow = new Set<string>();
    for (const url of urls) {
      const host = sourceHostname(url);
      if (!host) continue; // unparseable citation, skip silently
      let group = groups.get(host);
      if (!group) {
        // Rows are newest first, so the first URL seen is the freshest
        // sample page for this domain.
        group = {
          sampleUrl: url,
          appearances: 0,
          citedAppearances: 0,
          platforms: [],
          editorialHint: false,
        };
        groups.set(host, group);
      }
      // The editorial heuristic looks at every URL seen for the domain,
      // not just the sample: one loud listicle slug is enough.
      group.editorialHint = group.editorialHint || pathLooksEditorial(url);
      const label = platformLabel(row.platform);
      if (!group.platforms.includes(label)) group.platforms.push(label);
      if (countedThisRow.has(host)) continue;
      countedThisRow.add(host);
      group.appearances += 1;
      if (row.cited) group.citedAppearances += 1;
    }
  }

  // Presence verdicts are stored per URL, but the card shows one row per
  // domain, so join on the checked URL's hostname and keep the newest
  // verdict per domain (presenceRows is newest first). This keeps the
  // badge stable even when a newer answer rotates the sample URL to a
  // different page on the same domain.
  const presenceByHost = new Map<string, { present: boolean; checkedAt: Date }>();
  for (const row of presenceRows) {
    const host = sourceHostname(row.url);
    if (!host || presenceByHost.has(host)) continue;
    presenceByHost.set(host, { present: row.present, checkedAt: row.checkedAt });
  }

  const sources: CitedSource[] = [...groups.entries()]
    .map(([domain, group]) => {
      const verdict = presenceByHost.get(domain);
      const presence: CitedSource["presence"] = verdict
        ? verdict.present
          ? "present"
          : "absent"
        : "unchecked";
      return {
        domain,
        sampleUrl: group.sampleUrl,
        bucket: classifySource({
          host: domain,
          ownHosts,
          competitorDomains,
          editorialHint: group.editorialHint,
        }),
        appearances: group.appearances,
        citedAppearances: group.citedAppearances,
        platforms: group.platforms,
        presence,
        lastCheckedAt: verdict ? verdict.checkedAt.toISOString() : null,
      };
    })
    .sort(
      (a, b) =>
        b.appearances - a.appearances ||
        b.citedAppearances - a.citedAppearances ||
        a.domain.localeCompare(b.domain)
    )
    .slice(0, limit);

  return { sources, totalAnswersWithSources };
}

// ─── Presence check ──────────────────────────────────────────────────────────

/** Hard cap on pages fetched per call. */
const MAX_URLS_PER_CHECK = 10;

/** A verdict is fresh for this long; re-checks inside the window are
 *  skipped so repeated calls spend their budget on unchecked pages. */
const RECHECK_WINDOW_DAYS = 7;

const PRESENCE_FETCH_TIMEOUT_MS = 5000;

/** Same size cap and reasoning as the robots.txt checker: bound how much
 *  of an untrusted third-party page gets buffered. The first 512 KiB of
 *  HTML is far more than enough to find a store name. */
const MAX_PAGE_LENGTH = 512 * 1024;

/** Honest self-identifying UA for the on-demand page fetches. */
const PRESENCE_USER_AGENT = "GEORise-SourceCheck/1.0 (+https://georise.app)";

// ─── Check cooldown ──────────────────────────────────────────────────────────
// One presence check fans out up to 10 outbound fetches, so a merchant
// mashing the button (or a replayed request) would multiply third-party
// traffic and DB writes. One call per store per minute is plenty for an
// on-demand action. In-memory is correct here for the same reason as the
// crawler-hit write throttle: single long-lived Render process, and a
// restart just resets the window. The map holds at most one entry per
// store (bounded by store count).
const CHECK_COOLDOWN_MS = 60_000;
const lastCheckAt = new Map<string, number>();

function allowCheck(storeId: string): boolean {
  const now = Date.now();
  const last = lastCheckAt.get(storeId);
  if (last !== undefined && now - last < CHECK_COOLDOWN_MS) return false;
  lastCheckAt.set(storeId, now);
  return true;
}

/** Hostnames this server must never fetch: the URLs come from AI engine
 *  responses stored in our DB, which is not attacker-controlled in any
 *  direct way, but a server-side fetch of localhost, link-local metadata
 *  addresses, or private ranges has no legitimate purpose here, so reject
 *  IP literals and local names outright rather than reason about them. */
function isForbiddenHost(hostname: string): boolean {
  // A trailing dot is a valid FQDN form ("localhost.") that still resolves
  // to the same host, so strip it before matching or the checks below miss.
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.startsWith("[")) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal
  return false;
}

/** Accept only http(s) URLs on real public hostnames that fit the
 *  SourcePresence.url column. sourcesCited values are already capped at
 *  500 chars at write time, so the length check only guards direct
 *  callers. */
function isCheckableUrl(url: string): boolean {
  if (url.length > 500) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    return !isForbiddenHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Read at most `maxBytes` of a response body, streaming so a slow or
 *  huge origin can't buffer hundreds of MB into memory before we slice.
 *  Same pattern as crawler-access.server.ts: the pages checked here are
 *  arbitrary third-party origins picked by AI engines, so the body is
 *  untrusted; the 5s AbortSignal bounds time, this bounds size. One
 *  deliberate difference: a declared Content-Length over the cap returns
 *  null ("could not check") instead of an empty read, because scoring a
 *  page we refused to read as "no mention found" would be lying. */
async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // No streamable body (not expected for a normal fetch 200); fall back.
    return (await response.text()).slice(0, maxBytes);
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Stop the download as soon as we have enough (or hit the cap).
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, maxBytes);
}

/** Escape a needle for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word case-insensitive match, so a short store name ("Gear",
 *  "Bloom") does not fire on unrelated substrings ("Gearbox", "Bloomberg").
 *  Word boundaries also tighten the domain needle (example.com no longer
 *  matches example.company). */
function bodyMentions(body: string, needles: string[]): boolean {
  const lower = body.toLowerCase();
  return needles.some((needle) => {
    try {
      return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(lower);
    } catch {
      return lower.includes(needle);
    }
  });
}

/** Follow at most this many redirect hops, revalidating each target host so
 *  a public page cannot bounce the fetch onto an internal address. */
const MAX_REDIRECT_HOPS = 4;

/** Fetch one page and scan it for the needles. Returns true or false on a
 *  successful read, null when the page could not be checked (bad URL,
 *  non-2xx, timeout, network error, a redirect to a forbidden host, or a
 *  body rejected by the size cap). Null means "record nothing": absence of
 *  evidence is not evidence of absence when we never saw the page.
 *
 *  Redirects are followed manually one hop at a time, re-running
 *  isCheckableUrl on every Location, because Node's global fetch defaults
 *  to redirect:"follow" and would otherwise chase a public page's 3xx into
 *  localhost or a link-local metadata address without re-checking. */
async function fetchPresenceVerdict(
  url: string,
  needles: string[]
): Promise<boolean | null> {
  if (!isCheckableUrl(url)) return null;
  // One shared deadline across all hops, so a redirect chain cannot stack
  // several full timeouts.
  const signal = AbortSignal.timeout(PRESENCE_FETCH_TIMEOUT_MS);
  const headers = {
    "User-Agent": PRESENCE_USER_AGENT,
    Accept: "text/html, */*",
  };
  try {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal,
        headers,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop === MAX_REDIRECT_HOPS) return null;
        const next = new URL(location, currentUrl).toString();
        if (!isCheckableUrl(next)) return null;
        currentUrl = next;
        continue;
      }
      if (!response.ok) return null;
      const body = await readBoundedText(response, MAX_PAGE_LENGTH);
      if (body === null) return null;
      return bodyMentions(body, needles);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * On-demand presence check: fetch up to 10 of the given pages and record
 * whether the store is named on each one (case-insensitive store name or
 * own hostname in the body). Fetch failures and non-2xx responses are NOT
 * persisted: a page we could not read stays "unchecked" or keeps its
 * stale verdict rather than being recorded as a miss. A recorded miss can
 * still be a false negative (JS-rendered pages, paywalls, bot
 * protection); the UI copy owns that disclaimer.
 *
 * Never throws. `checked` counts pages fetched and recorded; `skipped`
 * counts everything else: URLs beyond the 10-per-call cap, URLs checked
 * within the last 7 days, unparseable or non-http(s) URLs, pages that
 * could not be fetched or read, and (when the per-store cooldown blocks
 * the whole call) every URL submitted.
 */
export async function checkSourcePresence(
  storeId: string,
  urls: string[]
): Promise<{ checked: number; skipped: number }> {
  const candidates = [...new Set(urls)];
  try {
    if (!allowCheck(storeId)) {
      return { checked: 0, skipped: candidates.length };
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { shopifyDomain: true, shopName: true },
    });
    if (!store) return { checked: 0, skipped: candidates.length };

    const batch = candidates.slice(0, MAX_URLS_PER_CHECK);
    let skipped = candidates.length - batch.length;
    let checked = 0;

    const recheckAfter = new Date(
      Date.now() - RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    const fresh = await prisma.sourcePresence.findMany({
      where: { storeId, url: { in: batch }, checkedAt: { gte: recheckAfter } },
      select: { url: true },
    });
    const freshUrls = new Set(fresh.map((r) => r.url));

    // Needles, lowercased once. The store name is the signal that
    // actually fires on third-party pages; the only own host resolvable
    // without the Admin API is the myshopify one (see ownHostsFor).
    const needles = [store.shopName, ...ownHostsFor(store.shopifyDomain)]
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n.length > 0);

    // Parallel fanout, each URL isolated: one page's failure (or one
    // upsert hiccup) must not lose the counts from the others.
    await Promise.all(
      batch.map(async (url) => {
        try {
          if (freshUrls.has(url)) {
            skipped += 1;
            return;
          }
          const verdict = await fetchPresenceVerdict(url, needles);
          if (verdict === null) {
            skipped += 1;
            return;
          }
          await prisma.sourcePresence.upsert({
            where: { storeId_url: { storeId, url } },
            create: { storeId, url, present: verdict },
            update: { present: verdict, checkedAt: new Date() },
          });
          checked += 1;
        } catch (err) {
          console.error("[GEO Rise] Source presence upsert failed:", err);
          skipped += 1;
        }
      })
    );

    return { checked, skipped };
  } catch (err) {
    // Never-throws contract: the tracking action turns these counts into
    // a toast, and a presence hiccup must not 500 the page.
    console.error("[GEO Rise] Source presence check failed:", err);
    return { checked: 0, skipped: candidates.length };
  }
}

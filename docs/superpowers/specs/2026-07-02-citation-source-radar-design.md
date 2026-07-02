# Citation Source Radar (F3): design spec

Date: 2026-07-02. Evidence basis: docs/geo-evidence-2026-07.md F3 (Layer 2,
highest strategic value: ~75% of AI citations point at third-party pages;
ranked listicles are the top cited format; only ~3% of citations hit the
brand's own domain). Approved by Lukas ("keep going" after the F3-first
plan).

## What the merchant gets

A new "Where AI answers come from" card on the tracking page (citations are
tracking data per the 2026-06-12 decision): the third-party pages AI engines
consulted or cited when answering the merchant's tracked prompts, ranked by
how often they appear, classified by type (Reddit, review platform,
marketplace, editorial or listicle, competitor, own site, other), plus an
on-demand "check my presence" action that fetches the top sources and
reports whether the store is named on each page. That turns tracking data we
already receive (and currently throw away) into a concrete outreach list.

## Honesty constraints (hard)

- Perplexity's source list includes every search result consulted, not only
  inline-cited pages; Claude's list is strictly inline citations (deliberate
  earlier bugfix) and OpenAI's is url_citation annotations. Do NOT relitigate
  cited-detection. UI copy must say "consulted or cited", never imply every
  source endorsed the store.
- Presence check is a fetch + case-insensitive match of store name / domain:
  a miss can be a false negative (JS-rendered pages, paywalls, bot
  protection). Copy must say so. Statuses: "mentions you", "no mention
  found", "could not check" (never a bare failure).
- Plain windows: "last 30 days". No em or en dashes anywhere.

## Data model (Agent A owns)

1. prisma/schema.prisma: add `sourcesCited Json?` to AiCitation (nullable,
   mirrors competitorsCited/productsCited exactly). Add new model:

   model SourcePresence {
     id        String   @id @default(cuid())
     storeId   String
     url       String   @db.VarChar(500)
     present   Boolean
     checkedAt DateTime @default(now())
     store     Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
     @@unique([storeId, url])
     @@index([storeId, checkedAt])
   }

   Plus the `sourcePresences SourcePresence[]` back-relation on Store.
2. Hand-written migration prisma/migrations/20260702120000_add_citation_sources/
   migration.sql in the existing house style (ALTER TABLE AiCitation ADD
   COLUMN, CreateTable, CreateIndex, AddForeignKey ON DELETE CASCADE).
3. tracking.server.ts: widen the shared asker response type to
   `{ responseText: string; sourceDomains: string[]; sourceUrls: string[] }`.
   All three askers (Claude text-block citations, OpenAI url_citation
   annotations, Perplexity citations[] + search_results[]) collect the FULL
   URLs into sourceUrls (deduped, insertion order) in the same loops that
   currently reduce to hostnames; sourceDomains stays byte-identical in
   behavior (cited-detection and competitorsCited must not change).
4. Persist at the single aiCitation.create site: `sourcesCited:
   sourceUrls.length > 0 ? sourceUrls.slice(0, 20).map(u => u.slice(0, 500))
   : undefined`. Cap 20 URLs per row, 500 chars per URL.

EXACT exported contract Agent A guarantees (for B and C):
- AiCitation.sourcesCited: Json? = string[] of full URLs (max 20, each max
  500 chars), undefined when none.

## Aggregation + classification service (Agent B owns)

NEW app/services/citation-sources.server.ts. No AI calls (deterministic v1;
AI classification via ai-retry is a possible later upgrade, not this build).

- `export type SourceBucket = "reddit" | "youtube" | "review_platform" |
  "marketplace" | "editorial" | "competitor" | "own_site" | "other";`
- `export interface CitedSource { domain: string; sampleUrl: string;
  bucket: SourceBucket; appearances: number; citedAppearances: number;
  platforms: string[]; presence: "present" | "absent" | "unknown" |
  "unchecked"; lastCheckedAt: string | null; }`
- `export async function getCitationSources(storeId: string, options?: {
  rangeDays?: number; limit?: number }): Promise<{ sources: CitedSource[];
  totalAnswersWithSources: number }>` : reads the last 500 AiCitation rows
  (30-day default window, tenant-scoped, bounded take, same pattern as
  citation-alerts), flattens sourcesCited, groups by hostname
  (lowercased, strip leading www.), counts appearances and
  citedAppearances (rows where cited=true), collects platforms, classifies,
  joins SourcePresence rows for presence/lastCheckedAt (ISO string), sorts
  by appearances desc, returns top `limit` (default 15).
- Classification order (first match wins): own_site (matches the store's
  primary/myshopify hosts, reuse the resolve pattern already in
  tracking.server.ts or accept hosts as a param from the caller);
  competitor (exact-or-subdomain match against tracked Competitor.domain,
  same hostMatchesDomain semantics as citation-alerts.server.ts); reddit
  (reddit.com); youtube (youtube.com, youtu.be); review_platform (static
  list: trustpilot.com, g2.com, yelp.com, capterra.com, sitejabber.com,
  judge.me, reviews.io); marketplace (amazon.*, ebay.*, etsy.com,
  walmart.com, target.com, temu.com, aliexpress.com); editorial (URL path
  heuristic on the sample URLs: contains "best", "top-", "-top", "review",
  "vs-", "guide", or a digit-led path segment like /10-); other.
- `export async function checkSourcePresence(storeId: string, urls:
  string[]): Promise<{ checked: number; skipped: number }>` : on-demand
  presence checker. Bounds: max 10 URLs per call; skip URLs checked within
  the last 7 days (SourcePresence.checkedAt); per-store in-memory cooldown
  of 1 call per 60s (crawler-hits throttle pattern); each fetch uses the
  bounded-read pattern from crawler-access.server.ts (5s timeout, 512KiB
  streaming cap, honest User-Agent "GEORise-SourceCheck/1.0
  (+https://georise.app)"); match = case-insensitive store name OR any own
  host in the body; upsert SourcePresence on [storeId, url]; non-2xx or
  fetch error = do not upsert (stays "unchecked"/stale rather than lying).
  Never throws; returns counts for the toast.

## UI (Agent C owns)

app/routes/app.tracking.tsx only.
- Loader: add `getCitationSources(store.id)` to the existing parallel loads
  (tracking page is already server-gated Growth+ via aiTracking; the card
  inherits that, no new gate needed). Pass through as `citedSources`.
- New Card "Where AI answers come from" rendered below the existing prompt
  cards: a simple list or IndexTable of top sources: domain (external link
  to sampleUrl), bucket as a Polaris Badge with STANDARD tone (no custom
  colors; text label carries the meaning), "appeared in N answers" plain
  count, platforms as text, presence chip: Badge tone success "mentions
  you" / attention "no mention found" / neutral "not checked yet" or
  "could not check". Wrap counts in honest copy: "Sources ChatGPT, Claude,
  and Perplexity consulted or cited when answering your tracked prompts,
  last 30 days."
- Subdued explainer under the list: "Pages that appear repeatedly are where
  AI finds your category. Getting your store listed on them is high-leverage
  work: most AI citations point at third-party pages like these, not at
  brand sites." Plus the false-negative disclaimer after a presence check.
- Action `checkSourcePresence`: button "Check top pages for your store"
  posts intent, calls the service with the top 10 non-own_site domains'
  sample URLs, toasts "Checked N pages (M recently checked were skipped)".
  Server-side plan gate identical to the page's existing action gates.
  Empty state (no sources yet): one subdued sentence inside the card, "Run
  a tracking check and sources will appear here." (Card only renders when
  the store has at least one prompt, mirroring existing page structure.)

## Explicitly out of scope (this build)

AI-powered domain classification, automatic scheduled presence re-checks,
outreach email drafts, per-source historical trends, surfacing on the
competitors page, backfill of sourcesCited for historical rows (starts
empty and fills as checks run; the card's empty state covers the gap).

## Verification

Central after all agents: prisma generate, tsc, build, em-dash scan on
changed files, adversarial review workflow, per-task commits (data,
service, UI), push, Render health check. Smoke on boda-brands: run a
tracking check, confirm sources appear, run the presence check, confirm
badges update. No Shopify Admin GraphQL shape changes anywhere in this
build (the only external calls are the AI vendors already in use and plain
HTTP fetches), so no shopify.dev doc-verification is required.

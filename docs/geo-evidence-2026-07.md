# GEO Evidence Brief (2026-07)

Core reference for every Claude Code session: the empirical basis for GEO Rise
feature work plus the build constraints that apply to the feature candidates.
This file is reference, not a task list; Lukas decides sequencing. When this
file conflicts with newer instructions from Lukas or newer repo state, the
newer thing wins; flag the conflict.

Provenance: written 2026-07 by Lukas's strategy Claude, then fact-checked
against this repo on 2026-07-02 by seven parallel verification agents and
amended with their findings. Every repo-facing correction below sits in a
"Repo status" or "Repo notes" block; the external evidence in section 1 is
unchanged from the original. Line numbers cited below are as of 2026-07-02
and will drift; treat them as pointers, not anchors. The full sourced version
of the evidence lives in Lukas's claude.ai project knowledge (file
09_GEO_EVIDENCE_BASE.md), not in this repo. Do not restate the numbers below
in merchant-facing copy without re-verifying the primary source.

## 1. The evidence in one page

Visibility in AI answers (ChatGPT, Perplexity, Claude, Gemini, AI Overviews,
AI Mode) is a five-layer stack. Lower layers gate higher ones.

- Layer 0, readability (binary): no major AI crawler executes JavaScript
  (Vercel/MERJ, 500M+ GPTBot fetches, zero JS execution; Gemini is the
  exception via Googlebot infrastructure). Crawlers read raw HTML only, do
  not scroll, time out in 1 to 5 seconds. robots.txt is the real access
  control; retrieval bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot)
  are distinct from training bots (GPTBot, ClaudeBot).
- Layer 1, retrieval rank: C-SEO Bench (NeurIPS 2025) showed content-tweak
  tactics are mostly ineffective and sometimes harmful, while classic
  retrieval ranking dominates what LLMs cite. Engine-to-index mapping:
  ChatGPT runs on Bing (about 87% of its citations match Bing top-10; about
  92% of agent queries use the Bing index), AI Overviews correlate with
  Google top-10 (about 76%), and ChatGPT citations are nearly independent of
  Google rank.
- Layer 2, brand mass off-site (dominant for who gets named): brand web
  mentions correlate 0.664 with AI citation rate versus 0.218 for backlinks
  (Ahrefs, 75k brands). Only about 3% of citations point at a brand's own
  domain; about 75% are third-party pages; ranked listicles are the top cited
  format (about 21% of all citations); Reddit is the top domain across
  engines; visibility ladders hard by brand size (roughly 73/44/11% for
  large/mid/small).
- Layer 3, on-page extractability (secondary): Princeton GEO paper (KDD
  2024): statistics +41%, quotations +28%, citing sources up to +115% for
  low-ranked pages; keyword stuffing hurts. Answer-first openings, concrete
  specs, entity clarity, FAQ blocks.
- Layer 4, structured commerce data: OpenAI ranks shopping merchants on
  availability, price, quality, and maker or primary-seller status. Since
  2026-03-24, Shopify Agentic Storefronts put eligible merchants into
  ChatGPT, Copilot, AI Mode, and Gemini by default via Shopify Catalog;
  selection runs on attribute completeness and price or stock accuracy. ACP
  feed spec says review stats, FAQs, and popularity metrics can enhance
  ranking.
- Cross-cutting: only about 11 to 12% cited-domain overlap between engines,
  so measure per engine. Brand mentions are near-binary and stable; sentiment
  flips about 6.7x more often. Mention rate is the headline metric.

Proven non-levers: llms.txt (Ahrefs 137k domains: 97% of files got zero
requests; Google explicitly ignores it; no provider commits to it), schema as
an independent citation lever (hygiene only, still keep it as the
product-data substrate), keyword stuffing, prompt-injection tricks,
manufactured mentions.

## 2. Standing guardrails (apply to every new feature)

All of these were verified present and accurate in the repo on 2026-07-02.

- No em dashes or en dashes anywhere: code, comments, UI copy, docs,
  AI-generated output. Generated content keeps the three-layer enforcement:
  prompt instruction, sanitizer pipeline, unconditional regex strip on every
  output field (see stripEmDashes in blog-generation.server.ts). Scan before
  claiming done. Repo state (cleanup pass completed 2026-07-02): the ONLY
  legitimate dash characters left are functional code where the character
  itself is the subject: the strip regexes in blog-generation and
  faq-generation, the ndash entity-decode mapping in
  llms-generator.server.ts, and grep commands inside older plan docs that
  search for the character. Anything else a scan finds is a violation.
- Polaris only, never the Polaris Grid component (use native CSS grid). All
  plan links go to /app/pricing; there is no /app/billing.
- Plan gates are enforced server-side in loaders and actions, at public
  surfaces, and in background jobs. Never UI-only. Prices and limits
  interpolate from billing.shared.ts, never hardcoded.
- Loaders return explicit field picks from the Store row, never a `...store`
  spread: the row carries shopifyAccessToken, and a spread serializes it into
  the browser. (Added 2026-07-02 after the adversarial review caught exactly
  this leak in the dashboard loader; it is fixed, keep it fixed.)
- Admin GraphQL is pinned to 2025-07 everywhere, with ONE documented
  exception: the Intent Lab ShopifyQL search-analytics query
  (tracking.server.ts, SEARCH_ANALYTICS_API_VERSION = 2026-04) uses its own
  raw versioned fetch because shopifyqlQuery does not exist in 2025-07. Do
  not downgrade it. Before claiming any new mutation or query works, verify
  the input shape against shopify.dev admin-graphql docs for 2025-07 (the
  articleCreate author bug proved TypeScript cannot catch this).
- Scope changes require: shopify.app.toml edit, npx shopify app deploy
  --allow-updates, merchant re-auth, AND updating the SCOPES env var on
  Render to the identical string. read_themes was deliberately removed
  2026-06-12; do not re-add any theme scope without an explicit new decision
  from Lukas.
- Webhook handlers must 2xx within about 5 seconds; heavy work is detached
  after acknowledgment. Duplicate deliveries are normal; write idempotently.
- Schema changes go through Prisma migrations (DIRECT_URL for migrate, pooled
  DATABASE_URL at runtime); container start runs migrate deploy on Render
  (both the docker-start npm script and the Dockerfile CMD do).
- All Claude calls are claude-sonnet-4-6, and every model call (Claude,
  OpenAI, Perplexity) goes through the ai-retry layer. The deliberate
  non-Claude models are the simulator's optional ChatGPT run (gpt-4o-mini)
  and the tracking engine askers (gpt-4o-search-preview, Perplexity sonar),
  because querying those engines IS the feature. Never swap any model
  silently.
- Copy honesty: "mentioned in N AI answers", "last 30 days", disclose
  half-active features, show orphaned data honestly. Rule from the evidence:
  never claim llms.txt or schema drives citations (see section 4 for the
  audit of current copy against this rule).
- In-memory coordination (cron singleton, llms regen coalescer) assumes
  Render's single process. New background work must respect that. Note the
  regen mechanism is a latest-wins coalescer, not an accumulating queue; see
  the F5 correction before copying it for anything non-idempotent.
- Secrets never appear in code, docs, HANDOFF.md, or chat. Env vars by name
  only.

## 3. Feature candidates with implementation sketches

Ranked by evidence strength. Sequencing is Lukas's call; do not start any of
these without his go.

### F1. AI crawler access checker plus robots.txt snippet (Layer 0)

Repo status (2026-07-02): ~90% ALREADY BUILT and shipped in June. What
exists: checkCrawlerAccess in app/services/crawler-access.server.ts (fetches
the storefront robots.txt with a 5s timeout and a 512KiB bounded streaming
read, parses per RFC 9309, returns allowed/blocked/unknown per bot; a missing
robots.txt counts as allow-all, network errors as unknown), surfaced on the
llms.txt page with per-bot status badges, a saved-toggles vs live robots.txt
mismatch banner, and buildRobotsSnippet emitting a complete robots.txt.liquid
template (preserving Shopify's default groups) with a copy button and a
numbered 5-step merchant walkthrough. The bot list is a 16-bot superset of
the 11 this brief originally named: GPTBot, OAI-SearchBot, ChatGPT-User,
ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User,
Google-Extended, Bytespider, meta-externalagent, plus GoogleOther, Bingbot,
CCBot, Amazonbot, Applebot-Extended. The gating question this brief left open
is answered in code: the checker and snippet are free on every plan (the
acquisition hook, exempted server-side), while the per-bot crawler ACTIVITY
breakdown (AiCrawlerHit analytics, llms.txt fetches only) is Growth+ with
byBot stripped server-side on FREE.

Remaining scope if picked up: the training versus retrieval versus user-fetch
bot-type distinction in the UI. The status list is flat (botName plus badge,
no type field on CrawlerPattern), and that taxonomy is this brief's own Layer
0 teaching point. Small, well-bounded feature.

The original constraint stands: no theme write scope (read_themes was
removed 2026-06-12; write_themes was never held), so the snippet stays
copy-paste with merchant instructions, never an API write. Do not propose
adding theme scopes.

### F2. Raw-HTML visibility check (extend ai-simulator, Layer 0)

What: the simulator already fetches the live product page HTML, which is
exactly what AI crawlers receive. Add a JS-dependence analysis: check whether
the description, price, reviews or rating markup, and JSON-LD are present in
the RAW response; flag content that only exists client-side (common with page
builders and review widget apps). Score it and add a "what the AI bot
actually sees" framing.

Repo notes (2026-07-02, unbuilt but verified feasible):
- Hook point: the raw HTML exists at exactly one place in
  ai-simulator.server.ts (the fetch body and the fallback assignment) before
  cleanHtml strips it. Deterministic checks belong there, before the
  multi-platform fan-out; the fetch is shared across Claude and the optional
  OpenAI run, so the check is naturally platform-independent. The result
  could also surface as a new audit signal, per the original sketch.
- The usedFallback boolean computed at that point is exactly the signal the
  "mark as not-run in dev-store fallback mode" requirement needs. Today's
  fallback synthesizes an IDEAL product page including a perfect JSON-LD
  block and scores it with only a warning banner, which strengthens the case
  for explicit not-run marking.
- Fix two gaps while in there: the simulator fetch has no response size bound
  (res.text() is unbounded; copy the 512KiB streaming pattern from
  crawler-access.server.ts), and there is no bot-protection or thin-HTML
  detection (a 200-status JS shell currently proceeds as real HTML and
  silently scores near zero with no explanation), which is exactly the edge
  case this sketch calls out: surface an honest "your store may be blocking
  AI fetchers" warning instead of a false fail.
- Terminology: the "22 fields" is the extraction schema; the comparison UI
  renders up to 19 rows (18 for products with no real variants, where the
  variants row is dropped); currency, variantCount, and schemaTypes are
  extracted but never compared.

### F3. Citation source gap analysis, the listicle radar (Layer 2, highest strategic value)

What: tracking checks already receive engine responses with sources. Start
persisting the cited source URLs per check, classify each domain (listicle or
editorial, review platform, Reddit, YouTube, marketplace, brand-owned,
other), and aggregate per store: "these are the pages AI cites in your
category; you appear on N of M." Recommendations become concrete outreach
targets.

Schema: add a sourcesCited Json column to AiCitation (nullable,
backward-compatible) via a Prisma migration, mirroring how competitorsCited
and productsCited work (both confirmed as nullable Json on the model;
sourcesCited confirmed absent). Populate in tracking.server.ts where
citations are parsed.

Repo notes (2026-07-02):
- The work is wider than one column: all three engine parsers in
  tracking.server.ts reduce full source URLs to hostnames immediately, and
  the shared response type across the Claude/OpenAI/Perplexity askers carries
  only sourceDomains. Widen that type to carry URLs through, then persist at
  the citation-create site.
- Engine semantics differ and sourcesCited will inherit the inconsistency
  unless handled: Claude's citation list is strictly inline-cited sources (a
  deliberate earlier bugfix), while Perplexity's includes every
  search_results entry whether or not it was cited in the answer. Tighten the
  Perplexity parser or disclose the difference in the UI.
- Placement decision already on record (spec 2026-06-12): citations are
  tracking data. Both the tracking and competitors pages already render
  AiCitation-derived UI, so either is a natural surface.
- Detection of "you appear on this source" can start as a fetch of the source
  URL plus a case-insensitive shop-name and domain match; be honest about
  false negatives. Bound the outbound fetches (top sources only, cache per
  domain) and route AI classification calls through ai-retry. Growth-plus
  gating suggested, server-side.

### F4. Catalog and feed readiness audit (new audit dimension, Layer 4)

What: score attribute completeness now that Agentic Storefronts list every
eligible merchant by default: product category (Shopify standard taxonomy),
barcode or GTIN, weight, vendor, variant option completeness, material and
size style attributes (metafields), spec-density of the description (concrete
attributes versus adjectives), review or rating presence, and price plus
availability consistency. Auto-fix candidates: Claude extracts attributes
from existing copy into structured suggestions; writing metafields uses
metafieldsSet under write_products, but VERIFY the 2025-07 input shape on
shopify.dev before implementing, and confirm which fields productUpdate
versus productVariantsBulkUpdate own in 2025-07.

Repo corrections (2026-07-02):
- Partially covered already: the current rubric scores vendor presence,
  review presence (15 pts, read from metafields), variant option
  distinctness plus SKUs, and productType. Genuinely new: barcode/GTIN,
  weight, real taxonomy (Product.category is never queried anywhere; only
  productType is), metafield completeness, and spec-density.
- Cost estimate corrected: the audit page has NO category filter (score-range
  filter and text search only), so there is nothing to update there beyond
  the hardcoded auto-fix breakdown counts. The files that DO hardcode
  category lists are app/routes/app.action-plan.tsx (type union and labels)
  and app/services/action-plan.server.ts (per-category fix-time weights).
- An enum migration may not be needed at all: the rubric's point sections do
  not map 1:1 to AuditCategory (VARIANTS & DATA issues are tagged CONTENT or
  TECHNICAL), and both ACCESSIBILITY and SCHEMA are dormant never-emitted
  enum values, so new checks can ride existing categories or reuse SCHEMA.
  The original's other placement option also stands: a parallel readiness
  score beside the GEO score instead of new rubric checks.
- Metafield writes would be the app's first ever (all current metafield usage
  is read-only); write_products covers metafieldsSet on product-owned
  metafields, so no new scope. Issue titles must be static and stable: the
  action plan (action-plan.server.ts) buckets issues by exact
  category::title, and autoFixIssues accepts an exact-title filter and
  dispatches fix handlers by category (with title-substring branching inside
  fixMetaIssue).

Copy: frame as "AI shopping readiness", never as a guarantee of ChatGPT
placement.

### F5. Bing and IndexNow check (Layer 1)

What: ChatGPT visibility runs through Bing, so check Bing indexation and
offer IndexNow. Sketch: site: style checks are unreliable programmatically;
prefer guiding the merchant to verify in Bing Webmaster Tools with numbered
steps, plus an app-side IndexNow integration: host the key file through the
app proxy and submit URLs on products/create, update, and delete webhooks
(detached after the 200).

Repo corrections (2026-07-02):
- All three product webhooks (create, update, delete) are registered and
  already follow the detach-after-2xx pattern. Good.
- IMPORTANT: do NOT copy the llms regen mechanism (see the coalescer note in
  section 2) for the IndexNow submitter. It is a per-store latest-wins
  coalescer (at most one running plus one pending runner; a new trigger
  overwrites the pending slot), which is only correct because full llms.txt
  regeneration is idempotent. An IndexNow submitter that copies it verbatim
  silently drops URL submissions during bursts. It must accumulate a
  per-store URL set, or recompute the full submission set inside the runner.
- Proxy child paths are a proven pattern (proxy.llms-txt.visit.ts,
  doc-verified pass-through). But a key file served through the proxy lands
  at /a/llms-txt/{key}.txt, not the host root, so submissions must use the
  IndexNow spec's keyLocation form; and whether IndexNow verifiers follow a
  urlRedirectCreate redirect from the root is unverified. Both of those,
  plus IndexNow's rate limits, stay must-verify against indexnow.org
  documentation before building. Do not claim this works until verified.

### F6. FAQ generator with FAQPage JSON-LD (Layer 3)

What: Claude drafts product FAQs; store in app DB; expose to the storefront
via product metafields (write_products covers metafield writes on products;
verify 2025-07 shapes) and render FAQPage JSON-LD from the existing theme app
extension block, which already injects the other schemas. Answer-first
phrasing per the Princeton findings. Gating suggestion: Growth-plus; monthly
caps like blog generation, enforced before the AI call.

Repo notes (2026-07-02):
- The blog cap pattern to copy is TWO-layered: the route reserves a
  placeholder row in a Serializable transaction AND the service re-checks the
  cap before the Claude call. Copying only the service-layer check is racy
  under concurrent requests.
- FAQPage JSON-LD is a pure Liquid addition to the existing embed block; the
  metafield-read pattern is already established there (ratings, barcode). The
  metafield WRITE is new app code (no code writes metafields today) but needs
  no new scope; it does need a storefront-readable metafield definition.

### F7. Prompt tuning to the evidence (cheap, Layer 3)

What: update blog-generation and auto-fix prompts to push statistics with
sources, quotable named claims, entity-first openings, direct 40 to 60 word
answer paragraphs, and spec-dense descriptions. Keep the em-dash triple
enforcement intact. No schema or route changes. (Verified still unbuilt and
still cheap: the prompts live in blog-generation.server.ts and
audit-engine.server.ts.)

### Explicitly not building (without a new decision from Lukas)

More llms.txt surface area beyond hygiene, schema features marketed as
citation levers, theme write access, Web Pixel attribution (note: the AI
visit beacon shipped 2026-07-02 uses the theme extension plus app proxy, not
a Web Pixel, and does not change this line), a standalone Intent Lab route
(confirmed: Intent Lab still lives inside the tracking page), market
subfolder URLs, FX conversion, refund handling, automated test suite,
renaming the app.

## 4. Copy-honesty audit against the new rule (2026-07-02)

The rule "never claim llms.txt or schema drives citations" was audited
against all merchant-facing copy. Status: 3 hard causal claims exist in
production copy and await a copy pass (Lukas has not yet given the go; do the
pass before or with the next merchant-facing release):

- app/routes/app.llms-txt.tsx, empty-state banner (~line 677): "Generate
  yours so ChatGPT, Gemini, and Perplexity can discover and recommend your
  products."
- app/routes/app.llms-txt.tsx, Free-plan upgrade CalloutCard (~line 1296):
  sells the Growth upgrade on "get discovered by more AI search engines."
  Hardest one: the upsell needs a new value proposition (completeness,
  coverage), not softer verbs.
- docs/app-store-listing.md (~line 36, plus the softer sitemap line ~18):
  "a machine-readable file that tells ChatGPT, Gemini, Perplexity, and Claude
  exactly what you sell."

Four softer implied-consumption claims if full compliance is wanted: the
dashboard schema discovery card, the listing's JSON-LD paragraph, and the
llms.txt page's stale-file and unpublished-products banners. Already clean:
pricing page, billing.shared.ts, weekly insight email, theme extension,
README. The register to match exists in-app already: the llms.txt page's
robots.txt disclaimer ("These toggles only annotate your llms.txt file, and
AI crawlers treat that as a polite request. What crawlers actually obey is
your store's robots.txt.").

Open decisions for Lukas, flagged 2026-07-02, not yet answered:
- Does the rule also cover app-level taglines ("Get your products recommended
  by ChatGPT" and similar in the listing), which attribute causation to the
  app as a whole rather than to llms.txt or schema?
- Two surfaces claim "products with reviews/ratings are significantly more
  likely to be cited by AI" (simulator recommendation copy and the audit
  engine's "Fewer than 5 reviews" issue description). Reviews are a real
  OpenAI shopping ranking factor per Layer 4, but "significantly more
  likely" is an unsourced statistic; keep, soften, or source it?

## 5. Session workflow reminder

Every feature: brainstorm, design spec in docs/superpowers/specs/, plan in
docs/superpowers/plans/, per-task commits, multi-agent adversarial review
(findings verified by skeptics before fixing), then update the handoff
chain: HANDOFF.md points to the current checkpoint doc; update the live tip
and keep the pointer intact. Verification: npx tsc --noEmit clean, npm run
build clean, em-dash scan zero on changed files, manual smoke on
boda-brands. A feature is not done until its smoke test passes AND is
checked off (the checklist lives in Lukas's claude.ai project knowledge,
file 01; ask Lukas to check it off there). Anthropic API credits must be
topped up before any AI-feature session.

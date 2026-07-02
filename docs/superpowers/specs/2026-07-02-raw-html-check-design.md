# Raw-HTML visibility check (F2): design spec

Date: 2026-07-02. Evidence basis: docs/geo-evidence-2026-07.md F2 (Layer 0:
no major AI crawler executes JavaScript; crawlers read raw HTML only). The
repo notes in that section were verified earlier by fact-check agents: the
raw HTML exists at exactly one hook point in ai-simulator.server.ts (the
fetch body and the fallback assignment) before cleanHtml strips it and
before the multi-platform fan-out; usedFallback at that point is the
"mark as not-run" signal; the fetch has no response size bound; and a
200-status JS shell currently proceeds as real HTML and silently scores
near zero with no explanation. Approved by Lukas ("Build F2 next").

## What the merchant gets

A new "What the AI bot actually sees" section on the simulator results:
five deterministic checks of the RAW page HTML (no JavaScript executed),
answering the question the LLM extraction cannot answer reliably: is this
content present in the bytes an AI crawler receives, or does it only exist
after client-side JavaScript runs (page builders, review widget apps)?

Checks (each "present" | "missing" | "not_checked" when the input data
needed for the check is unavailable):
- json_ld: a <script type="application/ld+json"> block exists, and one of
  them contains a Product type.
- title: the product title appears in the raw HTML (whitespace-normalized,
  case-insensitive, common HTML entities decoded on both sides).
- price: the product price amount appears (match the decimal form with
  either "." or "," separator; also the integer form on a word boundary
  when the decimal part is zero). Unusual currency formats can produce a
  false "missing"; the UI copy discloses this.
- description: a normalized snippet (first 80 chars of the plain-text
  Shopify description, whitespace-collapsed, lowercased) appears in the
  raw HTML normalized the same way. Descriptions under 40 plain chars are
  not_checked.
- review_markup: only when the Shopify data carries a rating or review
  count (otherwise not_checked): the raw HTML contains aggregateRating (in
  any JSON-LD block) or the rating value string. Missing here is the
  classic "review widget renders client-side only" finding.

Two honesty rails, straight from the evidence brief:
- Fallback mode NEVER passes: when the simulator falls back to synthetic
  data (dev store, password page, fetch failure), the analysis reports
  ran=false with skipReason "fallback" and the UI says the check did not
  run, instead of scoring the synthetic ideal page.
- Thin-HTML detection: a 200 response whose raw body is under 10 KB or
  whose tag-stripped text is under 400 chars is treated as a suspected
  bot-protection or JavaScript-shell page: ran=false, skipReason
  "thin_html", and the UI shows a warning ("your store may be blocking
  automated fetchers or building the page entirely with JavaScript")
  instead of a false wall of "missing".

## Engineering changes (Agent A owns app/services/ai-simulator.server.ts)

1. BOUNDED FETCH FIX: replace the unbounded `await res.text()` with the
   streaming bounded-read pattern from crawler-access.server.ts (declared
   Content-Length fast-reject + reader loop + cap), cap 1 MiB (product
   pages run larger than robots.txt; JSON-LD sits in <head> and body copy
   well within 1 MiB; still bounded against a hostile origin). Record
   htmlBytes (chars read) and truncated (hit the cap) on the analysis.
2. NEW module-private analyzeRawHtml(rawHtml, productData) computing the
   five checks per the rules above; runs at the single hook point AFTER
   the fetch/fallback decision and BEFORE cleanHtml and the platform
   fan-out (it is platform-independent). Reuse the existing JSON-LD
   extraction regex for the json_ld and review_markup checks rather than
   writing a second one.
3. Thin-HTML gate before the checks (only for real fetches, never for
   fallback HTML): thresholds above, constants with comments.
4. EXACT exported contract (Agent B codes against this):
   export type RawCheckStatus = "present" | "missing" | "not_checked";
   export interface RawHtmlCheck { key: "json_ld" | "title" | "price" |
     "description" | "review_markup"; status: RawCheckStatus; }
   export interface RawHtmlAnalysis {
     ran: boolean;
     skipReason: "fallback" | "thin_html" | null;
     checks: RawHtmlCheck[];   // empty when ran=false
     htmlBytes: number;        // 0 when ran=false and no body was read
     truncated: boolean;
   }
   The simulator result object the route already consumes gains a
   top-level `rawAnalysis: RawHtmlAnalysis` field (platform-independent,
   sits beside the per-platform results, plain JSON, no Dates).
5. NO change to the visibility score math, the LLM prompts, the 22-field
   extraction, the comparison rows (including the hardcoded
   structuredDataFound row: leave it; the new section supersedes it
   visually without moving scores), the fallback builder, or the
   SimulationUsage metering.

## UI (Agent B owns app/routes/app.simulator.tsx)

New Card "What the AI bot actually sees" rendered with the results, above
or beside the existing field comparison (match the page's existing card
anatomy). Contents:
- Intro line: "AI crawlers read your page's raw HTML without running
  JavaScript. Content that only appears after JavaScript runs is invisible
  to them."
- When rawAnalysis.ran: one row per check, label + Badge (standard tones:
  success "In the raw HTML", critical "Missing from raw HTML", default
  "Not checked"). Labels: "Structured data (JSON-LD)", "Product title",
  "Price", "Description", "Review markup". Subdued footnote: "Price and
  description matching is text-based and can miss unusual formats." Plus,
  when truncated, a subdued "Checked the first 1 MB of the page."
- When skipReason === "thin_html": a warning Banner: "This page returned
  almost no HTML. Your store may be blocking automated fetchers, or the
  page may be built entirely with JavaScript. AI crawlers would see the
  same near-empty page." No check rows.
- When skipReason === "fallback": a subdued line: "Not checked: this
  simulation used Shopify data directly because the live page could not be
  fetched, so there is no raw HTML to analyze." No check rows.
- review_markup "missing" gets one extra subdued hint: "Your reviews
  appear to render with JavaScript only, so AI crawlers cannot see them.
  A review app that outputs aggregateRating markup fixes this." (Honest:
  appears to.)
No em or en dashes, no recolored Polaris, no Grid, no score changes.

## Out of scope

Emitting the result as an audit signal (spec option deferred), changing
the visibility score, per-platform raw analysis, screenshot/rendering
comparison, retrying blocked fetches with different UAs.

## Verification

tsc, build, dash scan (no schema change, no deploy). Focused adversarial
review: check-correctness (false-positive/false-negative traps in the
matching rules, entity decoding, thin-HTML thresholds), honesty of the
three states, bounded-read correctness, no score drift (visibilityScore
byte-identical for the same inputs), contract match between service and
route. Fix confirmed findings, two per-task commits (service, UI), push,
health check. Smoke on boda-brands: run a simulation, see the raw-HTML
card; if the store password is on, expect the fallback not-run state.

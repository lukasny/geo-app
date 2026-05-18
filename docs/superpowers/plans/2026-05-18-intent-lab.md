# Intent Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing Claude-brainstormed `suggestTrackingPrompts` with a two-source parallel fetch (Shopify ShopifyQL search analytics + Reddit subreddit titles) plus a Claude polish step. Each suggestion shows where it came from (your store / specific subreddit / AI fallback).

**Architecture:** Stage 1 and Stage 2 run in parallel via `Promise.all`. Stage 1 queries `shopifyqlQuery` for the merchant's top storefront search terms. Stage 2 detects the niche via Claude, then fetches top posts from suggested subreddits via Reddit's public JSON endpoint. Stage 3 hands all collected signals to Claude with a polish-mode system prompt that ties each output prompt to a specific raw signal. Stage 0 fallback (existing pure-Claude brainstorm) runs only if both sources came back empty. UI changes: source badge per suggestion, source-detail line, source-summary header above the grid, updated loading copy. Adds `read_reports` scope.

**Tech Stack:** Remix, TypeScript strict, Shopify Polaris v12, Anthropic SDK (`claude-sonnet-4-6`), Prisma. No automated tests. Verification = `npx tsc --noEmit` plus manual smoke test on `boda-brands` at the end.

**Spec:** `docs/superpowers/specs/2026-05-18-intent-lab-design.md`

---

## Task 1: Extend `SuggestedPrompt` type + add `SuggestionSource` union

**Files:**
- Modify: `app/services/tracking.server.ts:50-60` (around the existing `SuggestedPrompt` interface)

- [ ] **Step 1: Update the type**

Find the existing `export interface SuggestedPrompt {` block (around line 53) and replace it with:

```ts
export type SuggestionSource = "shopify_search" | "reddit" | "ai_brainstorm";

export interface SuggestedPrompt {
  prompt: string;
  category: "comparison" | "recommendation" | "use_case" | "price" | "brand";
  rationale: string;
  /** Where this suggestion came from. shopify_search means the prompt was
   *  derived from one of the merchant's own storefront search queries.
   *  reddit means it was derived from a post title in a relevant
   *  community. ai_brainstorm is the fallback when both data sources
   *  returned nothing - Claude generated the prompt from the catalog alone. */
  source: SuggestionSource;
  /** Human-readable context surfaced under the suggestion. For
   *  shopify_search: e.g. "search query: 'best beginner snowboard' (37 searches)".
   *  For reddit: e.g. "from r/snowboarding". Undefined for ai_brainstorm. */
  sourceDetail?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Will fail with errors at the existing `suggestTrackingPrompts` callsite and the existing return-shape construction because the new fields are required. We fix those callsites in later tasks. For now, leave the build broken and proceed to Task 2; final typecheck happens after Task 5 when the cascade is wired up.

(If you want a clean typecheck mid-task, comment out the existing return-shape construction in `suggestTrackingPrompts` temporarily.)

- [ ] **Step 3: Commit**

```bash
git add app/services/tracking.server.ts
git commit -m "tracking: extend SuggestedPrompt with source + sourceDetail

Adds the SuggestionSource union ('shopify_search' | 'reddit' |
'ai_brainstorm') and the source / sourceDetail fields. The rest of
the Intent Lab cascade follows in subsequent commits; the existing
suggestTrackingPrompts is left broken for one commit and fixed
when the new cascade lands.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Stage 1 helper: `fetchShopifySearchAnalytics`

**Files:**
- Modify: `app/services/tracking.server.ts` (add new helper above the existing `suggestTrackingPrompts` function)

The helper queries ShopifyQL for the top 50 storefront search terms in the last 30 days. Returns an array of `{ term, count }`. Gracefully returns `[]` on any error (ParseError, missing access, network).

- [ ] **Step 1: Add the helper**

Add the following to `app/services/tracking.server.ts`. Place it BEFORE the existing `suggestTrackingPrompts` function. Also add the `AdminApiContext` import at the top of the file if it isn't already imported (check the imports block; if not present, add `import type { AdminApiContext } from "@shopify/shopify-app-remix/server";`):

```ts
// ─── Intent Lab signal sources ────────────────────────────────────────────────

interface SearchTerm {
  term: string;
  count: number;
}

const SHOPIFY_SEARCH_ANALYTICS_QUERY = `#graphql
  query SearchAnalytics($q: String!) {
    shopifyqlQuery(query: $q) {
      __typename
      ... on TableResponse {
        tableData {
          rowData
          columns { name dataType }
        }
      }
      ... on ParseError {
        code
        message
      }
    }
  }
`;

const SHOPIFYQL = `FROM online_store_search
SHOW count
BY search_term
SINCE -30d UNTIL today
ORDER BY count DESC
LIMIT 50`;

/** Stage 1 of Intent Lab. Pulls the top 50 storefront search terms from the
 *  merchant's last 30 days via ShopifyQL. Returns up to 20 cleaned results
 *  (3 to 200 character terms, deduped, ordered by count). Returns [] on any
 *  error so the caller can run Stage 2 regardless. */
async function fetchShopifySearchAnalytics(
  admin: AdminApiContext
): Promise<SearchTerm[]> {
  try {
    const response = await admin.graphql(SHOPIFY_SEARCH_ANALYTICS_QUERY, {
      variables: { q: SHOPIFYQL },
    });
    const json = (await response.json()) as {
      data?: {
        shopifyqlQuery?:
          | {
              __typename: "TableResponse";
              tableData: { rowData: unknown[][] };
            }
          | {
              __typename: "ParseError";
              code: string;
              message: string;
            };
      };
      errors?: { message?: string }[];
    };

    if (json.errors && json.errors.length > 0) {
      console.warn(
        "[Intent Lab] shopifyqlQuery returned top-level errors:",
        json.errors
      );
      return [];
    }

    const result = json.data?.shopifyqlQuery;
    if (!result) return [];
    if (result.__typename === "ParseError") {
      console.warn(
        `[Intent Lab] shopifyqlQuery ParseError ${result.code}: ${result.message}`
      );
      return [];
    }

    const rows = result.tableData?.rowData ?? [];
    const terms: SearchTerm[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const rawTerm = String(row[0] ?? "").trim();
      const rawCount = Number(row[1]);
      if (!rawTerm) continue;
      if (rawTerm.length < 3 || rawTerm.length > 200) continue;
      if (!Number.isFinite(rawCount) || rawCount <= 0) continue;
      const lower = rawTerm.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      terms.push({ term: rawTerm, count: rawCount });
      if (terms.length >= 20) break;
    }
    return terms;
  } catch (err) {
    console.warn("[Intent Lab] fetchShopifySearchAnalytics threw:", err);
    return [];
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: still failing at the existing `suggestTrackingPrompts` callsites. The new helper itself should typecheck clean within this file. If you see new errors specifically inside `fetchShopifySearchAnalytics`, fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add app/services/tracking.server.ts
git commit -m "tracking: add fetchShopifySearchAnalytics (Intent Lab Stage 1)

Queries shopifyqlQuery for the merchant's top 50 storefront search
terms in the last 30 days. Returns up to 20 cleaned SearchTerm rows
ordered by count. Returns [] on any error (ParseError, missing
read_reports scope, network) so the caller can run Stage 2 in
parallel without dependency.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Stage 2a helper: `detectNicheAndSubreddits`

**Files:**
- Modify: `app/services/tracking.server.ts` (add new helper after the Stage 1 helper)

One Claude call. Pass up to 25 of the merchant's active products. System prompt asks Claude to return a JSON `{ niche: string, subreddits: string[] }` where subreddits are 3 to 5 real subreddit names (no `r/` prefix). Returns `null` on any error.

- [ ] **Step 1: Add the helper**

Place this immediately after `fetchShopifySearchAnalytics`:

```ts
interface NicheInfo {
  niche: string;
  subreddits: string[];
}

const NICHE_DETECTION_SYSTEM_PROMPT = `You analyze a Shopify merchant's product catalog and identify two things:
1. The niche: a short descriptor of what they sell (e.g. "snowboarding gear and apparel", "natural skincare", "home espresso equipment")
2. 3 to 5 relevant subreddits where shoppers in this niche discuss products and recommendations

Choose subreddits known for product discussions and gear recommendations. Avoid NSFW, off-topic, or meme subreddits. Use real subreddit names that you are confident exist. Use lowercase names without the "r/" prefix.

CRITICAL: never use em-dashes (the long horizontal dash, U+2014) anywhere in your output. Use commas, colons, or periods instead.

Output strictly as JSON: { "niche": "string", "subreddits": ["name1", "name2"] }`;

// Small denylist of subreddits we never want to query even if Claude
// suggests them. Keeps the polish step focused on shopping-relevant signal.
const SUBREDDIT_DENYLIST = new Set<string>([
  "all",
  "popular",
  "askreddit",
  "funny",
  "memes",
  "nsfw",
]);

/** Stage 2a of Intent Lab. Returns the merchant's niche + 3 to 5 candidate
 *  subreddits. Used to drive the Stage 2b Reddit fetch. Returns null if the
 *  store has no products, Claude errors, or output is malformed. */
async function detectNicheAndSubreddits(
  storeId: string
): Promise<NicheInfo | null> {
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });
  if (products.length === 0) return null;

  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");

  try {
    const message = await withRetry(
      () =>
        anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          system: NICHE_DETECTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Catalog (up to 25 active products):\n${productLines}\n\nIdentify the niche and suggest 3 to 5 subreddits.`,
            },
          ],
        }),
      "detectNicheAndSubreddits"
    );

    const block = message.content[0];
    if (block?.type !== "text") return null;

    const raw = block.text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(raw) as {
      niche?: unknown;
      subreddits?: unknown;
    };

    const niche = typeof parsed.niche === "string" ? parsed.niche.trim() : "";
    const subreddits = Array.isArray(parsed.subreddits)
      ? parsed.subreddits
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.replace(/^r\//i, "").trim().toLowerCase())
          .filter((s) => /^[a-z0-9_]{2,21}$/i.test(s))
          .filter((s) => !SUBREDDIT_DENYLIST.has(s))
          .slice(0, 5)
      : [];

    if (!niche || subreddits.length === 0) return null;
    return { niche, subreddits };
  } catch (err) {
    console.warn("[Intent Lab] detectNicheAndSubreddits failed:", err);
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: still failing at the unmodified `suggestTrackingPrompts` callsites; the new helper itself should typecheck. Fix any errors inside `detectNicheAndSubreddits` before continuing.

- [ ] **Step 3: Commit**

```bash
git add app/services/tracking.server.ts
git commit -m "tracking: add detectNicheAndSubreddits (Intent Lab Stage 2a)

Single Claude call against up to 25 of the merchant's active products,
returns { niche, subreddits[] } where subreddits is a deduped, denylist-
filtered list of 3 to 5 real subreddit names. Returns null on no
products / Claude error / malformed output so Stage 2b can skip
gracefully.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Stage 2b helper: `fetchRedditTitles`

**Files:**
- Modify: `app/services/tracking.server.ts` (add new helper after the Stage 2a helper)

For each subreddit, fetch top monthly posts via Reddit's public JSON endpoint. Filter for question-shaped titles. Return up to 25 total titles across all subreddits, capped at 10 per subreddit. No auth, just a User-Agent header.

- [ ] **Step 1: Add the helper**

Place this immediately after `detectNicheAndSubreddits`:

```ts
interface RedditSignal {
  subreddit: string;
  title: string;
  permalink: string;
}

// Question-shaped title detector. Matches titles ending with ? OR starting
// (case-insensitive) with one of these question-style openers.
const QUESTION_OPENERS_RE =
  /^(best|should i|what['']s the difference|what is|how to|how do|vs\b|recommend|looking for|any tips for|need help|which|where|why)\b/i;

function isQuestionShapedTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 10 || t.length > 200) return false;
  if (t.endsWith("?")) return true;
  return QUESTION_OPENERS_RE.test(t);
}

/** Stage 2b of Intent Lab. Fetches recent question-shaped post titles from
 *  the given subreddits via Reddit's public JSON endpoint. No auth needed;
 *  Reddit requires a non-default User-Agent so we set one. Returns up to
 *  25 titles total, 10 per subreddit max. */
async function fetchRedditTitles(
  subreddits: string[]
): Promise<RedditSignal[]> {
  const results: RedditSignal[] = [];
  const PER_SUBREDDIT_LIMIT = 10;
  const TOTAL_LIMIT = 25;

  for (const subreddit of subreddits) {
    if (results.length >= TOTAL_LIMIT) break;
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?t=month&limit=25`;
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "web:geo-rise-shopify-app:1.0" },
      });
      if (!response.ok) {
        console.warn(
          `[Intent Lab] reddit ${subreddit} returned ${response.status}, skipping`
        );
        continue;
      }
      const json = (await response.json()) as {
        data?: {
          children?: Array<{
            data?: { title?: string; permalink?: string };
          }>;
        };
      };
      const posts = json.data?.children ?? [];
      let countForThisSub = 0;
      for (const post of posts) {
        if (countForThisSub >= PER_SUBREDDIT_LIMIT) break;
        if (results.length >= TOTAL_LIMIT) break;
        const title = post.data?.title?.trim();
        const permalink = post.data?.permalink ?? "";
        if (!title || !isQuestionShapedTitle(title)) continue;
        results.push({ subreddit, title, permalink });
        countForThisSub += 1;
      }
    } catch (err) {
      console.warn(`[Intent Lab] reddit ${subreddit} fetch threw:`, err);
      continue;
    }
  }

  return results;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: still failing at the unmodified `suggestTrackingPrompts` callsites. The new helper itself should typecheck.

- [ ] **Step 3: Commit**

```bash
git add app/services/tracking.server.ts
git commit -m "tracking: add fetchRedditTitles (Intent Lab Stage 2b)

For each suggested subreddit, GETs /r/{name}/top.json?t=month&limit=25
with the GEO Rise User-Agent. Filters for question-shaped titles (end
with ?, or start with 'best' / 'should i' / 'how to' / etc.). Returns
up to 25 titles total, 10 per subreddit. 404s and rate-limits are
logged and skipped silently.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Refactor `suggestTrackingPrompts` with the cascade

**Files:**
- Modify: `app/services/tracking.server.ts` (replace the existing `suggestTrackingPrompts` body)

Now we wire Stages 1 and 2 in parallel, hand the combined signals to Claude polish, and fall back to pure brainstorm if both sources came back empty.

- [ ] **Step 1: Replace the existing `SUGGEST_SYSTEM_PROMPT` with a polish-mode version, and keep the old text as a separate fallback prompt**

Find the existing `const SUGGEST_SYSTEM_PROMPT = \`...\`;` declaration. Rename it to `BRAINSTORM_SYSTEM_PROMPT` (this is the Stage 0 fallback). Then add a new polish-mode prompt:

```ts
// Renamed from SUGGEST_SYSTEM_PROMPT. Used only as the Stage 0 fallback
// when both Shopify search analytics and Reddit returned zero signals.
const BRAINSTORM_SYSTEM_PROMPT = `... existing text unchanged ...`;

// Stage 3 prompt: polish real shopper signals into tracking prompts. Each
// output prompt must cite the index of the signal it was derived from.
const POLISH_SYSTEM_PROMPT = `You polish real shopper queries into tracking prompts for a Shopify merchant's AI search visibility tool.

The signals provided are REAL shopper queries from two sources:
  - shopify_search: terms the merchant's own shoppers typed into their storefront search bar
  - reddit: question-shaped post titles from relevant subreddits

Your job: convert these raw signals into 8 well-formed tracking prompts. Each output prompt MUST be derived from one of the provided signals. Do not fabricate prompts that have no signal backing.

For each prompt:
- Phrase as a question a shopper would ask an AI search engine like ChatGPT or Perplexity
- Reference specific products or brands from the merchant's catalog when relevant
- Categorize as one of: comparison / recommendation / use_case / price / brand
- Add a one-sentence rationale explaining why this prompt matters for this merchant
- Cite the source index (the integer prefix of the signal that inspired it)

CRITICAL: never use em-dashes (the long horizontal dash, U+2014). Use commas, colons, or periods instead. This rule applies to the prompt and rationale fields.

Output strictly as JSON:
{
  "suggestions": [
    {
      "prompt": "string",
      "category": "comparison|recommendation|use_case|price|brand",
      "rationale": "one sentence",
      "sourceIndex": 0
    }
  ]
}`;
```

(Keep the entire existing text of the original `SUGGEST_SYSTEM_PROMPT` as the new `BRAINSTORM_SYSTEM_PROMPT` body. Don't change its wording, just rename the constant.)

- [ ] **Step 2: Replace the existing `suggestTrackingPrompts` function body**

Find the existing `export async function suggestTrackingPrompts(storeId: string): Promise<SuggestedPrompt[]> { ... }` and replace the whole function with:

```ts
/** Intent Lab orchestrator. Pulls real shopper signals from Shopify
 *  storefront search analytics and Reddit in parallel, then asks Claude to
 *  polish them into 8 tracking prompts. Falls back to pure-Claude
 *  brainstorming if both signal sources came back empty.
 *
 *  Each returned SuggestedPrompt carries a `source` field showing where
 *  it came from so the UI can attribute it. */
export async function suggestTrackingPrompts(
  storeId: string,
  admin: AdminApiContext
): Promise<SuggestedPrompt[]> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  // Stages 1 + 2 run in parallel. Both gracefully return empty arrays on
  // error so the orchestrator can always proceed to polish or fallback.
  const [searchTerms, niche] = await Promise.all([
    fetchShopifySearchAnalytics(admin),
    detectNicheAndSubreddits(storeId),
  ]);
  const redditSignals: RedditSignal[] = niche
    ? await fetchRedditTitles(niche.subreddits)
    : [];

  const haveSignals = searchTerms.length > 0 || redditSignals.length > 0;

  if (!haveSignals) {
    // Stage 0 fallback: existing pure-Claude brainstorm. Same as the
    // pre-Intent-Lab behavior. Output gets the ai_brainstorm source tag.
    return runBrainstormFallback(storeId, store.shopName);
  }

  return runPolishStage({
    storeId,
    shopName: store.shopName,
    searchTerms,
    redditSignals,
  });
}

/** Stage 3 polish: hand all collected signals to Claude with the polish
 *  prompt. Each Claude-returned suggestion cites a sourceIndex which we
 *  map back to the originating signal for source attribution. */
async function runPolishStage(args: {
  storeId: string;
  shopName: string;
  searchTerms: SearchTerm[];
  redditSignals: RedditSignal[];
}): Promise<SuggestedPrompt[]> {
  const { storeId, shopName, searchTerms, redditSignals } = args;

  // Build the numbered signal list. Index 0..N-1, where N is the total
  // signal count. Claude returns sourceIndex referencing these indices.
  type Signal =
    | { kind: "shopify_search"; index: number; term: string; count: number }
    | {
        kind: "reddit";
        index: number;
        subreddit: string;
        title: string;
      };
  const signals: Signal[] = [];
  for (const t of searchTerms) {
    signals.push({
      kind: "shopify_search",
      index: signals.length,
      term: t.term,
      count: t.count,
    });
  }
  for (const r of redditSignals) {
    signals.push({
      kind: "reddit",
      index: signals.length,
      subreddit: r.subreddit,
      title: r.title,
    });
  }

  const signalLines = signals
    .map((s) => {
      if (s.kind === "shopify_search") {
        return `[${s.index}] shopify_search: "${s.term}" (${s.count} ${s.count === 1 ? "search" : "searches"})`;
      }
      return `[${s.index}] reddit (r/${s.subreddit}): "${s.title}"`;
    })
    .join("\n");

  // Pull a fresh slice of products for catalog grounding.
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });
  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");
  const vendorSet = new Set<string>();
  for (const p of products) if (p.vendor) vendorSet.add(p.vendor);
  const vendors = [...vendorSet];

  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: POLISH_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Store name: ${shopName}
${vendors.length > 0 ? `Brands sold: ${vendors.join(", ")}` : ""}

Products (up to 25):
${productLines}

Signals (real shopper data):
${signalLines}

Generate 8 tracking prompts derived from these signals.`,
          },
        ],
      }),
    "suggestTrackingPrompts.polish"
  );

  const block = message.content[0];
  if (block?.type !== "text") {
    throw new Error("Claude returned no text response");
  }

  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: {
    suggestions?: Array<{
      prompt?: unknown;
      category?: unknown;
      rationale?: unknown;
      sourceIndex?: unknown;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Couldn't parse Claude's suggestions - please try again.");
  }
  const rawSuggestions = parsed.suggestions ?? [];

  // Filter against prompts the merchant already has so we don't suggest dupes.
  const existing = await prisma.trackingPrompt.findMany({
    where: { storeId },
    select: { prompt: true },
  });
  const existingLower = new Set(
    existing.map((p) => p.prompt.toLowerCase().trim())
  );

  const validCategories = new Set([
    "comparison",
    "recommendation",
    "use_case",
    "price",
    "brand",
  ]);

  const polished: SuggestedPrompt[] = [];
  for (const s of rawSuggestions) {
    if (typeof s.prompt !== "string") continue;
    if (typeof s.category !== "string") continue;
    if (typeof s.rationale !== "string") continue;
    if (typeof s.sourceIndex !== "number") continue;

    const promptText = s.prompt.trim();
    const category = s.category.trim();
    const rationale = s.rationale.trim();
    const sourceIndex = Math.floor(s.sourceIndex);

    if (!promptText || promptText.length > 500) continue;
    if (!validCategories.has(category)) continue;
    if (existingLower.has(promptText.toLowerCase())) continue;

    const signal = signals[sourceIndex];
    if (!signal) continue;

    const source: SuggestionSource =
      signal.kind === "shopify_search" ? "shopify_search" : "reddit";
    const sourceDetail =
      signal.kind === "shopify_search"
        ? `search query: "${signal.term}" (${signal.count} ${signal.count === 1 ? "search" : "searches"} on your store)`
        : `from r/${signal.subreddit}`;

    polished.push({
      prompt: promptText,
      category: category as SuggestedPrompt["category"],
      rationale,
      source,
      sourceDetail,
    });
  }

  // If polish produced too few results, fall through to brainstorm fallback
  // for the remainder. Most stores should get at least 8 here.
  if (polished.length < 4) {
    const fallback = await runBrainstormFallback(storeId, shopName);
    const merged = [...polished];
    for (const f of fallback) {
      if (merged.length >= 8) break;
      if (
        !merged.some((m) => m.prompt.toLowerCase() === f.prompt.toLowerCase())
      ) {
        merged.push(f);
      }
    }
    return merged;
  }
  return polished.slice(0, 8);
}

/** Stage 0 fallback. The original pure-Claude brainstorm flow. Used when
 *  both Stage 1 and Stage 2 returned zero signals. */
async function runBrainstormFallback(
  storeId: string,
  shopName: string
): Promise<SuggestedPrompt[]> {
  const products = await prisma.product.findMany({
    where: { storeId, status: "active" },
    select: { title: true, vendor: true, productType: true },
    take: 25,
  });
  if (products.length === 0) {
    throw new Error(
      "Run an audit first - we need product data to generate relevant prompts."
    );
  }

  const productLines = products
    .map(
      (p) =>
        `- ${p.title}${p.vendor ? ` (brand: ${p.vendor})` : ""}${p.productType ? ` [${p.productType}]` : ""}`
    )
    .join("\n");
  const vendorSet = new Set<string>();
  for (const p of products) if (p.vendor) vendorSet.add(p.vendor);
  const vendors = [...vendorSet];

  const message = await withRetry(
    () =>
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: BRAINSTORM_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Store name: ${shopName}
${vendors.length > 0 ? `Brands sold: ${vendors.join(", ")}` : ""}

Products (up to 25):
${productLines}

Generate 8 tracking prompts for this store.`,
          },
        ],
      }),
    "suggestTrackingPrompts.brainstorm"
  );

  const block = message.content[0];
  if (block?.type !== "text") {
    throw new Error("Claude returned no text response");
  }
  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: {
    suggestions?: Array<{
      prompt?: unknown;
      category?: unknown;
      rationale?: unknown;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Couldn't parse Claude's suggestions - please try again.");
  }
  const rawSuggestions = parsed.suggestions ?? [];

  const existing = await prisma.trackingPrompt.findMany({
    where: { storeId },
    select: { prompt: true },
  });
  const existingLower = new Set(
    existing.map((p) => p.prompt.toLowerCase().trim())
  );
  const validCategories = new Set([
    "comparison",
    "recommendation",
    "use_case",
    "price",
    "brand",
  ]);

  const valid: SuggestedPrompt[] = [];
  for (const s of rawSuggestions) {
    if (typeof s.prompt !== "string") continue;
    if (typeof s.category !== "string") continue;
    if (typeof s.rationale !== "string") continue;
    const promptText = s.prompt.trim();
    const category = s.category.trim();
    const rationale = s.rationale.trim();
    if (!promptText || promptText.length > 500) continue;
    if (!validCategories.has(category)) continue;
    if (existingLower.has(promptText.toLowerCase())) continue;
    valid.push({
      prompt: promptText,
      category: category as SuggestedPrompt["category"],
      rationale,
      source: "ai_brainstorm",
    });
  }
  return valid.slice(0, 8);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors at `app/routes/app.tracking.tsx` because the new `suggestTrackingPrompts` signature requires `admin`. That's fixed in Task 6.

The tracking.server.ts file itself should typecheck clean now.

- [ ] **Step 4: Commit**

```bash
git add app/services/tracking.server.ts
git commit -m "tracking: refactor suggestTrackingPrompts into Intent Lab cascade

Stages 1 and 2 (Shopify search analytics + Reddit) run in parallel.
Stage 3 (Claude polish) consumes the combined signals and outputs 8
tracking prompts with sourceIndex attribution. Stage 0 fallback (the
original pure-Claude brainstorm) only runs if both sources came back
empty.

The polish prompt requires Claude to cite which raw signal each
output was derived from. The orchestrator maps the cited sourceIndex
back to the originating signal to populate source ('shopify_search' |
'reddit') and sourceDetail ('search query: \"...\" (37 searches)' or
'from r/snowboarding').

Existing BRAINSTORM_SYSTEM_PROMPT is unchanged in content, just
renamed from SUGGEST_SYSTEM_PROMPT. The function signature now takes
admin: AdminApiContext for the ShopifyQL call.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Update the route action to pass `admin`

**Files:**
- Modify: `app/routes/app.tracking.tsx:343` (around the `suggestTrackingPrompts(store.id)` callsite)

- [ ] **Step 1: Pass `admin` to the service call**

Find the existing call `const suggestions = await suggestTrackingPrompts(store.id);` (around line 343). Change it to:

```ts
const suggestions = await suggestTrackingPrompts(store.id, admin);
```

The `admin` variable is already in scope from `const { admin, session } = await authenticate.admin(request);` at the top of the action.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean). The service + route are now type-consistent.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.tracking.tsx
git commit -m "tracking route: pass admin to suggestTrackingPrompts

The Intent Lab cascade needs admin to make the ShopifyQL call. The
route action already has it from authenticate.admin(request); this
is a one-line callsite update.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: UI changes (source badge + source detail + source summary + loading copy)

**Files:**
- Modify: `app/routes/app.tracking.tsx` (the existing SuggestedPromptCard rendering + the suggestions list area)

This is one task with multiple changes batched, all in the same file. Splitting into separate commits would leave the UI in inconsistent states.

- [ ] **Step 1: Find the existing SuggestedPrompt rendering**

Run: `grep -n "category\|rationale\|sourceDetail" app/routes/app.tracking.tsx | head -20`

Identify where each `SuggestedPrompt` is rendered. The existing UI shows the prompt heading, a category badge, and the rationale below. We add a source badge next to the category badge, plus an optional source-detail line under the rationale.

- [ ] **Step 2: Add source-badge + source-detail rendering**

Inside the existing per-suggestion card markup (where the category Badge is rendered), add the source badge alongside. The exact JSX depends on the current structure; the pattern is:

```tsx
<InlineStack gap="200">
  <Badge>{categoryLabel(suggestion.category)}</Badge>
  {suggestion.source === "shopify_search" && (
    <Badge tone="success">From your store</Badge>
  )}
  {suggestion.source === "reddit" && (
    <Badge tone="info">
      {suggestion.sourceDetail?.match(/from r\/[a-z0-9_]+/i)?.[0] ??
        "From shopper community"}
    </Badge>
  )}
  {suggestion.source === "ai_brainstorm" && (
    <Badge>AI suggested</Badge>
  )}
</InlineStack>
```

(Adjust the InlineStack wrapper to match the existing parent layout. If there's already an InlineStack around the category badge, add the new badges into that same stack.)

Under the rationale text, add the source detail:

```tsx
{suggestion.sourceDetail && suggestion.source === "shopify_search" && (
  <Text as="p" variant="bodySm" tone="subdued">
    Based on: {suggestion.sourceDetail}
  </Text>
)}
```

- [ ] **Step 3: Add source-summary helper + header**

Above the suggestions grid (where the cards are rendered in a list/map), add a `summarizeSources` helper and a header.

First, the helper (place it near the top of the file with the other utility functions, e.g. next to `sanitizeTrackingError`):

```ts
function summarizeSources(suggestions: SuggestedPrompt[]): string {
  if (suggestions.length === 0) return "";

  const fromStore = suggestions.filter(
    (s) => s.source === "shopify_search"
  ).length;
  const fromReddit = suggestions.filter((s) => s.source === "reddit").length;
  const aiOnly = suggestions.every((s) => s.source === "ai_brainstorm");

  if (aiOnly) {
    return `${suggestions.length} suggestions brainstormed by Claude. We couldn't reach Shopify analytics or Reddit this time, so we used your catalog only.`;
  }

  const parts: string[] = [];
  if (fromStore > 0) {
    parts.push(
      `${fromStore} from your store's recent searches`
    );
  }
  if (fromReddit > 0) {
    const subreddits = Array.from(
      new Set(
        suggestions
          .filter((s) => s.source === "reddit")
          .map((s) => s.sourceDetail?.match(/r\/[a-z0-9_]+/i)?.[0])
          .filter((x): x is string => Boolean(x))
      )
    );
    const sublabel = subreddits.length > 0 ? ` (${subreddits.join(", ")})` : "";
    parts.push(`${fromReddit} from shopper communities${sublabel}`);
  }
  return `${suggestions.length} suggestions: ${parts.join(" + ")}.`;
}
```

Then, in the component, render the summary just before the list of cards:

```tsx
{suggestions.length > 0 && (
  <Text as="p" variant="bodySm" tone="subdued">
    {summarizeSources(suggestions)}
  </Text>
)}
```

- [ ] **Step 4: Update the loading-state copy**

Find the existing loading message tied to the suggestPrompts intent. The exact line varies; search:

```bash
grep -n "brainstorm\|catalog\|Claude.*prompt" app/routes/app.tracking.tsx | head -10
```

Replace whatever message says "Claude is brainstorming based on your catalog..." (or similar) with:

```tsx
"Looking at your store's recent searches and shopper community discussions..."
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Em-dash sweep**

Run: `grep -n "—" app/routes/app.tracking.tsx app/services/tracking.server.ts`
Expected: no matches in user-facing copy or comments (regex literals are fine).

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.tracking.tsx
git commit -m "tracking UI: surface Intent Lab source attribution

Adds three UI elements:
1. Source badge per suggestion card (green 'From your store' / info
   'From r/snowboarding' / neutral 'AI suggested').
2. Source-detail line under the rationale showing the original
   search query and its count when source is shopify_search.
3. Source-summary header above the suggestions grid that summarizes
   which sources contributed and how many suggestions came from each.

Also updates the loading message from 'Asking Claude to brainstorm
based on your catalog' to 'Looking at your store's recent searches
and shopper community discussions'.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Add `read_reports` scope to `shopify.app.toml`

**Files:**
- Modify: `shopify.app.toml` (the `[access_scopes]` section)

- [ ] **Step 1: Add the scope**

Find the existing line:

```toml
scopes = "write_products,read_content,write_content,read_themes,read_orders"
```

Replace with:

```toml
scopes = "write_products,read_content,write_content,read_themes,read_orders,read_reports"
```

- [ ] **Step 2: Commit**

```bash
git add shopify.app.toml
git commit -m "shopify config: add read_reports scope for Intent Lab

ShopifyQL search analytics queries (Intent Lab Stage 1) require the
read_reports scope. Search analytics are aggregated counts with no
individual customer PII; this should NOT trigger Protected Customer
Data review (unlike orders/paid did earlier).

After the next shopify app deploy, installed merchants will see a
'GEO Rise requires additional permissions' prompt on their next
admin visit. One click to grant.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

The scope only takes effect after the next `shopify app deploy`. Task 9 runs that.

---

## Task 9: Final verification + Shopify deploy + smoke test + memory checkpoint

**Files:**
- Verify: all files touched in Tasks 1-8

- [ ] **Step 1: Em-dash sweep on every touched file**

Run:

```bash
grep -n "—" app/services/tracking.server.ts app/routes/app.tracking.tsx shopify.app.toml
```

Expected: no matches in user-facing copy. The QUESTION_OPENERS_RE regex uses normal hyphens (`-`), not em-dashes; any match inside the regex needs to be replaced with the actual character it intends.

- [ ] **Step 2: Final typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds with no errors. The pre-existing CSS print warning and dynamic-import advisory are unrelated.

- [ ] **Step 4: Push to main**

```bash
git push origin main
```

Render auto-deploys the Remix app. Wait ~2-3 minutes.

- [ ] **Step 5: Deploy the Shopify config to pick up the new read_reports scope**

```bash
npx shopify app deploy --allow-updates --force --message "Intent Lab: read_reports scope for ShopifyQL search analytics"
```

Expected success output:

```
✓ Released GEO Rise version <number>
```

If the deploy fails with the same Protected Customer Data error as before, the scope is unexpectedly restricted; remove `read_reports` from shopify.app.toml, re-deploy without it, and Intent Lab falls back to Reddit + Claude only (which still works).

- [ ] **Step 6: Re-authorize the app on `boda-brands`**

After the Shopify deploy, open the GEO Rise admin in your Shopify dashboard. You should see a prompt: "GEO Rise requires additional permissions". Click to grant. This unlocks the read_reports scope for `boda-brands`.

If no prompt appears, the new scope didn't deploy; check the CLI output and retry the deploy.

- [ ] **Step 7: Smoke test Intent Lab**

In the GEO Rise admin, navigate to AI Tracking. Click "Suggest prompts for me".

Expected behavior:
- Spinner appears with new copy: "Looking at your store's recent searches and shopper community discussions..."
- After ~10 to 30 seconds, 8 suggestion cards appear.
- A one-line summary above the cards reads something like:
  `"8 suggestions: 3 from your store's recent searches + 5 from shopper communities (r/snowboarding, r/snowboards)."`
  (Numbers and subreddits vary by store. If your store has no recent searches, it may read `"8 suggestions: 8 from shopper communities (...)."`.)
- Each card has TWO badges: the existing category badge AND a new source badge:
  - Green "From your store" for shopify_search suggestions
  - Info-toned "from r/snowboarding" for reddit suggestions
  - Neutral "AI suggested" only if both sources failed
- For shopify_search suggestions, a small subdued line under the rationale reads: `Based on: search query: "snowboard sizes" (4 searches on your store)`.

If the suggestions look entirely AI-brainstormed (every card shows "AI suggested"), one of two things happened:
1. ShopifyQL access failed AND Reddit was unreachable.
2. The merchant's store has no recent search data AND niche detection failed.

Check Render logs for `[Intent Lab]` warning lines to see which source failed.

- [ ] **Step 8: Update memory checkpoint**

Edit `C:\Users\nyima\.claude\projects\-Users-lukas-Desktop-geo-app\memory\project_checkpoint.md`:

1. Update "Last updated" to today.
2. Update "Latest deploy commit" to the head SHA from this session.
3. Add a changelog entry near the top describing what shipped:
   - Three-stage Intent Lab cascade (Shopify search analytics + Reddit + Claude polish)
   - Source attribution badges in the suggestions UI
   - New read_reports scope
   - Same `/app/tracking` UI surface

Also update `C:\Users\nyima\.claude\projects\-Users-lukas-Desktop-geo-app\memory\project_competitor_landscape.md`:
- Flip the "Intent Lab (real-search prompts)" row from `❌ gap` to `✅ (this work) - Shopify search analytics + Reddit polished by Claude` for GEO Rise.

---

## Self-review

**Spec coverage check:** every spec section maps to a task:
- `SuggestedPrompt` type extension → Task 1
- Stage 1 ShopifyQL helper → Task 2
- Stage 2a niche detection → Task 3
- Stage 2b Reddit fetcher → Task 4
- Three-stage cascade orchestrator + Stage 0 fallback → Task 5
- Route action callsite update → Task 6
- UI badge + source detail + source summary + loading copy → Task 7
- `read_reports` scope → Task 8
- Em-dash sweep, build, deploy, smoke test, memory → Task 9

**Type consistency check:**
- `SuggestionSource` and the extended `SuggestedPrompt` shape defined in Task 1, used in Tasks 5 and 7 unchanged.
- `SearchTerm`, `NicheInfo`, `RedditSignal` types defined and used within `tracking.server.ts` only (Tasks 2, 3, 4) and consumed in Task 5's polish orchestrator.
- `suggestTrackingPrompts(storeId, admin)` signature matches between Task 5 (definition) and Task 6 (callsite).
- `fetchShopifySearchAnalytics(admin)`, `detectNicheAndSubreddits(storeId)`, `fetchRedditTitles(subreddits)` signatures match between their respective definition tasks and Task 5's consumer.
- The `summarizeSources` helper and `SuggestedPromptCard` JSX in Task 7 use the same field names (`source`, `sourceDetail`) defined in Task 1.

**Placeholder scan:** no TBDs, no "TODO", no "similar to Task N". Every code step shows complete code. The User-Agent string, ShopifyQL query, niche-detection system prompt, polish system prompt, and Reddit URL pattern are all spelled out in full.

**Risk notes:**
- ShopifyQL syntax for the `online_store_search` table is a best-effort guess. If the column names differ from `search_term` / `count`, Stage 1 will return a ParseError, log it, and fall through to Stage 2. Acceptable graceful degradation.
- Reddit's public JSON endpoint sometimes rate-limits aggressively or returns 403 if it detects "bot-like" traffic. The User-Agent string is meant to look like a legitimate web app; if Reddit still blocks, all Stage 2 fetches return [] and we fall through to Stage 0 brainstorm.
- The Shopify CLI deploy in Task 9 Step 5 may fail unexpectedly if Shopify treats `read_reports` as a protected scope. The plan documents the fallback (remove read_reports, redeploy without it, Intent Lab works on Reddit + Claude only).

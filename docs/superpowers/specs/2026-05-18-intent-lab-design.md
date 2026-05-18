# Intent Lab: real-shopper-data-driven tracking prompt suggestions

**Date:** 2026-05-18
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

Replace the existing Claude-brainstormed "Suggest prompts" feature on `/app/tracking` with a backend that pulls real shopper data from two sources (the merchant's own storefront search analytics via ShopifyQL, plus relevant subreddit discussions via Reddit's public JSON endpoint), then uses Claude to polish those raw signals into well-formed tracking prompts. Same UI as today, smarter data underneath. Each suggestion shows its source so merchants see the difference.

## Scope

**In scope:**
- Refactor `suggestTrackingPrompts(storeId)` in `app/services/tracking.server.ts` into a three-stage cascade: Shopify search analytics, then Reddit subreddit posts, then Claude polish on whatever was collected.
- Add `read_reports` scope to `shopify.app.toml`. Re-deploy required.
- Extend `SuggestedPrompt` type with `source` and optional `sourceDetail` fields.
- Add source-attribution badges and a one-line summary header to the existing suggestions card on `/app/tracking`.
- Update loading-state copy on the "Suggest prompts" button to reflect the new data sources.
- Graceful fallback to pure-Claude brainstorming when both Shopify and Reddit sources fail.

**Out of scope:**
- A standalone `/app/intent-lab` route (we picked the "same UI, smarter backend" approach).
- Search-term drill-down (clicking a suggestion to see all related searches or Reddit threads).
- Caching raw signals long-term. Each "Suggest prompts" click hits live sources.
- Multi-language Reddit support. All queries hit English-speaking subreddits.
- Reddit OAuth setup (we use the public JSON endpoint, no auth).
- Any change to how added prompts flow through the AI Tracking lifecycle (`addPrompt`, `runCheck`, etc.).
- Automated tests (consistent with project policy).

## Architecture

Two sources run in parallel, then a Claude polish stage merges their output. A final fallback path covers the "both sources empty" case. Each source produces zero or more "raw signals" (free-form text strings derived from real shopper data). Claude consumes the combined signals and outputs structured `SuggestedPrompt[]`.

### Stage 1: Shopify storefront search analytics (ShopifyQL)

ShopifyQL is Shopify's analytics query language exposed via the Admin GraphQL API at `shopifyqlQuery`. We query the `online_store_search` table for the top 50 search terms in the last 30 days:

```graphql
query SearchAnalytics {
  shopifyqlQuery(query: """
    FROM online_store_search
    SHOW count
    BY search_term
    SINCE -30d UNTIL today
    ORDER BY count DESC
    LIMIT 50
  """) {
    __typename
    ... on TableResponse {
      tableData {
        rowData
        columns {
          name
          dataType
        }
      }
    }
    ... on ParseError {
      code
      message
    }
  }
}
```

Each row of `tableData.rowData` is `[searchTerm, count]`. We map to:

```ts
{ term: string, count: number }
```

Filter out empty terms, terms shorter than 3 characters (likely typos or single-letter searches), and terms over 200 characters (data noise). Keep up to 20 distinct terms ordered by count.

### Stage 2: Reddit community discussions

Always runs in parallel with Stage 1 (no dependency between them). Two sub-steps:

**Step 2a: Niche detection.** One Claude call passing up to 25 of the merchant's active products. System prompt asks for 3 to 5 relevant subreddit names plus a niche descriptor:

```json
{
  "niche": "snowboarding gear and apparel",
  "subreddits": ["snowboarding", "snowboardingnoobs", "snowboards"]
}
```

**Step 2b: Subreddit fetch.** For each suggested subreddit, GET `https://www.reddit.com/r/{subreddit}/top.json?t=month&limit=25` with User-Agent header `web:geo-rise-shopify-app:1.0`. Reddit's public JSON endpoint requires no auth.

Each response contains `data.children[].data.title`. Filter for question-shaped titles:
- Contains `?`
- OR starts (case-insensitive) with one of: "best", "should i", "what's the difference", "what is", "how to", "vs", "recommend", "looking for", "any tips for"

Keep up to 10 distinct titles per subreddit, capping the total at 25 across all subreddits.

If any subreddit returns 404 or other error, skip it silently and continue with the others.

### Stage 3: Claude polish

Combine the Stage 1 search terms and Stage 2 Reddit titles into a single input payload. Pass to Claude with a polish-specific system prompt:

> You are polishing real shopper queries into tracking prompts for a Shopify merchant's AI search visibility tool. The signals provided below are REAL shopper queries from the merchant's own storefront search bar and from relevant subreddits. Your job is to convert these raw signals into 8 well-formed tracking prompts.
>
> Each output prompt MUST be derived from one of the provided signals. Do not fabricate prompts that have no signal backing.
>
> For each prompt:
> - Reference specific products or brands from the merchant's catalog when relevant
> - Categorize as one of: comparison / recommendation / use_case / price / brand
> - Add a one-sentence rationale explaining why this prompt matters
> - Mark which signal it came from (cite the index)
>
> CRITICAL: never use em-dashes (the long horizontal dash). Use commas, colons, or periods instead.
>
> Output JSON: { "suggestions": [{ "prompt": "...", "category": "...", "rationale": "...", "sourceIndex": N }] }

The user message lists the merchant's store name, products, and the numbered raw signals labeled by source.

We map `sourceIndex` back to the originating signal to determine `source` (`shopify_search` or `reddit`) and populate `sourceDetail` with the original search term + count, or subreddit name + post title.

### Stage 0: ultimate fallback (no signals available)

If both Stage 1 and Stage 2 produced zero signals (every source errored or returned empty), fall back to the existing pure-Claude brainstorm flow with the original system prompt. All outputs in this branch are marked `source: ai_brainstorm` with no `sourceDetail`.

This is the path that runs when:
- ShopifyQL access denied for this store
- AND niche detection failed (zero products)
- AND no internet access to Reddit
- AND Claude is still reachable

Edge case: if Claude itself is down, the whole function throws and the existing error-handling UI shows "AI service is temporarily unavailable" via the tracking route's `sanitizeTrackingError`.

## Data flow

```
[User clicks "Suggest prompts for me" on /app/tracking]
            |
            v
   app.tracking.tsx action (intent=suggestPrompts)
            |
            v
   suggestTrackingPrompts(storeId, admin)
            |
   Promise.all:
   +-------------------+   +-----------------------------+
   | Stage 1           |   | Stage 2                     |
   | ShopifyQL         |   | a) Claude: niche+subreddits |
   | online_store_search|  | b) Reddit JSON per subreddit|
   |                   |   | c) Filter question-shaped   |
   +--------+----------+   +----------+------------------+
            |                         |
            | 0-20 search terms       | 0-25 Reddit titles
            +-----------+-------------+
                        |
                        v
            +-----------+-----------+
            | Combined signals      |
            | available?            |
            +---+---------------+---+
                |               |
              yes               no (both empty)
                |               |
                v               v
   +-----------+-----+   +-----+--------------+
   | Stage 3         |   | Stage 0 fallback   |
   | Claude polishes |   | Pure Claude        |
   | signals into 8  |   | brainstorm against |
   | SuggestedPrompt |   | catalog only       |
   +--------+--------+   +--------+-----------+
            |                     |
            +----------+----------+
                       |
                       v
   Return to route action, render on /app/tracking
```

## Type changes

```ts
// app/services/tracking.server.ts

export type SuggestionSource = "shopify_search" | "reddit" | "ai_brainstorm";

export interface SuggestedPrompt {
  prompt: string;
  category: "comparison" | "recommendation" | "use_case" | "price" | "brand";
  rationale: string;
  source: SuggestionSource;
  /** Optional context surfaced under the suggestion in the UI. For
   *  shopify_search: "search query: 'best beginner snowboard' (37 searches)".
   *  For reddit: "from r/snowboarding". For ai_brainstorm: undefined. */
  sourceDetail?: string;
}
```

The action handler in `app.tracking.tsx` is unchanged; it already returns `suggestions` to the loader and the component is shape-compatible (we just add the new fields).

## Signature change

```ts
// Before:
export async function suggestTrackingPrompts(storeId: string): Promise<SuggestedPrompt[]>;

// After:
export async function suggestTrackingPrompts(
  storeId: string,
  admin: AdminApiContext
): Promise<SuggestedPrompt[]>;
```

The route action already has `admin` from `authenticate.admin(request)`, so passing it through is a one-line change at the callsite.

## UI changes (app/routes/app.tracking.tsx)

The existing `SuggestedPromptCard` component receives the new fields via the `SuggestedPrompt` shape. Two additions:

**1. Source badge** next to the existing category badge:

```tsx
{suggestion.source === "shopify_search" && (
  <Badge tone="success">From your store</Badge>
)}
{suggestion.source === "reddit" && (
  <Badge tone="info">
    {suggestion.sourceDetail?.startsWith("from r/")
      ? suggestion.sourceDetail
      : "From shopper community"}
  </Badge>
)}
{suggestion.source === "ai_brainstorm" && (
  <Badge>AI suggested</Badge>
)}
```

**2. Source detail text** under the rationale, if present:

```tsx
{suggestion.sourceDetail && suggestion.source === "shopify_search" && (
  <Text as="p" variant="bodySm" tone="subdued">
    Based on: {suggestion.sourceDetail}
  </Text>
)}
```

**3. Source summary header** above the suggestions card grid:

A one-line summary computed from the suggestions array:

```ts
function summarizeSources(suggestions: SuggestedPrompt[]): string {
  const fromStore = suggestions.filter((s) => s.source === "shopify_search").length;
  const fromReddit = suggestions.filter((s) => s.source === "reddit").length;
  const aiOnly = suggestions.every((s) => s.source === "ai_brainstorm");

  if (aiOnly) {
    return "8 suggestions brainstormed by Claude. We couldn't reach Shopify analytics or Reddit this time, so we used your catalog only.";
  }

  const parts: string[] = [];
  if (fromStore > 0) parts.push(`${fromStore} from your store's recent searches`);
  if (fromReddit > 0) {
    const subreddits = Array.from(
      new Set(
        suggestions
          .filter((s) => s.source === "reddit")
          .map((s) => s.sourceDetail?.replace(/^from /i, "").trim())
          .filter((x): x is string => Boolean(x))
      )
    );
    parts.push(`${fromReddit} from shopper communities (${subreddits.join(", ")})`);
  }
  return `${suggestions.length} suggestions: ${parts.join(" + ")}.`;
}
```

Rendered as subdued text right above the suggestions card grid.

**4. Loading state copy update.** The existing toast or inline spinner message changes from "Asking Claude to brainstorm prompts based on your catalog..." to "Looking at your store's recent searches and shopper community discussions...".

## Scope addition: read_reports

`shopify.app.toml` adds `read_reports` to the existing scopes list:

```toml
[access_scopes]
scopes = "write_products,read_content,write_content,read_themes,read_orders,read_reports"
```

After `shopify app deploy`, the new scope is requested. For dev stores it's a one-click re-auth on next dashboard visit. For installed merchants in production, Shopify shows "GEO Rise requires additional permissions" on their next admin visit; one click grants.

`read_reports` should NOT trigger Protected Customer Data review because search analytics are aggregated counts with no individual customer identifiers. (If Shopify rejects the deploy on this scope, we drop the ShopifyQL stage entirely and fall back to Reddit-only Intent Lab.)

## Edge cases

| Scenario | Behavior |
|---|---|
| Store has 0 products | Niche detection fails. Stage 2 skipped. Stage 1 may still work if the store has search history. If both empty, Stage 0 fallback returns AI brainstorm based on shopName only, with low quality. Acceptable for new stores. |
| ShopifyQL returns ParseError | Log, skip Stage 1, continue with Stage 2. |
| ShopifyQL returns empty (no recent searches) | Log "no search analytics yet", skip Stage 1, continue with Stage 2. |
| Reddit subreddit doesn't exist (404) | Skip that one, continue with the others. |
| Reddit rate-limited (429) | Log, skip the rest of Stage 2, proceed with whatever Stage 1 gave. |
| Niche detection returns subreddits that don't exist | All 404, Stage 2 returns empty signals. Fall through to Stage 0 fallback. |
| Claude polish call fails | Throw. Route action catches via `sanitizeTrackingError` and shows clean error toast. |
| Claude returns malformed JSON | Throw "Couldn't parse Claude's suggestions" (same as existing). |
| Claude returns prompts not derivable from any signal | Discard those, return only the validated ones. If validated list is fewer than 4, fall through to Stage 0 fallback. |
| Reddit response contains NSFW or off-topic content | Filter happens via Claude polish step (system prompt asks for prompts relevant to the merchant's catalog). Defense in depth: also filter out subreddits returned by Claude that we recognize as NSFW (a small denylist). |
| Multi-language merchant | Reddit defaults to English-speaking communities. Acceptable for MVP. ShopifyQL returns the merchant's actual store search terms which will be in the shopper's language. |

## File-by-file changes (planning input)

1. `app/services/tracking.server.ts`:
   - Add `SuggestionSource` type and extend `SuggestedPrompt` interface.
   - Add `fetchShopifySearchAnalytics(admin)` helper for Stage 1.
   - Add `detectNiche(storeId)` Claude helper for Stage 2a.
   - Add `fetchRedditTitles(subreddits)` helper for Stage 2b.
   - Refactor `suggestTrackingPrompts` to orchestrate all stages.
   - Update the existing `SUGGEST_SYSTEM_PROMPT` to a polish-mode prompt OR add a separate polish prompt.
2. `app/routes/app.tracking.tsx`:
   - Pass `admin` to the service call.
   - Add source-badge rendering in `SuggestedPromptCard`.
   - Add `sourceDetail` line.
   - Add `summarizeSources` helper and source-summary header.
   - Update loading copy.
3. `shopify.app.toml`:
   - Add `read_reports` to scopes.

## Implementation order suggestion (for the plan)

1. Add the helpers (`fetchShopifySearchAnalytics`, `detectNiche`, `fetchRedditTitles`).
2. Refactor `suggestTrackingPrompts` with the new cascade and polish prompt.
3. Update the route action to pass `admin`.
4. Update the UI: type extension, badges, source-detail text, source summary.
5. Update `shopify.app.toml` and re-deploy theme + config.
6. Em-dash sweep, build, push, manual smoke test on `boda-brands`.

## Scope estimate

- Helper functions (3 stages): ~3 hours
- Service refactor + polish prompt: ~1 hour
- UI changes (badges, detail, summary, copy): ~45 min
- Typecheck, build, em-dash sweep: ~15 min
- shopify.app.toml update + deploy: ~15 min
- Commit, push, memory checkpoint: ~30 min
- Manual smoke test prep + execution: ~30 min

**Total: ~6 hours focused work, give or take.** Realistically closer to one session if uninterrupted.

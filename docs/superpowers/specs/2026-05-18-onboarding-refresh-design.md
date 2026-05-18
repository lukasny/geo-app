# Onboarding wizard refresh + dashboard feature discovery

**Date:** 2026-05-18
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

A brand-new merchant who installs GEO Rise should walk through a tight wizard, see the audit run on their real store, feel the wow moment of auto-fix raising their GEO score in real time, and then discover the rest of the product (tracking, competitors, blog generator, simulator, weekly emails, schema injection) through persistent dashboard cards. The current 4-step wizard predates most of the product and undersells it.

## Scope

**In scope:**
- Refactor `app/routes/app._index.tsx`'s `OnboardingWizard` from 4 steps to 3 steps.
- Auto-generate `llms.txt` silently during the audit step (no merchant action).
- Add an auto-fix demo step that runs after the audit and animates the score jump.
- Add a "Get more from GEO Rise" card section to the regular dashboard that surfaces features the merchant has not yet used.
- Plan-aware visibility: Free merchants only see cards for features available on their plan.
- Per-card auto-dismiss based on signals already in the data model. No new schema columns.

**Out of scope:**
- New schema columns or migrations.
- A "Dismiss this section" master switch (the user can dismiss cards individually).
- Re-running the wizard for existing merchants who already completed onboarding.
- Brand identity, illustrations, or visual design work beyond what existing Polaris components provide.
- Test suite work.

## Wizard refactor

Three steps, each tight. Total merchant time target: about 2-3 minutes.

### Step 1: Welcome
Copy:
> "GEO Rise will audit your store, show you how AI search engines like ChatGPT and Perplexity see it, and fix the biggest issues for you in one click. About 2 minutes."

Primary CTA: "Let's go" → step 2.

### Step 2: Audit + score reveal
- Loading state: "Auditing your top products..."
- Audit invocation: `runFullAudit(storeId, admin, { maxProducts: 5 })`. The wizard runs a bounded "starter audit" of 5 products rather than the merchant's full catalog so the step completes in ~30-60 seconds regardless of catalog size. The merchant can run the full plan-capped audit from the AI Audit page after the wizard.
- During this step, in parallel, kick off `generateLlmsTxt(store.id)` silently (no UI surface, no toast on success). It just appears as "ready" when the merchant later visits the llms.txt manager.
- When the audit completes, reveal the score with the existing `GeoScoreRing` and a one-line label (the existing `scoreLabel()` helper).
- Primary CTA: "Fix the biggest issues for me" → step 3.

### Step 3: The wow
- Pre-fix message: "We found N fixable issues in your catalog. Want to see what auto-fix does on this store?" where N is the count of unfixed `AuditResult` rows with `autoFixable = true`. Primary CTA: "Run auto-fix".
- During the run: spinner + "Claude is rewriting your content. This takes about 60 seconds..."
- Auto-fix invocation: `autoFixIssues(storeId, admin, { maxIssues: 5 })`. The existing `AutoFixOptions` accepts `category` and `title`, but not a count cap. As part of this work, add `maxIssues?: number` to `AutoFixOptions`. When set, the orchestrator stops after attempting that many fixes (skipped fixes don't count toward the cap; only actual `fix` attempts do). The 5-issue cap is enough to deliver a meaningful score jump on most stores without blowing through Anthropic credits or making the wizard feel slow.
- After auto-fix returns: re-run `runFullAudit(storeId, admin, { maxProducts: 5 })` to get the post-fix score. Animate the GeoScoreRing from `beforeScore` to `afterScore` over 1.2 seconds via `requestAnimationFrame`.
- End state: "Your GEO score went from X to Y. Welcome to GEO Rise." with an "Open the dashboard" primary CTA.
- The `completeOnboarding` action sets `store.onboardingCompleted = true` and reloads to the regular dashboard.
- If auto-fix returns 0 successful fixes (e.g. circuit breaker tripped on transient errors): show "Auto-fix had trouble running just now. Your starting score is X. Try again from the AI Audit page when you're ready." Still let the merchant proceed to the dashboard.

### Fallback paths

- **Zero-product store**: step 2 cannot audit. Show "Add your first product to Shopify, then come back here" with a link to the Shopify product creation URL. No score reveal, no wow.
- **Auto-fix unavailable** (Anthropic credits exhausted, transient API error, or zero fixable issues): skip step 3. Step 2's "Continue" CTA becomes "Open the dashboard" and the wizard ends after the score reveal.
- **Audit fails**: show a friendly error and a "Try again" CTA. The merchant can retry without losing wizard progress.

### What is dropped vs today

- The manual "Generate llms.txt" step (now silent in step 2).
- The manual "Enable AI Schema Injection" step (moves to a dashboard card so it doesn't block the wow).
- Dot count drops from 4 to 3.

## Dashboard "Get more from GEO Rise" section

A new card section on `app/routes/app._index.tsx`'s main dashboard, placed below the GEO score / Quick Actions row and above existing per-feature sections.

### Section header
> "Get more from GEO Rise"

Subtitle: "Features that take a few minutes to set up and pay off every week after."

### Cards, in this order

Each card is a Polaris `Card` with a heading, one-line description, and a primary CTA button. Each card runs an independent visibility check at loader time.

1. **Enable AI Schema Injection**
   - Pitch: "Add structured data to your product pages so ChatGPT, Gemini, and Perplexity can fully understand what you sell. Takes 30 seconds in your Shopify theme editor."
   - CTA: "Open Theme Editor" - opens `https://{shopifyDomain}/admin/themes/current/editor?context=apps` in a new tab.
   - Visibility: shown when `store.schemaInjectionEnabled !== true`.
   - Note: today we have no automatic way to detect the toggle change from inside the theme editor. The existing flow already has the merchant click a separate "I've enabled it" button to set the flag - we keep that pattern. The card includes a small secondary "I've enabled it" link below the primary CTA that POSTs `intent=markSchemaEnabled` to flip `schemaInjectionEnabled` to true.

2. **Set up AI Tracking**
   - Pitch: "See when ChatGPT, Claude, and Perplexity mention your products. We can suggest prompts based on your catalog."
   - CTA: "Go to AI Tracking" → `/app/tracking`.
   - Visibility: shown when the store has zero `TrackingPrompt` rows. Free plan never sees this card (tracking is not on their plan).

3. **Add a competitor to monitor**
   - Pitch: "Compare your AI visibility head-to-head with rivals in your niche."
   - CTA: "Go to Competitors" → `/app/competitors`.
   - Visibility: shown when the store has zero `Competitor` rows. Free plan never sees this card.

4. **Generate your first blog post**
   - Pitch: "AI-written posts grounded in your real catalog, structured for ChatGPT to cite and publish to your Shopify blog with one click."
   - CTA: "Go to Blog Generator" → `/app/blog-generator`.
   - Visibility: shown when the store has zero `BlogPost` rows with status in (draft, published). Free plan never sees this card.

5. **Run AI Simulator**
   - Pitch: "See exactly what ChatGPT and Claude extract from any product page on your store."
   - CTA: "Go to AI Simulator" → `/app/simulator`.
   - Visibility: shown when the store has zero `SimulationUsage` rows.

6. **Turn on weekly insight emails**
   - Pitch: "A weekly digest of your GEO score, top actions, competitor citation rates, and AI mentions. Lands in your inbox every Monday."
   - CTA: "Turn on weekly emails" - POSTs `intent=toggleWeeklyEmail` to set `weeklyInsightEnabled = true`. Card auto-dismisses on next loader pass.
   - Visibility: shown when `weeklyInsightEnabled === false`. Free plan never sees this card.

### Section visibility

When all eligible cards (filtered by plan) are dismissed, the entire section is hidden so the dashboard stays clean. This is a derived check, not a stored flag.

### Plan awareness

For each card, the loader checks the store's plan against `PLAN_LIMITS[plan]`'s feature flags before computing visibility:

| Card | Required feature flag | Free | Growth | Pro | Enterprise |
|---|---|---|---|---|---|
| Schema Injection | (none, available all plans) | ✓ | ✓ | ✓ | ✓ |
| AI Tracking | `aiTracking` | hidden | ✓ | ✓ | ✓ |
| Competitors | `competitorMonitoring` | hidden | ✓ | ✓ | ✓ |
| Blog Generator | `maxBlogPostsPerMonth > 0` | hidden | ✓ | ✓ | ✓ |
| AI Simulator | (all plans, capped on Free) | ✓ | ✓ | ✓ | ✓ |
| Weekly Emails | `insightEmails` | hidden | ✓ | ✓ | ✓ |

Free merchants therefore see at most three cards: Schema Injection, AI Simulator, and any other plan-available cards. The existing upgrade banners (already on `app._index.tsx`) handle the upsell path; this section does not duplicate that work.

## Data flow

### Loader additions to `app._index.tsx`

The existing loader already queries `store`, `llmsFile`, `citationCount`, `issueCounts`, `recentActivity`. Add four new counts in the same `Promise.all`:

```ts
const [trackingPromptCount, competitorCount, blogPostCount, simulationCount] = await Promise.all([
  prisma.trackingPrompt.count({ where: { storeId: store.id } }),
  prisma.competitor.count({ where: { storeId: store.id } }),
  prisma.blogPost.count({ where: { storeId: store.id, status: { in: ["draft", "published"] } } }),
  prisma.simulationUsage.count({ where: { storeId: store.id } }),
]);
```

These four counts plus the existing `store.schemaInjectionEnabled` and `store.weeklyInsightEnabled` give us all the per-card visibility signals. No new schema columns are added.

The loader returns a `discoveryCards` array of card descriptors, computed server-side:

```ts
type DiscoveryCard = "schema" | "tracking" | "competitors" | "blog" | "simulator" | "weeklyEmail";
const discoveryCards: DiscoveryCard[] = [
  !store.schemaInjectionEnabled && "schema",
  PLAN_LIMITS[planKey].aiTracking && trackingPromptCount === 0 && "tracking",
  PLAN_LIMITS[planKey].competitorMonitoring && competitorCount === 0 && "competitors",
  PLAN_LIMITS[planKey].maxBlogPostsPerMonth > 0 && blogPostCount === 0 && "blog",
  simulationCount === 0 && "simulator",
  PLAN_LIMITS[planKey].insightEmails && !store.weeklyInsightEnabled && "weeklyEmail",
].filter(Boolean) as DiscoveryCard[];
```

The component renders cards in array order. If the array is empty, the whole section is hidden.

### Action additions to `app._index.tsx`

Two new intents:
- `intent=markSchemaEnabled`: sets `store.schemaInjectionEnabled = true` and returns `{ success, intent }`. The card disappears on the next loader pass.
- `intent=toggleWeeklyEmail` already exists; reused as-is.

All other card CTAs are simple link navigations and don't need new action handlers.

## Component changes

### `OnboardingWizard` component (in `app._index.tsx`)
- Collapse the 4-step state machine into 3 steps with a unified state variable.
- Step 2 dispatches BOTH `runAudit` AND `generateLlms` actions in parallel on entry (the loader already supports both; we wire them up to fire together).
- Step 3 dispatches `autoFixIssues` once on entry, then re-dispatches `runAudit` on completion to get the new score.
- Score-jump animation: use a simple React state holding `{ beforeScore, afterScore }` and animate from before to after over 1.2 seconds using `requestAnimationFrame` (no new dependency).

### New `DiscoveryCards` component
- Lives inline in `app._index.tsx` for now (refactor to a separate file only if it grows past ~150 lines).
- Renders a section header + a vertical list of `Card`s based on the `discoveryCards` array.
- Each card is a small inline subcomponent (one per card type) so copy and CTAs are colocated with their visibility condition.

## Edge cases

| Scenario | Behavior |
|---|---|
| Store has zero products | Wizard step 2 shows "Add a product first" instead of running audit. Dashboard cards still render (they don't require products). |
| Anthropic credits exhausted during wizard step 3 | Skip step 3, end wizard at step 2's score reveal. Show friendly message: "Auto-fix is temporarily unavailable. Your starting GEO score is X. Welcome to GEO Rise." |
| Audit fails (network error) | Friendly error + "Try again" CTA. Don't advance the step. |
| Merchant completes wizard, returns to dashboard | They see whichever discovery cards still apply, based on signals. |
| Existing onboarded merchant (e.g. Lukas) | Wizard is skipped (`store.onboardingCompleted === true`). Dashboard discovery cards apply normally based on their current usage. |
| Free plan, all eligible cards dismissed | Section hides. Merchant continues to see upgrade banners as before. |
| Race: merchant generates a blog post and reloads the dashboard | Blog card auto-dismisses on the next loader pass. No stale state. |

## Code-level checklist

- `app/services/audit-engine.server.ts`: add `maxIssues?: number` to `AutoFixOptions`. In `autoFixIssues`, stop iterating once `attemptedFixes >= maxIssues` (counting only actual fix attempts, not skipped/already-good rows).
- `app/routes/app._index.tsx` loader: add four `Promise.all` counts (`trackingPromptCount`, `competitorCount`, `blogPostCount`, `simulationCount`) plus the `discoveryCards` computation.
- `app/routes/app._index.tsx` action: add `markSchemaEnabled` intent.
- `app/routes/app._index.tsx` `OnboardingWizard`: refactor to 3 steps. Step 2 dispatches `runAudit` and `generateLlms` in parallel; step 3 dispatches `autoFixIssues({ maxIssues: 5 })` and re-dispatches `runAudit({ maxProducts: 5 })` on completion.
- `app/routes/app._index.tsx` main dashboard: render the new `DiscoveryCards` section under the GEO score / Quick Actions row.
- Verify all em-dashes are absent from new copy (per project rule).
- `npx tsc --noEmit` and `npm run build` clean.
- Manual smoke test on `boda-brands` to confirm cards show/hide correctly based on usage signals.

## Lessons / non-goals

- No new schema migration. All visibility signals come from existing data.
- No new dependencies. Score-jump animation uses `requestAnimationFrame`.
- No A/B testing. Each card has one fixed pitch; we can iterate later if conversion data warrants.
- The wizard is **not** re-runnable. Once a merchant completes it, it's done. If we want a "tour" feature for existing merchants later, it's a separate project.

## Scope estimate

- Wizard refactor: ~1.5 hours
- Dashboard cards section + plan-aware visibility logic + signal-based dismiss: ~1.5 hours
- Edge case handling (zero products, auto-fix failure fallback, audit failure): ~30 min
- Typecheck, build, commit, push, memory checkpoint update: ~30 min

**Total: ~4 hours focused work.** Single implementation session.

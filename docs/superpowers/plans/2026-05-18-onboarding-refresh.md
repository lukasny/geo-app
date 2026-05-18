# Onboarding Wizard Refresh + Dashboard Discovery Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the onboarding wizard to focus on the audit-and-auto-fix wow moment and add a persistent "Get more from GEO Rise" section on the dashboard that surfaces features the merchant has not yet used.

**Architecture:** Two files touched: `app/services/audit-engine.server.ts` gets a `maxIssues` option added to `AutoFixOptions` so the wizard's wow step has a bounded runtime; `app/routes/app._index.tsx` gets a refactored 3-step `OnboardingWizard`, four new loader counts to feed plan-aware visibility logic, a new `markSchemaEnabled` action intent, and a new `DiscoveryCards` JSX section rendered on the main dashboard. No schema migrations.

**Tech Stack:** Remix, TypeScript strict, Shopify Polaris v12, App Bridge v4, Prisma. Project has no automated test suite (out of scope per spec). Verification per task = `npx tsc --noEmit` plus manual smoke test once the full feature is assembled at the end.

**Spec:** `docs/superpowers/specs/2026-05-18-onboarding-refresh-design.md`

---

## Task 1: Add maxIssues option to AutoFixOptions

**Files:**
- Modify: `app/services/audit-engine.server.ts:1604-1622`

The orchestrator currently iterates over every fixable issue with a circuit breaker only on consecutive failures. The wizard's wow step needs a hard cap to keep step 3 under ~60 seconds regardless of catalog size.

- [ ] **Step 1: Add `maxIssues` to `AutoFixOptions`**

Replace lines 1604-1616 of `app/services/audit-engine.server.ts` with:

```ts
export interface AutoFixOptions {
  /** If set, restrict the run to issues in this audit category. Used by the
   *  action plan page so each card's "Auto-fix" button only touches its own
   *  bucket (e.g. "fix the 12 missing meta descriptions, leave the
   *  descriptions for later"). Omit to fix every fixable issue, like the
   *  audit page's "Auto-fix All" button. */
  category?: "SCHEMA" | "CONTENT" | "TECHNICAL" | "ACCESSIBILITY" | "IMAGES" | "META";
  /** If set, restrict the run to issues with this exact `AuditResult.title`.
   *  Lets the action plan target a single fix-recipe (e.g. just the
   *  "Missing SEO title" issues, not the "Missing meta description" ones,
   *  even though both live under category=META). */
  title?: string;
  /** If set, stop the orchestrator after attempting this many fixes (counting
   *  successful + failed attempts; skipped fixes don't count). Used by the
   *  onboarding wizard's wow step to bound the runtime to a predictable
   *  ~60 seconds regardless of catalog size. */
  maxIssues?: number;
}
```

- [ ] **Step 2: Cap the orchestrator loop on attempted fixes**

Find the `outer: for` loop in `autoFixIssues` (around line 1647) and wrap the iteration so that once `fixed + failed >= options.maxIssues`, the loop breaks. After the existing `consecutiveFailures` increment and after the success path, insert a cap check just before the next loop iteration:

Locate the loop body. After the existing `consecutiveFailures` handling and after the success/failed/skipped counters get updated for the current iteration, add this check at the END of the loop body, just before the closing `}`:

```ts
    if (options.maxIssues !== undefined && fixed + failed >= options.maxIssues) {
      console.log(
        `[GEO Rise auto-fix] maxIssues cap (${options.maxIssues}) reached; stopping orchestrator after ${fixed} fixed + ${failed} failed`
      );
      break outer;
    }
```

The labeled `break outer` matches the existing label on the loop. The counters `fixed` and `failed` are already in scope. `skipped` is intentionally excluded from the count so a merchant with many already-good products doesn't stop the loop prematurely.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add app/services/audit-engine.server.ts
git commit -m "audit-engine: add maxIssues cap to AutoFixOptions

Bounds the orchestrator loop after N attempted fixes (fixed + failed,
excluding skipped). Used by the onboarding wizard wow step to keep
the auto-fix demo under ~60s regardless of catalog size.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Add four discovery-card counts to the dashboard loader

**Files:**
- Modify: `app/routes/app._index.tsx:121-140`

The loader already does a `Promise.all` of three queries. We extend it to also count TrackingPrompts, Competitors, BlogPosts (finished only), and SimulationUsages for the store. These four counts feed the per-card visibility checks.

- [ ] **Step 1: Add the four counts to the existing Promise.all**

Replace the `Promise.all` block at line 121 (the one that fetches `[llmsFile, auditResults, citations]`) with:

```ts
  const [
    llmsFile,
    auditResults,
    citations,
    trackingPromptCount,
    competitorCount,
    blogPostCount,
    simulationCount,
  ] = await Promise.all([
    prisma.llmsFile.findFirst({
      where: { storeId: store.id, marketCode: "default" },
      select: { productCount: true, lastGeneratedAt: true, content: true },
    }),
    prisma.auditResult.findMany({
      where: { storeId: store.id },
      select: { severity: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.aiCitation.count({
      where: {
        storeId: store.id,
        checkedAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
    }),
    prisma.trackingPrompt.count({ where: { storeId: store.id } }),
    prisma.competitor.count({ where: { storeId: store.id } }),
    prisma.blogPost.count({
      where: {
        storeId: store.id,
        status: { in: ["draft", "published"] },
      },
    }),
    prisma.simulationUsage.count({ where: { storeId: store.id } }),
  ]);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "dashboard loader: count tracking prompts, competitors, blog posts, sims

Four new counts feed the upcoming Discovery Cards section. Each lets
us hide the corresponding 'try this feature' card once the merchant
has actually used it. No schema changes needed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Compute discoveryCards array in loader

**Files:**
- Modify: `app/routes/app._index.tsx:56-66` (LoaderData type)
- Modify: `app/routes/app._index.tsx:175-194` (loader return)

The loader returns a `discoveryCards` array of card identifiers. Each is included only when its visibility check passes (plan-aware + signal-based). The component renders cards in array order.

- [ ] **Step 1: Add the `DiscoveryCard` type + field to `LoaderData`**

Insert ABOVE the `LoaderData` interface (around line 56):

```ts
type DiscoveryCard =
  | "schema"
  | "tracking"
  | "competitors"
  | "blog"
  | "simulator"
  | "weeklyEmail";
```

Then modify the `LoaderData` interface to add the new field. Replace lines 56-66 with:

```ts
interface LoaderData {
  store: StoreData | null;
  llmsFile: {
    productCount: number;
    lastGeneratedAt: string | null;
    hasContent: boolean;
  } | null;
  citationCount: number;
  issueCounts: { total: number; critical: number; high: number };
  recentActivity: ActivityItem[];
  /** Ordered list of feature-discovery cards to render on the dashboard.
   *  Each is filtered by plan + a "has the merchant used this" signal,
   *  so once the merchant tries a feature its card auto-dismisses on the
   *  next loader pass. */
  discoveryCards: DiscoveryCard[];
}
```

Also extend `StoreData` to include `schemaInjectionEnabled` (it's on the Store model but missing from the type). Find the `StoreData` interface at line 33 and add this line after `weeklyInsightEnabled: boolean;`:

```ts
  schemaInjectionEnabled: boolean;
```

- [ ] **Step 2: Compute discoveryCards in the loader**

Just before the `return {` block at line 175, add the computation:

```ts
  const planKey = store.plan as keyof typeof PLAN_LIMITS;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const discoveryCards: DiscoveryCard[] = [
    !store.schemaInjectionEnabled ? "schema" : null,
    limits.aiTracking && trackingPromptCount === 0 ? "tracking" : null,
    limits.competitorMonitoring && competitorCount === 0 ? "competitors" : null,
    limits.maxBlogPostsPerMonth > 0 && blogPostCount === 0 ? "blog" : null,
    simulationCount === 0 ? "simulator" : null,
    limits.insightEmails && !store.weeklyInsightEnabled ? "weeklyEmail" : null,
  ].filter((c): c is DiscoveryCard => c !== null);
```

- [ ] **Step 3: Return discoveryCards in the loader response**

Add `discoveryCards,` to the returned object, just after `recentActivity:` (around line 193). The final return becomes:

```ts
  return {
    store: {
      ...store,
      installedAt: store.installedAt.toISOString(),
      lastInsightSentAt: store.lastInsightSentAt?.toISOString() ?? null,
    },
    llmsFile: llmsFile
      ? {
          productCount: llmsFile.productCount,
          lastGeneratedAt: llmsFile.lastGeneratedAt?.toISOString() ?? null,
          hasContent: (llmsFile.content?.length ?? 0) > 0,
        }
      : null,
    citationCount: citations,
    issueCounts,
    recentActivity: activity.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    ),
    discoveryCards,
  } satisfies LoaderData;
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "dashboard loader: compute discoveryCards array

Plan-aware list of feature-discovery card IDs based on usage signals.
Free plan only sees cards for features available on their plan.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Add markSchemaEnabled action intent

**Files:**
- Modify: `app/routes/app._index.tsx` (action function, around line 289)

The "Enable AI Schema Injection" discovery card has a secondary "I've enabled it" link that flips `schemaInjectionEnabled` to true. We don't have a way to detect the toggle from inside the Shopify theme editor, so this is a merchant-driven confirmation.

- [ ] **Step 1: Add the intent handler**

Find the end of the action function (after the `sendTestEmail` handler that ends around line 288). Add a new intent block just before the closing of the action function:

```ts
  if (intent === "markSchemaEnabled") {
    await prisma.store.update({
      where: { id: store.id },
      data: { schemaInjectionEnabled: true },
    });
    return { success: true, intent };
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "dashboard action: add markSchemaEnabled intent

Flips store.schemaInjectionEnabled to true. Used by the Discovery Card
for AI Schema Injection so the merchant can self-report they enabled
the theme extension (we have no way to detect it server-side).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Refactor OnboardingWizard to 3 steps (step 1: Welcome)

**Files:**
- Modify: `app/routes/app._index.tsx:382-618` (OnboardingWizard function)

The current wizard has 5 internal step states (1, 2, 3, 4, 5) rendered through a 4-dot UI. We collapse to a 3-step state machine matching the new design: Welcome, Audit+Reveal, Wow. Each step gets new copy and a new shape.

This task only handles the OUTER STRUCTURE and STEP 1 (Welcome). Steps 2 and 3 follow in Tasks 6 and 7.

- [ ] **Step 1: Replace the OnboardingWizard function body**

Replace the entire OnboardingWizard function (from line 384 `function OnboardingWizard(` through the closing `}` on line 618) with this scaffold. Steps 2 and 3 are stubs for now; we fill them in subsequent tasks.

```tsx
function OnboardingWizard({
  shopName,
}: {
  shopName: string;
  shopifyDomain: string;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isLoading = fetcher.state !== "idle";
  const lastData = fetcher.data as Record<string, unknown> | undefined;
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;

  // The audit completes step 2 (revealing the starter score); the
  // completeOnboarding intent ends the wizard (reloading to the dashboard).
  useEffect(() => {
    if (!lastData || fetcher.state !== "idle") return;
    if ("error" in lastData) {
      shopify.toast.show(lastData.error as string, { isError: true });
      return;
    }
    if (lastData.intent === "completeOnboarding") {
      window.location.reload();
    }
  }, [lastData, fetcher.state, shopify]);

  const submit = (intent: string) =>
    fetcher.submit({ intent }, { method: "POST" });

  return (
    <Page>
      <TitleBar title="Welcome to GEO Rise" />
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <Card>
          <BlockStack gap="600">
            {/* Step dots - 3 steps total */}
            <InlineStack align="center" gap="200">
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    fontWeight: 600,
                    background:
                      step > n ? "#1D9E75" : step === n ? "#008060" : "#E4E5E7",
                    color: step >= n ? "#fff" : "#6D7175",
                  }}
                >
                  {step > n ? "✓" : n}
                </span>
              ))}
            </InlineStack>

            {/* Step 1 - Welcome */}
            {step === 1 && (
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Step 1 of 3
                  </Text>
                  <Text as="h2" variant="headingXl">
                    Welcome to GEO Rise, {shopName}
                  </Text>
                </BlockStack>
                <Text as="p" variant="bodyMd">
                  GEO Rise will audit your store, show you how AI search engines
                  like ChatGPT and Perplexity see it, and fix the biggest issues
                  for you with one click. About 2 minutes.
                </Text>
                <Button variant="primary" onClick={() => setStep(2)}>
                  Let&apos;s go
                </Button>
              </BlockStack>
            )}

            {/* Step 2 - Audit + score reveal. Filled in Task 6. */}
            {step === 2 && (
              <BlockStack gap="400">
                <Text as="p" variant="bodyMd">
                  Step 2 placeholder, filled in Task 6.
                </Text>
              </BlockStack>
            )}

            {/* Step 3 - The wow. Filled in Task 7. */}
            {step === 3 && (
              <BlockStack gap="400">
                <Text as="p" variant="bodyMd">
                  Step 3 placeholder, filled in Task 7.
                </Text>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </div>
    </Page>
  );
}
```

Note: the `shopifyDomain` prop is kept in the signature because step 3 will use it for the "Open dashboard" reload path later. It's intentionally unused for now (TS won't complain on unused destructured props from a typed interface).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "onboarding wizard: scaffold 3-step shape with step 1 (welcome)

Replaces the 4-step wizard with a 3-step state machine. Step 1
(welcome copy) is final; steps 2 and 3 are placeholders filled in
subsequent commits.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Wizard step 2 (audit + silent llms.txt + score reveal)

**Files:**
- Modify: `app/routes/app._index.tsx` (OnboardingWizard step 2 block)

Step 2 dispatches `runAudit` (capped to 5 products via a new wizard-specific intent) AND `generateLlms` in parallel on entry. When the audit completes, reveal the score with the existing `GeoScoreRing` component and offer the "Fix the biggest issues for me" CTA to advance to step 3.

We need a new action intent `runStarterAudit` that calls `runFullAudit` with `maxProducts: 5`. The existing `runAudit` intent uses the plan's full `maxAuditProducts` cap, which we don't want here (Pro plan would audit 1000s of products and the wizard would take minutes).

- [ ] **Step 1: Add the `runStarterAudit` action intent**

In the action function, add a new intent block after the existing `runAudit` handler (around line 240, before the `completeOnboarding` block):

```ts
  if (intent === "runStarterAudit") {
    try {
      // Bounded "wizard starter audit" of 5 products so the wizard step
      // completes in ~30-60s regardless of catalog size. Merchant can run
      // the full plan-capped audit from the AI Audit page after onboarding.
      const summary = await runFullAudit(store.id, admin, { maxProducts: 5 });
      return { success: true, intent, storeScore: summary.storeScore };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Audit failed." };
    }
  }
```

- [ ] **Step 2: Replace the step 2 placeholder with the real step 2 UI**

Find the `{/* Step 2 - Audit + score reveal. Filled in Task 6. */}` block in `OnboardingWizard` and replace it with:

```tsx
            {/* Step 2 - Audit + score reveal */}
            {step === 2 && (
              <Step2 fetcher={fetcher} onNext={() => setStep(3)} />
            )}
```

Then, BEFORE the closing `}` of the `OnboardingWizard` function (just before `// ─── Main Dashboard ───────────────────────────────────────────────────────────`), define the `Step2` subcomponent inline. The subcomponent owns its own effect that fires the audit + llms-gen on mount.

Add the new component definition:

```tsx
function Step2({
  fetcher,
  onNext,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  onNext: () => void;
}) {
  const [hasFiredAudit, setHasFiredAudit] = useState(false);
  const [hasFiredLlms, setHasFiredLlms] = useState(false);
  const data = fetcher.data as Record<string, unknown> | undefined;
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;
  const isAuditing = fetcher.state !== "idle" && lastIntent === "runStarterAudit";
  const score =
    data && data.intent === "runStarterAudit" && "storeScore" in data
      ? (data.storeScore as number)
      : null;
  const auditError =
    data && data.intent === "runStarterAudit" && "error" in data
      ? (data.error as string)
      : null;

  // Fire the audit and llms-gen exactly once on mount. They run in parallel:
  // the audit reveals the score (the merchant-facing reward), the llms-gen
  // is silent (no toast, no UI; merchant finds the result on the llms.txt
  // Manager page later).
  useEffect(() => {
    if (!hasFiredAudit) {
      fetcher.submit(
        { intent: "runStarterAudit" },
        { method: "POST" }
      );
      setHasFiredAudit(true);
    }
    if (!hasFiredLlms) {
      // Use a separate fetcher form-submit so the audit result still lands
      // on `fetcher.data`. We fire-and-forget the llms request via a plain
      // form POST.
      const formData = new FormData();
      formData.append("intent", "generateLlms");
      fetch(window.location.pathname, {
        method: "POST",
        body: formData,
      }).catch((err) => {
        // Silent: llms is best-effort during onboarding. If it fails, the
        // merchant can regenerate from the llms.txt Manager page.
        console.warn("[onboarding] silent llms generation failed:", err);
      });
      setHasFiredLlms(true);
    }
  }, [fetcher, hasFiredAudit, hasFiredLlms]);

  if (auditError) {
    return (
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Step 2 of 3
          </Text>
          <Text as="h2" variant="headingXl">
            We hit a snag
          </Text>
        </BlockStack>
        <Banner tone="warning">
          <Text as="p" variant="bodyMd">
            We couldn&apos;t finish the audit just now. {auditError}
          </Text>
        </Banner>
        <Button
          variant="primary"
          onClick={() => {
            setHasFiredAudit(false);
          }}
        >
          Try again
        </Button>
      </BlockStack>
    );
  }

  if (isAuditing || score === null) {
    return (
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Step 2 of 3
          </Text>
          <Text as="h2" variant="headingXl">
            Auditing your top products
          </Text>
        </BlockStack>
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="p" variant="bodySm">
            This takes about 30 to 60 seconds.
          </Text>
        </InlineStack>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          Step 2 of 3
        </Text>
        <Text as="h2" variant="headingXl">
          Here&apos;s how AI sees your store
        </Text>
      </BlockStack>
      <Box padding="400" background="bg-surface-secondary" borderRadius="200">
        <BlockStack gap="200" align="center">
          <GeoScoreRing score={score} />
          <Text as="p" variant="headingMd" alignment="center">
            Your starting GEO Score: {score} of 100
          </Text>
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            {scoreLabel(score)}
          </Text>
        </BlockStack>
      </Box>
      <Button variant="primary" onClick={onNext}>
        Fix the biggest issues for me
      </Button>
    </BlockStack>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "onboarding wizard step 2: starter audit + silent llms.txt

Fires runStarterAudit (5-product cap) and generateLlms in parallel
on mount. Audit completes with the existing GeoScoreRing reveal;
llms is fire-and-forget so the file is ready when the merchant
later visits the llms.txt Manager page.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Wizard step 3 (auto-fix wow + score animation)

**Files:**
- Modify: `app/routes/app._index.tsx` (OnboardingWizard step 3 block + new Step3 component)

Step 3 dispatches `autoFixIssues` with `maxIssues: 5`, then re-runs the starter audit to get the post-fix score, then animates the GeoScoreRing from the before score to the after score over 1.2 seconds. End state shows "Your GEO score went from X to Y" and a button to enter the dashboard.

We need a new action intent `runWizardAutoFix` that calls `autoFixIssues` with `maxIssues: 5` and then re-runs `runFullAudit` with `maxProducts: 5` and returns BOTH the autofix summary and the new score.

- [ ] **Step 1: Import `autoFixIssues` at the top of the file**

The file currently imports `runFullAudit` from `~/services/audit-engine.server` (line 27). Update that import to also include `autoFixIssues`:

```ts
import { autoFixIssues, runFullAudit } from "~/services/audit-engine.server";
```

- [ ] **Step 2: Add the `runWizardAutoFix` action intent**

In the action function, add this intent block after the `runStarterAudit` handler (which was added in Task 6):

```ts
  if (intent === "runWizardAutoFix") {
    try {
      // Bounded auto-fix: at most 5 attempted fixes so the wow step stays
      // under ~60s. Then re-run the starter audit so we can compute the
      // before/after score delta in one round-trip.
      const autoFix = await autoFixIssues(store.id, admin, { maxIssues: 5 });
      const audit = await runFullAudit(store.id, admin, { maxProducts: 5 });
      return {
        success: true,
        intent,
        fixedCount: autoFix.fixed,
        failedCount: autoFix.failed,
        afterScore: audit.storeScore,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Auto-fix failed." };
    }
  }
```

- [ ] **Step 3: Pass the `beforeScore` to Step2's `onNext` and propagate to Step3**

The `Step2` component currently calls `onNext()` with no argument. We need to pass the starting score forward so Step3 can show "went from X to Y". Update the `OnboardingWizard` function to track `beforeScore` in state:

Inside `OnboardingWizard`, just after the `const [step, setStep] = useState<1 | 2 | 3>(1);` line, add:

```ts
  const [beforeScore, setBeforeScore] = useState<number | null>(null);
```

Then update the `{step === 2 && ...}` JSX to pass a callback that captures the score before advancing:

```tsx
            {step === 2 && (
              <Step2
                fetcher={fetcher}
                onNext={(score) => {
                  setBeforeScore(score);
                  setStep(3);
                }}
              />
            )}
```

Update the `Step2` component's `onNext` prop type to `(score: number) => void` and call it with `score` (which is non-null at the point the merchant can click "Fix the biggest issues for me"). Replace the existing `onNext: () => void;` line in the Step2 props type with:

```ts
  onNext: (score: number) => void;
```

And update the final button in Step2 to pass the score:

```tsx
      <Button variant="primary" onClick={() => onNext(score)}>
        Fix the biggest issues for me
      </Button>
```

- [ ] **Step 4: Replace the step 3 placeholder with the Step3 component**

Find the `{/* Step 3 - The wow. Filled in Task 7. */}` block in `OnboardingWizard` and replace it with:

```tsx
            {/* Step 3 - The wow */}
            {step === 3 && beforeScore !== null && (
              <Step3
                fetcher={fetcher}
                beforeScore={beforeScore}
                onComplete={() => {
                  fetcher.submit(
                    { intent: "completeOnboarding" },
                    { method: "POST" }
                  );
                }}
              />
            )}
```

- [ ] **Step 5: Define the Step3 component inline**

Add the `Step3` component definition just below `Step2` (before the `// ─── Main Dashboard ───────────────────────────────────────────────────────────` divider):

```tsx
function Step3({
  fetcher,
  beforeScore,
  onComplete,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  beforeScore: number;
  onComplete: () => void;
}) {
  const [hasFired, setHasFired] = useState(false);
  const [animatedScore, setAnimatedScore] = useState(beforeScore);
  const data = fetcher.data as Record<string, unknown> | undefined;
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;
  const isFixing =
    fetcher.state !== "idle" && lastIntent === "runWizardAutoFix";

  const afterScore =
    data && data.intent === "runWizardAutoFix" && "afterScore" in data
      ? (data.afterScore as number)
      : null;
  const fixedCount =
    data && data.intent === "runWizardAutoFix" && "fixedCount" in data
      ? (data.fixedCount as number)
      : 0;
  const fixError =
    data && data.intent === "runWizardAutoFix" && "error" in data
      ? (data.error as string)
      : null;

  // Fire the auto-fix exactly once on mount.
  useEffect(() => {
    if (!hasFired) {
      fetcher.submit(
        { intent: "runWizardAutoFix" },
        { method: "POST" }
      );
      setHasFired(true);
    }
  }, [fetcher, hasFired]);

  // Animate the score ring from before to after over 1.2s once afterScore
  // arrives. Uses requestAnimationFrame; no new dependency.
  useEffect(() => {
    if (afterScore === null) return;
    if (afterScore === beforeScore) {
      setAnimatedScore(afterScore);
      return;
    }
    const start = performance.now();
    const duration = 1200;
    let frame: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quadratic
      const current = Math.round(beforeScore + (afterScore - beforeScore) * eased);
      setAnimatedScore(current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [afterScore, beforeScore]);

  // Auto-fix returned an error OR fixed 0 issues. Either way, no wow.
  // Don't block the merchant; let them continue to the dashboard with
  // their original score.
  if (fixError || (afterScore !== null && fixedCount === 0)) {
    return (
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Step 3 of 3
          </Text>
          <Text as="h2" variant="headingXl">
            Auto-fix didn&apos;t run this time
          </Text>
        </BlockStack>
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            {fixError
              ? "Auto-fix is temporarily unavailable, you can try it from the AI Audit page later."
              : "We didn't find any issues to fix automatically right now. You can review the audit results from the AI Audit page."}
          </Text>
        </Banner>
        <Box
          padding="400"
          background="bg-surface-secondary"
          borderRadius="200"
        >
          <BlockStack gap="200" align="center">
            <GeoScoreRing score={beforeScore} />
            <Text as="p" variant="headingMd" alignment="center">
              Your starting GEO Score: {beforeScore} of 100
            </Text>
          </BlockStack>
        </Box>
        <Button variant="primary" onClick={onComplete}>
          Open the dashboard
        </Button>
      </BlockStack>
    );
  }

  if (isFixing || afterScore === null) {
    return (
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            Step 3 of 3
          </Text>
          <Text as="h2" variant="headingXl">
            Claude is rewriting your content
          </Text>
        </BlockStack>
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="p" variant="bodySm">
            This takes about 60 seconds. Hold tight.
          </Text>
        </InlineStack>
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          Step 3 of 3
        </Text>
        <Text as="h2" variant="headingXl">
          Done. Your store just got better.
        </Text>
      </BlockStack>
      <Box padding="400" background="bg-surface-secondary" borderRadius="200">
        <BlockStack gap="200" align="center">
          <GeoScoreRing score={animatedScore} />
          <Text as="p" variant="headingMd" alignment="center">
            Your GEO Score: {beforeScore} -&gt; {afterScore}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            We just auto-fixed {fixedCount} {fixedCount === 1 ? "issue" : "issues"} on your top products.
          </Text>
        </BlockStack>
      </Box>
      <Button variant="primary" onClick={onComplete}>
        Open the dashboard
      </Button>
    </BlockStack>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "onboarding wizard step 3: auto-fix wow with score animation

Runs auto-fix (5-issue cap) followed by a re-audit, then animates
the GeoScoreRing from before to after over 1.2s via
requestAnimationFrame. Gracefully degrades to a static reveal when
auto-fix errors out or returns 0 fixes; the merchant always reaches
the dashboard.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Render the DiscoveryCards section on the main dashboard

**Files:**
- Modify: `app/routes/app._index.tsx` (main `Index` component, near the GEO score / Quick Actions row)

The main dashboard component (`Index` at line ~622) renders the existing dashboard sections. We add a new `DiscoveryCards` section between the Quick Actions row and the existing feature cards. The section renders the per-card subcomponents in the order returned by the loader.

- [ ] **Step 1: Read the current Index component to find the insertion point**

Run: `grep -n "Quick Actions\|recentActivity\|llmsFile\|geoScore" app/routes/app._index.tsx | head -30`

Look for where the main dashboard renders its cards. The DiscoveryCards section should sit AFTER the GEO score card and BEFORE existing per-feature sections. If the structure is ambiguous, place the section immediately after the row that contains the Quick Actions buttons (the buttons that include "Run AI Audit", "AI Simulator", "Blog Generator", etc.).

- [ ] **Step 2: Destructure `discoveryCards` from useLoaderData**

Find the existing `const { store, llmsFile, citationCount, issueCounts, recentActivity } = useLoaderData<LoaderData>();` line in the `Index` component (around line 623). Replace it with:

```ts
  const { store, llmsFile, citationCount, issueCounts, recentActivity, discoveryCards } =
    useLoaderData<LoaderData>();
```

- [ ] **Step 3: Render the DiscoveryCards section in the Index component**

Insert the `<DiscoveryCards />` element in the dashboard JSX after the Quick Actions row. The exact placement depends on the current structure; the principle is: under the score and above per-feature lists. Wrap in a Layout.Section if the dashboard uses Layout, or render as a Card group otherwise:

```tsx
{discoveryCards.length > 0 && store && (
  <Layout.Section>
    <DiscoveryCards
      cards={discoveryCards}
      shopifyDomain={store.shopifyDomain}
      fetcher={fetcher}
    />
  </Layout.Section>
)}
```

(If the existing dashboard renders cards directly under a `<Page>` or `<BlockStack>` instead of `<Layout>`, drop the `<Layout.Section>` wrapper and just render `{discoveryCards.length > 0 && store && (<DiscoveryCards ... />)}` inline at the same nesting level as the other top-level dashboard cards.)

- [ ] **Step 4: Define the DiscoveryCards component inline**

Add the `DiscoveryCards` component definition immediately before the `Index` component (so before `export default function Index()`):

```tsx
function DiscoveryCards({
  cards,
  shopifyDomain,
  fetcher,
}: {
  cards: DiscoveryCard[];
  shopifyDomain: string;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
}) {
  const themeEditorUrl = `https://${shopifyDomain}/admin/themes/current/editor?context=apps`;
  const isWorking = fetcher.state !== "idle";
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Get more from GEO Rise
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Features that take a few minutes to set up and pay off every week
            after.
          </Text>
        </BlockStack>
        <Divider />
        <BlockStack gap="400">
          {cards.map((card) => {
            if (card === "schema") {
              return (
                <DiscoveryCardSchema
                  key={card}
                  themeEditorUrl={themeEditorUrl}
                  fetcher={fetcher}
                  isWorking={isWorking && lastIntent === "markSchemaEnabled"}
                />
              );
            }
            if (card === "tracking") {
              return <DiscoveryCardTracking key={card} />;
            }
            if (card === "competitors") {
              return <DiscoveryCardCompetitors key={card} />;
            }
            if (card === "blog") {
              return <DiscoveryCardBlog key={card} />;
            }
            if (card === "simulator") {
              return <DiscoveryCardSimulator key={card} />;
            }
            if (card === "weeklyEmail") {
              return (
                <DiscoveryCardWeeklyEmail
                  key={card}
                  fetcher={fetcher}
                  isWorking={isWorking && lastIntent === "toggleWeeklyEmail"}
                />
              );
            }
            return null;
          })}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function DiscoveryCardSchema({
  themeEditorUrl,
  fetcher,
  isWorking,
}: {
  themeEditorUrl: string;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  isWorking: boolean;
}) {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Enable AI Schema Injection
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        Add structured data to your product pages so ChatGPT, Gemini, and
        Perplexity can fully understand what you sell. Takes 30 seconds in
        your Shopify theme editor.
      </Text>
      <InlineStack gap="200">
        <Button variant="primary" url={themeEditorUrl} target="_blank">
          Open Theme Editor
        </Button>
        <Button
          variant="plain"
          loading={isWorking}
          onClick={() => {
            fetcher.submit(
              { intent: "markSchemaEnabled" },
              { method: "POST" }
            );
          }}
        >
          I&apos;ve enabled it
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

function DiscoveryCardTracking() {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Set up AI Tracking
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        See when ChatGPT, Claude, and Perplexity mention your products. We can
        suggest prompts based on your catalog.
      </Text>
      <Button variant="primary" url="/app/tracking">
        Go to AI Tracking
      </Button>
    </BlockStack>
  );
}

function DiscoveryCardCompetitors() {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Add a competitor to monitor
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        Compare your AI visibility head-to-head with rivals in your niche.
      </Text>
      <Button variant="primary" url="/app/competitors">
        Go to Competitors
      </Button>
    </BlockStack>
  );
}

function DiscoveryCardBlog() {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Generate your first blog post
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        AI-written posts grounded in your real catalog, structured for ChatGPT
        to cite. Publish to your Shopify blog with one click.
      </Text>
      <Button variant="primary" url="/app/blog-generator">
        Go to Blog Generator
      </Button>
    </BlockStack>
  );
}

function DiscoveryCardSimulator() {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Run AI Simulator
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        See exactly what ChatGPT and Claude extract from any product page on
        your store.
      </Text>
      <Button variant="primary" url="/app/simulator">
        Go to AI Simulator
      </Button>
    </BlockStack>
  );
}

function DiscoveryCardWeeklyEmail({
  fetcher,
  isWorking,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  isWorking: boolean;
}) {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        Turn on weekly insight emails
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        A weekly digest of your GEO score, top actions, competitor citation
        rates, and AI mentions. Lands in your inbox every Monday.
      </Text>
      <Button
        variant="primary"
        loading={isWorking}
        onClick={() => {
          const formData = new FormData();
          formData.append("intent", "toggleWeeklyEmail");
          formData.append("enabled", "true");
          fetcher.submit(formData, { method: "POST" });
        }}
      >
        Turn on weekly emails
      </Button>
    </BlockStack>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "dashboard: render DiscoveryCards section under Quick Actions

Renders six feature-discovery cards (schema, tracking, competitors,
blog, simulator, weekly email) based on the loader's discoveryCards
array. Each card auto-dismisses on the next loader pass once the
underlying usage signal flips.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Em-dash sweep + final verification

**Files:**
- Verify: all files modified in tasks 1-8

The project bans em-dashes (U+2014) in all code, copy, and AI prompts. Verify the new code has none, then run the full build and a smoke test.

- [ ] **Step 1: Em-dash grep on touched files**

Run: `grep -n "—" app/routes/app._index.tsx app/services/audit-engine.server.ts`
Expected: only matches inside regex literals or escape sequences (none in copy or comments). If any em-dash appears in user-facing copy, replace with comma + space.

- [ ] **Step 2: Final typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build completes with no errors. The pre-existing CSS print warning and dynamic-import advisory are unrelated to this work and remain.

- [ ] **Step 4: Manual smoke test on boda-brands**

After pushing the commits to main, wait for Render to auto-deploy. Then verify:

1. **Existing merchant dashboard**: open GEO Rise as your existing boda-brands user. The Discovery Cards section should appear if you have not used each feature. Specifically:
   - Schema Injection card: shown if `store.schemaInjectionEnabled` is false in DB
   - Tracking, Competitors, Blog, Simulator cards: shown only if you have zero rows in the corresponding table
   - Weekly Email card: shown only if `weeklyInsightEnabled` is false
2. **Click each visible card's CTA**: verify navigation works (routes to /app/tracking, /app/competitors, etc.) and external Theme Editor opens in a new tab.
3. **Mark schema enabled**: click "I've enabled it" on the Schema card. Toast appears, card disappears on next page load.
4. **New onboarding flow**: to test, manually set `store.onboardingCompleted = false` in the DB for boda-brands, then reload the dashboard. The 3-step wizard should appear:
   - Step 1 (Welcome): clicks through.
   - Step 2 (Audit + reveal): spinner for ~30-60s, then GeoScoreRing reveal with the starter score. `llms.txt` is also regenerated in the background (verify by visiting llms.txt Manager and checking lastGeneratedAt).
   - Step 3 (Auto-fix wow): spinner, then score animates from before to after, with "Auto-fixed N issues" copy.
   - Clicking "Open the dashboard" sets `onboardingCompleted = true` and reloads.
5. **Wizard error fallback**: optional - temporarily unset `ANTHROPIC_API_KEY` to force auto-fix failure, verify Step 3 shows the graceful "Auto-fix didn't run" state and the merchant can still proceed.

- [ ] **Step 5: Push**

```bash
git push origin main
```

- [ ] **Step 6: Update memory checkpoint**

Update `C:\Users\nyima\.claude\projects\-Users-lukas-Desktop-geo-app\memory\project_checkpoint.md`:
- Change "Last updated" timestamp to today.
- Add a changelog entry at the top describing this work.
- Bump the latest deploy commit reference.

---

## Self-review notes

**Spec coverage check**: all spec sections (3-step wizard, silent llms.txt, auto-fix wow with animation, dashboard cards with plan-aware visibility, edge cases for zero-product and auto-fix failure) are covered by Tasks 1-8. Task 9 handles verification + memory update.

**Type consistency check**:
- `DiscoveryCard` union type defined in Task 3, used in Tasks 3 and 8.
- `Step2.onNext` signature is `(score: number) => void` in Task 7's update.
- `runStarterAudit` intent name matches between Task 6's action and Task 6's component.
- `runWizardAutoFix` intent name matches between Task 7's action and Task 7's component.
- `markSchemaEnabled` intent name matches between Task 4's action and Task 8's `DiscoveryCardSchema` component.
- `autoFixIssues` already exists; Task 7 imports it. Task 1 adds the `maxIssues` option that Task 7 passes.

**Risk note**: Task 5 leaves the wizard with placeholder Step 2 and Step 3 content. Between Task 5 and Task 6's completion, the wizard is in a "halfway" state. If you stop mid-way and ship, new merchants will see the placeholder text. Don't ship between Task 5 and Task 6, OR run them as a batch and commit once.

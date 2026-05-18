import { useEffect, useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  ButtonGroup,
  BlockStack,
  InlineStack,
  Badge,
  ProgressBar,
  Banner,
  CalloutCard,
  ResourceList,
  ResourceItem,
  Box,
  Divider,
  Spinner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { generateLlmsTxt } from "~/services/llms-generator.server";
import { autoFixIssues, runFullAudit } from "~/services/audit-engine.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import { timeAgo } from "~/utils/time";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoreData {
  id: string;
  shopifyDomain: string;
  shopName: string;
  email: string | null;
  plan: string;
  geoScore: number;
  totalProducts: number;
  auditedProducts: number;
  onboardingCompleted: boolean;
  installedAt: string;
  weeklyInsightEnabled: boolean;
  lastInsightSentAt: string | null;
  schemaInjectionEnabled: boolean;
}

type DiscoveryCard =
  | "schema"
  | "tracking"
  | "competitors"
  | "blog"
  | "simulator"
  | "weeklyEmail";

interface ActivityItem {
  id: string;
  type: "audit" | "llms" | "install";
  title: string;
  detail: string;
  timestamp: string;
}

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

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Auto-create store record on first load
  let store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
  });

  if (!store) {
    store = await prisma.store.create({
      data: {
        shopifyDomain: session.shop,
        shopifyAccessToken: session.accessToken ?? "",
        shopName: session.shop.replace(".myshopify.com", ""),
      },
    });
  }

  // Backfill `store.email` from Shopify the first time the merchant lands
  // on the dashboard. Earlier installs created the Store row without an
  // email which broke the "Send a test email now" button - it can't send
  // anywhere if we don't know where. We pull `shop.email` (the owner
  // login email - the operator we want to email weekly digests to) rather
  // than `shop.contactEmail` (the customer-facing support address, which
  // is sometimes blank). One-shot: only fetches when the column is null,
  // so it costs nothing on subsequent loads.
  if (!store.email) {
    try {
      const shopResponse = await admin.graphql(
        `#graphql
         query GetShopOwnerEmail {
           shop { email }
         }`
      );
      const shopJson = (await shopResponse.json()) as {
        data?: { shop?: { email?: string | null } };
      };
      const shopEmail = shopJson.data?.shop?.email;
      if (shopEmail) {
        store = await prisma.store.update({
          where: { id: store.id },
          data: { email: shopEmail },
        });
      }
    } catch (err) {
      // Non-fatal: dashboard still renders without the email; the Weekly
      // Insight card just keeps showing "No email on file" until next try.
      console.error("[GEO Rise] Failed to backfill shop email:", err);
    }
  }

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

  const issueCounts = {
    total: auditResults.length,
    critical: auditResults.filter((r) => r.severity === "CRITICAL").length,
    high: auditResults.filter((r) => r.severity === "HIGH").length,
  };

  const activity: ActivityItem[] = [];
  if (auditResults.length > 0) {
    activity.push({
      id: "audit",
      type: "audit",
      title: `Audit completed - GEO score: ${store.geoScore}`,
      detail: `${store.auditedProducts} products audited, ${issueCounts.total} issues found`,
      timestamp: auditResults[0].createdAt.toISOString(),
    });
  }
  if (llmsFile?.lastGeneratedAt) {
    activity.push({
      id: "llms",
      type: "llms",
      title: "llms.txt regenerated",
      detail: `${llmsFile.productCount} products included`,
      timestamp: llmsFile.lastGeneratedAt.toISOString(),
    });
  }
  activity.push({
    id: "install",
    type: "install",
    title: "GEO Rise installed",
    detail: `Connected to ${store.shopName}`,
    timestamp: store.installedAt.toISOString(),
  });

  // Compute the feature-discovery cards to show on the dashboard. Each card
  // is filtered by plan + a usage signal (zero rows in the relevant table
  // means the merchant hasn't tried that feature yet). Once they use a
  // feature, the corresponding card auto-dismisses on the next loader pass.
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
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
  });
  if (!store) return { error: "Store not found." };

  if (intent === "generateLlms") {
    try {
      // Pass the plan's product cap into the service so Free-plan stores
      // don't accidentally publish their entire catalog in the public
      // llms.txt file.
      const planLimits =
        PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
      const result = await generateLlmsTxt(store.id, {
        maxProducts: planLimits.maxProductsInLlmsTxt,
      });
      return { success: true, intent, productCount: result.productCount };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Generation failed." };
    }
  }

  if (intent === "runAudit") {
    try {
      // Plan limit MUST flow through the service layer - calling
      // runFullAudit without `maxProducts` previously let a Free merchant
      // audit their entire catalog by triggering the audit from the
      // dashboard instead of the audit page.
      const planLimits =
        PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
      const summary = await runFullAudit(store.id, admin, {
        maxProducts: planLimits.maxAuditProducts,
      });
      return { success: true, intent, storeScore: summary.storeScore };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Audit failed." };
    }
  }

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

  if (intent === "completeOnboarding") {
    await prisma.store.update({
      where: { id: store.id },
      data: { onboardingCompleted: true },
    });
    return { success: true, intent };
  }

  if (intent === "toggleWeeklyEmail") {
    // Plan-tier guard: only paid plans get insight emails. Block the toggle
    // from being enabled on FREE - the cron tick filters them out anyway,
    // but failing fast surfaces "upgrade required" instead of silently
    // toggling a flag that has no effect.
    const planLimits =
      PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
    const wantsEnable = formData.get("enabled") === "true";
    if (wantsEnable && !planLimits.insightEmails) {
      return {
        error: "Weekly insight emails are a Growth/Pro/Enterprise feature.",
      };
    }
    await prisma.store.update({
      where: { id: store.id },
      data: { weeklyInsightEnabled: wantsEnable },
    });
    return { success: true, intent, weeklyInsightEnabled: wantsEnable };
  }

  if (intent === "sendTestEmail") {
    const planLimits =
      PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
    if (!planLimits.insightEmails) {
      return {
        error: "Insight emails are a Growth/Pro/Enterprise feature.",
      };
    }
    const { sendInsightEmail } = await import(
      "~/services/insight-email.server"
    );
    const result = await sendInsightEmail(store.id);
    if (result.sent) {
      return { success: true, intent };
    }
    return {
      error: result.reason ?? "Couldn't send the test email.",
    };
  }

  if (intent === "markSchemaEnabled") {
    // Self-reported confirmation from the merchant's "I've enabled it"
    // click on the Discovery Card. We have no reliable server-side way
    // to detect the theme-extension toggle change inside Shopify's theme
    // editor, so this is a one-click "yes, I did it" handshake.
    await prisma.store.update({
      where: { id: store.id },
      data: { schemaInjectionEnabled: true },
    });
    return { success: true, intent };
  }

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number) {
  if (score < 40) return "#E24B4A";
  if (score < 70) return "#EF9F27";
  return "#1D9E75";
}

function scoreLabel(score: number) {
  if (score < 50)
    return "Your products are mostly invisible to AI search. Run an audit to see what's wrong.";
  if (score < 75)
    return "Good start, but AI still misses key product details. Run an audit to find gaps.";
  return "Great! Your store is well-optimized for AI discovery. Keep it up.";
}

// `timeAgo` is now imported from ~/utils/time. The previous local
// implementation produced "-1m ago" for timestamps newer than 60s
// (Math.floor of a negative diff). The shared helper clamps to
// "just now" instead.

/** Estimate when the next weekly digest will fire given the last-sent
 *  timestamp. Matches the runWeeklyInsightDigest cutoff (6.5 days). */
function nextSendHint(lastSentIso: string): string {
  const lastSent = new Date(lastSentIso).getTime();
  const nextEligible = lastSent + 6.5 * 24 * 60 * 60 * 1000;
  const diffMs = nextEligible - Date.now();
  if (diffMs <= 0) return "scheduled for the next daily cron tick";
  const hrs = Math.round(diffMs / 3600000);
  if (hrs < 24) return `scheduled in ~${hrs}h`;
  const days = Math.round(hrs / 24);
  return `scheduled in ~${days}d`;
}

// ─── Circular Progress Ring ───────────────────────────────────────────────────

function GeoScoreRing({ score }: { score: number }) {
  const r = 60;
  const c = 2 * Math.PI * r;
  const offset = c - (score / 100) * c;
  const color = scoreColor(score);

  return (
    <svg
      width="160"
      height="160"
      viewBox="0 0 160 160"
      aria-label={`GEO Score: ${score} out of 100`}
      style={{ display: "block", margin: "0 auto" }}
    >
      <circle cx="80" cy="80" r={r} fill="none" stroke="#E4E5E7" strokeWidth="14" />
      <circle
        cx="80"
        cy="80"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="14"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 80 80)"
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text
        x="80"
        y="72"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="30"
        fontWeight="700"
        fill={color}
      >
        {score}
      </text>
      <text
        x="80"
        y="95"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="12"
        fill="#6D7175"
      >
        / 100
      </text>
    </svg>
  );
}

// ─── Onboarding Wizard ────────────────────────────────────────────────────────

function OnboardingWizard({
  shopName,
}: {
  shopName: string;
  shopifyDomain: string;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [beforeScore, setBeforeScore] = useState<number | null>(null);
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const lastData = fetcher.data as Record<string, unknown> | undefined;

  // The completeOnboarding intent reloads to the regular dashboard.
  // Step 2 and Step 3 handle their own action dispatch / state internally.
  useEffect(() => {
    if (!lastData || fetcher.state !== "idle") return;
    if ("error" in lastData && lastData.intent === "completeOnboarding") {
      shopify.toast.show(lastData.error as string, { isError: true });
      return;
    }
    if (lastData.intent === "completeOnboarding") {
      window.location.reload();
    }
  }, [lastData, fetcher.state, shopify]);

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

            {/* Step 2 - Audit + score reveal */}
            {step === 2 && (
              <Step2
                fetcher={fetcher}
                onNext={(score) => {
                  setBeforeScore(score);
                  setStep(3);
                }}
              />
            )}

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
          </BlockStack>
        </Card>
      </div>
    </Page>
  );
}

function Step2({
  fetcher,
  onNext,
}: {
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  onNext: (score: number) => void;
}) {
  const [hasFiredAudit, setHasFiredAudit] = useState(false);
  const [hasFiredLlms, setHasFiredLlms] = useState(false);
  const data = fetcher.data as Record<string, unknown> | undefined;
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;
  const isAuditing =
    fetcher.state !== "idle" && lastIntent === "runStarterAudit";
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
      fetcher.submit({ intent: "runStarterAudit" }, { method: "POST" });
      setHasFiredAudit(true);
    }
    if (!hasFiredLlms) {
      // Fire-and-forget llms-gen via a separate plain fetch so the audit
      // result still lands on `fetcher.data`. If it fails, the merchant
      // can regenerate from the llms.txt Manager page.
      const formData = new FormData();
      formData.append("intent", "generateLlms");
      fetch(window.location.pathname, {
        method: "POST",
        body: formData,
      }).catch((err) => {
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
          {/* Wizard-specific message that primes the next step (auto-fix).
              The generic scoreLabel() copy used elsewhere ends with "Run an
              audit to find gaps", which is wrong here, the audit just ran. */}
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            {score >= 80
              ? "Looking strong. Let's see if we can push it higher in the next step."
              : score >= 60
                ? "Solid start. Next we'll auto-fix the biggest gaps we found."
                : "Lots of room to grow. Next we'll auto-fix the biggest issues we found."}
          </Text>
        </BlockStack>
      </Box>
      <Button variant="primary" onClick={() => onNext(score)}>
        Fix the biggest issues for me
      </Button>
    </BlockStack>
  );
}

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
      fetcher.submit({ intent: "runWizardAutoFix" }, { method: "POST" });
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
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quadratic
      const current = Math.round(
        beforeScore + (afterScore - beforeScore) * eased
      );
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
            Your GEO Score: {beforeScore} to {afterScore}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            We just auto-fixed {fixedCount}{" "}
            {fixedCount === 1 ? "issue" : "issues"} on your top products.
          </Text>
        </BlockStack>
      </Box>
      <Button variant="primary" onClick={onComplete}>
        Open the dashboard
      </Button>
    </BlockStack>
  );
}

// ─── Discovery Cards ──────────────────────────────────────────────────────────

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

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Index() {
  const { store, llmsFile, citationCount, issueCounts, recentActivity, discoveryCards } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // All hooks must be called unconditionally on every render, before any
  // early return - otherwise the order changes between renders and React
  // throws "rendered fewer hooks than expected" once onboarding completes.
  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if (data.intent === "generateLlms") {
      shopify.toast.show(`llms.txt generated with ${data.productCount} products!`);
    } else if (data.intent === "runAudit") {
      shopify.toast.show(`Audit complete! GEO score: ${data.storeScore}/100`);
    } else if (data.intent === "toggleWeeklyEmail") {
      shopify.toast.show(
        data.weeklyInsightEnabled
          ? "Weekly insight emails on - you'll get the next one within ~7 days"
          : "Weekly insight emails turned off"
      );
    } else if (data.intent === "sendTestEmail") {
      shopify.toast.show("Test email sent - check your inbox");
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const submit = useCallback(
    (intent: string) => fetcher.submit({ intent }, { method: "POST" }),
    [fetcher]
  );

  if (!store || !store.onboardingCompleted) {
    return (
      <OnboardingWizard
        shopName={store?.shopName ?? "your store"}
        shopifyDomain={store?.shopifyDomain ?? ""}
      />
    );
  }

  const isLoading = fetcher.state !== "idle";
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;

  const hasLlms = llmsFile?.hasContent ?? false;
  const hasAudit = store.auditedProducts > 0;
  const isFreePlan = store.plan === "FREE";

  return (
    <Page>
      <TitleBar title={`GEO Rise - ${store.shopName}`} />

      <BlockStack gap="600">
        {/* ── ROW 1: GEO Score ── */}
        <Card>
          <Layout>
            <Layout.Section variant="oneThird">
              <Box padding="400">
                <div style={{ textAlign: "center" }}>
                  <GeoScoreRing score={store.geoScore} />
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                    GEO Score
                  </Text>
                </div>
              </Box>
            </Layout.Section>

            <Layout.Section>
              <Box padding="400">
                <BlockStack gap="400" inlineAlign="start">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingXl">
                      Your store is{" "}
                      <span style={{ color: scoreColor(store.geoScore) }}>
                        {store.geoScore}% ready
                      </span>{" "}
                      for AI discovery
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {scoreLabel(store.geoScore)}
                    </Text>
                  </BlockStack>

                  <Divider />

                  <InlineStack gap="500">
                    {[
                      { label: "Products optimized", value: `${store.auditedProducts}/${store.totalProducts}` },
                      { label: "Issues found", value: String(issueCounts.total) },
                      { label: "Critical", value: String(issueCounts.critical) },
                    ].map(({ label, value }) => (
                      <BlockStack gap="050" key={label}>
                        <Text as="p" variant="bodyLg" fontWeight="bold">{value}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                      </BlockStack>
                    ))}
                  </InlineStack>

                  <Button variant="primary" url="/app/audit">
                    {hasAudit ? "View Full Audit Report" : "Run First Audit"}
                  </Button>
                </BlockStack>
              </Box>
            </Layout.Section>
          </Layout>
        </Card>

        {/* ── ROW 2: Stats grid ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Audited</Text>
              <Text as="p" variant="headingLg">
                {store.auditedProducts}
                <Text as="span" variant="bodyMd" tone="subdued">/{store.totalProducts}</Text>
              </Text>
              <ProgressBar
                progress={store.totalProducts > 0 ? (store.auditedProducts / store.totalProducts) * 100 : 0}
                size="small"
                tone="success"
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">AI Citations</Text>
              {isFreePlan ? (
                <BlockStack gap="100">
                  <Text as="p" variant="headingLg">🔒</Text>
                  <Button size="slim" url="/app/pricing" variant="plain">Upgrade to track</Button>
                </BlockStack>
              ) : (
                <Text as="p" variant="headingLg">{citationCount}</Text>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">Issues</Text>
              <Text as="p" variant="headingLg">{issueCounts.total}</Text>
              <Text as="p" variant="bodySm" tone="critical">
                {issueCounts.critical} critical, {issueCounts.high} high
              </Text>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" tone="subdued">llms.txt</Text>
              <Badge tone={hasLlms ? "success" : "attention"}>
                {hasLlms ? "Active" : "Not Generated"}
              </Badge>
              {llmsFile?.lastGeneratedAt && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Updated {timeAgo(llmsFile.lastGeneratedAt)}
                </Text>
              )}
            </BlockStack>
          </Card>
        </div>

        {/* ── ROW 3: Quick actions ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Quick Actions</Text>
            <ButtonGroup>
              <Button
                variant={hasLlms ? "secondary" : "primary"}
                onClick={() => submit("generateLlms")}
                loading={isLoading && lastIntent === "generateLlms"}
              >
                {hasLlms ? "Regenerate llms.txt" : "Generate llms.txt"}
              </Button>
              <Button
                variant={hasAudit ? "secondary" : "primary"}
                onClick={() => submit("runAudit")}
                loading={isLoading && lastIntent === "runAudit"}
              >
                {hasAudit ? "Re-run AI Audit" : "Run AI Audit"}
              </Button>
              {hasAudit && (
                <Button url="/app/action-plan">See Action Plan</Button>
              )}
              <Button url="/app/simulator">Try AI Simulation</Button>
              {!isFreePlan && (
                <Button url="/app/tracking">AI Visibility Tracking</Button>
              )}
              {!isFreePlan && (
                <Button url="/app/blog-generator">Blog Generator</Button>
              )}
              <Button url="/app/llms-txt">llms.txt Manager</Button>
              {!isFreePlan && <Button url="/app/pricing">View Plan</Button>}
            </ButtonGroup>
            {isLoading && (
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" />
                <Text as="p" variant="bodySm" tone="subdued">
                  {lastIntent === "generateLlms"
                    ? "Generating llms.txt… this takes about 30 seconds."
                    : "Running audit… this may take a minute for large catalogs."}
                </Text>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        {/* ── ROW 3.25: Discovery cards ── */}
        {/* Persistent "Get more from GEO Rise" section. Cards auto-dismiss
            once the merchant has used the feature; the whole section
            hides when all eligible cards are dismissed (computed loader-side). */}
        {discoveryCards.length > 0 && (
          <DiscoveryCards
            cards={discoveryCards}
            shopifyDomain={store.shopifyDomain}
            fetcher={fetcher}
          />
        )}

        {/* ── ROW 3.5: Weekly insight email preferences ── */}
        {/* Paid plans only - Free plan hides the card. Lets merchant toggle
            the weekly digest and send a one-off test to verify deliverability
            before the next scheduled run. */}
        {!isFreePlan && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Weekly insight email
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  We&apos;ll email a digest to{" "}
                  <strong>{store.email ?? "your store contact"}</strong> every
                  ~7 days with your GEO score, top action items, and recent AI
                  tracking activity. Currently:{" "}
                  <strong>
                    {store.weeklyInsightEnabled ? "on" : "off"}
                  </strong>
                  .{" "}
                  {store.lastInsightSentAt ? (
                    <>
                      Last sent {timeAgo(store.lastInsightSentAt)}.
                      {store.weeklyInsightEnabled
                        ? ` Next ${nextSendHint(store.lastInsightSentAt)}.`
                        : ""}
                    </>
                  ) : store.weeklyInsightEnabled ? (
                    <>
                      Nothing sent yet, but the next scheduled cron tick will
                      pick this store up.
                    </>
                  ) : (
                    <>No emails sent yet.</>
                  )}
                </Text>
              </BlockStack>
              <InlineStack gap="300" blockAlign="center" wrap>
                <fetcher.Form method="POST">
                  <input
                    type="hidden"
                    name="intent"
                    value="toggleWeeklyEmail"
                  />
                  <input
                    type="hidden"
                    name="enabled"
                    value={String(!store.weeklyInsightEnabled)}
                  />
                  <Button
                    submit
                    loading={
                      isLoading && lastIntent === "toggleWeeklyEmail"
                    }
                    disabled={isLoading && lastIntent !== "toggleWeeklyEmail"}
                  >
                    {store.weeklyInsightEnabled
                      ? "Turn off weekly emails"
                      : "Turn on weekly emails"}
                  </Button>
                </fetcher.Form>
                <Button
                  onClick={() => submit("sendTestEmail")}
                  loading={isLoading && lastIntent === "sendTestEmail"}
                  disabled={
                    !store.email ||
                    (isLoading && lastIntent !== "sendTestEmail")
                  }
                >
                  Send a test email now
                </Button>
                {!store.email && (
                  <Text as="span" variant="bodySm" tone="critical">
                    No email on file - set it in your Shopify store contact.
                  </Text>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {/* ── ROW 4: Plan upgrade ── */}
        {/* Pricing pulls from PLAN_DEFINITIONS so we don't drift again - this
            copy was stale-by-a-pivot until late on 2026-05-17. */}
        {isFreePlan ? (
          <CalloutCard
            title="Unlock the full GEO Rise experience"
            illustration=""
            primaryAction={{ content: "Start 7-day free trial →", url: "/app/pricing" }}
          >
            <Text as="p" variant="bodyMd">
              You&apos;re on the Free plan. Upgrade to{" "}
              <strong>
                {PLAN_DEFINITIONS.GROWTH.name} (${PLAN_DEFINITIONS.GROWTH.price}/mo)
              </strong>{" "}
              to unlock unlimited product audits and auto-fix,{" "}
              {PLAN_LIMITS.GROWTH.maxTrackingPrompts} AI tracking prompts across
              Claude / ChatGPT / Perplexity, and the multi-AI simulator - with
              a 7-day free trial.
            </Text>
          </CalloutCard>
        ) : store.plan === "GROWTH" ? (
          <Banner
            tone="info"
            action={{ content: `Upgrade to ${PLAN_DEFINITIONS.PRO.name}`, url: "/app/pricing" }}
          >
            <Text as="p" variant="bodyMd">
              Tracking up to {PLAN_LIMITS.GROWTH.maxTrackingPrompts} prompts on
              Growth - upgrade to{" "}
              <strong>
                {PLAN_DEFINITIONS.PRO.name} (${PLAN_DEFINITIONS.PRO.price}/mo)
              </strong>{" "}
              for {PLAN_LIMITS.PRO.maxTrackingPrompts} prompts and scheduled
              daily/weekly checks.
            </Text>
          </Banner>
        ) : null}

        {/* ── ROW 5: Recent activity ── */}
        {recentActivity.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recent Activity</Text>
              <ResourceList
                resourceName={{ singular: "event", plural: "events" }}
                items={recentActivity}
                renderItem={(item) => (
                  <ResourceItem id={item.id} onClick={() => {}} shortcutActions={[]}>
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">{item.title}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">{item.detail}</Text>
                      </BlockStack>
                      <Text as="p" variant="bodySm" tone="subdued">{timeAgo(item.timestamp)}</Text>
                    </InlineStack>
                  </ResourceItem>
                )}
              />
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

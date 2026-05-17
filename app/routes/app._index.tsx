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
import { runFullAudit } from "~/services/audit-engine.server";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoreData {
  id: string;
  shopifyDomain: string;
  shopName: string;
  plan: string;
  geoScore: number;
  totalProducts: number;
  auditedProducts: number;
  onboardingCompleted: boolean;
  installedAt: string;
}

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
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

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

  const [llmsFile, auditResults, citations] = await Promise.all([
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
      title: `Audit completed — GEO score: ${store.geoScore}`,
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

  return {
    store: { ...store, installedAt: store.installedAt.toISOString() },
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
      const result = await generateLlmsTxt(store.id);
      return { success: true, intent, productCount: result.productCount };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Generation failed." };
    }
  }

  if (intent === "runAudit") {
    try {
      const summary = await runFullAudit(store.id, admin);
      return { success: true, intent, storeScore: summary.storeScore };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Audit failed." };
    }
  }

  if (intent === "completeOnboarding") {
    await prisma.store.update({
      where: { id: store.id },
      data: { onboardingCompleted: true },
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

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
  shopifyDomain,
}: {
  shopName: string;
  shopifyDomain: string;
}) {
  const [step, setStep] = useState(1);
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isLoading = fetcher.state !== "idle";
  const lastData = fetcher.data as Record<string, unknown> | undefined;
  const lastIntent = fetcher.formData?.get("intent") as string | undefined;

  // Displayed dot count (steps 3 and 4 share dot 3)
  const dotStep = step <= 3 ? step : step - 1;

  useEffect(() => {
    if (!lastData || fetcher.state !== "idle") return;
    if ("error" in lastData) {
      shopify.toast.show(lastData.error as string, { isError: true });
      return;
    }
    if (lastData.intent === "generateLlms") setStep(3);
    if (lastData.intent === "runAudit") setStep(4);
    if (lastData.intent === "completeOnboarding") window.location.reload();
  }, [lastData, fetcher.state, shopify]);

  const submit = (intent: string) =>
    fetcher.submit({ intent }, { method: "POST" });

  const storeScore =
    lastData && "storeScore" in lastData ? (lastData.storeScore as number) : null;

  const themeEditorUrl = `https://${shopifyDomain}/admin/themes/current/editor?context=apps`;

  return (
    <Page>
      <TitleBar title="Welcome to GEO Rise" />
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <Card>
          <BlockStack gap="600">
            {/* Step dots — 4 steps total */}
            <InlineStack align="center" gap="200">
              {[1, 2, 3, 4].map((n) => (
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
                      dotStep > n ? "#1D9E75" : dotStep === n ? "#008060" : "#E4E5E7",
                    color: dotStep >= n ? "#fff" : "#6D7175",
                  }}
                >
                  {dotStep > n ? "✓" : n}
                </span>
              ))}
            </InlineStack>

            {/* Step 1 — Welcome */}
            {step === 1 && (
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Step 1 of 4</Text>
                  <Text as="h2" variant="headingXl">Welcome to GEO Rise, {shopName}!</Text>
                </BlockStack>
                <Text as="p" variant="bodyMd">
                  GEO Rise helps AI search engines like ChatGPT, Gemini, and
                  Perplexity discover and recommend your products. Let&apos;s
                  get your store AI-ready in 4 quick steps.
                </Text>
                <Button variant="primary" onClick={() => setStep(2)}>
                  Let&apos;s go →
                </Button>
              </BlockStack>
            )}

            {/* Step 2 — Generate llms.txt */}
            {step === 2 && (
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Step 2 of 4</Text>
                  <Text as="h2" variant="headingXl">Generate your AI sitemap</Text>
                </BlockStack>
                <Text as="p" variant="bodyMd">
                  We&apos;ll create an <strong>llms.txt</strong> file — a
                  sitemap specifically for AI engines. This tells ChatGPT and
                  other AI tools exactly what your store sells, including
                  product details, prices, and availability.
                </Text>
                {isLoading && lastIntent === "generateLlms" && (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" />
                    <Text as="p" variant="bodySm">Generating your llms.txt…</Text>
                  </InlineStack>
                )}
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={() => submit("generateLlms")}
                    loading={isLoading && lastIntent === "generateLlms"}
                  >
                    Generate llms.txt
                  </Button>
                  <Button variant="plain" onClick={() => setStep(3)} disabled={isLoading}>
                    I&apos;ll do this later
                  </Button>
                </InlineStack>
              </BlockStack>
            )}

            {/* Step 3 — Audit (pre-run) / Step 4 — Audit result */}
            {(step === 3 || step === 4) && (
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Step 3 of 4</Text>
                  <Text as="h2" variant="headingXl">See how AI sees your store</Text>
                </BlockStack>
                <Text as="p" variant="bodyMd">
                  Let&apos;s run a quick AI readiness audit on your products.
                  This gives you a GEO score and shows exactly what AI search
                  engines can — and can&apos;t — see about your store.
                </Text>

                {step === 4 && storeScore !== null && (
                  <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="200" align="center">
                      <GeoScoreRing score={storeScore} />
                      <Text as="p" variant="headingMd" alignment="center">
                        Your GEO Score: {storeScore}/100
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                        {scoreLabel(storeScore)}
                      </Text>
                    </BlockStack>
                  </Box>
                )}

                {isLoading && lastIntent === "runAudit" && (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" />
                    <Text as="p" variant="bodySm">Auditing your products…</Text>
                  </InlineStack>
                )}

                <InlineStack gap="300">
                  {step === 3 && (
                    <Button
                      variant="primary"
                      onClick={() => submit("runAudit")}
                      loading={isLoading && lastIntent === "runAudit"}
                    >
                      Run Quick Audit
                    </Button>
                  )}
                  {step === 4 && (
                    <Button variant="primary" onClick={() => setStep(5)}>
                      Continue →
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            )}

            {/* Step 5 — Enable theme app extension */}
            {step === 5 && (
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Step 4 of 4</Text>
                  <Text as="h2" variant="headingXl">Enable AI Schema Injection</Text>
                </BlockStack>
                <Text as="p" variant="bodyMd">
                  This adds structured data (JSON-LD) to your product pages so
                  AI engines like ChatGPT and Gemini can fully understand what
                  you sell. It&apos;s automatic and won&apos;t affect your
                  store&apos;s design or speed.
                </Text>
                <Box
                  padding="400"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      How to enable:
                    </Text>
                    <Text as="p" variant="bodySm">
                      1. Click &quot;Open Theme Editor&quot; below
                      <br />
                      2. In the left sidebar, click <strong>App embeds</strong>
                      <br />
                      3. Toggle on <strong>GEO Rise — AI Schema</strong>
                      <br />
                      4. Click Save, then come back here
                    </Text>
                  </BlockStack>
                </Box>
                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    url={themeEditorUrl}
                    target="_blank"
                  >
                    Open Theme Editor ↗
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => submit("completeOnboarding")}
                    loading={isLoading}
                  >
                    I&apos;ve enabled it — Go to Dashboard →
                  </Button>
                </InlineStack>
                <Button
                  variant="plain"
                  onClick={() => submit("completeOnboarding")}
                  disabled={isLoading}
                >
                  Skip for now
                </Button>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </div>
    </Page>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Index() {
  const { store, llmsFile, citationCount, issueCounts, recentActivity } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // All hooks must be called unconditionally on every render, before any
  // early return — otherwise the order changes between renders and React
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
      <TitleBar title={`GEO Rise — ${store.shopName}`} />

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
              <Button url="/app/simulator">Try AI Simulation</Button>
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

        {/* ── ROW 4: Plan upgrade ── */}
        {isFreePlan ? (
          <CalloutCard
            title="Unlock the full GEO Rise experience"
            illustration=""
            primaryAction={{ content: "Start Free Trial →", url: "/app/pricing" }}
          >
            <Text as="p" variant="bodyMd">
              You&apos;re on the Free plan. Upgrade to <strong>Growth ($39/mo)</strong> to
              unlock unlimited product optimization, AI visibility tracking,
              competitor monitoring, and weekly insight reports — with a 7-day
              free trial.
            </Text>
          </CalloutCard>
        ) : store.plan === "GROWTH" ? (
          <Banner
            tone="info"
            action={{ content: "Upgrade to Pro", url: "/app/pricing" }}
          >
            <Text as="p" variant="bodyMd">
              Want competitor monitoring and AI revenue attribution? Upgrade to Pro ($79/mo).
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

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  Divider,
  Modal,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  createSubscription,
  cancelSubscription,
  getActiveSubscription,
  syncSubscriptionFromShopify,
} from "~/services/billing.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import prisma from "~/db.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  // Returning from Shopify billing approval - sync subscription
  const chargeId = url.searchParams.get("charge_id");
  if (chargeId) {
    await syncSubscriptionFromShopify(admin, session.shop);
    // Redirect to clean URL so F5 doesn't re-sync
    return redirect("/app/pricing?synced=1");
  }

  const [store, activeShopifySub] = await Promise.all([
    prisma.store.findUnique({
      where: { shopifyDomain: session.shop },
      select: {
        id: true,
        plan: true,
        shopName: true,
        subscription: { select: { trialEndsAt: true } },
      },
    }),
    getActiveSubscription(admin),
  ]);

  return {
    currentPlan: (store?.plan ?? "FREE") as PlanKey,
    shopName: store?.shopName ?? "",
    shopifySubId: activeShopifySub?.id ?? null,
    trialEndsAt: store?.subscription?.trialEndsAt?.toISOString() ?? null,
    justSynced: url.searchParams.has("synced"),
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "subscribe") {
    // Runtime validation, not just a type cast: only self-serve paid plans
    // are valid subscribe targets (Enterprise goes through contact-us).
    const requested = formData.get("plan");
    if (requested !== "GROWTH" && requested !== "PRO") {
      return { error: "Invalid plan selection." };
    }
    const planKey = requested as Exclude<PlanKey, "FREE" | "ENTERPRISE">;
    try {
      // A merchant already on a paid plan is switching, not starting out:
      // the new subscription replaces the old one on approval (Shopify
      // prorates automatically) and must not grant a fresh free trial.
      const store = await prisma.store.findUnique({
        where: { shopifyDomain: session.shop },
        select: { plan: true },
      });
      const isPlanSwitch = (store?.plan ?? "FREE") !== "FREE";
      const confirmationUrl = await createSubscription(
        admin,
        planKey,
        session.shop,
        { skipTrial: isPlanSwitch }
      );
      // Return the URL as data - the client navigates via window.top.location.
      // shopify-app-remix's redirect helper is unreliable in this iframe context;
      // returning data and letting the client escape the iframe is deterministic.
      return { confirmationUrl };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Subscription creation failed." };
    }
  }

  if (intent === "cancel") {
    const subscriptionId = formData.get("subscriptionId") as string;
    if (!subscriptionId) {
      // No active Shopify subscription to cancel - just ensure DB is on FREE
      const store = await prisma.store.findUnique({
        where: { shopifyDomain: session.shop },
        select: { id: true },
      });
      if (store) {
        await prisma.store.update({ where: { id: store.id }, data: { plan: "FREE" } });
      }
      return { success: true, message: "You are now on the Free plan." };
    }
    await cancelSubscription(admin, subscriptionId, session.shop);
    return { success: true, message: "Your plan has been cancelled. You're back on Free." };
  }

  return { error: "Unknown action." };
};

// ─── Feature rows ──────────────────────────────────────────────────────────────

type FeatureValue = boolean | string;

interface FeatureRow {
  label: string;
  free: FeatureValue;
  growth: FeatureValue;
  pro: FeatureValue;
  enterprise: FeatureValue;
}

const FEATURES: FeatureRow[] = [
  {
    label: "Products in llms.txt",
    free: "25",
    growth: "Unlimited",
    pro: "Unlimited",
    enterprise: "Unlimited",
  },
  {
    label: "AI readiness audit",
    free: "3 products",
    growth: "All products",
    pro: "All products",
    enterprise: "All products",
  },
  {
    label: "AI simulation",
    free: "3 / month",
    growth: "Unlimited",
    pro: "Unlimited",
    enterprise: "Unlimited",
  },
  { label: "llms.txt generation",     free: true, growth: true, pro: true, enterprise: true },
  { label: "JSON-LD schema injection", free: true, growth: true, pro: true, enterprise: true },
  { label: "Multi-market llms.txt",   free: false, growth: true, pro: true, enterprise: true },
  { label: "Bulk optimization",       free: false, growth: true, pro: true, enterprise: true },
  {
    label: "AI tracking (platforms)",
    free: false,
    growth: "3 platforms",
    pro: "All 6+",
    enterprise: "All 6+",
  },
  { label: "Weekly insight emails",   free: false, growth: true, pro: true, enterprise: true },
  { label: "Competitor monitoring",   free: false, growth: false, pro: true, enterprise: true },
  { label: "AI revenue attribution",  free: false, growth: false, pro: true, enterprise: true },
  {
    label: "AI blog posts per month",
    free: String(PLAN_LIMITS.FREE.maxBlogPostsPerMonth),
    growth: String(PLAN_LIMITS.GROWTH.maxBlogPostsPerMonth),
    pro: String(PLAN_LIMITS.PRO.maxBlogPostsPerMonth),
    enterprise: String(PLAN_LIMITS.ENTERPRISE.maxBlogPostsPerMonth),
  },
  { label: "Shopify Flow integration",free: false, growth: false, pro: false, enterprise: true },
  { label: "Priority support",        free: false, growth: false, pro: true, enterprise: true },
];

// ─── Small helpers ────────────────────────────────────────────────────────────

function FeatureCell({ value }: { value: FeatureValue }) {
  if (typeof value === "string") {
    return (
      <Text as="span" variant="bodySm">
        {value}
      </Text>
    );
  }
  if (value) {
    return (
      <span style={{ color: "#1D9E75", fontWeight: 700, fontSize: 16 }}>✓</span>
    );
  }
  return (
    <span style={{ color: "#C9CCCF", fontWeight: 700, fontSize: 16 }}>✗</span>
  );
}

// ─── Plan Card ────────────────────────────────────────────────────────────────

type PricingFetcher = ReturnType<typeof useFetcher<typeof action>>;

interface PlanCardProps {
  planKey: PlanKey;
  currentPlan: PlanKey;
  shopifySubId: string | null;
  trialEndsAt: string | null;
  fetcher: PricingFetcher;
}

const PLAN_ORDER: PlanKey[] = ["FREE", "GROWTH", "PRO", "ENTERPRISE"];

function PlanCard({ planKey, currentPlan, shopifySubId, fetcher }: PlanCardProps) {
  const [showCancelModal, setShowCancelModal] = useState(false);
  const def = PLAN_DEFINITIONS[planKey];
  const limits = PLAN_LIMITS[planKey];

  // One fetcher is shared by all plan cards so only a single subscribe/cancel
  // request can be in flight at a time. The submitted `plan` field identifies
  // which card initiated the request; siblings disable their CTAs meanwhile.
  const anySubmitting = fetcher.state !== "idle";
  const isLoading = anySubmitting && fetcher.formData?.get("plan") === planKey;
  const siblingSubmitting = anySubmitting && !isLoading;

  const isCurrent = planKey === currentPlan;
  const currentRank = PLAN_ORDER.indexOf(currentPlan);
  const thisRank = PLAN_ORDER.indexOf(planKey);
  const isUpgrade = thisRank > currentRank;
  const isDowngrade = thisRank < currentRank;
  const isPopular = planKey === "GROWTH";
  const isEnterprise = planKey === "ENTERPRISE";

  const featureValues: FeatureValue[] = [
    def.name === "Free"
      ? `${PLAN_LIMITS.FREE.maxProductsInLlmsTxt}`
      : limits.maxProductsInLlmsTxt === Infinity
      ? "Unlimited"
      : String(limits.maxProductsInLlmsTxt),
    def.name === "Free"
      ? `${PLAN_LIMITS.FREE.maxAuditProducts} products`
      : "All products",
    def.name === "Free"
      ? `${PLAN_LIMITS.FREE.maxSimulations} / month`
      : "Unlimited",
    true,
    true,
    limits.multiMarketLlmsTxt,
    limits.bulkOptimization,
    planKey === "GROWTH"
      ? "3 platforms"
      : planKey === "PRO" || planKey === "ENTERPRISE"
      ? "All 6+"
      : false,
    limits.insightEmails,
    limits.competitorMonitoring,
    limits.revenueAttribution,
    String(limits.maxBlogPostsPerMonth),
    limits.shopifyFlowIntegration,
    limits.prioritySupport,
  ];

  const topBorderColor = isPopular ? "#005BD3" : isCurrent ? "#008060" : "transparent";

  return (
    <div
      style={{
        border: `2px solid ${isCurrent ? "#008060" : isPopular ? "#005BD3" : "#E4E5E7"}`,
        borderRadius: 12,
        overflow: "hidden",
        background: "#fff",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Top label bar */}
      <div
        style={{
          background: topBorderColor,
          color: "#fff",
          textAlign: "center",
          fontSize: 11,
          fontWeight: 700,
          padding: isCurrent || isPopular ? "5px 0" : 0,
          letterSpacing: "0.08em",
          minHeight: isCurrent || isPopular ? undefined : 0,
        }}
      >
        {isCurrent ? "CURRENT PLAN" : isPopular ? "MOST POPULAR" : ""}
      </div>

      <Box padding="400">
        <BlockStack gap="400">
          {/* Price header */}
          <BlockStack gap="100">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingLg">{def.name}</Text>
            </InlineStack>
            <InlineStack gap="100" blockAlign="end">
              <Text as="p" variant="heading2xl" fontWeight="bold">
                {def.price === 0 ? "Free" : `$${def.price}`}
              </Text>
              {def.price > 0 && (
                <Text as="p" variant="bodyMd" tone="subdued">/month</Text>
              )}
            </InlineStack>
            {def.trialDays > 0 && !isCurrent && isUpgrade && (
              <Badge tone="success">{`${def.trialDays}-day free trial`}</Badge>
            )}
          </BlockStack>

          {/* CTA */}
          {isCurrent ? (
            <>
              <Button disabled fullWidth>Current plan</Button>
              {planKey !== "FREE" && shopifySubId && (
                <Button
                  variant="plain"
                  tone="critical"
                  loading={isLoading}
                  disabled={siblingSubmitting}
                  fullWidth
                  onClick={() => setShowCancelModal(true)}
                >
                  Cancel plan
                </Button>
              )}
            </>
          ) : isEnterprise ? (
            <Button url="mailto:hello@boda.no" fullWidth>Contact us</Button>
          ) : isUpgrade ? (
            <Button
              variant="primary"
              loading={isLoading}
              disabled={siblingSubmitting}
              fullWidth
              onClick={() => {
                fetcher.submit(
                  { intent: "subscribe", plan: planKey },
                  { method: "POST" }
                );
              }}
            >
              {`Start ${def.trialDays}-day free trial`}
            </Button>
          ) : isDowngrade && planKey === "FREE" ? (
            // Moving to Free = cancelling the subscription. Confirmed via
            // the shared modal below.
            <Button
              variant="plain"
              loading={isLoading}
              disabled={siblingSubmitting}
              fullWidth
              onClick={() => setShowCancelModal(true)}
            >
              Downgrade to Free
            </Button>
          ) : isDowngrade ? (
            // Paid-to-paid switch: a NEW subscription replaces the active
            // one when the merchant approves it on Shopify's confirmation
            // page (prorated automatically). Never cancel here; that would
            // drop the merchant to Free instead of switching plans.
            <Button
              variant="plain"
              loading={isLoading}
              disabled={siblingSubmitting}
              fullWidth
              onClick={() => {
                fetcher.submit(
                  { intent: "subscribe", plan: planKey },
                  { method: "POST" }
                );
              }}
            >
              {`Switch to ${def.name}`}
            </Button>
          ) : null}

          {/* Shared cancel confirmation: opened by "Cancel plan" on the
              current paid card and "Downgrade to Free" on the Free card. */}
          <Modal
            open={showCancelModal}
            onClose={() => setShowCancelModal(false)}
            title={`Cancel your ${PLAN_DEFINITIONS[currentPlan].name} plan?`}
            primaryAction={{
              content: "Cancel plan",
              destructive: true,
              loading: isLoading,
              onAction: () => {
                fetcher.submit(
                  {
                    intent: "cancel",
                    subscriptionId: shopifySubId ?? "",
                    plan: planKey,
                  },
                  { method: "POST" }
                );
                setShowCancelModal(false);
              },
            }}
            secondaryActions={[
              {
                content: "Keep my plan",
                onAction: () => setShowCancelModal(false),
              },
            ]}
          >
            <Modal.Section>
              <Text as="p" variant="bodyMd">
                You'll move to the Free plan immediately. Your data stays,
                but paid features like AI tracking, bulk optimization, and
                weekly insight emails lock until you upgrade again.
              </Text>
            </Modal.Section>
          </Modal>

          <Divider />

          {/* Feature list */}
          <BlockStack gap="200">
            {FEATURES.map((feat, i) => (
              <InlineStack key={feat.label} align="space-between" blockAlign="center" gap="200">
                <Text as="span" variant="bodySm" tone="subdued">
                  {feat.label}
                </Text>
                <FeatureCell
                  value={featureValues[i] as FeatureValue}
                />
              </InlineStack>
            ))}
          </BlockStack>
        </BlockStack>
      </Box>
    </div>
  );
}

// ─── FAQ ──────────────────────────────────────────────────────────────────────

const FAQ = [
  {
    q: "Can I cancel anytime?",
    a: "Yes, cancel directly from your Shopify admin. No contracts, no cancellation fees.",
  },
  {
    q: "What happens to my data if I downgrade?",
    a: "Your data stays. You just lose access to premium features until you upgrade again. Nothing is deleted.",
  },
  {
    q: "Do I get charged during the trial?",
    a: `No. Your ${PLAN_DEFINITIONS.GROWTH.trialDays}-day trial is completely free. You only get charged after it ends, and only if you don't cancel.`,
  },
  {
    q: "Is this billed through Shopify?",
    a: "Yes - billing goes through Shopify's standard app billing and appears on your existing Shopify invoice. No separate payment method needed.",
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  const { currentPlan, shopName, shopifySubId, trialEndsAt, justSynced } =
    useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (justSynced) {
      shopify.toast.show("Plan updated successfully!");
    }
  }, [justSynced, shopify]);

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if ("message" in data) {
      shopify.toast.show(data.message as string);
    }
  }, [fetcher.data, fetcher.state, shopify]);

  // When the action returns a Shopify billing confirmationUrl, escape the
  // embedded-app iframe by navigating the top window directly. Setting
  // window.top.location.href is allowed by Shopify's iframe sandbox under
  // allow-top-navigation-by-user-activation as long as the user clicked
  // recently.
  useEffect(() => {
    const data = fetcher.data as { confirmationUrl?: string } | undefined;
    if (data?.confirmationUrl && fetcher.state === "idle") {
      try {
        if (window.top) {
          window.top.location.href = data.confirmationUrl;
        } else {
          window.location.href = data.confirmationUrl;
        }
      } catch {
        open(data.confirmationUrl, "_top");
      }
    }
  }, [fetcher.data, fetcher.state]);

  const isOnPaidPlan = currentPlan !== "FREE";

  return (
    <Page>
      <TitleBar title="Pricing" />

      <BlockStack gap="500">
        {/* Hero */}
        <BlockStack gap="200">
          <Text as="h1" variant="headingXl" alignment="center">
            Choose your GEO Rise plan
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
            All paid plans start with a {PLAN_DEFINITIONS.GROWTH.trialDays}-day free trial. Billed through your Shopify account.
          </Text>
        </BlockStack>

        {/* Current plan banner */}
        {isOnPaidPlan && (
          <Banner tone="success">
            <Text as="p" variant="bodyMd">
              {shopName} is on the{" "}
              <strong>
                {PLAN_DEFINITIONS[currentPlan].name} (${PLAN_DEFINITIONS[currentPlan].price}/mo)
              </strong>{" "}
              plan.{" "}
              {trialEndsAt && new Date(trialEndsAt) > new Date()
                ? `Your free trial ends on ${new Date(trialEndsAt).toLocaleDateString()}.`
                : "Billed monthly via Shopify."}
            </Text>
          </Banner>
        )}

        {/* 4-column plan cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 16,
            alignItems: "start",
          }}
        >
          {(["FREE", "GROWTH", "PRO", "ENTERPRISE"] as PlanKey[]).map((key) => (
            <PlanCard
              key={key}
              planKey={key}
              currentPlan={currentPlan}
              shopifySubId={shopifySubId}
              trialEndsAt={trialEndsAt}
              fetcher={fetcher}
            />
          ))}
        </div>

        {/* FAQ */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Frequently asked questions</Text>
            <BlockStack gap="400">
              {FAQ.map(({ q, a }) => (
                <BlockStack gap="100" key={q}>
                  <Text as="p" variant="bodyMd" fontWeight="semibold">{q}</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">{a}</Text>
                </BlockStack>
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

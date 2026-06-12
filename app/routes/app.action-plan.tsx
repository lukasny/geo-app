import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  ButtonGroup,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  EmptyState,
  Spinner,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  getActionPlan,
  type ActionItem,
} from "~/services/action-plan.server";
import {
  autoFixIssues,
  runFullAudit,
} from "~/services/audit-engine.server";
import { PLAN_LIMITS } from "~/services/billing.shared";
import { severityTone, severityLabel } from "~/utils/severity";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoaderData {
  storeScore: number;
  actions: ActionItem[];
  totalUnfixed: number;
  hasAudit: boolean;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, geoScore: true, plan: true },
  });
  if (!store) {
    return {
      storeScore: 0,
      actions: [],
      totalUnfixed: 0,
      hasAudit: false,
    } satisfies LoaderData;
  }

  // Plumb the plan-tier audit cap into the service so a Pro→Free downgrade
  // doesn't leak the merchant's pre-downgrade issue list. Same pattern as
  // the audit page loader.
  const { PLAN_LIMITS } = await import("~/services/billing.shared");
  const planLimits =
    PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
  const productLimit = Number.isFinite(planLimits.maxAuditProducts)
    ? planLimits.maxAuditProducts
    : undefined;

  const plan = await getActionPlan(store.id, { productLimit });
  return {
    storeScore: store.geoScore,
    actions: plan.actions,
    totalUnfixed: plan.totalUnfixed,
    hasAudit: plan.hasAudit,
  } satisfies LoaderData;
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true },
  });
  if (!store) return { error: "Store not found." };

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "autoFixGroup") {
    // Per-card auto-fix: only touch issues matching THIS card's category +
    // title. Lets the merchant burn down one bucket at a time instead of
    // committing to the whole catalog with the Audit page's "Auto-fix All".
    const category = formData.get("category") as string;
    const title = formData.get("title") as string;
    if (!category || !title) {
      return { error: "Missing category or title." };
    }
    try {
      const result = await autoFixIssues(store.id, admin, {
        category: category as
          | "SCHEMA"
          | "CONTENT"
          | "TECHNICAL"
          | "ACCESSIBILITY"
          | "IMAGES"
          | "META",
        title,
      });
      return {
        success: true,
        intent,
        fixed: result.fixed,
        failed: result.failed,
        skipped: result.skipped ?? 0,
        aborted: result.aborted ?? false,
        title,
      };
    } catch (err) {
      console.error("[GEO Rise action-plan] autoFixGroup threw:", err);
      return {
        error:
          "Couldn't run that auto-fix. Try again in a moment; if it keeps failing, hit Re-run audit.",
      };
    }
  }

  if (intent === "runAudit") {
    try {
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

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  CONTENT: "Content",
  META: "SEO / Meta",
  IMAGES: "Images",
  SCHEMA: "Schema",
  TECHNICAL: "Technical",
  ACCESSIBILITY: "Accessibility",
};

function formatTimeEstimate(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `≈${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `≈${minutes} min`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ActionPlanPage() {
  const { storeScore, actions, totalUnfixed, hasAudit } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isWorking = fetcher.state !== "idle";

  // Per-card "in flight" tracking so we can show the loading state on
  // the right button while others stay clickable.
  const inFlightActionId =
    isWorking && fetcher.formData?.get("intent") === "autoFixGroup"
      ? (fetcher.formData?.get("actionId") as string) ?? null
      : null;
  const isAuditing =
    isWorking && fetcher.formData?.get("intent") === "runAudit";

  const [lastFixOutcome, setLastFixOutcome] = useState<{
    title: string;
    fixed: number;
    failed: number;
    skipped: number;
    aborted: boolean;
  } | null>(null);

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data && data.error) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if (data.success && data.intent === "autoFixGroup") {
      const f = (data.fixed as number) ?? 0;
      const s = (data.skipped as number) ?? 0;
      const fl = (data.failed as number) ?? 0;
      const aborted = (data.aborted as boolean) ?? false;
      setLastFixOutcome({
        title: (data.title as string) ?? "",
        fixed: f,
        failed: fl,
        skipped: s,
        aborted,
      });
      if (aborted) {
        shopify.toast.show(
          `Fixed ${f}, then AI service hit a limit. Try again in a few minutes.`,
          { isError: true }
        );
      } else {
        const parts: string[] = [`Fixed ${f}`];
        if (s > 0) parts.push(`skipped ${s} already good`);
        if (fl > 0) parts.push(`${fl} failed`);
        shopify.toast.show(parts.join(", "));
      }
    } else if (data.success && data.intent === "runAudit") {
      const score = data.storeScore as number | undefined;
      shopify.toast.show(
        score !== undefined ? `Audit complete - new score ${score}/100` : "Audit complete"
      );
      // Clear stale fix outcome - the new audit invalidates it.
      setLastFixOutcome(null);
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const handleAutoFix = (a: ActionItem) => {
    fetcher.submit(
      {
        intent: "autoFixGroup",
        actionId: a.id,
        category: a.category,
        title: a.title,
      },
      { method: "POST" }
    );
  };

  const handleAudit = () => {
    // Guard against double submit: a second click would abort the first
    // run's client handling through the shared fetcher.
    if (isWorking) return;
    fetcher.submit({ intent: "runAudit" }, { method: "POST" });
  };

  // ── Empty states ──
  if (!hasAudit) {
    return (
      <Page>
        <TitleBar title="Action Plan" />
        <Card>
          <EmptyState
            heading="Run an audit to see your action plan"
            action={{
              content: "Run AI Readiness Audit",
              url: "/app/audit",
            }}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <Text as="p" variant="bodyMd">
              Your action plan is generated from the issues your audit finds.
              Run your first audit to get a prioritized list of fixes ranked
              by how much they&apos;ll move your GEO score.
            </Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  if (actions.length === 0) {
    return (
      <Page>
        <TitleBar title="Action Plan" />
        <BlockStack gap="500">
          {isAuditing && (
            <Banner tone="info">
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" />
                <Text as="span" variant="bodyMd">
                  Re-running your audit… this may take a minute for large
                  catalogs.
                </Text>
              </InlineStack>
            </Banner>
          )}
          <Card>
            <EmptyState
              heading="Nothing to fix - your store is in great shape"
              action={{
                content: isAuditing ? "Re-running audit…" : "Re-run audit",
                onAction: handleAudit,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Your last audit found no unfixed issues. Re-run the audit
                periodically (or set up AI tracking to monitor drift over
                time). Current GEO score: <strong>{storeScore}/100</strong>.
              </Text>
            </EmptyState>
          </Card>
        </BlockStack>
      </Page>
    );
  }

  const remainingIssues =
    totalUnfixed - actions.reduce((sum, a) => sum + a.count, 0);

  return (
    <Page>
      <TitleBar title="Action Plan">
        {/* Disable during ANY fetcher state, not just runAudit - otherwise
            a merchant could trigger an audit while an auto-fix is mid-flight,
            which clobbers the in-flight request and leaves partial state. */}
        <button onClick={handleAudit} disabled={isWorking}>
          {isAuditing ? "Re-auditing…" : "Re-run audit"}
        </button>
      </TitleBar>

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Your top <strong>{actions.length}</strong> actions, ranked by
            impact. Click <em>Auto-fix</em> on any card to fix that group of
            issues; we&apos;ll skip anything you&apos;ve already fixed
            manually.{" "}
            {remainingIssues > 0 ? (
              <>
                {remainingIssues} smaller issues sit below this list;
                they&apos;ll bubble up as you knock out the top ones.
              </>
            ) : null}
          </Text>
        </Banner>

        {lastFixOutcome && (
          <Banner
            tone={
              lastFixOutcome.aborted
                ? "warning"
                : lastFixOutcome.failed > 0
                ? "warning"
                : "success"
            }
            onDismiss={() => setLastFixOutcome(null)}
            title={
              lastFixOutcome.aborted
                ? `Stopped early on "${lastFixOutcome.title}"`
                : `Done with "${lastFixOutcome.title}"`
            }
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {lastFixOutcome.aborted
                  ? "The AI service hit a limit. Try the same action again in a few minutes to pick up the rest."
                  : `Fixed ${lastFixOutcome.fixed}${
                      lastFixOutcome.skipped > 0
                        ? `, skipped ${lastFixOutcome.skipped} already correct`
                        : ""
                    }${
                      lastFixOutcome.failed > 0
                        ? `, ${lastFixOutcome.failed} failed`
                        : ""
                    }. Re-run the audit to see your new score.`}
              </Text>
              <div>
                <Button
                  variant="primary"
                  onClick={handleAudit}
                  loading={isAuditing}
                >
                  Re-run audit
                </Button>
              </div>
            </BlockStack>
          </Banner>
        )}

        {actions.map((a, i) => (
          <ActionCard
            key={a.id}
            action={a}
            rank={i + 1}
            onAutoFix={handleAutoFix}
            isFixing={inFlightActionId === a.id}
            anyInFlight={isWorking}
          />
        ))}

        <Box paddingBlockEnd="500">
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            GEO score from your last audit: <strong>{storeScore}/100</strong>.
            Re-run the audit after fixing a batch to see your new score.
          </Text>
        </Box>
      </BlockStack>
    </Page>
  );
}

// ─── Per-action card ──────────────────────────────────────────────────────────

interface ActionCardProps {
  action: ActionItem;
  rank: number;
  onAutoFix: (a: ActionItem) => void;
  isFixing: boolean;
  anyInFlight: boolean;
}

function ActionCard({ action, rank, onAutoFix, isFixing, anyInFlight }: ActionCardProps) {
  const timeHint = formatTimeEstimate(action.estimatedTimeSeconds);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start" wrap={false} gap="400">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Badge tone="info">{`#${rank}`}</Badge>
              <Badge tone={severityTone(action.severity)}>
                {severityLabel(action.severity)}
              </Badge>
              <Badge>
                {CATEGORY_LABEL[action.category] ?? action.category}
              </Badge>
              <Badge>{`${action.count} issue${action.count === 1 ? "" : "s"}`}</Badge>
              {action.affectedProductCount > 0 &&
                action.affectedProductCount !== action.count && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    across {action.affectedProductCount} product
                    {action.affectedProductCount === 1 ? "" : "s"}
                  </Text>
                )}
            </InlineStack>
            <Text as="h3" variant="headingMd">
              {action.title}
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              {action.description}
            </Text>
          </BlockStack>

          <BlockStack gap="200" align="end">
            {action.autoFixable ? (
              <ButtonGroup>
                <Button
                  variant="primary"
                  onClick={() => onAutoFix(action)}
                  loading={isFixing}
                  disabled={anyInFlight && !isFixing}
                >
                  {`Auto-fix ${action.count}`}
                </Button>
              </ButtonGroup>
            ) : (
              <Button url="/app/audit">View affected products</Button>
            )}
            {timeHint && (
              <Text as="span" variant="bodySm" tone="subdued" alignment="end">
                {timeHint}
              </Text>
            )}
          </BlockStack>
        </InlineStack>

        {isFixing && (
          <>
            <Divider />
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="span" variant="bodySm" tone="subdued">
                Working through the {action.count} issue
                {action.count === 1 ? "" : "s"} - stay on this page; the
                results land when done.
              </Text>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

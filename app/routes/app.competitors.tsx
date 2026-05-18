import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  TextField,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  EmptyState,
  ButtonGroup,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  getCompetitorOverview,
  suggestCompetitors,
  normalizeDomain,
  type CompetitorOverview,
  type SuggestedCompetitor,
} from "~/services/competitor-monitoring.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoaderData {
  plan: PlanKey;
  overview: CompetitorOverview;
  suggestions: SuggestedCompetitor[];
  competitorsRemaining: number | null; // null = unlimited
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true },
  });
  if (!store) {
    return {
      plan: "FREE" as PlanKey,
      overview: { storeCitedCount: 0, totalChecks: 0, competitors: [] },
      suggestions: [],
      competitorsRemaining: 0,
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;

  const [overview, suggestions] = await Promise.all([
    getCompetitorOverview(store.id),
    suggestCompetitors(store.id, 8),
  ]);

  const cap = limits.maxCompetitors;
  const competitorsRemaining =
    cap === Infinity ? null : Math.max(0, cap - overview.competitors.length);

  return {
    plan: planKey,
    overview,
    suggestions,
    competitorsRemaining,
  } satisfies LoaderData;
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true },
  });
  if (!store) return { error: "Store not found." };

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "addCompetitor") {
    if (!limits.competitorMonitoring) {
      return {
        error: "Competitor monitoring is a Growth/Pro/Enterprise feature.",
      };
    }

    const rawDomain = (formData.get("domain") as string) ?? "";
    const rawName = ((formData.get("name") as string) ?? "").trim();
    const notes = ((formData.get("notes") as string) ?? "").trim() || null;

    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      return {
        error:
          "Please enter a valid domain (e.g. example.com - protocols and paths are stripped automatically).",
      };
    }
    // If the merchant didn't type a name, fall back to the domain. Easier
    // than forcing them to think about a label.
    const name = rawName || domain;

    const existingCount = await prisma.competitor.count({
      where: { storeId: store.id },
    });
    if (existingCount >= limits.maxCompetitors) {
      return {
        // Plan caps are 3/10/25 - all plural, so no `=== 1` branch needed.
        error: `Your plan allows ${limits.maxCompetitors} tracked competitors. Upgrade for more.`,
      };
    }

    // The DB has a unique constraint on (storeId, domain); catch the
    // P2002 to surface a clean error instead of an unhandled throw.
    try {
      await prisma.competitor.create({
        data: { storeId: store.id, name, domain, notes },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Unique constraint/i.test(msg) || /P2002/i.test(msg)) {
        return {
          error: `${domain} is already tracked.`,
        };
      }
      console.error("[competitors] addCompetitor failed:", err);
      return { error: "Couldn't add competitor - please try again." };
    }

    return { success: true, intent, addedDomain: domain };
  }

  if (intent === "deleteCompetitor") {
    const competitorId = formData.get("competitorId") as string;
    if (!competitorId) return { error: "Missing competitor ID." };
    await prisma.competitor.deleteMany({
      where: { id: competitorId, storeId: store.id },
    });
    return { success: true, intent };
  }

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

const PLATFORM_LABELS: Record<string, string> = {
  CLAUDE: "Claude",
  CHATGPT: "ChatGPT",
  PERPLEXITY: "Perplexity",
  GEMINI: "Gemini",
  GROK: "Grok",
  GOOGLE_AI_OVERVIEW: "Google AI",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function CompetitorsPage() {
  const { plan, overview, suggestions, competitorsRemaining } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isWorking = fetcher.state !== "idle";

  const [domainDraft, setDomainDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  // Track which suggestion is being added so we can per-row spinner.
  const [addingSuggestion, setAddingSuggestion] = useState<string | null>(null);
  // Suggestions live in client state so the row disappears optimistically
  // when added (without re-running the expensive auto-discovery).
  const [visibleSuggestions, setVisibleSuggestions] =
    useState<SuggestedCompetitor[]>(suggestions);

  // Keep visibleSuggestions in sync if the loader returns a fresh set
  // (e.g. after navigating away and back).
  useEffect(() => {
    setVisibleSuggestions(suggestions);
  }, [suggestions]);

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data) {
      shopify.toast.show(data.error as string, { isError: true });
      setAddingSuggestion(null);
    } else if (data.success && data.intent === "addCompetitor") {
      const addedDomain = ((data.addedDomain as string) ?? "").trim();
      if (addedDomain && addingSuggestion && addingSuggestion === addedDomain) {
        // Came from a suggestion card - drop the suggestion row.
        setVisibleSuggestions((s) =>
          s.filter((sp) => sp.domain !== addedDomain)
        );
      } else {
        shopify.toast.show("Competitor added");
        setDomainDraft("");
        setNameDraft("");
        setNotesDraft("");
      }
      setAddingSuggestion(null);
    } else if (data.success && data.intent === "deleteCompetitor") {
      shopify.toast.show("Competitor removed");
    }
  }, [fetcher.data, fetcher.state, addingSuggestion, shopify]);

  const planDef = PLAN_DEFINITIONS[plan];
  const planLimits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.FREE;
  const canTrack =
    planLimits.competitorMonitoring && planLimits.maxCompetitors > 0;
  const atCap =
    planLimits.maxCompetitors !== Infinity &&
    overview.competitors.length >= planLimits.maxCompetitors;

  const isAddingExplicit =
    isWorking &&
    fetcher.formData?.get("intent") === "addCompetitor" &&
    !addingSuggestion;

  const handleAddSuggestion = (sp: SuggestedCompetitor) => {
    setAddingSuggestion(sp.domain);
    fetcher.submit(
      {
        intent: "addCompetitor",
        domain: sp.domain,
        name: sp.domain,
        notes: "",
      },
      { method: "POST" }
    );
  };

  const handleDelete = (competitorId: string) => {
    fetcher.submit(
      { intent: "deleteCompetitor", competitorId },
      { method: "POST" }
    );
  };

  return (
    <Page>
      <TitleBar title="Competitor Monitoring" />

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Track named competitor domains across your AI tracking results.
            When AI search engines (ChatGPT, Perplexity, Claude) answer your
            tracked prompts, we&apos;ll show whose store gets cited - yours,
            your competitors&apos;, or both.
          </Text>
        </Banner>

        {!canTrack && (
          <Banner
            tone="warning"
            title={`${planDef.name} plan doesn't include competitor monitoring`}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                Upgrade to {PLAN_DEFINITIONS.GROWTH.name} ($
                {PLAN_DEFINITIONS.GROWTH.price}/mo) to track up to{" "}
                {PLAN_LIMITS.GROWTH.maxCompetitors} competitors, or{" "}
                {PLAN_DEFINITIONS.PRO.name} ($
                {PLAN_DEFINITIONS.PRO.price}/mo) for{" "}
                {PLAN_LIMITS.PRO.maxCompetitors}.
              </Text>
              <div>
                <Link to="/app/pricing">
                  <Button variant="primary">See pricing</Button>
                </Link>
              </div>
            </BlockStack>
          </Banner>
        )}

        {/* ── Head-to-head summary ── */}
        {canTrack && overview.totalChecks > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Head-to-head
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Across the {overview.totalChecks} most recent tracking checks
                on your store.
              </Text>
              <InlineStack gap="500" wrap>
                <Box
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                  minWidth="180px"
                >
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      Your store cited
                    </Text>
                    <Text as="span" variant="heading2xl">
                      {overview.storeCitedCount}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      out of {overview.totalChecks}
                    </Text>
                  </BlockStack>
                </Box>
                {overview.competitors.length === 0 ? (
                  <Box
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                    minWidth="180px"
                  >
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Add competitors below
                      </Text>
                      <Text as="span" variant="bodyMd" tone="subdued">
                        We&apos;ll show their head-to-head citation counts
                        here.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  overview.competitors.slice(0, 4).map((c) => (
                    <Box
                      key={c.competitor.id}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                      minWidth="180px"
                    >
                      <BlockStack gap="100">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {c.competitor.name} cited
                        </Text>
                        <Text as="span" variant="heading2xl">
                          {c.citedCount}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          out of {overview.totalChecks}
                        </Text>
                      </BlockStack>
                    </Box>
                  ))
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {/* ── Add competitor form ── */}
        {canTrack && (
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Track a competitor
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {competitorsRemaining === null
                    ? "Unlimited competitors on your plan."
                    : `${competitorsRemaining} of ${planLimits.maxCompetitors} slots remaining on your ${planDef.name} plan.`}
                </Text>
              </BlockStack>

              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="addCompetitor" />
                <BlockStack gap="300">
                  <TextField
                    label="Domain"
                    name="domain"
                    value={domainDraft}
                    onChange={setDomainDraft}
                    placeholder="e.g. burton.com"
                    helpText="Just the hostname - we strip http://, www., and paths automatically. Subdomains (shop.burton.com) match the parent too."
                    autoComplete="off"
                  />
                  <TextField
                    label="Display name (optional)"
                    name="name"
                    value={nameDraft}
                    onChange={setNameDraft}
                    placeholder="e.g. Burton"
                    helpText="Defaults to the domain if left blank."
                    autoComplete="off"
                  />
                  <TextField
                    label="Notes (optional)"
                    name="notes"
                    value={notesDraft}
                    onChange={setNotesDraft}
                    placeholder="Why you're tracking them"
                    autoComplete="off"
                    multiline={2}
                  />
                  <InlineStack align="end">
                    <Button
                      submit
                      variant="primary"
                      loading={isAddingExplicit}
                      disabled={atCap || !domainDraft.trim()}
                    >
                      {atCap ? "Plan limit reached" : "Add competitor"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </fetcher.Form>
            </BlockStack>
          </Card>
        )}

        {/* ── Auto-suggested competitors ── */}
        {canTrack && visibleSuggestions.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Discovered competitors ({visibleSuggestions.length})
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  These domains showed up alongside your store in recent AI
                  tracking results but aren&apos;t tracked yet. Add the ones
                  that are real competitors.
                </Text>
              </BlockStack>

              <BlockStack gap="200">
                {visibleSuggestions.map((sp) => {
                  const isAddingThis = addingSuggestion === sp.domain;
                  return (
                    <Box
                      key={sp.domain}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="300"
                        wrap={false}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {sp.domain}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Cited in {sp.count} of the last{" "}
                            {overview.totalChecks} tracking checks
                          </Text>
                        </BlockStack>
                        <Button
                          onClick={() => handleAddSuggestion(sp)}
                          loading={isAddingThis}
                          disabled={(isWorking && !isAddingThis) || atCap}
                        >
                          {atCap ? "At limit" : "Add"}
                        </Button>
                      </InlineStack>
                    </Box>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {/* ── Tracked competitors list ── */}
        {canTrack && overview.competitors.length === 0 && (
          <Card>
            <EmptyState
              heading="No competitors tracked yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Add competitor domains above to see how often AI search
                engines mention them in answers to your tracked prompts. If
                you&apos;ve already run a few tracking checks, the
                &ldquo;Discovered competitors&rdquo; section will populate
                automatically.
              </Text>
            </EmptyState>
          </Card>
        )}

        {canTrack &&
          overview.competitors.map((c) => (
            <CompetitorCard
              key={c.competitor.id}
              stats={c}
              totalChecks={overview.totalChecks}
              onDelete={handleDelete}
              isDeleting={
                isWorking &&
                fetcher.formData?.get("intent") === "deleteCompetitor" &&
                fetcher.formData?.get("competitorId") === c.competitor.id
              }
            />
          ))}
      </BlockStack>
    </Page>
  );
}

// ─── Per-competitor card ──────────────────────────────────────────────────────

interface CompetitorCardProps {
  stats: CompetitorOverview["competitors"][number];
  totalChecks: number;
  onDelete: (id: string) => void;
  isDeleting: boolean;
}

function CompetitorCard({
  stats,
  totalChecks,
  onDelete,
  isDeleting,
}: CompetitorCardProps) {
  const { competitor, citedCount, lastCitedAt, byPlatform, storeCitedSameQueries } =
    stats;
  const platformBadges = Object.entries(byPlatform).filter(([, n]) => n > 0);
  const citedRate =
    totalChecks > 0 ? Math.round((citedCount / totalChecks) * 100) : null;
  const hasAnyTrackingData = totalChecks > 0;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" wrap={false}>
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              {competitor.name}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {competitor.domain}
            </Text>
            {competitor.notes && (
              <Text as="p" variant="bodySm" tone="subdued">
                {competitor.notes}
              </Text>
            )}
          </BlockStack>
          <ButtonGroup>
            <Button
              tone="critical"
              variant="plain"
              onClick={() => onDelete(competitor.id)}
              loading={isDeleting}
            >
              Remove
            </Button>
          </ButtonGroup>
        </InlineStack>

        {!hasAnyTrackingData ? (
          <Box
            padding="300"
            background="bg-surface-secondary"
            borderRadius="200"
          >
            <Text as="p" variant="bodySm" tone="subdued">
              No tracking checks have run yet. Add some prompts on{" "}
              <Link to="/app/tracking">AI Tracking</Link> and run them - once
              there&apos;s data, this card will show how often AI search
              engines cite {competitor.name} alongside (or instead of) your
              store.
            </Text>
          </Box>
        ) : (
          <InlineStack gap="500" wrap>
            <Box minWidth="120px">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Cited in
                </Text>
                <Text as="span" variant="headingLg">
                  {citedCount}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  of {totalChecks} checks ({citedRate ?? 0}%)
                </Text>
              </BlockStack>
            </Box>
            <Box minWidth="160px">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  You vs them, head-to-head
                </Text>
                <Text as="span" variant="bodyMd">
                  {citedCount === 0 ? (
                    "They haven't been cited yet in your tracking results."
                  ) : (
                    <>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {storeCitedSameQueries}
                      </Text>{" "}
                      of the {citedCount} times they were cited, your store
                      was cited too
                    </>
                  )}
                </Text>
              </BlockStack>
            </Box>
            <Box minWidth="120px">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Last cited
                </Text>
                <Text as="span" variant="bodyMd">
                  {relativeTime(lastCitedAt)}
                </Text>
              </BlockStack>
            </Box>
          </InlineStack>
        )}

        {platformBadges.length > 0 && (
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone="subdued">
              By platform:
            </Text>
            {platformBadges.map(([platform, n]) => (
              <Badge key={platform} tone="info">
                {`${PLATFORM_LABELS[platform] ?? platform}: ${n}`}
              </Badge>
            ))}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

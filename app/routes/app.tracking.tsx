import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  TextField,
  Select,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  Divider,
  EmptyState,
  ButtonGroup,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { runTrackingCheck } from "~/services/tracking.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoaderPrompt {
  id: string;
  prompt: string;
  category: string | null;
  isActive: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  totalChecks: number;
  citedCount: number;
  latestCitation: {
    id: string;
    cited: boolean;
    position: number | null;
    citationContext: string | null;
    productsCited: string[];
    competitorsCited: string[];
    responseSnippet: string | null;
    checkedAt: string;
  } | null;
}

interface LoaderData {
  plan: PlanKey;
  prompts: LoaderPrompt[];
  promptsRemaining: number | null; // null = unlimited
  storeId: string;
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
      prompts: [],
      promptsRemaining: 0,
      storeId: "",
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;

  const prompts = await prisma.trackingPrompt.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
  });

  // Pull aggregate citation stats per prompt
  const promptIds = prompts.map((p) => p.id);
  const citations = promptIds.length > 0
    ? await prisma.aiCitation.findMany({
        where: { storeId: store.id, prompt: { in: prompts.map((p) => p.prompt) } },
        orderBy: { checkedAt: "desc" },
      })
    : [];

  const citationsByPrompt = new Map<string, typeof citations>();
  for (const c of citations) {
    const matching = prompts.find((p) => p.prompt === c.prompt);
    if (!matching) continue;
    const arr = citationsByPrompt.get(matching.id) ?? [];
    arr.push(c);
    citationsByPrompt.set(matching.id, arr);
  }

  const loaderPrompts: LoaderPrompt[] = prompts.map((p) => {
    const cs = citationsByPrompt.get(p.id) ?? [];
    const latest = cs[0];
    return {
      id: p.id,
      prompt: p.prompt,
      category: p.category,
      isActive: p.isActive,
      lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      totalChecks: cs.length,
      citedCount: cs.filter((c) => c.cited).length,
      latestCitation: latest
        ? {
            id: latest.id,
            cited: latest.cited,
            position: latest.position,
            citationContext: latest.citationContext,
            productsCited: Array.isArray(latest.productsCited)
              ? (latest.productsCited as string[])
              : [],
            competitorsCited: Array.isArray(latest.competitorsCited)
              ? (latest.competitorsCited as string[])
              : [],
            responseSnippet: latest.responseSnippet,
            checkedAt: latest.checkedAt.toISOString(),
          }
        : null,
    };
  });

  const used = prompts.length;
  const cap = limits.maxTrackingPrompts;
  const promptsRemaining = cap === Infinity ? null : Math.max(0, cap - used);

  return {
    plan: planKey,
    prompts: loaderPrompts,
    promptsRemaining,
    storeId: store.id,
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

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;

  if (intent === "addPrompt") {
    const promptText = (formData.get("prompt") as string).trim();
    const category = (formData.get("category") as string)?.trim() || null;
    if (!promptText) return { error: "Prompt cannot be empty." };
    if (promptText.length > 500)
      return { error: "Prompt must be 500 characters or fewer." };

    const existingCount = await prisma.trackingPrompt.count({
      where: { storeId: store.id },
    });
    if (existingCount >= limits.maxTrackingPrompts) {
      return {
        error: `Your plan allows ${limits.maxTrackingPrompts} tracking prompts. Upgrade for more.`,
      };
    }

    const created = await prisma.trackingPrompt.create({
      data: {
        storeId: store.id,
        prompt: promptText,
        category,
        isActive: true,
      },
    });
    return { success: true, intent, promptId: created.id };
  }

  if (intent === "runCheck") {
    const promptId = formData.get("promptId") as string;
    if (!promptId) return { error: "Missing prompt ID." };
    // Verify it belongs to this store before running
    const owns = await prisma.trackingPrompt.findFirst({
      where: { id: promptId, storeId: store.id },
      select: { id: true },
    });
    if (!owns) return { error: "Prompt not found." };
    try {
      const result = await runTrackingCheck(promptId);
      return { success: true, intent, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Tracking check failed: ${msg}` };
    }
  }

  if (intent === "deletePrompt") {
    const promptId = formData.get("promptId") as string;
    if (!promptId) return { error: "Missing prompt ID." };
    await prisma.trackingPrompt.deleteMany({
      where: { id: promptId, storeId: store.id },
    });
    return { success: true, intent };
  }

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

const CATEGORY_OPTIONS = [
  { label: "No category", value: "" },
  { label: "Comparison", value: "comparison" },
  { label: "Recommendation", value: "recommendation" },
  { label: "Use case", value: "use_case" },
  { label: "Price / Value", value: "price" },
  { label: "Brand", value: "brand" },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function TrackingPage() {
  const { plan, prompts, promptsRemaining } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isWorking = fetcher.state !== "idle";

  const [promptDraft, setPromptDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if (data.success && data.intent === "addPrompt") {
      shopify.toast.show("Tracking prompt added");
      setPromptDraft("");
      setCategoryDraft("");
    } else if (data.success && data.intent === "runCheck") {
      const cited = (data.result as { cited?: boolean })?.cited;
      shopify.toast.show(
        cited
          ? "✓ Your store was cited"
          : "Check complete — not cited this run"
      );
    } else if (data.success && data.intent === "deletePrompt") {
      shopify.toast.show("Tracking prompt deleted");
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const planDef = PLAN_DEFINITIONS[plan];
  const planLimits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.FREE;
  const canAddPrompts = planLimits.maxTrackingPrompts > 0;
  const atCap =
    planLimits.maxTrackingPrompts !== Infinity &&
    prompts.length >= planLimits.maxTrackingPrompts;

  const isAddingPrompt =
    isWorking && fetcher.formData?.get("intent") === "addPrompt";

  return (
    <Page>
      <TitleBar title="AI Visibility Tracking" />

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Track how AI assistants (ChatGPT, Perplexity, Claude, Gemini) answer
            shopper questions about products in your category. Add the prompts
            your customers might ask, and we'll check whether your store gets
            cited — and where.
          </Text>
        </Banner>

        {!canAddPrompts && (
          <Banner tone="warning" title={`${planDef.name} plan doesn't include AI tracking`}>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                Upgrade to Growth ($19/mo) to unlock {PLAN_LIMITS.GROWTH.maxTrackingPrompts} tracking prompts, or Pro ($49/mo) for {PLAN_LIMITS.PRO.maxTrackingPrompts}.
              </Text>
              <div>
                <Link to="/app/pricing">
                  <Button variant="primary">See pricing</Button>
                </Link>
              </div>
            </BlockStack>
          </Banner>
        )}

        {/* ── Add Prompt ── */}
        {canAddPrompts && (
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Add tracking prompt
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {promptsRemaining === null
                    ? "Unlimited prompts on your plan."
                    : `${promptsRemaining} of ${planLimits.maxTrackingPrompts} prompts remaining on your ${planDef.name} plan.`}
                </Text>
              </BlockStack>

              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="addPrompt" />
                <BlockStack gap="300">
                  <TextField
                    label="Prompt"
                    name="prompt"
                    value={promptDraft}
                    onChange={setPromptDraft}
                    placeholder="e.g. What's the best snowboard for intermediate riders?"
                    helpText="A question a real customer might ask ChatGPT or Perplexity."
                    autoComplete="off"
                    multiline={2}
                    maxLength={500}
                    showCharacterCount
                  />
                  <Select
                    label="Category (optional)"
                    name="category"
                    options={CATEGORY_OPTIONS}
                    value={categoryDraft}
                    onChange={setCategoryDraft}
                  />
                  <InlineStack align="end">
                    <Button
                      submit
                      variant="primary"
                      loading={isAddingPrompt}
                      disabled={atCap || !promptDraft.trim()}
                    >
                      {atCap ? "Plan limit reached" : "Add prompt"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </fetcher.Form>
            </BlockStack>
          </Card>
        )}

        {/* ── Prompts list ── */}
        {prompts.length === 0 && canAddPrompts ? (
          <Card>
            <EmptyState
              heading="No tracking prompts yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Add your first prompt above to start tracking how AI search
                engines answer questions in your category. Good starting points:
                comparison queries, "best of" questions, and product
                recommendations.
              </Text>
            </EmptyState>
          </Card>
        ) : (
          prompts.map((p) => (
            <PromptCard
              key={p.id}
              prompt={p}
              isWorking={isWorking}
              currentIntent={
                isWorking
                  ? {
                      intent: fetcher.formData?.get("intent") as string,
                      promptId: fetcher.formData?.get("promptId") as string,
                    }
                  : null
              }
              fetcher={fetcher}
            />
          ))
        )}
      </BlockStack>
    </Page>
  );
}

// ─── Per-Prompt Card ──────────────────────────────────────────────────────────

interface PromptCardProps {
  prompt: LoaderPrompt;
  isWorking: boolean;
  currentIntent: { intent: string; promptId: string } | null;
  fetcher: ReturnType<typeof useFetcher>;
}

function PromptCard({ prompt, isWorking, currentIntent, fetcher }: PromptCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isRunningThis =
    isWorking &&
    currentIntent?.intent === "runCheck" &&
    currentIntent.promptId === prompt.id;
  const isDeletingThis =
    isWorking &&
    currentIntent?.intent === "deletePrompt" &&
    currentIntent.promptId === prompt.id;

  const citedRate =
    prompt.totalChecks > 0
      ? Math.round((prompt.citedCount / prompt.totalChecks) * 100)
      : null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack gap="300" align="space-between" blockAlign="start" wrap={false}>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              {prompt.prompt}
            </Text>
            <InlineStack gap="200" blockAlign="center" wrap>
              {prompt.category && (
                <Badge tone="info">{prompt.category}</Badge>
              )}
              <Text as="span" variant="bodySm" tone="subdued">
                Last checked: {relativeTime(prompt.lastCheckedAt)}
              </Text>
              {citedRate !== null && (
                <Text as="span" variant="bodySm" tone="subdued">
                  Cited in {prompt.citedCount} of {prompt.totalChecks} checks
                  ({citedRate}%)
                </Text>
              )}
            </InlineStack>
          </BlockStack>

          <ButtonGroup>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="runCheck" />
              <input type="hidden" name="promptId" value={prompt.id} />
              <Button
                submit
                variant="primary"
                loading={isRunningThis}
                disabled={isWorking && !isRunningThis}
              >
                {isRunningThis ? "Checking…" : "Run check"}
              </Button>
            </fetcher.Form>
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="deletePrompt" />
              <input type="hidden" name="promptId" value={prompt.id} />
              <Button
                submit
                tone="critical"
                variant="plain"
                loading={isDeletingThis}
                disabled={isWorking && !isDeletingThis}
              >
                Delete
              </Button>
            </fetcher.Form>
          </ButtonGroup>
        </InlineStack>

        {prompt.latestCitation && (
          <>
            <Divider />
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h4" variant="headingSm">
                  Latest result
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {relativeTime(prompt.latestCitation.checkedAt)}
                </Text>
                <Badge tone={prompt.latestCitation.cited ? "success" : "critical"}>
                  {prompt.latestCitation.cited ? "Cited" : "Not cited"}
                </Badge>
                {prompt.latestCitation.position != null && (
                  <Badge tone="info">
                    {`Position ${prompt.latestCitation.position}`}
                  </Badge>
                )}
              </InlineStack>

              {prompt.latestCitation.citationContext && (
                <Box
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <Text as="p" variant="bodyMd">
                    {prompt.latestCitation.citationContext}
                  </Text>
                </Box>
              )}

              {prompt.latestCitation.productsCited.length > 0 && (
                <InlineStack gap="200" wrap blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Products mentioned:
                  </Text>
                  {prompt.latestCitation.productsCited.slice(0, 5).map((title) => (
                    <Badge key={title} tone="success">
                      {title}
                    </Badge>
                  ))}
                </InlineStack>
              )}

              {prompt.latestCitation.competitorsCited.length > 0 && (
                <InlineStack gap="200" wrap blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Sources cited alongside (potential competitors):
                  </Text>
                  {prompt.latestCitation.competitorsCited
                    .slice(0, 5)
                    .map((domain) => (
                      <Badge key={domain} tone="attention">
                        {domain}
                      </Badge>
                    ))}
                </InlineStack>
              )}

              {prompt.latestCitation.responseSnippet && (
                <>
                  <Button
                    variant="plain"
                    onClick={() => setExpanded((v) => !v)}
                    disclosure={expanded ? "up" : "down"}
                  >
                    {expanded ? "Hide full AI response" : "Show full AI response"}
                  </Button>

                  {expanded && (
                    <Box
                      padding="400"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <Text as="p" variant="bodyMd">
                        {prompt.latestCitation.responseSnippet
                          .split(/\n\n+/)
                          .map((para, i) => (
                            <span key={i} style={{ display: "block", marginBottom: "0.5em" }}>
                              {para}
                            </span>
                          ))}
                      </Text>
                    </Box>
                  )}
                </>
              )}
            </BlockStack>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

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
import { runTrackingCheck, suggestTrackingPrompts } from "~/services/tracking.server";
import type { SuggestedPrompt } from "~/services/tracking.server";
import {
  computeNextRunAt,
  type TrackingSchedule,
} from "~/services/tracking-scheduler.shared";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import { sanitizeAiVendorError } from "~/services/ai-retry.server";
import { getProductCitationStats } from "~/services/product-citations.server";
import type { ProductCitationStats } from "~/services/product-citations.server";

// ─── Types ────────────────────────────────────────────────────────────────────

type AiPlatform =
  | "CLAUDE"
  | "CHATGPT"
  | "PERPLEXITY"
  | "GEMINI"
  | "GROK"
  | "GOOGLE_AI_OVERVIEW";

const PLATFORM_LABELS: Record<AiPlatform, string> = {
  CLAUDE: "Claude",
  CHATGPT: "ChatGPT",
  PERPLEXITY: "Perplexity",
  GEMINI: "Gemini",
  GROK: "Grok",
  GOOGLE_AI_OVERVIEW: "Google AI",
};

interface HistoryPoint {
  id: string;
  cited: boolean;
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  platform: AiPlatform;
  checkedAt: string;
}

interface LoaderPrompt {
  id: string;
  prompt: string;
  category: string | null;
  isActive: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  schedule: TrackingSchedule;
  nextRunAt: string | null;
  totalChecks: number;
  citedCount: number;
  history: HistoryPoint[];
  latestCitation: {
    id: string;
    cited: boolean;
    position: number | null;
    sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
    platform: AiPlatform;
    citationContext: string | null;
    productsCited: string[];
    competitorsCited: string[];
    responseSnippet: string | null;
    checkedAt: string;
  } | null;
  /** Per-platform "cited / not cited" summary across the most recent
   *  AiCitation rows for this prompt - one entry per distinct platform
   *  that's actually run a check. */
  platformBreakdown: { platform: AiPlatform; cited: boolean }[];
}

interface LoaderData {
  plan: PlanKey;
  prompts: LoaderPrompt[];
  promptsRemaining: number | null; // null = unlimited
  storeId: string;
  /** Per-product mention stats for the "Top cited products" card.
   *  Null when the plan has no tracking (the query is skipped). */
  productCitations: ProductCitationStats | null;
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
      productCitations: null,
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

    // Per-platform breakdown: most recent citation row per distinct platform.
    // Shown as small badges on the result card so the merchant can see, e.g.
    // "Cited by Claude, not by ChatGPT" at a glance.
    const latestByPlatform = new Map<string, (typeof cs)[number]>();
    for (const c of cs) {
      if (!latestByPlatform.has(c.platform)) {
        latestByPlatform.set(c.platform, c);
      }
    }
    const platformBreakdown = Array.from(latestByPlatform.entries()).map(
      ([platform, c]) => ({ platform: platform as AiPlatform, cited: c.cited })
    );

    return {
      id: p.id,
      prompt: p.prompt,
      category: p.category,
      isActive: p.isActive,
      lastCheckedAt: p.lastCheckedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      schedule: p.schedule as TrackingSchedule,
      nextRunAt: p.nextRunAt?.toISOString() ?? null,
      // cs is desc (newest first). Reverse to chronological, then take the
      // last 20 most-recent points for the trend timeline - capping the
      // payload so prompts with hundreds of checks don't bloat the loader.
      history: cs
        .slice()
        .reverse()
        .slice(-20)
        .map((c) => ({
          id: c.id,
          cited: c.cited,
          sentiment: c.sentiment as "POSITIVE" | "NEUTRAL" | "NEGATIVE",
          platform: c.platform as AiPlatform,
          checkedAt: c.checkedAt.toISOString(),
        })),
      totalChecks: cs.length,
      citedCount: cs.filter((c) => c.cited).length,
      latestCitation: latest
        ? {
            id: latest.id,
            cited: latest.cited,
            position: latest.position,
            sentiment: latest.sentiment as "POSITIVE" | "NEUTRAL" | "NEGATIVE",
            platform: latest.platform as AiPlatform,
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
      platformBreakdown,
    };
  });

  const used = prompts.length;
  const cap = limits.maxTrackingPrompts;
  const promptsRemaining = cap === Infinity ? null : Math.max(0, cap - used);

  // Per-product mention stats. FREE has no tracking, and the card only
  // renders when prompts exist, so skip the query in both cases. This
  // mirrors the render condition exactly.
  const productCitations =
    limits.maxTrackingPrompts > 0 && prompts.length > 0
      ? await getProductCitationStats(store.id)
      : null;

  return {
    plan: planKey,
    prompts: loaderPrompts,
    promptsRemaining,
    storeId: store.id,
    productCitations,
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

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;

  if (intent === "addPrompt") {
    const promptText = (formData.get("prompt") as string).trim();
    const category = (formData.get("category") as string)?.trim() || null;
    const scheduleRaw = (formData.get("schedule") as string) || "MANUAL";
    const schedule: TrackingSchedule = (
      ["MANUAL", "DAILY", "WEEKLY"].includes(scheduleRaw) ? scheduleRaw : "MANUAL"
    ) as TrackingSchedule;
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
        schedule,
        nextRunAt: computeNextRunAt(schedule),
      },
    });
    return { success: true, intent, promptId: created.id, addedPrompt: promptText };
  }

  if (intent === "setSchedule") {
    const promptId = formData.get("promptId") as string;
    const scheduleRaw = (formData.get("schedule") as string) || "MANUAL";
    if (!promptId) return { error: "Missing prompt ID." };
    if (!["MANUAL", "DAILY", "WEEKLY"].includes(scheduleRaw)) {
      return { error: "Invalid schedule." };
    }
    // FREE plan can't schedule. The scheduler tick already filters by plan,
    // but block at the action so the merchant gets immediate feedback (and so
    // we don't write a misleading `nextRunAt` they'll see in the UI as a
    // scheduled run that will never actually fire).
    if (scheduleRaw !== "MANUAL" && planKey === "FREE") {
      return {
        error: "Scheduled tracking is a Growth/Pro/Enterprise feature.",
      };
    }
    const owns = await prisma.trackingPrompt.findFirst({
      where: { id: promptId, storeId: store.id },
      select: { id: true },
    });
    if (!owns) return { error: "Prompt not found." };
    const schedule = scheduleRaw as TrackingSchedule;
    await prisma.trackingPrompt.update({
      where: { id: promptId },
      data: { schedule, nextRunAt: computeNextRunAt(schedule) },
    });
    return { success: true, intent };
  }

  if (intent === "runCheck") {
    // P1-15 fix: re-enforce plan tier here. A merchant who downgrades to
    // FREE keeps their existing TrackingPrompt rows; without this guard
    // they could still trigger paid AI calls by clicking Run check on
    // those orphaned rows.
    if (planKey === "FREE" || limits.maxTrackingPrompts === 0) {
      return {
        error:
          "AI tracking is a Growth/Pro/Enterprise feature. Please upgrade to run checks.",
      };
    }
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
      return { error: sanitizeTrackingError(err) };
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

  if (intent === "suggestPrompts") {
    // P1-14 fix: entitlement guard. Without this a FREE merchant could
    // call the action directly (curl, devtools) and burn our Claude API
    // budget generating suggestions they can't even save.
    if (planKey === "FREE" || limits.maxTrackingPrompts === 0) {
      return {
        error:
          "Prompt suggestions are a Growth/Pro/Enterprise feature. Please upgrade.",
      };
    }
    try {
      const suggestions = await suggestTrackingPrompts(store.id, admin);
      return { success: true, intent, suggestions };
    } catch (err) {
      return { error: sanitizeTrackingError(err) };
    }
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

const SCHEDULE_OPTIONS = [
  { label: "Manual only", value: "MANUAL" },
  { label: "Daily", value: "DAILY" },
  { label: "Weekly", value: "WEEKLY" },
];

// ─── TrendTimeline ────────────────────────────────────────────────────────────

// Color tokens for the per-check dots. Hardcoded hex so they look right
// regardless of Polaris theme - these are deliberately close to
// success/caution semantics but tuned so a "cited but neutral" reading is
// visually distinct from "cited and positive."
const TIMELINE_FILLS = {
  POSITIVE_CITED: "#108043", // success-green - best signal
  NEUTRAL_CITED: "#6a9a7a",  // muted green - cited but flat
  NEGATIVE_CITED: "#b98900", // amber - cited but cautionary
  NOT_CITED_FILL: "transparent",
  NOT_CITED_STROKE: "#9ea3a8", // gray outline
} as const;

function formatTooltipDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function TrendTimeline({ history }: { history: HistoryPoint[] }) {
  if (history.length === 0) return null;
  const DOT = 10;
  const GAP = 4;
  const PAD = 2;
  const width = history.length * DOT + Math.max(0, history.length - 1) * GAP;
  const height = DOT + PAD * 2;
  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="span" variant="bodySm" tone="subdued">
        Trend:
      </Text>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Trend of last ${history.length} checks, oldest to newest`}
      >
        {history.map((p, i) => {
          const cx = i * (DOT + GAP) + DOT / 2;
          const cy = height / 2;
          let fill: string = TIMELINE_FILLS.NOT_CITED_FILL;
          let stroke = "transparent";
          let label: string;
          if (p.cited) {
            fill =
              p.sentiment === "POSITIVE"
                ? TIMELINE_FILLS.POSITIVE_CITED
                : p.sentiment === "NEGATIVE"
                ? TIMELINE_FILLS.NEGATIVE_CITED
                : TIMELINE_FILLS.NEUTRAL_CITED;
            label = `Cited (${p.sentiment.toLowerCase()})`;
          } else {
            stroke = TIMELINE_FILLS.NOT_CITED_STROKE;
            label = "Not cited";
          }
          return (
            <circle
              key={p.id}
              cx={cx}
              cy={cy}
              r={DOT / 2}
              fill={fill}
              stroke={stroke}
              strokeWidth={1}
            >
              <title>{`${formatTooltipDate(p.checkedAt)} • ${PLATFORM_LABELS[p.platform] ?? p.platform} • ${label}`}</title>
            </circle>
          );
        })}
      </svg>
      <Text as="span" variant="bodySm" tone="subdued">
        {history.length === 1 ? "1 check" : `last ${history.length} checks`}
      </Text>
    </InlineStack>
  );
}

/** Wrap the shared `sanitizeAiVendorError` with tracking-specific pass-throughs
 *  for known service-layer error messages we WANT the merchant to see. The
 *  shared helper handles the generic vendor failure modes (credit / rate-limit
 *  / timeout / overloaded). */
/** Builds the one-line summary above the suggestions card grid that
 *  tells the merchant which sources contributed. Intent Lab makes this
 *  the visible signal that suggestions came from real shopper data. */
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
    parts.push(`${fromStore} from your store's recent searches`);
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

function sanitizeTrackingError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/run an audit first/i.test(raw)) return raw;
  if (/couldn't parse claude/i.test(raw)) {
    return "We had trouble understanding the AI response. Please try again.";
  }
  return sanitizeAiVendorError(err, { context: "Tracking", logTag: "tracking" });
}

function relativeFuture(iso: string | null): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  if (diff <= 0) return "any moment now";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TrackingPage() {
  const { plan, prompts, promptsRemaining, productCitations } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isWorking = fetcher.state !== "idle";

  const [promptDraft, setPromptDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [scheduleDraft, setScheduleDraft] = useState<string>("MANUAL");
  // Suggestions returned by the suggest action live in client state so the
  // user can dismiss them individually as they get added (without re-running
  // the (expensive) suggest call).
  const [suggestions, setSuggestions] = useState<SuggestedPrompt[]>([]);
  // Track which suggestion text is being added so we can show per-card spinners
  // when multiple add submits happen in quick succession.
  const [addingSuggestion, setAddingSuggestion] = useState<string | null>(null);

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data) {
      shopify.toast.show(data.error as string, { isError: true });
      setAddingSuggestion(null);
    } else if (data.success && data.intent === "addPrompt") {
      const addedText = ((data.addedPrompt as string) ?? "").trim();
      if (addedText && addingSuggestion && addingSuggestion === addedText) {
        // The add originated from a suggestion card - drop that card.
        setSuggestions((s) => s.filter((sp) => sp.prompt.trim() !== addedText));
      } else {
        shopify.toast.show("Tracking prompt added");
        setPromptDraft("");
        setCategoryDraft("");
        setScheduleDraft("MANUAL");
      }
      setAddingSuggestion(null);
    } else if (data.success && data.intent === "runCheck") {
      const cited = (data.result as { cited?: boolean })?.cited;
      shopify.toast.show(
        cited
          ? "✓ Your store was cited"
          : "Check complete - not cited this run"
      );
    } else if (data.success && data.intent === "deletePrompt") {
      shopify.toast.show("Tracking prompt deleted");
    } else if (data.success && data.intent === "setSchedule") {
      shopify.toast.show("Schedule updated");
    } else if (data.success && data.intent === "suggestPrompts") {
      const list = (data.suggestions as SuggestedPrompt[] | undefined) ?? [];
      setSuggestions(list);
      if (list.length === 0) {
        shopify.toast.show("No new suggestions - you already cover the main angles", { isError: true });
      } else {
        shopify.toast.show(`Generated ${list.length} prompt suggestions`);
      }
    }
  }, [fetcher.data, fetcher.state, addingSuggestion, shopify]);

  const planDef = PLAN_DEFINITIONS[plan];
  const planLimits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.FREE;
  const canAddPrompts = planLimits.maxTrackingPrompts > 0;
  const atCap =
    planLimits.maxTrackingPrompts !== Infinity &&
    prompts.length >= planLimits.maxTrackingPrompts;

  const isAddingPrompt =
    isWorking &&
    fetcher.formData?.get("intent") === "addPrompt" &&
    !addingSuggestion;
  const isSuggesting =
    isWorking && fetcher.formData?.get("intent") === "suggestPrompts";

  const handleAddSuggestion = (sp: SuggestedPrompt) => {
    setAddingSuggestion(sp.prompt.trim());
    fetcher.submit(
      { intent: "addPrompt", prompt: sp.prompt, category: sp.category },
      { method: "POST" }
    );
  };

  return (
    <Page>
      <TitleBar title="AI Visibility Tracking" />

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Track how AI assistants (ChatGPT, Perplexity, Claude, Gemini) answer
            shopper questions about products in your category. Add the prompts
            your customers might ask, and we'll check whether your store gets
            cited - and where.
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
              <InlineStack align="space-between" blockAlign="start" wrap={false}>
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
                  <input type="hidden" name="intent" value="suggestPrompts" />
                  <Button
                    submit
                    loading={isSuggesting}
                    disabled={isWorking && !isSuggesting}
                  >
                    {isSuggesting ? "Generating…" : "Suggest prompts for me"}
                  </Button>
                </fetcher.Form>
              </InlineStack>

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
                  <Select
                    label="Schedule"
                    name="schedule"
                    options={SCHEDULE_OPTIONS}
                    value={scheduleDraft}
                    onChange={setScheduleDraft}
                    helpText="Daily or Weekly reruns this prompt automatically. Manual = only when you click Run check."
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

        {/* ── Suggestions (from suggestPrompts action) ── */}
        {canAddPrompts && suggestions.length > 0 && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Suggested prompts ({suggestions.length})
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {summarizeSources(suggestions)}
                  </Text>
                </BlockStack>
                <Button
                  variant="plain"
                  onClick={() => setSuggestions([])}
                  disabled={isWorking}
                >
                  Dismiss all
                </Button>
              </InlineStack>

              <BlockStack gap="300">
                {suggestions.map((sp) => {
                  const isAddingThis = addingSuggestion === sp.prompt.trim();
                  const subredditMatch =
                    sp.source === "reddit"
                      ? sp.sourceDetail?.match(/r\/[a-z0-9_]+/i)?.[0]
                      : null;
                  return (
                    <Box
                      key={sp.prompt}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                        <BlockStack gap="200">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {sp.prompt}
                          </Text>
                          {sp.rationale && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {sp.rationale}
                            </Text>
                          )}
                          {sp.source === "shopify_search" && sp.sourceDetail && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Based on: {sp.sourceDetail}
                            </Text>
                          )}
                          <InlineStack gap="200" wrap>
                            <Badge tone="info">{sp.category.replace("_", " ")}</Badge>
                            {sp.source === "shopify_search" && (
                              <Badge tone="success">From your store</Badge>
                            )}
                            {sp.source === "reddit" && (
                              <Badge tone="info">
                                {subredditMatch
                                  ? `From ${subredditMatch}`
                                  : "From shopper community"}
                              </Badge>
                            )}
                            {sp.source === "ai_brainstorm" && (
                              <Badge>AI suggested</Badge>
                            )}
                          </InlineStack>
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

        {/* ── Top cited products ── */}
        {canAddPrompts && productCitations && prompts.length > 0 && (
          <TopCitedProductsCard stats={productCitations} />
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
              plan={plan}
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

// ─── Top Cited Products ───────────────────────────────────────────────────────

function TopCitedProductsCard({ stats }: { stats: ProductCitationStats }) {
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Top cited products
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {stats.truncated
              ? "Which of your products AI assistants mentioned, based on your most recent AI answers."
              : `Which of your products AI assistants mentioned in the last ${stats.rangeDays} days, across all your prompts.`}
          </Text>
        </BlockStack>

        {stats.products.length === 0 ? (
          <Text as="p" variant="bodyMd" tone="subdued">
            No product mentions detected yet. Run checks on your prompts - when
            an AI answer names one of your products, it shows up here.
          </Text>
        ) : (
          <BlockStack gap="300">
            {stats.products.map((p) => (
              <Box
                key={p.title.toLowerCase()}
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <BlockStack gap="200">
                  <InlineStack
                    align="space-between"
                    blockAlign="start"
                    gap="300"
                    wrap={false}
                  >
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {p.title}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Last mentioned {relativeTime(p.lastMentionedAt)}
                    </Text>
                  </InlineStack>
                  <InlineStack gap="200" wrap blockAlign="center">
                    <Text as="span" variant="bodySm">
                      {p.mentionCount === 1
                        ? "Mentioned in 1 AI answer"
                        : `Mentioned in ${p.mentionCount} AI answers`}
                    </Text>
                    {(
                      Object.entries(p.byPlatform) as [AiPlatform, number][]
                    ).map(([platform, count]) => (
                      <Badge key={platform} tone="info">
                        {`${PLATFORM_LABELS[platform] ?? platform}: ${count}`}
                      </Badge>
                    ))}
                    {!p.inCatalog && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        No longer matches a product in your catalog
                      </Text>
                    )}
                  </InlineStack>
                </BlockStack>
              </Box>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

// ─── Per-Prompt Card ──────────────────────────────────────────────────────────

interface PromptCardProps {
  prompt: LoaderPrompt;
  plan: PlanKey;
  isWorking: boolean;
  currentIntent: { intent: string; promptId: string } | null;
  fetcher: ReturnType<typeof useFetcher>;
}

function PromptCard({ prompt, plan, isWorking, currentIntent, fetcher }: PromptCardProps) {
  const canSchedule = plan !== "FREE";
  const [expanded, setExpanded] = useState(false);
  const isRunningThis =
    isWorking &&
    currentIntent?.intent === "runCheck" &&
    currentIntent.promptId === prompt.id;
  const isDeletingThis =
    isWorking &&
    currentIntent?.intent === "deletePrompt" &&
    currentIntent.promptId === prompt.id;
  const isSchedulingThis =
    isWorking &&
    currentIntent?.intent === "setSchedule" &&
    currentIntent.promptId === prompt.id;

  const handleScheduleChange = (newSchedule: string) => {
    fetcher.submit(
      {
        intent: "setSchedule",
        promptId: prompt.id,
        schedule: newSchedule,
      },
      { method: "POST" }
    );
  };

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
            <TrendTimeline history={prompt.history} />
            <InlineStack gap="200" blockAlign="center" wrap>
              <div style={{ minWidth: 160 }}>
                <Select
                  label="Schedule"
                  labelHidden
                  options={SCHEDULE_OPTIONS}
                  value={prompt.schedule}
                  onChange={handleScheduleChange}
                  disabled={!canSchedule || (isWorking && !isSchedulingThis)}
                />
              </div>
              {!canSchedule ? (
                <Text as="span" variant="bodySm" tone="subdued">
                  Upgrade to Growth or higher to schedule recurring checks.
                </Text>
              ) : (
                <>
                  {prompt.schedule !== "MANUAL" && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Next auto-run: {relativeFuture(prompt.nextRunAt)}
                    </Text>
                  )}
                  {isSchedulingThis && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Saving…
                    </Text>
                  )}
                </>
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
                <Badge tone="info">
                  {`on ${PLATFORM_LABELS[prompt.latestCitation.platform] ?? prompt.latestCitation.platform}`}
                </Badge>
                {prompt.latestCitation.position != null && (
                  <Badge tone="info">
                    {`Position ${prompt.latestCitation.position}`}
                  </Badge>
                )}
                {prompt.latestCitation.cited &&
                  prompt.latestCitation.sentiment !== "NEUTRAL" && (
                    <Badge
                      tone={
                        prompt.latestCitation.sentiment === "POSITIVE"
                          ? "success"
                          : "critical"
                      }
                    >
                      {prompt.latestCitation.sentiment === "POSITIVE"
                        ? "Positive tone"
                        : "Negative tone"}
                    </Badge>
                  )}
              </InlineStack>

              {prompt.platformBreakdown.length > 1 && (
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Most recent per platform:
                  </Text>
                  {prompt.platformBreakdown.map((pb) => (
                    <Badge
                      key={pb.platform}
                      tone={pb.cited ? "success" : undefined}
                    >
                      {`${PLATFORM_LABELS[pb.platform] ?? pb.platform}: ${
                        pb.cited ? "cited" : "not cited"
                      }`}
                    </Badge>
                  ))}
                </InlineStack>
              )}

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

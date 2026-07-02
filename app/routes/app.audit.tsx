import { useEffect, useState, useMemo, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  IndexTable,
  Modal,
  EmptyState,
  Banner,
  Spinner,
  Box,
  ChoiceList,
  Filters,
  InlineGrid,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { runFullAudit, autoFixIssues } from "~/services/audit-engine.server";
import { timeAgo as timeAgoUtil } from "~/utils/time";
import { PLAN_LIMITS } from "~/services/billing.shared";
import {
  READINESS_GAP_LABELS,
  READINESS_GAP_HINTS,
} from "~/services/readiness.shared";
import type { ReadinessGapKey } from "~/services/readiness.shared";
import { severityTone, severityLabel } from "~/utils/severity";
import { ScorePill, scoreColor } from "~/components/ScorePill";
import { brand } from "~/brand/tokens";

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface TopIssue {
  id: string;
  title: string;
  severity: Severity;
}

interface ProductRow {
  id: string;
  shopifyProductId: string;
  title: string;
  aiReadinessScore: number;
  descriptionWordCount: number;
  imageCount: number;
  hasAltText: boolean;
  hasMetaTitle: boolean;
  hasMetaDescription: boolean;
  lastAuditedAt: string | null;
  topIssue: TopIssue | null;
  /** Null means readiness wasn't computed for this product yet (audited
   *  before the F4 rollout, or its per-product computation failed). */
  readinessScore: number | null;
  readinessGaps: ReadinessGapKey[];
}

interface AuditResultItem {
  id: string;
  productId: string | null;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  recommendation: string;
  autoFixable: boolean;
  fixed: boolean;
  fixedAt: string | null;
}

interface LoaderData {
  store: {
    id: string;
    shopifyDomain: string;
    shopName: string;
    plan: string;
    geoScore: number;
    totalProducts: number;
    auditedProducts: number;
    /** Null until the first audit that computed readiness (F4). */
    readinessScore: number | null;
  } | null;
  products: ProductRow[];
  auditResults: AuditResultItem[];
  issueCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    autoFixable: number;
  };
  hasRunAudit: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Local wrapper keeps the "N minute(s) / hour(s) / day(s) ago" word form
// this page used (the shared util uses "Nm / Nh / Nd" compact form).
// Delegates to the shared util for the actual edge-case handling (clock
// skew, < 60s, null input).
function timeAgo(dateStr: string): string {
  const compact = timeAgoUtil(dateStr);
  if (compact === "just now" || compact === "Never") return compact;
  const match = compact.match(/^(\d+)([mhd])\sago$/);
  if (!match) return compact;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const word = unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
  return `${n} ${word}${n !== 1 ? "s" : ""} ago`;
}

const FREE_PLAN_LIMIT = PLAN_LIMITS.FREE.maxAuditProducts;

// Defensive parse of the Product.readinessGaps Json column: only strings
// that are known gap keys survive, so a manual DB edit or schema drift can
// never inject arbitrary text into the UI (labels/hints render only from
// readiness.shared.ts).
function parseReadinessGaps(raw: unknown): ReadinessGapKey[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (gap): gap is ReadinessGapKey =>
      typeof gap === "string" &&
      Object.prototype.hasOwnProperty.call(READINESS_GAP_LABELS, gap)
  );
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: {
      id: true,
      shopifyDomain: true,
      shopName: true,
      plan: true,
      geoScore: true,
      totalProducts: true,
      auditedProducts: true,
      readinessScore: true,
    },
  });

  if (!store) {
    return {
      store: null,
      products: [],
      auditResults: [],
      issueCounts: { critical: 0, high: 0, medium: 0, low: 0, autoFixable: 0 },
      hasRunAudit: false,
    } satisfies LoaderData;
  }

  // P0-4 fix: for plans with an audit cap (Free), restrict what the loader
  // sends to the client to the audited subset. Previously the loader
  // returned every product + every audit result and the UI just visually
  // locked the locked rows - but a savvy merchant could inspect the network
  // payload and see all of it. Server-side filtering plugs that gap.
  const planLimits =
    PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
  const productLimit = Number.isFinite(planLimits.maxAuditProducts)
    ? planLimits.maxAuditProducts
    : undefined;

  const dbProducts = await prisma.product.findMany({
    where: {
      storeId: store.id,
      // On capped plans, only return products that have actually been
      // audited. Hides any pre-downgrade audit history a merchant shouldn't
      // see, and stops empty-cache products from polluting the worst-score
      // ordering.
      ...(productLimit !== undefined ? { lastAuditedAt: { not: null } } : {}),
    },
    orderBy: { aiReadinessScore: "asc" },
    take: productLimit,
    select: {
      id: true,
      shopifyProductId: true,
      title: true,
      aiReadinessScore: true,
      descriptionWordCount: true,
      imageCount: true,
      hasAltText: true,
      hasMetaTitle: true,
      hasMetaDescription: true,
      lastAuditedAt: true,
      // Readiness fields ride the same cap-filtered query (P0-4 parity):
      // capped plans only ever receive readiness data for the products
      // this findMany already restricts them to.
      readinessScore: true,
      readinessGaps: true,
      auditResults: {
        orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
        take: 1,
        select: { id: true, title: true, severity: true },
      },
    },
  });

  // Restrict audit results to the allowed product set.
  const allowedProductIds = dbProducts.map((p) => p.id);
  const auditResultsRaw = await prisma.auditResult.findMany({
    where: {
      storeId: store.id,
      ...(productLimit !== undefined
        ? { productId: { in: allowedProductIds } }
        : {}),
    },
    select: {
      id: true,
      productId: true,
      category: true,
      severity: true,
      title: true,
      description: true,
      recommendation: true,
      autoFixable: true,
      fixed: true,
      fixedAt: true,
    },
  });

  const products: ProductRow[] = dbProducts.map((p) => ({
    id: p.id,
    shopifyProductId: p.shopifyProductId,
    title: p.title,
    aiReadinessScore: p.aiReadinessScore,
    descriptionWordCount: p.descriptionWordCount,
    imageCount: p.imageCount,
    hasAltText: p.hasAltText,
    hasMetaTitle: p.hasMetaTitle,
    hasMetaDescription: p.hasMetaDescription,
    lastAuditedAt: p.lastAuditedAt?.toISOString() ?? null,
    readinessScore: p.readinessScore,
    readinessGaps: parseReadinessGaps(p.readinessGaps),
    topIssue: p.auditResults[0]
      ? {
          id: p.auditResults[0].id,
          title: p.auditResults[0].title,
          severity: p.auditResults[0].severity as Severity,
        }
      : null,
  }));

  const auditResults: AuditResultItem[] = auditResultsRaw.map((r) => ({
    ...r,
    fixedAt: r.fixedAt?.toISOString() ?? null,
  }));

  const hasRunAudit = dbProducts.some((p) => p.lastAuditedAt !== null);

  const issueCounts = {
    critical: auditResults.filter((r) => r.severity === "CRITICAL").length,
    high: auditResults.filter((r) => r.severity === "HIGH").length,
    medium: auditResults.filter((r) => r.severity === "MEDIUM").length,
    low: auditResults.filter((r) => r.severity === "LOW").length,
    autoFixable: auditResults.filter((r) => r.autoFixable && !r.fixed).length,
  };

  return {
    store,
    products,
    auditResults,
    issueCounts,
    hasRunAudit,
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

  if (intent === "runAudit") {
    try {
      // Plumb the plan's audit cap into the service. The cap is enforced
      // inside `runFullAudit` -> `fetchAllProductsForAudit` so it can't be
      // bypassed by any route. For Free (cap=3 on 2026-05-17), this means a
      // store with 20 products gets the first 3 audited rather than the
      // whole audit blocked; the UI surfaces "audited X of Y" + upgrade CTA.
      const planLimits =
        PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
      const summary = await runFullAudit(store.id, admin, {
        maxProducts: planLimits.maxAuditProducts,
      });
      return { success: true, summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Audit failed: ${msg}` };
    }
  }

  if (intent === "autoFix") {
    try {
      // Mirror the loader's plan cap (P0-4). On capped plans the loader only
      // shows the worst-N audited products, and the confirm modal's
      // "Auto-fix N issues" count comes from that subset - but AuditResults
      // from before a downgrade survive until the next audit run, so without
      // the same filter here this action would fix the merchant's entire
      // pre-downgrade catalog: Claude spend and product writes far beyond
      // both the plan and what the modal promised.
      const planLimits =
        PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
      let productIds: string[] | undefined;
      if (Number.isFinite(planLimits.maxAuditProducts)) {
        const allowedProducts = await prisma.product.findMany({
          where: { storeId: store.id, lastAuditedAt: { not: null } },
          orderBy: { aiReadinessScore: "asc" },
          take: planLimits.maxAuditProducts,
          select: { id: true },
        });
        productIds = allowedProducts.map((p) => p.id);
      }
      const result = await autoFixIssues(store.id, admin, { productIds });
      return {
        success: true,
        fixed: result.fixed,
        failed: result.failed,
        skipped: result.skipped ?? 0,
        aborted: result.aborted ?? false,
      };
    } catch (err) {
      // The auto-fix loop catches its own per-issue errors. Reaching here
      // means something unexpected (DB outage, etc.) - log raw for debugging
      // and show a sanitized message to the merchant.
      console.error("[GEO Rise auto-fix] orchestrator threw:", err);
      return {
        error:
          "Auto-fix couldn't start. Please refresh and try again; if it keeps failing, contact support.",
      };
    }
  }

  return { error: "Unknown action." };
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ProductDetailModal({
  product,
  issues,
  shopifyDomain,
  onClose,
}: {
  product: ProductRow | null;
  issues: AuditResultItem[];
  shopifyDomain: string;
  onClose: () => void;
}) {
  if (!product) return null;
  const SEVERITY_ORDER: Record<Severity, number> = {
    CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
  };
  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );

  return (
    <Modal
      open={!!product}
      onClose={onClose}
      title={product.title}
      size="large"
    >
      <Modal.Section>
        <InlineStack gap="300" blockAlign="center">
          <ScorePill score={product.aiReadinessScore} />
          <Text as="p" variant="bodySm" tone="subdued">
            {sorted.length} issue{sorted.length !== 1 ? "s" : ""} found
          </Text>
        </InlineStack>
      </Modal.Section>

      {/* AI shopping readiness: only for products whose readiness was
          computed (null = audited before F4 or computation failed). Labels
          and hints come exclusively from readiness.shared.ts. */}
      {product.readinessScore !== null && (
        <Modal.Section>
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="headingSm">
                AI shopping readiness:
              </Text>
              <ScorePill score={product.readinessScore} />
              <Text as="span" variant="bodySm" tone="subdued">
                /100
              </Text>
            </InlineStack>
            {product.readinessGaps.length > 0 ? (
              <BlockStack gap="200">
                {product.readinessGaps.map((gap) => (
                  <BlockStack gap="050" key={gap}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {READINESS_GAP_LABELS[gap]}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {READINESS_GAP_HINTS[gap]}
                    </Text>
                  </BlockStack>
                ))}
              </BlockStack>
            ) : (
              <Text as="p" variant="bodySm" tone="success">
                No catalog attribute gaps found.
              </Text>
            )}
            <InlineStack>
              {/* target="_blank" is mandatory: an in-frame navigation to the
                  Shopify admin breaks the embedded app session. */}
              <Button
                url={`https://${shopifyDomain}/admin/products/${product.shopifyProductId.split("/").pop()}`}
                target="_blank"
              >
                Edit product in Shopify admin
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      )}

      {sorted.length === 0 && (
        <Modal.Section>
          <Text as="p" variant="bodyMd" tone="success">
            No issues found - this product is well optimized for AI discovery.
          </Text>
        </Modal.Section>
      )}

      {sorted.map((issue) => (
        <Modal.Section key={issue.id}>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={severityTone(issue.severity)}>
                {severityLabel(issue.severity)}
              </Badge>
              {issue.autoFixable && !issue.fixed && (
                <Badge tone="info">Auto-fixable</Badge>
              )}
              {issue.fixed && <Badge tone="success">Fixed</Badge>}
              <Text as="span" variant="headingSm">
                {issue.title}
              </Text>
            </InlineStack>
            <Text as="p" variant="bodyMd" tone="subdued">
              {issue.description}
            </Text>
            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  How to fix:
                </Text>
                <Text as="p" variant="bodySm">
                  {issue.recommendation}
                </Text>
              </BlockStack>
            </Box>
          </BlockStack>
        </Modal.Section>
      ))}
    </Modal>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const { store, products, auditResults, issueCounts, hasRunAudit } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // ── Local state ──
  const [selectedProduct, setSelectedProduct] = useState<ProductRow | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [scoreFilter, setScoreFilter] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const PAGE_SIZE = 25;
  // Auto-fix UX: confirm before writing (so we don't surprise the merchant)
  // and show a persistent post-fix banner with "Re-run audit" CTA.
  const [showAutoFixConfirm, setShowAutoFixConfirm] = useState(false);
  const [lastFixResult, setLastFixResult] = useState<{
    fixed: number;
    skipped: number;
    failed: number;
    aborted: boolean;
  } | null>(null);

  // ── Auto-fix breakdown by category ──
  // Powers the "we're about to..." modal so the merchant sees exactly what
  // they're authorizing before clicking through.
  const autoFixBreakdown = useMemo(() => {
    const fixable = auditResults.filter((r) => r.autoFixable && !r.fixed);
    const isSeoTitle = (r: AuditResultItem) =>
      r.title.toLowerCase().includes("seo title");
    return {
      descriptions: fixable.filter((r) => r.category === "CONTENT").length,
      metaDescriptions: fixable.filter(
        (r) => r.category === "META" && !isSeoTitle(r)
      ).length,
      seoTitles: fixable.filter((r) => r.category === "META" && isSeoTitle(r))
        .length,
      altTexts: fixable.filter((r) => r.category === "IMAGES").length,
      total: fixable.length,
    };
  }, [auditResults]);

  // Aggregate readiness gap counts across the loader's products. The
  // loader already applies the plan cap server-side (P0-4), so capped
  // plans only ever count gaps for products they're allowed to see.
  const topReadinessGaps = useMemo(() => {
    const counts = new Map<ReadinessGapKey, number>();
    for (const product of products) {
      for (const gap of product.readinessGaps) {
        counts.set(gap, (counts.get(gap) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [products]);

  // ── Loading flags ──
  const isRunningAudit =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "runAudit";

  const isAutoFixing =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "autoFix";

  // ── Toast on results ──
  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    const data = fetcher.data as Record<string, unknown>;
    if ("error" in data && data.error) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if ("summary" in data && data.summary) {
      const s = data.summary as { storeScore: number; totalProducts: number };
      // Zero-product store: an audit found nothing to score, so a "GEO score
      // is 0/100" toast would be misleading (there's no store to score, not a
      // failing one). Tell the merchant to add products instead.
      if (s.totalProducts === 0) {
        shopify.toast.show(
          "No active products found to audit. Add products to your store, then run the audit again."
        );
      } else {
        shopify.toast.show(
          `Audit complete! Your GEO score is ${s.storeScore}/100`
        );
      }
      // Audit just finished - the post-fix banner is stale info, clear it.
      setLastFixResult(null);
    } else if ("fixed" in data) {
      const f = data.fixed as number;
      const s = (data.skipped as number) ?? 0;
      const fl = (data.failed as number) ?? 0;
      const aborted = (data.aborted as boolean) ?? false;
      // Persist a Banner with the breakdown + "Re-run audit" CTA - the toast
      // disappears in 5 seconds; the banner stays until the merchant either
      // re-runs the audit or dismisses it.
      setLastFixResult({ fixed: f, skipped: s, failed: fl, aborted });
      if (aborted) {
        const fixedPart = `Auto-fixed ${f} issue${f !== 1 ? "s" : ""}`;
        shopify.toast.show(
          `${fixedPart} - then the AI service hit a limit. Try again in a few minutes to pick up the rest.`,
          { isError: true }
        );
      } else {
        const parts: string[] = [];
        parts.push(`Auto-fixed ${f} issue${f !== 1 ? "s" : ""}`);
        if (s > 0) parts.push(`skipped ${s} already good`);
        if (fl > 0) parts.push(`${fl} failed`);
        shopify.toast.show(`${parts.join(", ")}.`);
      }
    }
  }, [fetcher.data, fetcher.state, shopify]);

  // ── Filtered / paginated products ──
  const isFreePlan = store?.plan === "FREE";

  // A store with an empty catalog: an audit has nothing to score, so the
  // empty-state CTA points to adding products instead of running an audit
  // (which would silently do nothing and leave the merchant on this screen).
  // Gate on totalProducts once an audit has recorded it; before any audit
  // it stays 0, which is exactly the "add products first" case we want.
  const hasNoProducts = (store?.totalProducts ?? 0) === 0;

  const filteredProducts = useMemo(() => {
    let list = [...products];
    if (searchValue) {
      list = list.filter((p) =>
        p.title.toLowerCase().includes(searchValue.toLowerCase())
      );
    }
    if (scoreFilter.includes("critical")) {
      list = list.filter((p) => p.aiReadinessScore < 40);
    } else if (scoreFilter.includes("medium")) {
      list = list.filter(
        (p) => p.aiReadinessScore >= 40 && p.aiReadinessScore < 70
      );
    } else if (scoreFilter.includes("good")) {
      list = list.filter((p) => p.aiReadinessScore >= 70);
    }
    return list;
  }, [products, searchValue, scoreFilter]);

  const totalPages = Math.ceil(filteredProducts.length / PAGE_SIZE);
  const paginated = filteredProducts.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );

  // ── Product modal issues ──
  const modalIssues = selectedProduct
    ? auditResults.filter((r) => r.productId === selectedProduct.id)
    : [];

  // ── Last audited time ──
  const lastAuditedProduct = products.find((p) => p.lastAuditedAt);
  const lastAudited = lastAuditedProduct?.lastAuditedAt
    ? timeAgo(lastAuditedProduct.lastAuditedAt)
    : null;

  const submit = useCallback(
    (intent: string) => fetcher.submit({ intent }, { method: "POST" }),
    [fetcher]
  );

  const appliedFilters = scoreFilter.length
    ? [
        {
          key: "score",
          label: `Score: ${scoreFilter[0]}`,
          onRemove: () => setScoreFilter([]),
        },
      ]
    : [];

  // ── IndexTable rows ──
  // Note: the loader already caps what capped plans receive, so every row
  // we have is fully visible - no client-side "locked row" rendering needed.
  const tableRows = paginated.map((product, index) => {
    const absIndex = currentPage * PAGE_SIZE + index;

    return (
      <IndexTable.Row id={product.id} key={product.id} position={absIndex}>
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {product.title}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <ScorePill score={product.aiReadinessScore} />
        </IndexTable.Cell>

        <IndexTable.Cell>
          {product.topIssue ? (
            <InlineStack gap="100" blockAlign="center">
              <Badge tone={severityTone(product.topIssue.severity)}>
                {severityLabel(product.topIssue.severity)}
              </Badge>
              <Text as="span" variant="bodySm">
                {product.topIssue.title}
              </Text>
            </InlineStack>
          ) : (
            <Text as="span" variant="bodySm" tone="success">
              No issues
            </Text>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text
            as="span"
            variant="bodySm"
            tone={product.descriptionWordCount < 50 ? "critical" : undefined}
          >
            {product.descriptionWordCount} words
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {product.imageCount}{" "}
            {product.imageCount === 1 ? "image" : "images"}, alt text{" "}
            {product.hasAltText ? "set" : "missing"}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <InlineStack gap="100">
            <Badge tone={product.hasMetaTitle ? "success" : "attention"}>
              {product.hasMetaTitle ? "Set" : "Missing"}
            </Badge>
            <Badge
              tone={product.hasMetaDescription ? "success" : "attention"}
            >
              {product.hasMetaDescription ? "Set" : "Missing"}
            </Badge>
          </InlineStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Button
            size="slim"
            onClick={() => setSelectedProduct(product)}
          >
            View details
          </Button>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page>
      <TitleBar title="AI Audit">
        <button
          variant="primary"
          onClick={() => submit("runAudit")}
          disabled={isRunningAudit || isAutoFixing}
        >
          {isRunningAudit
            ? "Running audit…"
            : hasRunAudit
            ? "Re-run audit"
            : "Run first audit"}
        </button>
        {issueCounts.autoFixable > 0 && (
          <button
            onClick={() => setShowAutoFixConfirm(true)}
            disabled={isRunningAudit || isAutoFixing}
          >
            {isAutoFixing
              ? "Fixing…"
              : `Auto-fix all (${issueCounts.autoFixable})`}
          </button>
        )}
      </TitleBar>

      <BlockStack gap="500">
        {/* ── Post-fix banner - persists until re-audit or dismiss ── */}
        {lastFixResult && !isAutoFixing && !isRunningAudit && (
          <Banner
            tone={
              lastFixResult.aborted
                ? "warning"
                : lastFixResult.failed > 0
                ? "warning"
                : "success"
            }
            title={
              lastFixResult.aborted
                ? `Auto-fix stopped early - ${lastFixResult.fixed} fix${
                    lastFixResult.fixed !== 1 ? "es" : ""
                  } applied`
                : `Auto-fix complete: ${lastFixResult.fixed} fix${
                    lastFixResult.fixed !== 1 ? "es" : ""
                  } applied`
            }
            onDismiss={() => setLastFixResult(null)}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {lastFixResult.aborted
                  ? "The AI service hit a limit before we could finish. Try clicking Auto-fix again in a few minutes to pick up the rest."
                  : (() => {
                      const parts: string[] = [];
                      if (lastFixResult.fixed > 0) {
                        parts.push(
                          `Wrote new content for ${lastFixResult.fixed} issue${
                            lastFixResult.fixed !== 1 ? "s" : ""
                          }.`
                        );
                      }
                      if (lastFixResult.skipped > 0) {
                        parts.push(
                          `Skipped ${lastFixResult.skipped} that were already correct.`
                        );
                      }
                      if (lastFixResult.failed > 0) {
                        parts.push(
                          `${lastFixResult.failed} failed and may need a manual look.`
                        );
                      }
                      return parts.join(" ");
                    })()}
              </Text>
              <InlineStack gap="200">
                <Button
                  variant="primary"
                  onClick={() => {
                    setLastFixResult(null);
                    submit("runAudit");
                  }}
                  loading={isRunningAudit}
                >
                  Re-run audit to update your score
                </Button>
                <Button url="/app/action-plan">
                  See remaining fixes in Action Plan
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        )}

        {/* ── Running banner ── */}
        {isRunningAudit && (
          <Banner tone="info">
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="p" variant="bodyMd">
                Auditing your store… This may take a minute for large catalogs.
              </Text>
            </InlineStack>
          </Banner>
        )}

        {/* ── Auto-fixing banner ── */}
        {isAutoFixing && (
          <Banner tone="info">
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="p" variant="bodyMd">
                Writing fresh content with Claude… ~3 seconds per fix. Stay on
                this page; we'll show the results when done.
              </Text>
            </InlineStack>
          </Banner>
        )}

        {/* ── No audit yet ── */}
        {/* A zero-product store needs a different first move: running an
            audit on an empty catalog does nothing (no product rows means
            hasRunAudit never flips), so send the merchant to add products
            first rather than looping on "Run first audit". */}
        {!hasRunAudit && !isRunningAudit && hasNoProducts && (
          <Card>
            <EmptyState
              heading="Add products to run your first audit"
              action={{
                content: "Add products in Shopify admin",
                url: `https://${store?.shopifyDomain}/admin/products`,
                external: true,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Your store has no active products yet. Add products to your
                store, then run your first audit to get a detailed AI readiness
                score for each one.
              </Text>
            </EmptyState>
          </Card>
        )}
        {!hasRunAudit && !isRunningAudit && !hasNoProducts && (
          <Card>
            <EmptyState
              heading="Ready to see how AI sees your store?"
              action={{
                content: "Run first audit",
                onAction: () => submit("runAudit"),
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Run your first audit to get a detailed AI readiness score for
                every product. We check descriptions, images, search listing
                text, and more, then tell you exactly what to fix.
              </Text>
            </EmptyState>
          </Card>
        )}

        {/* ── GEO score hero ── */}
        {hasRunAudit && store && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start">
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Store GEO score
                  </Text>
                  <span
                    style={{
                      fontSize: "48px",
                      fontWeight: 700,
                      lineHeight: 1,
                      color: scoreColor(store.geoScore),
                    }}
                  >
                    {store.geoScore}
                    <span
                      style={{
                        fontSize: "24px",
                        fontWeight: 400,
                        color: brand.neutral[500],
                      }}
                    >
                      /100
                    </span>
                  </span>
                  <Text as="p" variant="bodyMd">
                    Your store is{" "}
                    <strong>{store.geoScore}%</strong> ready for AI discovery
                  </Text>
                  {lastAudited && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Last audited: {lastAudited}
                    </Text>
                  )}
                </BlockStack>

                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued" alignment="end">
                    {store.auditedProducts} products audited
                  </Text>
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {/* ── Issue summary cards ── */}
        {hasRunAudit && (
          <BlockStack gap="200">
            <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
              {[
                { label: "Critical", count: issueCounts.critical, tone: "critical" as const },
                { label: "High", count: issueCounts.high, tone: "warning" as const },
                { label: "Medium", count: issueCounts.medium, tone: "attention" as const },
                {
                  label: "Auto-fixable",
                  count: issueCounts.autoFixable,
                  tone: "info" as const,
                  action:
                    issueCounts.autoFixable > 0
                      ? () => setShowAutoFixConfirm(true)
                      : undefined,
                },
              ].map(({ label, count, tone, action: onAction }) => (
                <Card key={label}>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                      <Badge tone={tone}>{String(count)}</Badge>
                    </InlineStack>
                    <Text as="p" variant="headingLg">{count}</Text>
                    {onAction && count > 0 && (
                      <Button size="slim" variant="plain" onClick={onAction} loading={isAutoFixing}>
                        Fix all
                      </Button>
                    )}
                  </BlockStack>
                </Card>
              ))}
            </InlineGrid>
            <InlineStack gap="100" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                Missing meta titles or alt text across many products?
              </Text>
              <Button variant="plain" url="/app/bulk-edit">
                Fix them in one pass in Bulk Edit
              </Button>
            </InlineStack>
          </BlockStack>
        )}

        {/* ── AI shopping readiness ── */}
        {/* Parallel score, deliberately framed apart from the GEO score:
            this one is catalog attribute completeness for AI shopping
            agents, not on-page readability. Null store score means no
            audit has computed readiness yet (never render 0/100). */}
        {hasRunAudit && store && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                AI shopping readiness
              </Text>
              {store.readinessScore === null ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  Run an audit to compute your AI shopping readiness score.
                </Text>
              ) : (
                <BlockStack gap="300">
                  <span
                    style={{
                      fontSize: "48px",
                      fontWeight: 700,
                      lineHeight: 1,
                      color: scoreColor(store.readinessScore),
                    }}
                  >
                    {store.readinessScore}
                    <span
                      style={{
                        fontSize: "24px",
                        fontWeight: 400,
                        color: brand.neutral[500],
                      }}
                    >
                      /100
                    </span>
                  </span>
                  <Text as="p" variant="bodyMd">
                    Measures how complete your catalog attributes are for AI
                    shopping agents: category, barcodes, brand, images, SKUs,
                    reviews, and spec detail. Your GEO score measures on-page
                    readability; this measures feed completeness.
                  </Text>
                  {topReadinessGaps.length > 0 && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        Top gaps
                      </Text>
                      {topReadinessGaps.map(([gap, count]) => (
                        <Text as="p" variant="bodySm" key={gap}>
                          {count} product{count !== 1 ? "s" : ""}:{" "}
                          {READINESS_GAP_LABELS[gap]}
                        </Text>
                      ))}
                    </BlockStack>
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">
                    Weight is not checked yet. Scores update when you run an
                    audit.
                  </Text>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        )}

        {/* ── Free plan upgrade banner ── */}
        {/* Gate on the store's real catalog size, not the truncated loader
            payload: the loader caps products at FREE_PLAN_LIMIT for Free
            stores, so products.length can never exceed the limit. */}
        {isFreePlan &&
          hasRunAudit &&
          (store?.totalProducts ?? 0) > FREE_PLAN_LIMIT && (
          <Banner
            title="You're on the Free plan"
            tone="warning"
            action={{
              content: `Upgrade to audit all ${store?.totalProducts} products`,
              url: "/app/pricing",
            }}
          >
            <Text as="p" variant="bodyMd">
              Free plan shows detailed scores for {FREE_PLAN_LIMIT} products.
              Upgrade to Growth to unlock your full audit.
            </Text>
          </Banner>
        )}

        {/* ── Product table ── */}
        {hasRunAudit && products.length > 0 && (
          <Card padding="0">
            <Box padding="400">
              <Filters
                queryValue={searchValue}
                queryPlaceholder="Search products"
                onQueryChange={(v) => {
                  setSearchValue(v);
                  setCurrentPage(0);
                }}
                onQueryClear={() => {
                  setSearchValue("");
                  setCurrentPage(0);
                }}
                filters={[
                  {
                    key: "score",
                    label: "Score range",
                    filter: (
                      <ChoiceList
                        title="Score range"
                        titleHidden
                        choices={[
                          { label: "Critical (0-39)", value: "critical" },
                          { label: "Needs work (40-69)", value: "medium" },
                          { label: "Good (70-100)", value: "good" },
                        ]}
                        selected={scoreFilter}
                        onChange={(v) => {
                          setScoreFilter(v);
                          setCurrentPage(0);
                        }}
                      />
                    ),
                  },
                ]}
                appliedFilters={appliedFilters}
                onClearAll={() => {
                  setSearchValue("");
                  setScoreFilter([]);
                  setCurrentPage(0);
                }}
              />
            </Box>

            <IndexTable
              resourceName={{ singular: "product", plural: "products" }}
              itemCount={filteredProducts.length}
              headings={[
                { title: "Product" },
                { title: "AI score" },
                { title: "Top issue" },
                { title: "Description" },
                { title: "Images" },
                { title: "Meta title / description" },
                { title: "" },
              ]}
              selectable={false}
              pagination={{
                hasPrevious: currentPage > 0,
                onPrevious: () => setCurrentPage((p) => p - 1),
                hasNext: currentPage < totalPages - 1,
                onNext: () => setCurrentPage((p) => p + 1),
              }}
            >
              {tableRows}
            </IndexTable>
          </Card>
        )}
      </BlockStack>

      {/* ── Product detail modal ── */}
      <ProductDetailModal
        product={selectedProduct}
        issues={modalIssues}
        shopifyDomain={store?.shopifyDomain ?? ""}
        onClose={() => setSelectedProduct(null)}
      />

      {/* ── Auto-fix confirmation modal ── */}
      {/* Shown before submitting "Auto-fix all" so the merchant sees exactly
          what's about to be written + estimated time. Stops the surprise of
          "clicked the button, 90 seconds passed, products rewritten." */}
      <Modal
        open={showAutoFixConfirm}
        onClose={() => setShowAutoFixConfirm(false)}
        title="Start auto-fix?"
        primaryAction={{
          content: `Auto-fix ${autoFixBreakdown.total} issue${
            autoFixBreakdown.total !== 1 ? "s" : ""
          }`,
          onAction: () => {
            setShowAutoFixConfirm(false);
            setLastFixResult(null); // clear old result while new run is in flight
            submit("autoFix");
          },
          disabled: autoFixBreakdown.total === 0,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setShowAutoFixConfirm(false),
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              We&apos;ll use Claude to write fresh content for these:
            </Text>
            <BlockStack gap="100">
              {autoFixBreakdown.descriptions > 0 && (
                <Text as="p" variant="bodyMd">
                  •{" "}
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {autoFixBreakdown.descriptions}
                  </Text>{" "}
                  product description
                  {autoFixBreakdown.descriptions !== 1 ? "s" : ""} (writes a new
                  2-3 paragraph blurb using Claude vision on the product image)
                </Text>
              )}
              {autoFixBreakdown.metaDescriptions > 0 && (
                <Text as="p" variant="bodyMd">
                  •{" "}
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {autoFixBreakdown.metaDescriptions}
                  </Text>{" "}
                  meta description
                  {autoFixBreakdown.metaDescriptions !== 1 ? "s" : ""}{" "}
                  (120-158 chars, what shows up in search results)
                </Text>
              )}
              {autoFixBreakdown.seoTitles > 0 && (
                <Text as="p" variant="bodyMd">
                  •{" "}
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {autoFixBreakdown.seoTitles}
                  </Text>{" "}
                  SEO title{autoFixBreakdown.seoTitles !== 1 ? "s" : ""}{" "}
                  (30-58 chars, the clickable headline in Google)
                </Text>
              )}
              {autoFixBreakdown.altTexts > 0 && (
                <Text as="p" variant="bodyMd">
                  •{" "}
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {autoFixBreakdown.altTexts}
                  </Text>{" "}
                  image alt text{autoFixBreakdown.altTexts !== 1 ? "s" : ""}{" "}
                  (descriptive text Claude generates by actually looking at the
                  image)
                </Text>
              )}
            </BlockStack>
            <Banner tone="info">
              <Text as="p" variant="bodyMd">
                Estimated time: ~
                {Math.max(10, Math.ceil(autoFixBreakdown.total * 3))} seconds.
                We&apos;ll skip anything you&apos;ve already fixed manually, and
                the page refreshes when done. Your existing data is overwritten
                - there&apos;s no undo, so review one product first if
                you&apos;re unsure.
              </Text>
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

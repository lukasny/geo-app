import { useEffect, useState, useMemo, useCallback } from "react";
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
  IndexTable,
  Modal,
  EmptyState,
  Banner,
  Spinner,
  Box,
  Divider,
  TextField,
  ChoiceList,
  Filters,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { runFullAudit } from "~/services/audit-engine.server";
import { autoFixIssues } from "~/services/audit-engine.server";

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

function scoreColor(score: number): string {
  if (score < 40) return "#E24B4A";
  if (score < 70) return "#EF9F27";
  return "#1D9E75";
}

function scoreTone(score: number): "critical" | "primary" | "success" {
  if (score < 40) return "critical";
  if (score < 70) return "primary";
  return "success";
}

function severityTone(
  severity: Severity
): "critical" | "warning" | "attention" | "info" {
  switch (severity) {
    case "CRITICAL": return "critical";
    case "HIGH": return "warning";
    case "MEDIUM": return "attention";
    default: return "info";
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

const FREE_PLAN_LIMIT = 3;

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

  const [dbProducts, auditResultsRaw] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { aiReadinessScore: "asc" },
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
        auditResults: {
          orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
          take: 1,
          select: { id: true, title: true, severity: true },
        },
      },
    }),
    prisma.auditResult.findMany({
      where: { storeId: store.id },
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
    }),
  ]);

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
      const { PLAN_LIMITS } = await import("~/services/billing.shared");
      const planLimits = PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
      const maxProducts = planLimits.maxAuditProducts;
      if (maxProducts !== Infinity) {
        // Query Shopify directly for the actual catalog count. Counting the
        // local Product cache lets first-time users bypass the limit because
        // the cache is empty until after an audit has run.
        const countResponse = await admin.graphql(
          `#graphql
          query AuditProductCount {
            productsCount(query: "status:active") { count }
          }`
        );
        const countJson = (await countResponse.json()) as {
          data?: { productsCount?: { count: number } };
        };
        const actualCount = countJson.data?.productsCount?.count ?? 0;
        if (actualCount > maxProducts) {
          return { error: `Your plan allows auditing up to ${maxProducts} products. Upgrade to audit all ${actualCount} products.` };
        }
      }
      const summary = await runFullAudit(store.id, admin);
      return { success: true, summary };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { error: `Audit failed: ${msg}` };
    }
  }

  if (intent === "autoFix") {
    try {
      const result = await autoFixIssues(store.id, admin);
      return {
        success: true,
        fixed: result.fixed,
        failed: result.failed,
        skipped: result.skipped ?? 0,
        aborted: result.aborted ?? false,
      };
    } catch (err) {
      // The auto-fix loop catches its own per-issue errors. Reaching here
      // means something unexpected (DB outage, etc.) — log raw for debugging
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

function ScorePill({ score }: { score: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "12px",
        backgroundColor: scoreColor(score),
        color: "#fff",
        fontWeight: 600,
        fontSize: "13px",
        minWidth: "36px",
        textAlign: "center",
      }}
    >
      {score}
    </span>
  );
}

function CheckOrX({ value }: { value: boolean }) {
  return (
    <Text as="span" tone={value ? "success" : "critical"} variant="bodyMd">
      {value ? "✓" : "✗"}
    </Text>
  );
}

function ProductDetailModal({
  product,
  issues,
  onClose,
}: {
  product: ProductRow | null;
  issues: AuditResultItem[];
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

      {sorted.length === 0 && (
        <Modal.Section>
          <Text as="p" variant="bodyMd" tone="success">
            No issues found — this product is well optimized for AI discovery.
          </Text>
        </Modal.Section>
      )}

      {sorted.map((issue) => (
        <Modal.Section key={issue.id}>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={severityTone(issue.severity)}>
                {issue.severity}
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
      const s = data.summary as { storeScore: number };
      shopify.toast.show(
        `Audit complete! Your GEO score is ${s.storeScore}/100`
      );
    } else if ("fixed" in data) {
      const f = data.fixed as number;
      const s = (data.skipped as number) ?? 0;
      const fl = (data.failed as number) ?? 0;
      const aborted = (data.aborted as boolean) ?? false;
      if (aborted) {
        const fixedPart = `Auto-fixed ${f} issue${f !== 1 ? "s" : ""}`;
        shopify.toast.show(
          `${fixedPart} — then the AI service hit a limit. Try again in a few minutes to pick up the rest.`,
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
  const tableRows = paginated.map((product, index) => {
    const absIndex = currentPage * PAGE_SIZE + index;
    const locked = isFreePlan && absIndex >= FREE_PLAN_LIMIT;

    return (
      <IndexTable.Row id={product.id} key={product.id} position={absIndex}>
        <IndexTable.Cell>
          {locked ? (
            <span style={{ filter: "blur(4px)", userSelect: "none" }}>
              Locked product
            </span>
          ) : (
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {product.title}
            </Text>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          {locked ? (
            <Badge>Locked</Badge>
          ) : (
            <ScorePill score={product.aiReadinessScore} />
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          {locked ? null : product.topIssue ? (
            <InlineStack gap="100" blockAlign="center">
              <Badge tone={severityTone(product.topIssue.severity)}>
                {product.topIssue.severity}
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
          {locked ? null : (
            <Text
              as="span"
              variant="bodySm"
              tone={product.descriptionWordCount < 50 ? "critical" : undefined}
            >
              {product.descriptionWordCount} words
            </Text>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          {locked ? null : (
            <Text as="span" variant="bodySm">
              {product.hasAltText ? "✓" : "✗"} alt / {product.imageCount} imgs
            </Text>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          {locked ? null : (
            <InlineStack gap="100">
              <CheckOrX value={product.hasMetaTitle} />
              <CheckOrX value={product.hasMetaDescription} />
            </InlineStack>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          {locked ? (
            <Button
              size="slim"
              url="/app/pricing"
              variant="primary"
            >
              Upgrade
            </Button>
          ) : (
            <Button
              size="slim"
              onClick={() => setSelectedProduct(product)}
            >
              View details
            </Button>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page>
      <TitleBar title="AI Readiness Audit">
        <button
          variant="primary"
          onClick={() => submit("runAudit")}
          disabled={isRunningAudit}
        >
          {isRunningAudit
            ? "Running audit…"
            : hasRunAudit
            ? "Re-run Audit"
            : "Run First Audit"}
        </button>
        {issueCounts.autoFixable > 0 && (
          <button onClick={() => submit("autoFix")} disabled={isAutoFixing}>
            {isAutoFixing
              ? "Fixing…"
              : `Auto-fix All (${issueCounts.autoFixable})`}
          </button>
        )}
      </TitleBar>

      <BlockStack gap="500">
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

        {/* ── No audit yet ── */}
        {!hasRunAudit && !isRunningAudit && (
          <Card>
            <EmptyState
              heading="Ready to see how AI sees your store?"
              action={{
                content: "Run First Audit",
                onAction: () => submit("runAudit"),
              }}
              image=""
            >
              <Text as="p" variant="bodyMd">
                Run your first audit to get a detailed AI readiness score for
                every product. We check descriptions, images, meta data,
                structured data, and more — then tell you exactly what to fix.
              </Text>
            </EmptyState>
          </Card>
        )}

        {/* ── GEO Score hero ── */}
        {hasRunAudit && store && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start">
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Store GEO Score
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
                        color: "#6d7175",
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
            {[
              { label: "Critical", count: issueCounts.critical, tone: "critical" as const },
              { label: "High", count: issueCounts.high, tone: "warning" as const },
              { label: "Medium", count: issueCounts.medium, tone: "attention" as const },
              {
                label: "Auto-fixable",
                count: issueCounts.autoFixable,
                tone: "info" as const,
                action: issueCounts.autoFixable > 0 ? () => submit("autoFix") : undefined,
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
          </div>
        )}

        {/* ── Free plan upgrade banner ── */}
        {isFreePlan && hasRunAudit && products.length > FREE_PLAN_LIMIT && (
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
                          { label: "Critical (0–39)", value: "critical" },
                          { label: "Needs work (40–69)", value: "medium" },
                          { label: "Good (70–100)", value: "good" },
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
                { title: "AI Score" },
                { title: "Top Issue" },
                { title: "Description" },
                { title: "Images" },
                { title: "Meta T/D" },
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
        onClose={() => setSelectedProduct(null)}
      />
    </Page>
  );
}

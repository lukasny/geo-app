import { useState, useCallback, useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  SkeletonPage,
  SkeletonBodyText,
  SkeletonDisplayText,
  Select,
  Box,
  Divider,
  Thumbnail,
  Icon,
  Link,
} from "@shopify/polaris";
import {
  CheckCircleIcon,
  XCircleIcon,
  AlertCircleIcon,
} from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { simulateAiView } from "~/services/ai-simulator.server";
import type { FieldComparison, SimulationResult } from "~/services/ai-simulator.server";
import { PLAN_LIMITS } from "~/services/billing.shared";
import { severityLabel } from "~/utils/severity";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductOption {
  id: string;
  title: string;
  handle: string;
  shopifyProductId: string;
  price: string | null;
  imageUrl: string | null;
  aiReadinessScore: number;
}

interface LoaderData {
  products: ProductOption[];
  store: {
    id: string;
    shopifyDomain: string;
    shopName: string;
    plan: string;
  } | null;
  simulationsUsedThisMonth: number;
}

type ActionData =
  | { error: string }
  | {
      result: SimulationResult;
      productTitle: string;
      productPrice: string | null;
      productImageUrl: string | null;
      productDescription: string | null;
      productUrl: string;
    };

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, shopifyDomain: true, shopName: true, plan: true },
  });

  if (!store) {
    return { products: [], store: null, simulationsUsedThisMonth: 0 } satisfies LoaderData;
  }

  const dbProducts = await prisma.product.findMany({
    where: { storeId: store.id, status: "active" },
    orderBy: { title: "asc" },
    select: {
      id: true,
      title: true,
      handle: true,
      shopifyProductId: true,
      price: true,
      aiReadinessScore: true,
    },
    take: 250,
  });

  const products: ProductOption[] = dbProducts.map((p) => ({
    ...p,
    imageUrl: null, // Not stored in DB - fetched via Shopify when simulating
  }));

  // Same start-of-month window the action uses to enforce the FREE cap,
  // so the counter the merchant sees matches the limit check exactly.
  let simulationsUsedThisMonth = 0;
  if (store.plan === "FREE") {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    simulationsUsedThisMonth = await prisma.simulationUsage.count({
      where: { storeId: store.id, createdAt: { gte: startOfMonth } },
    });
  }

  return { products, store, simulationsUsedThisMonth } satisfies LoaderData;
};

// ─── Action ───────────────────────────────────────────────────────────────────

const PRODUCT_DETAIL_QUERY = `#graphql
  query SimulatorProduct($id: ID!) {
    product(id: $id) {
      title
      descriptionHtml
      vendor
      productType
      onlineStoreUrl
      images(first: 1) { edges { node { url altText } } }
      variants(first: 100) { edges { node { title price sku availableForSale } } }
      metafields(first: 20) { edges { node { namespace key value } } }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
    }
    shop { url }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent !== "simulate") return { error: "Unknown action." };

  const productDbId = formData.get("productId") as string;
  if (!productDbId) return { error: "No product selected." };

  // Enforce simulation limit for free plan
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true },
  });
  if (!store) return { error: "Store not found." };

  if (store.plan === "FREE") {
    const limit = PLAN_LIMITS.FREE.maxSimulations;
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    // Count actual simulator runs - the previous code counted AiCitation
    // records, which are never created by the simulator, so the limit never
    // tripped and free users could run unlimited simulations.
    const usedThisMonth = await prisma.simulationUsage.count({
      where: {
        storeId: store.id,
        createdAt: { gte: startOfMonth },
      },
    });
    if (usedThisMonth >= limit) {
      return { error: `Free plan allows ${limit} simulations per month. Upgrade to Growth for unlimited simulations.` };
    }
  }

  // P1-11 fix: scope the product lookup to this store. CUIDs are hard to
  // guess but tenant isolation should never rely on opaque-ID secrecy.
  const dbProduct = await prisma.product.findFirst({
    where: { id: productDbId, storeId: store.id },
    select: {
      shopifyProductId: true,
      handle: true,
      hasAltText: true,
      hasReviews: true,
      reviewCount: true,
      imageCount: true,
    },
  });

  if (!dbProduct) return { error: "Product not found." };

  // Fetch full product from Shopify
  const shopifyRes = await admin.graphql(PRODUCT_DETAIL_QUERY, {
    variables: { id: dbProduct.shopifyProductId },
  });
  const shopifyJson = (await shopifyRes.json()) as {
    data: {
      product: {
        title: string;
        descriptionHtml: string;
        vendor: string;
        productType: string;
        onlineStoreUrl: string | null;
        images: { edges: { node: { url: string; altText: string | null } }[] };
        variants: {
          edges: {
            node: {
              title: string;
              price: string;
              sku: string | null;
              availableForSale: boolean;
            };
          }[];
        };
        metafields: { edges: { node: { namespace: string; key: string; value: string } }[] };
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
        };
      };
      shop: { url: string };
    };
  };

  const sp = shopifyJson.data.product;
  const shopUrl = shopifyJson.data.shop.url;

  const productUrl =
    sp.onlineStoreUrl ??
    `${shopUrl}/products/${dbProduct.handle}`;

  const plainDesc = sp.descriptionHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const firstVariant = sp.variants.edges[0]?.node;
  const available = sp.variants.edges.some((e) => e.node.availableForSale);
  const variantTitles = sp.variants.edges
    .map((e) => e.node.title)
    .filter((t) => t !== "Default Title");

  // Check review metafields
  const reviewMf = sp.metafields.edges.find(
    (e) =>
      e.node.namespace === "reviews" ||
      e.node.namespace === "loox" ||
      e.node.namespace === "okendo"
  );

  const shopifyInput = {
    title: sp.title,
    description: plainDesc || null,
    price: firstVariant
      ? `${firstVariant.price} ${sp.priceRangeV2.minVariantPrice.currencyCode}`
      : null,
    currency: sp.priceRangeV2.minVariantPrice.currencyCode,
    available,
    vendor: sp.vendor || null,
    productType: sp.productType || null,
    sku: firstVariant?.sku || null,
    imageCount: sp.images.edges.length,
    hasAltText: dbProduct.hasAltText,
    variants: variantTitles,
    hasReviews: dbProduct.hasReviews,
    reviewCount: dbProduct.reviewCount,
    rating: reviewMf ? parseFloat(reviewMf.node.value) || null : null,
  };

  try {
    const result = await simulateAiView(productUrl, shopifyInput);
    // Record one usage row per successful run so the monthly limit check
    // actually has data to count.
    await prisma.simulationUsage.create({
      data: { storeId: store.id, productId: productDbId },
    });
    return {
      result,
      productTitle: sp.title,
      productPrice: firstVariant
        ? `${sp.priceRangeV2.minVariantPrice.amount} ${sp.priceRangeV2.minVariantPrice.currencyCode}`
        : null,
      productImageUrl: sp.images.edges[0]?.node.url ?? null,
      productDescription: plainDesc.slice(0, 200) || null,
      productUrl,
    } satisfies ActionData;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { error: `Simulation failed: ${msg}. Please try again.` };
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const IMPORTANCE_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

function statusIcon(status: FieldComparison["status"]) {
  switch (status) {
    case "found":
      return <Icon source={CheckCircleIcon} tone="success" />;
    case "missing":
      return <Icon source={XCircleIcon} tone="critical" />;
    case "partial":
    case "mismatch":
      return <Icon source={AlertCircleIcon} tone="caution" />;
  }
}

function importanceBadge(importance: FieldComparison["importance"]) {
  const map = {
    critical: "critical" as const,
    high: "warning" as const,
    medium: "attention" as const,
    low: "info" as const,
  };
  return (
    <Badge tone={map[importance]} size="small">
      {severityLabel(importance)}
    </Badge>
  );
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "-";
  if (Array.isArray(val)) return val.length > 0 ? val.slice(0, 3).join(", ") : "None";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return String(val).slice(0, 80);
}

function scoreColor(score: number): string {
  if (score < 40) return "#E24B4A";
  if (score < 70) return "#EF9F27";
  return "#1D9E75";
}

const FIX_RECOMMENDATIONS: Record<string, string> = {
  description:
    "Add a detailed product description of 100+ words using natural, conversational language. Describe what the product is, who it's for, and its key benefits.",
  structuredDataFound:
    "Enable GEO Rise's JSON-LD Schema Injector in your theme. Go to Online Store → Themes → Customize → App Embeds and turn on 'GEO Rise Schema'.",
  reviewCount:
    "Install a review app (Judge.me, Loox, or Okendo) and send post-purchase review request emails. Even 3-5 reviews significantly improve AI visibility.",
  rating:
    "Collect customer reviews using a review app. Products with ratings are significantly more likely to be cited by AI search engines.",
  imagesHaveAltText:
    "Add descriptive alt text to all product images. GEO Rise can auto-generate these for you - go to the Audit page and click 'Auto-fix All'.",
  brand:
    "Set the Vendor field on your product. AI search engines use brand information to answer queries like 'best [product] by [brand]'.",
  shippingInfo:
    "Add shipping information to your product description or store policies. AI agents use this to answer customer questions about delivery.",
  returnPolicy:
    "Add your return policy to the product description or ensure your store's return policy page is linked. AI agents cite return policies in purchase decisions.",
  materials:
    "Mention the materials, fabrics, or ingredients in your product description. Specific material information makes AI recommendations more accurate.",
  dimensions:
    "Add dimensions, size specifications, or weight to your product description. Buyers use this information when making AI-assisted purchase decisions.",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SimulationSkeleton() {
  return (
    <BlockStack gap="500">
      <Banner tone="info">
        <Text as="p" variant="bodyMd">
          Asking AI to analyze your product page… This takes about 10 seconds.
        </Text>
      </Banner>
      <SkeletonPage>
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={5} />
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={8} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    </BlockStack>
  );
}

function FieldRow({ field }: { field: FieldComparison }) {
  const isMissing = field.status === "missing";
  return (
    <Box
      padding="300"
      background={
        isMissing && field.importance === "critical"
          ? "bg-surface-critical"
          : "bg-surface"
      }
      borderRadius="200"
    >
      <InlineStack align="space-between" blockAlign="start" gap="200">
        <InlineStack gap="200" blockAlign="center">
          {statusIcon(field.status)}
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" fontWeight="semibold">
              {field.label}
            </Text>
            {!isMissing && field.aiExtractedValue !== null && (
              <Text as="span" variant="bodySm" tone="subdued">
                {formatValue(field.aiExtractedValue)}
              </Text>
            )}
            {isMissing && (
              <Text as="span" variant="bodySm" tone="critical">
                Not found by AI
              </Text>
            )}
            {field.status === "partial" && (
              <Text as="span" variant="bodySm" tone="caution">
                Partially found
              </Text>
            )}
          </BlockStack>
        </InlineStack>
        {importanceBadge(field.importance)}
      </InlineStack>
    </Box>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SimulatorPage() {
  const { products, store, simulationsUsedThisMonth } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();

  const [selectedProductId, setSelectedProductId] = useState(
    products[0]?.id ?? ""
  );

  const isSimulating = fetcher.state !== "idle";
  const actionData = fetcher.data;
  const hasResult = actionData && "result" in actionData;
  const hasError = actionData && "error" in actionData;

  const selectOptions = useMemo(
    () =>
      products.map((p) => ({
        label: `${p.title}${p.aiReadinessScore > 0 ? ` (Score: ${p.aiReadinessScore})` : ""}`,
        value: p.id,
      })),
    [products]
  );

  const runSimulation = useCallback(() => {
    fetcher.submit(
      { intent: "simulate", productId: selectedProductId },
      { method: "POST" }
    );
  }, [fetcher, selectedProductId]);

  // Sort comparison by importance
  const sortedComparison = useMemo(() => {
    if (!hasResult) return [];
    return [...(actionData as { result: SimulationResult }).result.comparison].sort(
      (a, b) =>
        IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
    );
  }, [hasResult, actionData]);

  const missingWithFix = useMemo(() => {
    return sortedComparison
      .filter((f) => f.status === "missing" && FIX_RECOMMENDATIONS[f.fieldName])
      .slice(0, 6);
  }, [sortedComparison]);

  return (
    <Page>
      <TitleBar title="AI Simulator" />

      <BlockStack gap="500">
        {/* ── Product selector ── */}
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                See your products through the eyes of AI
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Pick a product and we&apos;ll show you exactly what ChatGPT,
                Perplexity, and Gemini can and cannot see about it.
              </Text>
            </BlockStack>

            <InlineStack gap="300" blockAlign="end">
              <div style={{ flex: 1 }}>
                {products.length === 0 ? (
                  <Banner tone="warning">
                    <Text as="p" variant="bodyMd">
                      Run an audit first to populate your product list.{" "}
                      <Link url="/app/audit">Go to AI Audit</Link>
                    </Text>
                  </Banner>
                ) : (
                  <Select
                    label="Select a product"
                    options={selectOptions}
                    value={selectedProductId}
                    onChange={setSelectedProductId}
                  />
                )}
              </div>
              <Button
                variant="primary"
                onClick={runSimulation}
                loading={isSimulating}
                disabled={!selectedProductId || products.length === 0}
              >
                Run simulation
              </Button>
            </InlineStack>

            {store?.plan === "FREE" && (
              <Text as="p" variant="bodySm" tone="subdued">
                {simulationsUsedThisMonth} of {PLAN_LIMITS.FREE.maxSimulations}{" "}
                free simulations used this month.
              </Text>
            )}
          </BlockStack>
        </Card>

        {/* ── Error ── */}
        {/* Gated on !isSimulating so a stale failure banner doesn't sit
            above the loading skeleton while a retry is in flight. */}
        {hasError && !isSimulating && (
          <Banner tone="critical" title="Simulation failed">
            <Text as="p" variant="bodyMd">
              {(actionData as { error: string }).error}
            </Text>
          </Banner>
        )}

        {/* ── Loading skeleton ── */}
        {isSimulating && <SimulationSkeleton />}

        {/* ── Results ── */}
        {!isSimulating && hasResult && (() => {
          const { result, productTitle, productPrice, productImageUrl, productDescription, productUrl } =
            actionData as Exclude<ActionData, { error: string }>;

          const scoreTone =
            result.visibilityScore < 40
              ? ("critical" as const)
              : result.visibilityScore < 70
              ? ("warning" as const)
              : ("success" as const);

          const scoreMessage =
            result.visibilityScore < 40
              ? `AI can only see ${result.foundFields} of ${result.totalFields} product attributes. Your product is nearly invisible to AI search.`
              : result.visibilityScore < 70
              ? `AI found ${result.foundFields} of ${result.totalFields} attributes. There's significant room for improvement.`
              : `AI can see ${result.foundFields} of ${result.totalFields} attributes. Good foundation - let's make it even better.`;

          return (
            <BlockStack gap="500">
              {/* Fallback notice - explains why we're simulating off Shopify data
                  instead of the live page (password protected, 404, etc.) */}
              {result.usedFallback && result.fallbackReason && (
                <Banner tone="warning" title="Simulating on Shopify data - live page not reachable">
                  <Text as="p" variant="bodyMd">
                    {result.fallbackReason}
                  </Text>
                </Banner>
              )}

              {/* Score banner */}
              <Banner tone={scoreTone}>
                <InlineStack gap="300" blockAlign="center">
                  <span
                    style={{
                      fontSize: "32px",
                      fontWeight: 700,
                      color: scoreColor(result.visibilityScore),
                      lineHeight: 1,
                    }}
                  >
                    {result.visibilityScore}%
                  </span>
                  <Text as="p" variant="bodyMd">
                    {scoreMessage}
                  </Text>
                </InlineStack>
              </Banner>

              {/* Cross-AI platform breakdown - only when 2+ platforms ran.
                  Shows merchant which models see their product differently.
                  Hidden in single-platform setups so the UI stays uncluttered. */}
              {result.platforms && result.platforms.length > 1 && (
                <Card>
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingMd">
                        Cross-AI comparison
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Each model extracted from the same page independently.
                        A gap between platforms means one of them is missing
                        something the other found - usually a sign your
                        structured data could be clearer.
                      </Text>
                    </BlockStack>
                    <InlineStack gap="300" wrap>
                      {result.platforms.map((p) => {
                        const label =
                          p.platform === "CLAUDE" ? "Claude" : "ChatGPT";
                        return (
                          <Box
                            key={p.platform}
                            padding="300"
                            background="bg-surface-secondary"
                            borderRadius="200"
                            minWidth="160px"
                          >
                            <BlockStack gap="100">
                              <Text
                                as="span"
                                variant="bodyMd"
                                fontWeight="semibold"
                              >
                                {label}
                              </Text>
                              {p.errorReason ? (
                                <Text
                                  as="span"
                                  variant="bodySm"
                                  tone="critical"
                                >
                                  Couldn't extract
                                </Text>
                              ) : (
                                <>
                                  <span
                                    style={{
                                      fontSize: "24px",
                                      fontWeight: 700,
                                      color: scoreColor(p.visibilityScore),
                                      lineHeight: 1,
                                    }}
                                  >
                                    {p.visibilityScore}%
                                  </span>
                                  <Text
                                    as="span"
                                    variant="bodySm"
                                    tone="subdued"
                                  >
                                    {p.foundFields} of {p.totalFields} fields
                                  </Text>
                                </>
                              )}
                            </BlockStack>
                          </Box>
                        );
                      })}
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}

              {/* Two-column layout */}
              <Layout>
                {/* Left - what humans see */}
                <Layout.Section variant="oneHalf">
                  <Card>
                    <BlockStack gap="400">
                      <Text as="h2" variant="headingMd">
                        What your customers see
                      </Text>
                      <Divider />

                      {productImageUrl && (
                        <Thumbnail
                          source={productImageUrl}
                          alt={productTitle}
                          size="large"
                        />
                      )}

                      <BlockStack gap="100">
                        <Text as="h3" variant="headingLg">
                          {productTitle}
                        </Text>
                        {productPrice && (
                          <Text as="p" variant="headingMd" tone="success">
                            {productPrice}
                          </Text>
                        )}
                      </BlockStack>

                      {productDescription && (
                        <Text as="p" variant="bodyMd" tone="subdued">
                          {productDescription}
                          {productDescription.length >= 200 && "…"}
                        </Text>
                      )}

                      <Box paddingBlockStart="200">
                        <Button
                          url={productUrl}
                          external
                          variant="plain"
                        >
                          View full product page
                        </Button>
                      </Box>
                    </BlockStack>
                  </Card>
                </Layout.Section>

                {/* Right - what AI sees */}
                <Layout.Section variant="oneHalf">
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          What AI search engines see
                        </Text>
                        <Badge
                          tone={
                            result.visibilityScore >= 70
                              ? "success"
                              : result.visibilityScore >= 40
                              ? "attention"
                              : "critical"
                          }
                        >
                          {`${result.foundFields}/${result.totalFields} fields`}
                        </Badge>
                      </InlineStack>
                      <Divider />

                      <BlockStack gap="200">
                        {sortedComparison.map((field) => (
                          <FieldRow key={field.fieldName} field={field} />
                        ))}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                </Layout.Section>
              </Layout>

              {/* Fix recommendations */}
              {missingWithFix.length > 0 && (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      How to fix this
                    </Text>
                    <Divider />
                    <BlockStack gap="300">
                      {missingWithFix.map((field) => (
                        <Box
                          key={field.fieldName}
                          padding="300"
                          background="bg-surface-secondary"
                          borderRadius="200"
                        >
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Icon source={XCircleIcon} tone="critical" />
                              <Text
                                as="span"
                                variant="bodySm"
                                fontWeight="semibold"
                              >
                                {field.label}
                              </Text>
                              {importanceBadge(field.importance)}
                            </InlineStack>
                            <Box paddingInlineStart="600">
                              <Text as="p" variant="bodySm" tone="subdued">
                                {FIX_RECOMMENDATIONS[field.fieldName]}
                              </Text>
                            </Box>
                          </BlockStack>
                        </Box>
                      ))}
                    </BlockStack>

                    <Divider />

                    <InlineStack gap="300">
                      <Button variant="primary" url="/app/audit">
                        Run a full audit for all products
                      </Button>
                      <Button url="/app/action-plan">
                        See your action plan
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          );
        })()}
      </BlockStack>
    </Page>
  );
}

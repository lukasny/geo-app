import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  TextField,
  BlockStack,
  InlineStack,
  Banner,
  Badge,
  Box,
  Filters,
  IndexTable,
  useIndexResourceState,
  Modal,
  Spinner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  applyBulkEdit,
  MAX_BULK_PRODUCTS,
} from "~/services/bulk-edit.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import { ScorePill } from "~/components/ScorePill";
import { BrandEmptyState } from "~/brand/BrandEmptyState";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductRow {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  price: string | null;
  handle: string;
  hasMetaTitle: boolean;
  hasMetaDescription: boolean;
  hasAltText: boolean;
  imageCount: number;
  aiReadinessScore: number;
}

interface LoaderData {
  plan: PlanKey;
  planAllowsFeature: boolean;
  products: ProductRow[];
  maxBulkProducts: number;
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
      planAllowsFeature: false,
      products: [],
      maxBulkProducts: MAX_BULK_PRODUCTS,
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const planAllowsFeature = Boolean(limits.bulkOptimization);

  // Gated server-side like app.revenue.tsx: FREE gets no product data.
  const products = planAllowsFeature
    ? await prisma.product.findMany({
        where: { storeId: store.id },
        orderBy: { title: "asc" },
        select: {
          id: true,
          title: true,
          vendor: true,
          productType: true,
          price: true,
          handle: true,
          hasMetaTitle: true,
          hasMetaDescription: true,
          hasAltText: true,
          imageCount: true,
          aiReadinessScore: true,
        },
      })
    : [];

  return {
    plan: planKey,
    planAllowsFeature,
    products,
    maxBulkProducts: MAX_BULK_PRODUCTS,
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

  // Server-side plan enforcement, independent of what the UI shows.
  const limits = PLAN_LIMITS[store.plan as PlanKey] ?? PLAN_LIMITS.FREE;
  if (!limits.bulkOptimization) {
    return {
      error:
        "Bulk editing is available on Growth and higher plans. See pricing to upgrade.",
    };
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "applyBulkEdit") {
    let productIds: unknown;
    try {
      productIds = JSON.parse((formData.get("productIds") as string) ?? "[]");
    } catch {
      return { error: "Invalid product selection." };
    }
    if (
      !Array.isArray(productIds) ||
      productIds.length === 0 ||
      !productIds.every((id) => typeof id === "string")
    ) {
      return { error: "Select at least one product." };
    }

    const metaTitleTemplate =
      ((formData.get("metaTitleTemplate") as string) ?? "").slice(0, 200);
    const altTextTemplate =
      ((formData.get("altTextTemplate") as string) ?? "").slice(0, 200);

    try {
      const summary = await applyBulkEdit(store.id, admin, {
        productIds: productIds as string[],
        metaTitleTemplate,
        altTextTemplate,
      });
      return { success: true, summary };
    } catch (err) {
      console.error("[GEO Rise bulk-edit] apply failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      // Our own validation errors are merchant-readable; anything else
      // gets a generic line so vendor internals don't leak into toasts.
      return {
        error: message.includes("template")
          ? message
          : "Bulk edit failed partway. Your products were not damaged; check a few in Shopify admin and try again.",
      };
    }
  }

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const TEMPLATE_HELP =
  "Variables: {title}, {vendor}, {type}, {handle}, {price}, {shop}";

/** Client-side twin of the server's renderTemplate (the service module is
 *  server-only and can't be imported into component code). */
function renderPreview(
  template: string,
  vars: Record<string, string | null | undefined>
): string {
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function statusBadge(ok: boolean, okLabel: string, missingLabel: string) {
  return ok ? (
    <Badge tone="success">{okLabel}</Badge>
  ) : (
    <Badge tone="attention">{missingLabel}</Badge>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BulkEditPage() {
  const { plan, planAllowsFeature, products, maxBulkProducts } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [metaTitleTemplate, setMetaTitleTemplate] = useState("");
  const [altTextTemplate, setAltTextTemplate] = useState("");
  const [queryValue, setQueryValue] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [showConfirm, setShowConfirm] = useState(false);

  const filtered = useMemo(() => {
    const q = queryValue.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.vendor ?? "").toLowerCase().includes(q)
    );
  }, [products, queryValue]);

  // The hook gets the FILTERED list, not the whole catalog: select-all and
  // shift-click ranges resolve against the hook's array, so feeding it
  // unfiltered products would let a select-all during a search silently
  // select (and edit) products the merchant never saw.
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(filtered.map((p) => ({ id: p.id })));

  const isApplying =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "applyBulkEdit";

  useEffect(() => {
    if (!fetcher.data || fetcher.state !== "idle") return;
    if ("success" in fetcher.data && fetcher.data.success) {
      const s = fetcher.data.summary;
      const parts = [
        `Updated ${s.updated} ${s.updated === 1 ? "product" : "products"}`,
      ];
      if (s.metaTitlesSet > 0) parts.push(`${s.metaTitlesSet} meta titles`);
      if (s.altTextsSet > 0) parts.push(`${s.altTextsSet} alt texts`);
      if (s.skipped > 0) parts.push(`${s.skipped} needed no change`);
      if (s.failed > 0) parts.push(`${s.failed} failed`);
      if (s.metaTitlesFailed > 0)
        parts.push(`${s.metaTitlesFailed} meta titles failed`);
      if (s.altTextsFailed > 0)
        parts.push(`${s.altTextsFailed} alt texts failed`);
      const anyFailure =
        s.failed > 0 || s.metaTitlesFailed > 0 || s.altTextsFailed > 0;
      shopify.toast.show(parts.join(", "), { isError: anyFailure });
      if (s.aborted) {
        shopify.toast.show(
          "Stopped early after repeated failures. Try again in a minute.",
          { isError: true }
        );
      }
      setShowConfirm(false);
      clearSelection();
    } else if ("error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      setShowConfirm(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state, shopify]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE
  );

  const hasAnyTemplate =
    metaTitleTemplate.trim().length > 0 || altTextTemplate.trim().length > 0;

  const firstSelected =
    products.find((p) => selectedResources.includes(p.id)) ?? products[0];
  const previewVars = firstSelected
    ? {
        title: firstSelected.title,
        vendor: firstSelected.vendor,
        type: firstSelected.productType,
        handle: firstSelected.handle,
        price: firstSelected.price,
        shop: "Your Store",
      }
    : null;

  // ── Plan gate ──
  if (!planAllowsFeature) {
    return (
      <Page>
        <TitleBar title="Bulk edit" />
        <Banner
          tone="warning"
          title={`${PLAN_DEFINITIONS[plan].name} plan doesn't include bulk editing`}
        >
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              Select any number of products and apply meta title patterns and
              image alt-text templates in one pass. Available on Growth ($
              {PLAN_DEFINITIONS.GROWTH.price}/mo) and higher plans.
            </Text>
            <div>
              <Link to="/app/pricing">
                <Button variant="primary">See pricing</Button>
              </Link>
            </div>
          </BlockStack>
        </Banner>
      </Page>
    );
  }

  return (
    <Page>
      <TitleBar title="Bulk edit" />

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Write a template once, apply it to many products at once. Select
            products below, then use the bulk action bar that appears above
            the table. Alt-text templates only fill images that have no alt
            text yet; nothing gets overwritten.
          </Text>
        </Banner>

        {isApplying && (
          <Banner tone="info">
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="p" variant="bodyMd">
                Applying templates to{" "}
                {Math.min(selectedResources.length, maxBulkProducts)} products.
                This takes roughly a second per product; stay on this page.
              </Text>
            </InlineStack>
          </Banner>
        )}

        {/* ── Templates ── */}
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Templates
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Fill in one or both. Empty fields are left alone.
              </Text>
            </BlockStack>
            <TextField
              label="Meta title template"
              value={metaTitleTemplate}
              onChange={setMetaTitleTemplate}
              placeholder="{title} | {shop}"
              helpText={`${TEMPLATE_HELP}. Aim for under 60 characters.`}
              autoComplete="off"
              maxLength={200}
            />
            <TextField
              label="Image alt text template"
              value={altTextTemplate}
              onChange={setAltTextTemplate}
              placeholder="{title} by {vendor}"
              helpText={`${TEMPLATE_HELP}. Applied only to images missing alt text.`}
              autoComplete="off"
              maxLength={200}
            />
            {previewVars && hasAnyTemplate && (
              <Box
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Preview for "{firstSelected.title}":
                  </Text>
                  {metaTitleTemplate.trim() && (
                    <Text as="p" variant="bodySm">
                      Meta title: {renderPreview(metaTitleTemplate, previewVars)}
                    </Text>
                  )}
                  {altTextTemplate.trim() && (
                    <Text as="p" variant="bodySm">
                      Alt text: {renderPreview(altTextTemplate, previewVars)}
                    </Text>
                  )}
                </BlockStack>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* ── Product grid ── */}
        {products.length === 0 ? (
          <BrandEmptyState
            heading="No products to edit yet"
            body="Bulk edit works on your audited catalog. Run an audit first, then come back here to apply meta title and alt text templates across many products at once."
            primaryAction={{ content: "Go to AI audit", url: "/app/audit" }}
          />
        ) : (
          <Card padding="0">
            <Box padding="400">
              <Filters
                queryValue={queryValue}
                queryPlaceholder="Search by product title or vendor"
                filters={[]}
                onQueryChange={(v) => {
                  setQueryValue(v);
                  setCurrentPage(0);
                  // Selection is scoped to the visible (filtered) list;
                  // changing the filter resets it so stale picks from a
                  // previous search can't ride along into an apply.
                  clearSelection();
                }}
                onQueryClear={() => {
                  setQueryValue("");
                  setCurrentPage(0);
                  clearSelection();
                }}
                onClearAll={() => {
                  setQueryValue("");
                  setCurrentPage(0);
                  clearSelection();
                }}
              />
            </Box>
            <IndexTable
              resourceName={{ singular: "product", plural: "products" }}
              itemCount={filtered.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={[
                {
                  content: hasAnyTemplate
                    ? "Apply templates"
                    : "Apply templates (write one above first)",
                  onAction: () => {
                    if (!hasAnyTemplate) {
                      shopify.toast.show("Write a template first", {
                        isError: true,
                      });
                      return;
                    }
                    setShowConfirm(true);
                  },
                },
              ]}
              headings={[
                { title: "Product" },
                { title: "Meta title" },
                { title: "Meta description" },
                { title: "Alt text" },
                { title: "Images" },
                { title: "AI score" },
              ]}
              pagination={{
                hasPrevious: currentPage > 0,
                onPrevious: () => setCurrentPage((p) => p - 1),
                hasNext: currentPage < totalPages - 1,
                onNext: () => setCurrentPage((p) => p + 1),
              }}
            >
              {paginated.map((product, index) => {
                const absIndex = currentPage * PAGE_SIZE + index;
                return (
                  <IndexTable.Row
                    id={product.id}
                    key={product.id}
                    position={absIndex}
                    selected={selectedResources.includes(product.id)}
                  >
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {product.title}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {statusBadge(product.hasMetaTitle, "Set", "Missing")}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {statusBadge(product.hasMetaDescription, "Set", "Missing")}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {product.imageCount === 0 ? (
                        <Text as="span" variant="bodySm" tone="subdued">
                          No images
                        </Text>
                      ) : (
                        statusBadge(product.hasAltText, "Set", "Missing")
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{product.imageCount}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <ScorePill score={product.aiReadinessScore} />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          </Card>
        )}
      </BlockStack>

      {/* ── Confirmation Modal ── */}
      <Modal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        title={`Apply templates to ${Math.min(
          selectedResources.length,
          maxBulkProducts
        )} products?`}
        primaryAction={{
          content: isApplying ? "Applying…" : "Apply",
          onAction: () => {
            fetcher.submit(
              {
                intent: "applyBulkEdit",
                productIds: JSON.stringify(
                  selectedResources.slice(0, maxBulkProducts)
                ),
                metaTitleTemplate,
                altTextTemplate,
              },
              { method: "POST" }
            );
          },
          loading: isApplying,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setShowConfirm(false),
            disabled: isApplying,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {metaTitleTemplate.trim() && (
              <Text as="p" variant="bodyMd">
                Meta title will become: <b>{metaTitleTemplate.trim()}</b>
              </Text>
            )}
            {altTextTemplate.trim() && (
              <Text as="p" variant="bodyMd">
                Images without alt text will get:{" "}
                <b>{altTextTemplate.trim()}</b>
              </Text>
            )}
            {selectedResources.length > maxBulkProducts && (
              <Banner tone="warning">
                <Text as="p" variant="bodyMd">
                  You selected {selectedResources.length} products; the first{" "}
                  {maxBulkProducts} will be processed this round. Run it again
                  for the rest.
                </Text>
              </Banner>
            )}
            <Text as="p" variant="bodyMd" tone="subdued">
              This updates your live Shopify products. Existing meta
              descriptions are preserved, existing alt text is never
              overwritten, and there is no undo.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

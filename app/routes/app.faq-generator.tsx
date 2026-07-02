import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  Select,
  BlockStack,
  InlineStack,
  Badge,
  Banner,
  Box,
  ButtonGroup,
  Divider,
  Modal,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { Prisma } from "@prisma/client";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  FaqCapReachedError,
  generateProductFaqDraft,
  publishFaqToStorefront,
  unpublishFaqFromStorefront,
  countProductFaqsThisMonth,
} from "~/services/faq-generation.server";
import { sanitizeAiVendorError } from "~/services/ai-retry.server";
import { BrandEmptyState } from "~/brand/BrandEmptyState";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import { timeAgo } from "~/utils/time";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FaqQuestion {
  question: string;
  answer: string;
}

interface LoaderProduct {
  shopifyProductId: string;
  title: string;
}

interface LoaderFaq {
  id: string;
  shopifyProductId: string;
  productTitle: string;
  questions: FaqQuestion[];
  status: string;
  publishedAt: string | null;
  createdAt: string;
}

interface LoaderData {
  plan: PlanKey;
  products: LoaderProduct[];
  faqs: LoaderFaq[];
  faqsThisMonth: number;
  /** null = unlimited FAQ runs on this plan. */
  monthlyCap: number | null;
  /** null = unlimited runs; otherwise remaining runs this month. */
  capRemaining: number | null;
}

// Normalize the questions Json column into a typed FAQ array, dropping any
// malformed entries so the UI never renders a broken row.
function toQuestions(raw: unknown): FaqQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (q): q is FaqQuestion =>
        !!q &&
        typeof q === "object" &&
        typeof (q as FaqQuestion).question === "string" &&
        typeof (q as FaqQuestion).answer === "string",
    )
    .map((q) => ({ question: q.question, answer: q.answer }));
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Narrow field pick, never `...store`: the Store row carries the access
  // token and a spread would serialize it into the browser payload.
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true, faqMetafieldDefinitionCreated: true },
  });
  if (!store) {
    return {
      plan: "FREE" as PlanKey,
      products: [],
      faqs: [],
      faqsThisMonth: 0,
      monthlyCap: 0,
      capRemaining: 0,
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const monthlyCap = limits.maxProductFaqsPerMonth;

  // Products come from the cached Product model (populated by the AI Audit /
  // product sync). Loader only surfaces finished FAQ states. In-flight
  // ("generating"), errored ("failed"), and soft-deleted ("deleted") rows
  // still count toward the monthly cap but don't render in the UI.
  const [products, faqs, faqsThisMonth] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      select: { shopifyProductId: true, title: true },
      orderBy: { title: "asc" },
      take: 200,
    }),
    prisma.productFaq.findMany({
      where: {
        storeId: store.id,
        status: { notIn: ["generating", "deleted"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    countProductFaqsThisMonth(store.id),
  ]);

  const capRemaining =
    monthlyCap === Infinity ? null : Math.max(0, monthlyCap - faqsThisMonth);

  const loaderFaqs: LoaderFaq[] = faqs.map((f) => ({
    id: f.id,
    shopifyProductId: f.shopifyProductId,
    productTitle: f.productTitle,
    questions: toQuestions(f.questions),
    status: f.status,
    publishedAt: f.publishedAt?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
  }));

  return {
    plan: planKey,
    products: products.map((p) => ({
      shopifyProductId: p.shopifyProductId,
      title: p.title,
    })),
    faqs: loaderFaqs,
    faqsThisMonth,
    monthlyCap: monthlyCap === Infinity ? null : monthlyCap,
    capRemaining,
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

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const monthlyCap = limits.maxProductFaqsPerMonth;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "generate") {
    if (monthlyCap === 0) {
      return {
        error: "FAQ generation is a Growth/Pro/Enterprise feature.",
      };
    }

    const shopifyProductId = ((formData.get("shopifyProductId") as string) ?? "").trim();
    if (!shopifyProductId) return { error: "Pick a product first." };

    // Look up the cached product to denormalize its title onto the row. If
    // the product isn't cached, generation can still proceed with the id,
    // but there's no title to display, so we require an audited product here.
    const product = await prisma.product.findFirst({
      where: { storeId: store.id, shopifyProductId },
      select: { title: true },
    });
    if (!product) {
      return {
        error:
          "That product isn't cached yet. Run the AI Audit first so we have its details.",
      };
    }
    const productTitle = product.title;

    // Race-condition mitigation (mirrors blog-generator): insert a placeholder
    // row inside a SERIALIZABLE transaction that also re-checks the cap. Under
    // the default READ COMMITTED isolation two overlapping requests each count
    // only committed rows, so neither sees the other's placeholder and both
    // pass the check (write skew); Serializable makes Postgres abort one of
    // them with a serialization failure (Prisma P2034) instead. The
    // placeholder is updated to a real draft on success, or marked "failed" on
    // error. Either way it counts toward the monthly quota (Anthropic was
    // billed for the call regardless).
    const reserveQuotaSlot = () =>
      prisma.$transaction(
        async (tx) => {
          // Reap orphaned placeholders before counting. A crash or deploy
          // mid-generation leaves rows stuck at "generating" forever; the
          // cap count below includes them while the UI count excludes them,
          // so the merchant would see quota remaining while the server
          // refuses. Ten minutes is far beyond the longest Claude call, so
          // anything older cannot still be in flight. Marking them "failed"
          // makes both counts agree.
          await tx.productFaq.updateMany({
            where: {
              storeId: store.id,
              status: "generating",
              createdAt: { lt: new Date(Date.now() - 10 * 60_000) },
            },
            data: { status: "failed" },
          });

          if (monthlyCap !== Infinity) {
            const startOfMonth = new Date();
            startOfMonth.setUTCDate(1);
            startOfMonth.setUTCHours(0, 0, 0, 0);
            const used = await tx.productFaq.count({
              where: {
                storeId: store.id,
                createdAt: { gte: startOfMonth },
              },
            });
            if (used >= monthlyCap) {
              throw new FaqCapReachedError(monthlyCap);
            }
          }
          const placeholder = await tx.productFaq.create({
            data: {
              storeId: store.id,
              shopifyProductId,
              productTitle,
              questions: [],
              status: "generating",
            },
          });
          return placeholder.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

    const isSerializationConflict = (err: unknown) =>
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2034";

    let placeholderId: string;
    try {
      try {
        placeholderId = await reserveQuotaSlot();
      } catch (err) {
        // One retry on a serialization conflict: by then the competing
        // request's placeholder is committed, so the count is accurate and
        // the retry either succeeds or hits the cap check honestly.
        if (!isSerializationConflict(err)) throw err;
        placeholderId = await reserveQuotaSlot();
      }
    } catch (err) {
      if (err instanceof FaqCapReachedError) {
        return {
          error: `You've used all ${err.cap} FAQ generations on your plan this month. Upgrade for more, or try again next month.`,
        };
      }
      if (isSerializationConflict(err)) {
        return {
          error:
            "Another FAQ generation just started for your store. Give it a moment, then try again.",
        };
      }
      console.error("[GEO Rise faq] placeholder transaction failed:", err);
      return { error: "Couldn't start a new FAQ generation. Please try again." };
    }

    try {
      const draft = await generateProductFaqDraft(store.id, {
        shopifyProductId,
        maxPerMonth: monthlyCap,
      });

      const faq = await prisma.productFaq.update({
        where: { id: placeholderId },
        data: {
          questions: draft.questions,
          status: "draft",
        },
      });

      return { success: true, intent, faqId: faq.id, title: productTitle };
    } catch (err) {
      // Mark the placeholder failed so it stops appearing as "generating"
      // anywhere and stays counted toward the monthly cap.
      await prisma.productFaq
        .update({ where: { id: placeholderId }, data: { status: "failed" } })
        .catch(() => {});

      if (err instanceof FaqCapReachedError) {
        // Should be unreachable because we just checked, but mirrors the
        // service-layer guarantee.
        return {
          error: `You've used all ${err.cap} FAQ generations on your plan this month.`,
        };
      }
      return {
        error: sanitizeAiVendorError(err, {
          context: "FAQ generation",
          logTag: "faq generate",
        }),
      };
    }
  }

  if (intent === "publish") {
    if (monthlyCap === 0) {
      return {
        error: "Publishing requires a paid plan.",
      };
    }

    const faqId = (formData.get("faqId") as string) ?? "";
    if (!faqId) return { error: "Missing FAQ ID." };

    // Ownership is enforced inside the service via findFirst on
    // { id, storeId }, so no separate check is needed here.
    const result = await publishFaqToStorefront(admin, store.id, faqId);
    if (!result.ok) {
      return { error: result.error ?? "Couldn't publish these FAQs." };
    }
    return { success: true, intent, warning: result.warning };
  }

  if (intent === "unpublish") {
    const faqId = (formData.get("faqId") as string) ?? "";
    if (!faqId) return { error: "Missing FAQ ID." };

    const result = await unpublishFaqFromStorefront(admin, store.id, faqId);
    if (!result.ok) {
      return { error: result.error ?? "Couldn't unpublish these FAQs." };
    }
    return { success: true, intent, warning: result.warning };
  }

  if (intent === "delete") {
    const faqId = (formData.get("faqId") as string) ?? "";
    if (!faqId) return { error: "Missing FAQ ID." };

    // Soft delete to preserve monthly usage counts. The merchant can clear a
    // botched draft without resetting their quota. This only removes the row
    // here; if the FAQs were published, the metafield is left untouched, so
    // unpublish first to clear it from the storefront.
    await prisma.productFaq.updateMany({
      where: { id: faqId, storeId: store.id },
      data: { status: "deleted" },
    });
    return { success: true, intent };
  }

  return { error: "Unknown action." };
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function FaqGeneratorPage() {
  const { plan, products, faqs, faqsThisMonth, monthlyCap, capRemaining } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isWorking = fetcher.state !== "idle";

  const [productDraft, setProductDraft] = useState<string>(
    products[0]?.shopifyProductId ?? "",
  );
  const [deleteTarget, setDeleteTarget] = useState<LoaderFaq | null>(null);

  // Track which FAQ's action button was clicked so the spinner lands on the
  // right card.
  const inFlightFaqId =
    isWorking &&
    (fetcher.formData?.get("intent") === "publish" ||
      fetcher.formData?.get("intent") === "unpublish" ||
      fetcher.formData?.get("intent") === "delete")
      ? ((fetcher.formData?.get("faqId") as string) ?? null)
      : null;
  const isGenerating =
    isWorking && fetcher.formData?.get("intent") === "generate";

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data && data.error) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if (data.success && data.intent === "generate") {
      shopify.toast.show(`Generated FAQs for ${(data.title as string) ?? "product"}`);
    } else if (data.success && data.intent === "publish") {
      if (typeof data.warning === "string" && data.warning) {
        shopify.toast.show(data.warning, { duration: 8000 });
      } else {
        shopify.toast.show("Published to your storefront");
      }
    } else if (data.success && data.intent === "unpublish") {
      shopify.toast.show("Cleared from your storefront");
    } else if (data.success && data.intent === "delete") {
      shopify.toast.show("Draft deleted");
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const planDef = PLAN_DEFINITIONS[plan];
  // monthlyCap === null means unlimited. monthlyCap === 0 means the plan
  // doesn't include FAQ generation (Free).
  const canGenerate = monthlyCap === null || monthlyCap > 0;
  const atCap = capRemaining !== null && capRemaining === 0;

  if (!canGenerate) {
    return (
      <Page>
        <TitleBar title="FAQ Generator" />
        <BlockStack gap="500">
          <Banner
            tone="warning"
            title={`${planDef.name} plan doesn't include FAQ generation`}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                AI-written product FAQs are a Growth/Pro/Enterprise feature.
                Draft answer-first FAQs for a product, then publish them so they
                render as FAQPage structured data on that product's page, giving
                AI search engines clean question and answer pairs to read.
              </Text>
              <Text as="p" variant="bodyMd">
                {PLAN_DEFINITIONS.GROWTH.name} (${PLAN_DEFINITIONS.GROWTH.price}
                /mo) includes {PLAN_LIMITS.GROWTH.maxProductFaqsPerMonth} FAQ
                runs a month. {PLAN_DEFINITIONS.PRO.name} ($
                {PLAN_DEFINITIONS.PRO.price}/mo) includes{" "}
                {PLAN_LIMITS.PRO.maxProductFaqsPerMonth}.
              </Text>
              <div>
                <Link to="/app/pricing">
                  <Button variant="primary">See pricing</Button>
                </Link>
              </div>
            </BlockStack>
          </Banner>
        </BlockStack>
      </Page>
    );
  }

  const confirmDelete = () => {
    if (!deleteTarget) return;
    fetcher.submit(
      { intent: "delete", faqId: deleteTarget.id },
      { method: "POST" },
    );
    setDeleteTarget(null);
  };

  const productOptions = products.map((p) => ({
    label: p.title,
    value: p.shopifyProductId,
  }));

  return (
    <Page>
      <TitleBar title="FAQ Generator" />

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Pick a product and we&apos;ll draft 4 to 6 answer-first FAQs for it.
            Review the draft here, then click <strong>Publish to storefront</strong>{" "}
            to save them to a product metafield. They render as FAQPage
            structured data on that product&apos;s page, giving AI search engines
            clean question and answer pairs. Publishing needs the GEO Rise theme
            app embed enabled on your storefront.
          </Text>
        </Banner>

        {/* ── Generate form ── */}
        {products.length === 0 ? (
          <BrandEmptyState
            heading="No products to generate FAQs for yet"
            body="The FAQ generator drafts answer-first product FAQs and publishes them as FAQPage structured data. It reads your products from the AI Audit's cache, which is empty right now. Run an audit to sync your catalog, then come back here to draft FAQs."
            primaryAction={{
              content: "Go to AI Audit",
              url: "/app/audit",
            }}
          />
        ) : (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start" wrap={false}>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Generate FAQs for a product
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {capRemaining === null
                      ? `Unlimited FAQ runs on your ${planDef.name} plan. Used ${faqsThisMonth} this month.`
                      : `${capRemaining} of ${monthlyCap} FAQ runs remaining this month on your ${planDef.name} plan.`}
                  </Text>
                </BlockStack>
              </InlineStack>

              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="generate" />
                <BlockStack gap="300">
                  <Select
                    label="Product"
                    name="shopifyProductId"
                    options={productOptions}
                    value={productDraft}
                    onChange={setProductDraft}
                    helpText="We draft FAQs from this product's cached title and description. Re-run to draft a fresh set; each run counts toward your monthly cap."
                  />
                  <InlineStack align="end">
                    <Button
                      submit
                      variant="primary"
                      loading={isGenerating}
                      disabled={atCap || !productDraft || isWorking}
                    >
                      {atCap
                        ? "Monthly cap reached"
                        : isGenerating
                        ? "Generating, this takes ~20s..."
                        : "Generate FAQs"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </fetcher.Form>
            </BlockStack>
          </Card>
        )}

        {/* ── FAQ list ── */}
        {products.length > 0 && faqs.length === 0 ? (
          <BrandEmptyState
            heading="No FAQs yet"
            body="The FAQ generator drafts answer-first questions and answers for a product, then publishes them as FAQPage structured data on that product's page. Draft one above and it will appear here, ready to review and publish to your storefront."
            primaryAction={{
              content: "Draft your first FAQ set",
              onClick: () => {
                const field = document.querySelector(
                  'select[name="shopifyProductId"]',
                ) as HTMLElement | null;
                field?.scrollIntoView({ behavior: "smooth", block: "center" });
                field?.focus();
              },
            }}
          />
        ) : (
          faqs.map((faq) => (
            <FaqCard
              key={faq.id}
              faq={faq}
              fetcher={fetcher}
              onRequestDelete={setDeleteTarget}
              isPublishing={
                inFlightFaqId === faq.id &&
                fetcher.formData?.get("intent") === "publish"
              }
              isUnpublishing={
                inFlightFaqId === faq.id &&
                fetcher.formData?.get("intent") === "unpublish"
              }
              isDeleting={
                inFlightFaqId === faq.id &&
                fetcher.formData?.get("intent") === "delete"
              }
              anyInFlight={isWorking}
            />
          ))
        )}
      </BlockStack>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete FAQ draft?"
        primaryAction={{
          content: "Delete draft",
          destructive: true,
          onAction: confirmDelete,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteTarget(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            This deletes the FAQ draft from GEO Rise. It still counts toward your
            monthly FAQ quota. If these FAQs are published, unpublish them first
            so they clear from your storefront.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

// ─── Per-FAQ card ─────────────────────────────────────────────────────────────

interface FaqCardProps {
  faq: LoaderFaq;
  fetcher: ReturnType<typeof useFetcher>;
  onRequestDelete: (faq: LoaderFaq) => void;
  isPublishing: boolean;
  isUnpublishing: boolean;
  isDeleting: boolean;
  anyInFlight: boolean;
}

function FaqCard({
  faq,
  fetcher,
  onRequestDelete,
  isPublishing,
  isUnpublishing,
  isDeleting,
  anyInFlight,
}: FaqCardProps) {
  const [expanded, setExpanded] = useState(true);
  const isPublished = faq.status === "published";

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" wrap={false} gap="300">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Badge tone={isPublished ? "success" : "info"}>
                {isPublished ? "Published" : "Draft"}
              </Badge>
              <Text as="span" variant="bodySm" tone="subdued">
                {faq.questions.length}{" "}
                {faq.questions.length === 1 ? "question" : "questions"}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {isPublished && faq.publishedAt
                  ? `Published ${timeAgo(faq.publishedAt)}`
                  : `Drafted ${timeAgo(faq.createdAt)}`}
              </Text>
            </InlineStack>
            <Text as="h3" variant="headingMd">
              {faq.productTitle}
            </Text>
          </BlockStack>

          <ButtonGroup>
            {!isPublished ? (
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="publish" />
                <input type="hidden" name="faqId" value={faq.id} />
                <Button
                  submit
                  variant="primary"
                  loading={isPublishing}
                  disabled={anyInFlight && !isPublishing}
                >
                  Publish to storefront
                </Button>
              </fetcher.Form>
            ) : (
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="unpublish" />
                <input type="hidden" name="faqId" value={faq.id} />
                <Button
                  submit
                  loading={isUnpublishing}
                  disabled={anyInFlight && !isUnpublishing}
                >
                  Unpublish
                </Button>
              </fetcher.Form>
            )}
            <Button
              tone="critical"
              variant="plain"
              loading={isDeleting}
              disabled={anyInFlight && !isDeleting}
              onClick={() => onRequestDelete(faq)}
            >
              Delete draft
            </Button>
          </ButtonGroup>
        </InlineStack>

        <Button
          variant="plain"
          onClick={() => setExpanded((v) => !v)}
          disclosure={expanded ? "up" : "down"}
        >
          {expanded ? "Hide FAQs" : "Show FAQs"}
        </Button>

        {expanded && faq.questions.length > 0 && (
          <>
            <Divider />
            <Box
              padding="400"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="400">
                {faq.questions.map((q, i) => (
                  <BlockStack key={i} gap="100">
                    <Text as="h4" variant="headingSm">
                      {q.question}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {q.answer}
                    </Text>
                  </BlockStack>
                ))}
              </BlockStack>
            </Box>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

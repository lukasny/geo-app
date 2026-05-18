import { useEffect, useState } from "react";
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
  EmptyState,
  ButtonGroup,
  Divider,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  generateBlogPostDraft,
  publishBlogPostToShopify,
  countBlogPostsThisMonth,
  type BlogPostTone,
  type BlogPostLength,
} from "~/services/blog-generation.server";
import { PLAN_DEFINITIONS, PLAN_LIMITS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import { timeAgo } from "~/utils/time";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoaderPost {
  id: string;
  topic: string;
  tone: string | null;
  title: string;
  excerpt: string;
  bodyHtml: string;
  tags: string[];
  wordCount: number;
  status: string;
  shopifyArticleId: string | null;
  publishedAt: string | null;
  createdAt: string;
}

interface LoaderData {
  plan: PlanKey;
  posts: LoaderPost[];
  postsThisMonth: number;
  monthlyCap: number; // Infinity is serialized as a sentinel by the loader
  capRemaining: number | null; // null = unlimited
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
      posts: [],
      postsThisMonth: 0,
      monthlyCap: 0,
      capRemaining: 0,
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const monthlyCap = limits.maxBlogPostsPerMonth;

  const [posts, postsThisMonth] = await Promise.all([
    prisma.blogPost.findMany({
      where: { storeId: store.id, status: { not: "deleted" } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    countBlogPostsThisMonth(store.id),
  ]);

  const capRemaining =
    monthlyCap === Infinity ? null : Math.max(0, monthlyCap - postsThisMonth);

  const loaderPosts: LoaderPost[] = posts.map((p) => ({
    id: p.id,
    topic: p.topic,
    tone: p.tone,
    title: p.title,
    excerpt: p.excerpt,
    bodyHtml: p.bodyHtml,
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
    wordCount: p.wordCount,
    status: p.status,
    shopifyArticleId: p.shopifyArticleId,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }));

  return {
    plan: planKey,
    posts: loaderPosts,
    postsThisMonth,
    monthlyCap: monthlyCap === Infinity ? Number.MAX_SAFE_INTEGER : monthlyCap,
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
  const monthlyCap = limits.maxBlogPostsPerMonth;

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "generatePost") {
    if (monthlyCap === 0) {
      return {
        error: "Blog post generation is a Growth/Pro/Enterprise feature.",
      };
    }

    const usedThisMonth = await countBlogPostsThisMonth(store.id);
    if (monthlyCap !== Infinity && usedThisMonth >= monthlyCap) {
      return {
        error: `You've used all ${monthlyCap} blog posts on your plan this month. Upgrade for more, or try again next month.`,
      };
    }

    const topic = ((formData.get("topic") as string) ?? "").trim();
    if (!topic) return { error: "Topic is required." };
    if (topic.length > 500) {
      return { error: "Topic must be 500 characters or fewer." };
    }

    const rawKeywords = ((formData.get("keywords") as string) ?? "").trim();
    const targetKeywords = rawKeywords
      ? rawKeywords
          .split(",")
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
          .slice(0, 10)
      : undefined;

    const toneRaw = (formData.get("tone") as string) ?? "informative";
    const tone: BlogPostTone = (
      ["informative", "tutorial", "comparison", "buying_guide"].includes(toneRaw)
        ? toneRaw
        : "informative"
    ) as BlogPostTone;

    const lengthRaw = (formData.get("length") as string) ?? "medium";
    const length: BlogPostLength = (
      ["short", "medium", "long"].includes(lengthRaw) ? lengthRaw : "medium"
    ) as BlogPostLength;

    try {
      const draft = await generateBlogPostDraft(store.id, {
        topic,
        targetKeywords,
        tone,
        length,
      });

      const post = await prisma.blogPost.create({
        data: {
          storeId: store.id,
          topic,
          targetKeywords: targetKeywords ?? undefined,
          tone,
          title: draft.title,
          excerpt: draft.excerpt,
          bodyHtml: draft.bodyHtml,
          tags: draft.tags.length > 0 ? draft.tags : undefined,
          metaTitle: draft.metaTitle || null,
          metaDescription: draft.metaDescription || null,
          wordCount: draft.wordCount,
          status: "draft",
        },
      });

      return { success: true, intent, postId: post.id, title: draft.title };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      // Sanitize Anthropic credit / quota errors so the raw vendor message
      // doesn't leak to merchants. Same pattern as tracking sanitizer.
      const safeMessage = /credit balance|insufficient_quota|billing/i.test(
        message
      )
        ? "Our AI service is temporarily unavailable. Please try again in a few minutes."
        : message;
      console.error("[GEO Rise blog] generatePost failed:", err);
      return { error: safeMessage };
    }
  }

  if (intent === "publishPost") {
    if (monthlyCap === 0) {
      return {
        error: "Publishing requires a paid plan.",
      };
    }

    const postId = (formData.get("postId") as string) ?? "";
    if (!postId) return { error: "Missing post ID." };

    // Verify ownership before letting the publish endpoint accept this ID.
    const owns = await prisma.blogPost.findFirst({
      where: { id: postId, storeId: store.id },
      select: { id: true },
    });
    if (!owns) return { error: "Post not found." };

    const result = await publishBlogPostToShopify(postId, admin);
    if (!result.ok) {
      return { error: result.error ?? "Couldn't publish the post." };
    }
    return { success: true, intent };
  }

  if (intent === "deletePost") {
    const postId = (formData.get("postId") as string) ?? "";
    if (!postId) return { error: "Missing post ID." };

    // Soft delete to preserve monthly usage counts. The merchant can clear
    // a botched draft without resetting their quota.
    await prisma.blogPost.updateMany({
      where: { id: postId, storeId: store.id },
      data: { status: "deleted" },
    });
    return { success: true, intent };
  }

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TONE_OPTIONS = [
  { label: "Informative (explains the topic)", value: "informative" },
  { label: "Tutorial (step-by-step)", value: "tutorial" },
  { label: "Comparison (vs alternatives)", value: "comparison" },
  { label: "Buying guide (helps decide)", value: "buying_guide" },
];

const LENGTH_OPTIONS = [
  { label: "Short (~500 words)", value: "short" },
  { label: "Medium (~900 words)", value: "medium" },
  { label: "Long (~1500 words)", value: "long" },
];

const TONE_LABEL: Record<string, string> = {
  informative: "Informative",
  tutorial: "Tutorial",
  comparison: "Comparison",
  buying_guide: "Buying guide",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function BlogGeneratorPage() {
  const { plan, posts, postsThisMonth, monthlyCap, capRemaining } =
    useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isWorking = fetcher.state !== "idle";

  const [topicDraft, setTopicDraft] = useState("");
  const [keywordsDraft, setKeywordsDraft] = useState("");
  const [toneDraft, setToneDraft] = useState<string>("informative");
  const [lengthDraft, setLengthDraft] = useState<string>("medium");

  // Track which post's "Publish" button was clicked so the spinner lands
  // on the right card.
  const inFlightPostId =
    isWorking &&
    (fetcher.formData?.get("intent") === "publishPost" ||
      fetcher.formData?.get("intent") === "deletePost")
      ? ((fetcher.formData?.get("postId") as string) ?? null)
      : null;
  const isGenerating =
    isWorking && fetcher.formData?.get("intent") === "generatePost";

  useEffect(() => {
    const data = fetcher.data as Record<string, unknown> | undefined;
    if (!data || fetcher.state !== "idle") return;
    if ("error" in data && data.error) {
      shopify.toast.show(data.error as string, { isError: true });
    } else if (data.success && data.intent === "generatePost") {
      shopify.toast.show(`Generated: ${(data.title as string) ?? "post"}`);
      setTopicDraft("");
      setKeywordsDraft("");
    } else if (data.success && data.intent === "publishPost") {
      shopify.toast.show("Published to your Shopify blog");
    } else if (data.success && data.intent === "deletePost") {
      shopify.toast.show("Draft deleted");
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const planDef = PLAN_DEFINITIONS[plan];
  const canGenerate = monthlyCap > 0;
  const atCap = capRemaining !== null && capRemaining === 0;

  if (!canGenerate) {
    return (
      <Page>
        <TitleBar title="AI Blog Post Generator" />
        <BlockStack gap="500">
          <Banner
            tone="warning"
            title={`${planDef.name} plan doesn't include blog post generation`}
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                AI-written blog posts are a Growth/Pro/Enterprise feature.
                Generate posts that answer real shopper questions, mention your
                products naturally, and get indexed by AI search engines like
                ChatGPT and Perplexity.
              </Text>
              <Text as="p" variant="bodyMd">
                {PLAN_DEFINITIONS.GROWTH.name} (${PLAN_DEFINITIONS.GROWTH.price}
                /mo) includes {PLAN_LIMITS.GROWTH.maxBlogPostsPerMonth} posts a
                month. {PLAN_DEFINITIONS.PRO.name} (${PLAN_DEFINITIONS.PRO.price}
                /mo) includes {PLAN_LIMITS.PRO.maxBlogPostsPerMonth}.
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

  return (
    <Page>
      <TitleBar title="AI Blog Post Generator" />

      <BlockStack gap="500">
        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Write a question or topic and we&apos;ll generate a fully-formed
            blog post that answers it, mentions your products where relevant,
            and is structured for AI search engines to cite. Drafts stay here
            until you click <strong>Publish to Shopify blog</strong>.
          </Text>
        </Banner>

        {/* ── Generate form ── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Generate a new post
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {capRemaining === null
                    ? `Unlimited posts on your ${planDef.name} plan. Used ${postsThisMonth} this month.`
                    : `${capRemaining} of ${monthlyCap} posts remaining this month on your ${planDef.name} plan.`}
                </Text>
              </BlockStack>
            </InlineStack>

            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="generatePost" />
              <BlockStack gap="300">
                <TextField
                  label="Topic"
                  name="topic"
                  value={topicDraft}
                  onChange={setTopicDraft}
                  placeholder="e.g. How to choose the right snowboard for an intermediate rider"
                  helpText="Phrase it as a question a real shopper would ask. Specific topics produce better posts than broad ones."
                  autoComplete="off"
                  multiline={2}
                  maxLength={500}
                  showCharacterCount
                />
                <TextField
                  label="Target keywords (optional)"
                  name="keywords"
                  value={keywordsDraft}
                  onChange={setKeywordsDraft}
                  placeholder="snowboard sizing, intermediate snowboard, all-mountain snowboard"
                  helpText="Comma-separated. We'll weave them in naturally, never keyword-stuff."
                  autoComplete="off"
                />
                <Select
                  label="Tone"
                  name="tone"
                  options={TONE_OPTIONS}
                  value={toneDraft}
                  onChange={setToneDraft}
                />
                <Select
                  label="Length"
                  name="length"
                  options={LENGTH_OPTIONS}
                  value={lengthDraft}
                  onChange={setLengthDraft}
                  helpText="Longer posts rank better for substantive topics; shorter ones publish faster."
                />
                <InlineStack align="end">
                  <Button
                    submit
                    variant="primary"
                    loading={isGenerating}
                    disabled={atCap || !topicDraft.trim() || isWorking}
                  >
                    {atCap
                      ? "Monthly cap reached"
                      : isGenerating
                      ? "Generating, this takes ~30s..."
                      : "Generate post"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </fetcher.Form>
          </BlockStack>
        </Card>

        {/* ── Posts list ── */}
        {posts.length === 0 ? (
          <Card>
            <EmptyState
              heading="No posts yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <Text as="p" variant="bodyMd">
                Once you generate a post above, it&apos;ll appear here as a
                draft. Review the content, then publish to your Shopify blog
                when ready.
              </Text>
            </EmptyState>
          </Card>
        ) : (
          posts.map((post) => (
            <BlogPostCard
              key={post.id}
              post={post}
              fetcher={fetcher}
              isPublishing={
                inFlightPostId === post.id &&
                fetcher.formData?.get("intent") === "publishPost"
              }
              isDeleting={
                inFlightPostId === post.id &&
                fetcher.formData?.get("intent") === "deletePost"
              }
              anyInFlight={isWorking}
            />
          ))
        )}
      </BlockStack>
    </Page>
  );
}

// ─── Per-post card ────────────────────────────────────────────────────────────

interface BlogPostCardProps {
  post: LoaderPost;
  fetcher: ReturnType<typeof useFetcher>;
  isPublishing: boolean;
  isDeleting: boolean;
  anyInFlight: boolean;
}

function BlogPostCard({
  post,
  fetcher,
  isPublishing,
  isDeleting,
  anyInFlight,
}: BlogPostCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isPublished = post.status === "published";

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" wrap={false} gap="300">
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Badge tone={isPublished ? "success" : "info"}>
                {isPublished ? "Published" : "Draft"}
              </Badge>
              {post.tone && (
                <Badge>{TONE_LABEL[post.tone] ?? post.tone}</Badge>
              )}
              <Text as="span" variant="bodySm" tone="subdued">
                {post.wordCount} words
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {isPublished && post.publishedAt
                  ? `Published ${timeAgo(post.publishedAt)}`
                  : `Drafted ${timeAgo(post.createdAt)}`}
              </Text>
            </InlineStack>
            <Text as="h3" variant="headingMd">
              {post.title}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Topic: {post.topic}
            </Text>
            {post.excerpt && (
              <Text as="p" variant="bodyMd">
                {post.excerpt}
              </Text>
            )}
            {post.tags.length > 0 && (
              <InlineStack gap="100" wrap>
                {post.tags.slice(0, 6).map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </InlineStack>
            )}
          </BlockStack>

          <ButtonGroup>
            {!isPublished && (
              <fetcher.Form method="POST">
                <input type="hidden" name="intent" value="publishPost" />
                <input type="hidden" name="postId" value={post.id} />
                <Button
                  submit
                  variant="primary"
                  loading={isPublishing}
                  disabled={anyInFlight && !isPublishing}
                >
                  Publish to Shopify blog
                </Button>
              </fetcher.Form>
            )}
            <fetcher.Form method="POST">
              <input type="hidden" name="intent" value="deletePost" />
              <input type="hidden" name="postId" value={post.id} />
              <Button
                submit
                tone="critical"
                variant="plain"
                loading={isDeleting}
                disabled={anyInFlight && !isDeleting}
              >
                Delete
              </Button>
            </fetcher.Form>
          </ButtonGroup>
        </InlineStack>

        <Button
          variant="plain"
          onClick={() => setExpanded((v) => !v)}
          disclosure={expanded ? "up" : "down"}
        >
          {expanded ? "Hide preview" : "Show preview"}
        </Button>

        {expanded && (
          <>
            <Divider />
            <Box
              padding="400"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              {/* The body is sanitized server-side via the audit-engine
                  allowlist sanitizer plus a blog-specific superset (h2/h3/
                  blockquote). Rendering with dangerouslySetInnerHTML is
                  safe within those constraints; nothing unsanitized hits
                  this surface. */}
              <div
                style={{
                  fontSize: "14px",
                  lineHeight: 1.6,
                  color: "#202223",
                }}
                dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
              />
            </Box>
          </>
        )}
      </BlockStack>
    </Card>
  );
}

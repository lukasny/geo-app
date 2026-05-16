import { useEffect, useState, useCallback } from "react";
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
  Banner,
  Checkbox,
  Select,
  Box,
  Divider,
  Badge,
  Collapsible,
  CalloutCard,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  generateLlmsTxt,
  getOrCreateLlmsFile,
} from "~/services/llms-generator.server";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LlmsFileData {
  id: string;
  content: string;
  marketCode: string;
  productCount: number;
  collectionCount: number;
  blogPostCount: number;
  includeProducts: boolean;
  includeCollections: boolean;
  includeBlogPosts: boolean;
  allowChatGPT: boolean;
  allowClaude: boolean;
  allowGemini: boolean;
  allowPerplexity: boolean;
  allowDeepSeek: boolean;
  allowGrok: boolean;
  refreshInterval: string;
  fileSizeBytes: number;
  lastGeneratedAt: string | null;
}

interface LoaderData {
  store: {
    id: string;
    shopifyDomain: string;
    shopName: string;
    plan: string;
    totalProducts: number;
  } | null;
  llmsFile: LlmsFileData | null;
  proxyUrl: string;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
    select: {
      id: true,
      shopifyDomain: true,
      shopName: true,
      plan: true,
      totalProducts: true,
    },
  });

  let llmsFile: LlmsFileData | null = null;
  if (store) {
    const raw = await getOrCreateLlmsFile(store.id);
    llmsFile = {
      ...raw,
      lastGeneratedAt: raw.lastGeneratedAt?.toISOString() ?? null,
    };
  }

  const proxyUrl = `https://${shopDomain}/a/llms-txt`;

  return { store, llmsFile, proxyUrl };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const store = await prisma.store.findUnique({
    where: { shopifyDomain: shopDomain },
  });

  if (!store) {
    return { error: "Store not found. Please reinstall the app." };
  }

  if (intent === "generate" || intent === "regenerate") {
    try {
      const result = await generateLlmsTxt(store.id);
      return {
        success: true,
        message: `llms.txt generated with ${result.productCount} products, ${result.collectionCount} collections, and ${result.blogPostCount} blog posts.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { error: `Generation failed: ${message}` };
    }
  }

  if (intent === "updateSettings") {
    const llmsFile = await getOrCreateLlmsFile(store.id);
    await prisma.llmsFile.update({
      where: { id: llmsFile.id },
      data: {
        includeProducts: formData.get("includeProducts") === "true",
        includeCollections: formData.get("includeCollections") === "true",
        includeBlogPosts: formData.get("includeBlogPosts") === "true",
        allowChatGPT: formData.get("allowChatGPT") === "true",
        allowClaude: formData.get("allowClaude") === "true",
        allowGemini: formData.get("allowGemini") === "true",
        allowPerplexity: formData.get("allowPerplexity") === "true",
        allowDeepSeek: formData.get("allowDeepSeek") === "true",
        allowGrok: formData.get("allowGrok") === "true",
        refreshInterval: formData.get("refreshInterval") as string,
      },
    });
    return { success: true, message: "Settings saved." };
  }

  return { error: "Unknown action." };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  return Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const REFRESH_OPTIONS = [
  { label: "Hourly", value: "hourly" },
  { label: "Daily", value: "daily" },
  { label: "On product change", value: "on_change" },
  { label: "Manual only", value: "manual" },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function LlmsTxtPage() {
  const { store, llmsFile, proxyUrl } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  // Local settings state (controlled form)
  const [settings, setSettings] = useState({
    includeProducts: llmsFile?.includeProducts ?? true,
    includeCollections: llmsFile?.includeCollections ?? true,
    includeBlogPosts: llmsFile?.includeBlogPosts ?? true,
    allowChatGPT: llmsFile?.allowChatGPT ?? true,
    allowClaude: llmsFile?.allowClaude ?? true,
    allowGemini: llmsFile?.allowGemini ?? true,
    allowPerplexity: llmsFile?.allowPerplexity ?? true,
    allowDeepSeek: llmsFile?.allowDeepSeek ?? true,
    allowGrok: llmsFile?.allowGrok ?? true,
    refreshInterval: llmsFile?.refreshInterval ?? "daily",
  });

  const [previewOpen, setPreviewOpen] = useState(false);

  const isGenerating =
    ["loading", "submitting"].includes(fetcher.state) &&
    ["generate", "regenerate"].includes(
      fetcher.formData?.get("intent") as string
    );

  const isSavingSettings =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formData?.get("intent") === "updateSettings";

  // Toast on action result
  useEffect(() => {
    if (!fetcher.data) return;
    if ("success" in fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message ?? "Done!");
    } else if ("error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const submitGenerate = (intent: "generate" | "regenerate") => {
    fetcher.submit({ intent }, { method: "POST" });
  };

  const submitSettings = useCallback(() => {
    fetcher.submit(
      {
        intent: "updateSettings",
        includeProducts: String(settings.includeProducts),
        includeCollections: String(settings.includeCollections),
        includeBlogPosts: String(settings.includeBlogPosts),
        allowChatGPT: String(settings.allowChatGPT),
        allowClaude: String(settings.allowClaude),
        allowGemini: String(settings.allowGemini),
        allowPerplexity: String(settings.allowPerplexity),
        allowDeepSeek: String(settings.allowDeepSeek),
        allowGrok: String(settings.allowGrok),
        refreshInterval: settings.refreshInterval,
      },
      { method: "POST" }
    );
  }, [fetcher, settings]);

  const hasFile = !!(llmsFile?.content && llmsFile.content.length > 0);
  const lastGenerated = llmsFile?.lastGeneratedAt
    ? daysSince(llmsFile.lastGeneratedAt)
    : null;
  const isStale = lastGenerated !== null && lastGenerated > 7;

  const previewLines = hasFile
    ? llmsFile!.content.split("\n").slice(0, 50).join("\n")
    : "";

  const isFreePlanLimited =
    store?.plan === "FREE" && (store?.totalProducts ?? 0) > 25;

  return (
    <Page>
      <TitleBar title="llms.txt Manager">
        <button
          variant="primary"
          onClick={() => submitGenerate(hasFile ? "regenerate" : "generate")}
          disabled={isGenerating}
        >
          {isGenerating
            ? "Generating…"
            : hasFile
            ? "Regenerate"
            : "Generate llms.txt"}
        </button>
      </TitleBar>

      <BlockStack gap="500">
        {/* ── Status Banner ── */}
        {hasFile && !isStale && (
          <Banner tone="success">
            <Text as="p" variant="bodyMd">
              Your llms.txt is live at{" "}
              <a href={proxyUrl} target="_blank" rel="noreferrer">
                {proxyUrl}
              </a>
            </Text>
          </Banner>
        )}
        {hasFile && isStale && (
          <Banner tone="warning">
            <Text as="p" variant="bodyMd">
              Your llms.txt hasn&apos;t been updated in {lastGenerated} days.
              Regenerate to keep AI search engines up to date.
            </Text>
          </Banner>
        )}
        {!hasFile && (
          <Banner tone="info">
            <Text as="p" variant="bodyMd">
              Generate your first llms.txt to get discovered by ChatGPT,
              Gemini, and Perplexity.
            </Text>
          </Banner>
        )}

        {/* ── Stats Cards ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
          {[
            { label: "Products", value: llmsFile?.productCount ?? 0 },
            { label: "Collections", value: llmsFile?.collectionCount ?? 0 },
            { label: "Blog Posts", value: llmsFile?.blogPostCount ?? 0 },
            { label: "File Size", value: formatBytes(llmsFile?.fileSizeBytes ?? 0) },
          ].map(({ label, value }) => (
            <Card key={label}>
              <BlockStack gap="100">
                <Text variant="bodySm" as="p" tone="subdued">{label}</Text>
                <Text variant="headingLg" as="p">{value}</Text>
              </BlockStack>
            </Card>
          ))}
        </div>

        {/* ── Settings + Bot Access ── */}
        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Content Settings
                </Text>
                <BlockStack gap="300">
                  <Checkbox
                    label="Include products"
                    checked={settings.includeProducts}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, includeProducts: v }))
                    }
                  />
                  <Checkbox
                    label="Include collections"
                    checked={settings.includeCollections}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, includeCollections: v }))
                    }
                  />
                  <Checkbox
                    label="Include blog posts"
                    checked={settings.includeBlogPosts}
                    onChange={(v) =>
                      setSettings((s) => ({ ...s, includeBlogPosts: v }))
                    }
                  />
                </BlockStack>
                <Divider />
                <Select
                  label="Auto-refresh interval"
                  options={REFRESH_OPTIONS}
                  value={settings.refreshInterval}
                  onChange={(v) =>
                    setSettings((s) => ({ ...s, refreshInterval: v }))
                  }
                />
                <InlineStack align="end">
                  <Button
                    onClick={submitSettings}
                    loading={isSavingSettings}
                  >
                    Save settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    AI Bot Access Control
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Choose which AI engines can read your store data
                  </Text>
                </BlockStack>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  {(
                    [
                      { key: "allowChatGPT" as const, label: "ChatGPT" },
                      { key: "allowClaude" as const, label: "Claude" },
                      { key: "allowGemini" as const, label: "Gemini" },
                      { key: "allowPerplexity" as const, label: "Perplexity" },
                      { key: "allowDeepSeek" as const, label: "DeepSeek" },
                      { key: "allowGrok" as const, label: "Grok" },
                    ] as const
                  ).map(({ key, label }) => (
                    <Checkbox
                      key={key}
                      label={label}
                      checked={settings[key]}
                      onChange={(v) =>
                        setSettings((s) => ({ ...s, [key]: v }))
                      }
                    />
                  ))}
                </div>
                <InlineStack align="end">
                  <Button
                    onClick={submitSettings}
                    loading={isSavingSettings}
                  >
                    Save settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* ── File Preview ── */}
        {hasFile && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Preview
                </Text>
                <InlineStack gap="200">
                  <Button
                    variant="plain"
                    onClick={() =>
                      navigator.clipboard.writeText(llmsFile!.content)
                        .then(() => shopify.toast.show("Copied to clipboard!"))
                    }
                  >
                    Copy full file
                  </Button>
                  <Button
                    variant="plain"
                    onClick={() => {
                      const blob = new Blob([llmsFile!.content], {
                        type: "text/plain",
                      });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = "llms.txt";
                      a.click();
                    }}
                  >
                    Download .txt
                  </Button>
                  <Button
                    variant="plain"
                    onClick={() => setPreviewOpen((o) => !o)}
                  >
                    {previewOpen ? "Hide" : "Show"} preview
                  </Button>
                </InlineStack>
              </InlineStack>

              <Collapsible
                open={previewOpen}
                id="llms-preview"
                transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
              >
                <Box
                  padding="400"
                  background="bg-surface-secondary"
                  borderRadius="200"
                  overflowX="scroll"
                >
                  <pre
                    style={{
                      margin: 0,
                      fontFamily: "monospace",
                      fontSize: "12px",
                      lineHeight: "1.6",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {previewLines}
                    {llmsFile!.content.split("\n").length > 50 && (
                      <span style={{ color: "#888" }}>
                        {"\n"}… and {llmsFile!.content.split("\n").length - 50}{" "}
                        more lines
                      </span>
                    )}
                  </pre>
                </Box>
              </Collapsible>

              <Box paddingBlockStart="200">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">Live</Badge>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Served at{" "}
                    <a href={proxyUrl} target="_blank" rel="noreferrer">
                      {proxyUrl}
                    </a>
                  </Text>
                  {llmsFile?.lastGeneratedAt && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      · Last generated {daysSince(llmsFile.lastGeneratedAt)}{" "}
                      {daysSince(llmsFile.lastGeneratedAt) === 1 ? "day" : "days"} ago
                    </Text>
                  )}
                </InlineStack>
              </Box>
            </BlockStack>
          </Card>
        )}

        {/* ── Upgrade Callout ── */}
        {isFreePlanLimited && (
          <CalloutCard
            title="Unlock all your products in llms.txt"
            illustration="https://cdn.shopify.com/s/assets/admin/checkout/settings-customizecart-705f57c725ac05be5a34ec20c05b94298cb8ept14702f09612f04cf1c04049e5a42f98c.png"
            primaryAction={{
              content: "Upgrade to Growth",
              url: "/app/pricing",
            }}
          >
            <Text as="p" variant="bodyMd">
              Your free plan includes 25 products in llms.txt. Upgrade to
              Growth to include all {store?.totalProducts} products and get
              discovered by more AI search engines.
            </Text>
          </CalloutCard>
        )}
      </BlockStack>
    </Page>
  );
}

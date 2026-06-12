import { useEffect, useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
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
import { listMarkets } from "~/services/markets.server";
import { PLAN_LIMITS } from "~/services/billing.shared";

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

interface MarketOption {
  /** Market handle, used as LlmsFile.marketCode and the ?market= value. */
  handle: string;
  /** Merchant-facing market name from Shopify. */
  name: string;
  /** True when this market already has generated llms.txt content. */
  hasFile: boolean;
}

interface LoaderData {
  store: {
    id: string;
    shopifyDomain: string;
    shopName: string;
    plan: string;
    totalProducts: number;
  } | null;
  /** The ACTIVE market's file (null when a market was selected that has no
   *  generated file yet). */
  llmsFile: LlmsFileData | null;
  /** Public URL of the active market's file (?market= included). */
  proxyUrl: string;
  /** Non-primary Shopify Markets (the primary market IS the default file).
   *  Empty for plans without multi-market or before the merchant re-auths
   *  with the read_markets permission. */
  markets: MarketOption[];
  activeMarketCode: string;
  planAllowsMultiMarket: boolean;
}

/** Market codes are URL-safe slugs; anything else falls back to default. */
function normalizeMarketCode(raw: string | null): string {
  const code = String(raw ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(code) ? code : "default";
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const marketParam = normalizeMarketCode(
    new URL(request.url).searchParams.get("market")
  );

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
  let markets: MarketOption[] = [];
  let activeMarketCode = "default";
  let planAllowsMultiMarket = false;

  if (store) {
    const planLimits =
      PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
    planAllowsMultiMarket = Boolean(planLimits.multiMarketLlmsTxt);

    if (planAllowsMultiMarket) {
      try {
        const storeMarkets = (await listMarkets(store.id)).filter(
          (m) => !m.isPrimary
        );
        const rows = await prisma.llmsFile.findMany({
          where: { storeId: store.id, marketCode: { not: "default" } },
          select: { marketCode: true, content: true },
        });
        const rowsByCode = new Map(rows.map((r) => [r.marketCode, r]));
        markets = storeMarkets.map((m) => ({
          handle: m.handle,
          name: m.name,
          hasFile: Boolean(rowsByCode.get(m.handle)?.content),
        }));
        if (
          marketParam !== "default" &&
          storeMarkets.some((m) => m.handle === marketParam)
        ) {
          activeMarketCode = marketParam;
        }
      } catch (err) {
        // Markets are an enhancement; the default file must keep working
        // even if the markets lookup fails outright.
        console.error(`[llms.txt] markets lookup failed for ${store.id}:`, err);
      }
    }

    if (activeMarketCode === "default") {
      const raw = await getOrCreateLlmsFile(store.id);
      llmsFile = {
        ...raw,
        lastGeneratedAt: raw.lastGeneratedAt?.toISOString() ?? null,
      };
    } else {
      // Browsing a market must not create rows; generation does that.
      const raw = await prisma.llmsFile.findFirst({
        where: { storeId: store.id, marketCode: activeMarketCode },
      });
      llmsFile = raw
        ? { ...raw, lastGeneratedAt: raw.lastGeneratedAt?.toISOString() ?? null }
        : null;
    }
  }

  const baseProxyUrl = `https://${shopDomain}/a/llms-txt`;
  const proxyUrl =
    activeMarketCode === "default"
      ? baseProxyUrl
      : `${baseProxyUrl}?market=${activeMarketCode}`;

  return {
    store,
    llmsFile,
    proxyUrl,
    markets,
    activeMarketCode,
    planAllowsMultiMarket,
  };
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

  const planLimits =
    PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;

  // Server-side plan enforcement: non-default markets are Growth+, no
  // matter what the client sends.
  const marketCode = normalizeMarketCode(
    formData.get("marketCode") as string | null
  );
  if (marketCode !== "default" && !planLimits.multiMarketLlmsTxt) {
    return {
      error:
        "Multi-market llms.txt requires the Growth plan or higher. Upgrade on the Plans page to generate market files.",
    };
  }

  if (intent === "generate" || intent === "regenerate") {
    try {
      const result = await generateLlmsTxt(store.id, {
        maxProducts: planLimits.maxProductsInLlmsTxt,
        marketCode,
      });
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
    const llmsFile = await getOrCreateLlmsFile(store.id, marketCode);
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
  const {
    store,
    llmsFile,
    proxyUrl,
    markets,
    activeMarketCode,
    planAllowsMultiMarket,
  } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

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

  // Resync the controlled form when the merchant switches markets: each
  // market has its own settings row and useState only seeds once.
  useEffect(() => {
    setSettings({
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
    // llmsFile changes identity on every revalidation; the market switch
    // (and the row id swap that comes with it) is the signal we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarketCode, llmsFile?.id]);

  const [previewOpen, setPreviewOpen] = useState(false);

  const handleMarketChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "default") {
      next.delete("market");
    } else {
      next.set("market", value);
    }
    setSearchParams(next);
  };

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
    fetcher.submit({ intent, marketCode: activeMarketCode }, { method: "POST" });
  };

  const submitSettings = useCallback(() => {
    fetcher.submit(
      {
        intent: "updateSettings",
        marketCode: activeMarketCode,
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
  }, [fetcher, settings, activeMarketCode]);

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

        {/* ── Market Picker ── */}
        {planAllowsMultiMarket && markets.length > 0 && (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Market
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Each Shopify Market gets its own llms.txt with translated
                  content, local prices and market URLs. Generate and tune
                  them one market at a time.
                </Text>
              </BlockStack>
              <div style={{ minWidth: "240px" }}>
                <Select
                  label="Market"
                  labelHidden
                  options={[
                    { label: "Default (primary market)", value: "default" },
                    ...markets.map((m) => ({
                      label: m.hasFile ? m.name : `${m.name} (not generated yet)`,
                      value: m.handle,
                    })),
                  ]}
                  value={activeMarketCode}
                  onChange={handleMarketChange}
                />
              </div>
            </InlineStack>
          </Card>
        )}
        {store && !planAllowsMultiMarket && (
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Multi-market llms.txt
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Selling in multiple countries or languages? Growth and
                  higher plans generate one llms.txt per Shopify Market,
                  with translated content and local prices.
                </Text>
              </BlockStack>
              <Button variant="primary" url="/app/pricing">
                See pricing
              </Button>
            </InlineStack>
          </Card>
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

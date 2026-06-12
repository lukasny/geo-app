import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  InlineGrid,
  Badge,
  Banner,
  EmptyState,
  IndexTable,
  Link,
  useIndexResourceState,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { PLAN_LIMITS, PLAN_DEFINITIONS } from "~/services/billing.shared";
import type { PlanKey } from "~/services/billing.shared";
import { getRevenueAttribution } from "~/services/revenue-attribution.server";
import type {
  AiPlatform,
  RevenueSummary,
} from "~/services/revenue-attribution.server";
import { timeAgo } from "~/utils/time";
import { formatMoney } from "~/utils/money";
import { platformLabel } from "~/utils/platforms";

interface LoaderData {
  plan: PlanKey;
  shopifyDomain: string;
  planAllowsFeature: boolean;
  summary: RevenueSummary | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { id: true, plan: true, shopifyDomain: true },
  });
  if (!store) {
    return {
      plan: "FREE" as PlanKey,
      shopifyDomain: session.shop,
      planAllowsFeature: false,
      summary: null,
    } satisfies LoaderData;
  }

  const planKey = store.plan as PlanKey;
  const limits = PLAN_LIMITS[planKey] ?? PLAN_LIMITS.FREE;
  const planAllowsFeature = Boolean(limits.revenueAttribution);

  const summary = planAllowsFeature
    ? await getRevenueAttribution(store.id, { rangeDays: 30, orderLimit: 25 })
    : null;

  return {
    plan: planKey,
    shopifyDomain: store.shopifyDomain,
    planAllowsFeature,
    summary,
  } satisfies LoaderData;
};

const PLATFORM_COLORS: Record<AiPlatform, string> = {
  CHATGPT: "#00C853",
  PERPLEXITY: "#7E57C2",
  CLAUDE: "#FF7043",
  GEMINI: "#4285F4",
  GROK: "#FF1744",
  GOOGLE_AI_OVERVIEW: "#9E9E9E",
};

export default function RevenuePage() {
  const { plan, shopifyDomain, planAllowsFeature, summary } =
    useLoaderData<LoaderData>();

  if (!planAllowsFeature) {
    return (
      <Page>
        <TitleBar title="AI Revenue" />
        <Banner
          tone="warning"
          title={`${PLAN_DEFINITIONS[plan].name} plan doesn't include AI revenue attribution`}
        >
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              See real revenue attributed to ChatGPT, Perplexity, Claude, and
              Gemini referrals. Available on Pro ($
              {PLAN_DEFINITIONS.PRO.price}/mo) and Enterprise.
            </Text>
            <div>
              <Button variant="primary" url="/app/pricing">
                See pricing
              </Button>
            </div>
          </BlockStack>
        </Banner>
      </Page>
    );
  }

  const hasData =
    summary !== null &&
    (summary.byCurrency.length > 0 || summary.allTimeTotal !== null);

  if (!hasData) {
    return (
      <Page>
        <TitleBar title="AI Revenue" />
        <Card>
          <EmptyState
            heading="No AI-attributed revenue yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            action={{
              content: "Open theme editor",
              url: `https://${shopifyDomain}/admin/themes/current/editor?context=apps`,
              external: true,
            }}
          >
            <Text as="p" variant="bodyMd">
              Once a shopper reaches your store from ChatGPT, Perplexity,
              Claude, Gemini, or Grok and places an order, it&apos;ll appear
              here. Make sure the GEO Rise Schema app embed is enabled so the
              tracker can detect AI referrals.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Note: order tracking is awaiting Shopify&apos;s approval for
              protected order data and activates automatically once granted.
              AI referrals are already being tagged in the meantime.
            </Text>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const dominant = summary!.byCurrency[0] ?? {
    currency: summary!.allTimeTotal?.currency ?? "USD",
    amount: 0,
    orderCount: 0,
  };

  return (
    <Page>
      <TitleBar title="AI Revenue" />
      <BlockStack gap="500">
        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Revenue, last 30 days
              </Text>
              <Text as="p" variant="headingLg">
                {formatMoney(dominant.amount, dominant.currency)}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Revenue, all time
              </Text>
              <Text as="p" variant="headingLg">
                {summary!.allTimeTotal
                  ? formatMoney(
                      summary!.allTimeTotal.amount,
                      summary!.allTimeTotal.currency
                    )
                  : "-"}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Orders, last 30 days
              </Text>
              <Text as="p" variant="headingLg">
                {dominant.orderCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Top AI platform
              </Text>
              <Text as="p" variant="headingLg">
                {summary!.topPlatform
                  ? platformLabel(summary!.topPlatform)
                  : "-"}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        {summary!.byCurrency.length === 0 && (
          <Text as="p" variant="bodySm" tone="subdued">
            No AI-attributed orders in the last 30 days. The all-time total and
            recent orders below reflect older activity.
          </Text>
        )}

        {summary!.byCurrency.length > 1 && (
          <Banner tone="info">
            <Text as="p" variant="bodySm">
              Orders in {summary!.byCurrency.length} currencies. Headline
              numbers above show the dominant currency ({dominant.currency});
              the per-order table below shows every order in its native
              currency.
            </Text>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Daily AI revenue, last 30 days ({dominant.currency})
            </Text>
            <RevenueChart byDay={summary!.byDay} currency={dominant.currency} />
            <InlineStack gap="300" wrap>
              {summary!.byPlatform.map((p) => (
                <InlineStack key={p.platform} gap="100" blockAlign="center">
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 2,
                      background: PLATFORM_COLORS[p.platform] ?? "#9E9E9E",
                      display: "inline-block",
                    }}
                  />
                  <Text as="span" variant="bodySm">
                    {platformLabel(p.platform)}{" "}
                    <strong>{formatMoney(p.amount, p.currency)}</strong>
                  </Text>
                </InlineStack>
              ))}
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent attributed orders
            </Text>
            <RevenueOrderTable
              orders={summary!.recentOrders}
              shopifyDomain={shopifyDomain}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

function RevenueChart({
  byDay,
  currency,
}: {
  byDay: RevenueSummary["byDay"];
  currency: string;
}) {
  const maxValue = Math.max(1, ...byDay.map((d) => d.total));
  const width = 600;
  const height = 140;
  const padding = 8;
  const barGap = 2;
  const usableWidth = width - padding * 2;
  const barWidth =
    (usableWidth - barGap * (byDay.length - 1)) / byDay.length;
  const usableHeight = height - padding * 2;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ display: "block", maxWidth: width }}
      >
        {byDay.map((bucket, idx) => {
          const x = padding + idx * (barWidth + barGap);
          const segments = Object.entries(bucket.platforms).sort(
            ([, a], [, b]) => (b ?? 0) - (a ?? 0)
          );
          let yCursor = padding + usableHeight;
          const hoverParts = [
            new Date(bucket.date + "T00:00:00Z").toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
            `Total: ${formatMoney(bucket.total, currency)}`,
            ...segments.map(
              ([platform, amount]) =>
                `${platformLabel(platform)}: ${formatMoney(amount ?? 0, currency)}`
            ),
          ];

          if (bucket.total === 0) {
            return (
              <g key={bucket.date}>
                <rect
                  x={x}
                  y={padding + usableHeight - 2}
                  width={barWidth}
                  height={2}
                  fill="#E4E5E7"
                >
                  <title>{hoverParts[0] + "\nNo revenue"}</title>
                </rect>
              </g>
            );
          }

          return (
            <g key={bucket.date}>
              {segments.map(([platform, amount]) => {
                const h = ((amount ?? 0) / maxValue) * usableHeight;
                yCursor -= h;
                return (
                  <rect
                    key={platform}
                    x={x}
                    y={yCursor}
                    width={barWidth}
                    height={h}
                    fill={
                      PLATFORM_COLORS[platform as AiPlatform] ?? "#9E9E9E"
                    }
                  >
                    <title>{hoverParts.join("\n")}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RevenueOrderTable({
  orders,
  shopifyDomain,
}: {
  orders: RevenueSummary["recentOrders"];
  shopifyDomain: string;
}) {
  const resourceName = { singular: "order", plural: "orders" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(orders.map((o) => ({ id: o.id })));

  if (orders.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        No orders attributed yet in this window.
      </Text>
    );
  }

  const rowMarkup = orders.map((order, index) => {
    const numericId = order.orderId.split("/").pop() ?? order.orderId;
    const adminUrl = `https://${shopifyDomain}/admin/orders/${numericId}`;
    return (
      <IndexTable.Row
        id={order.id}
        key={order.id}
        selected={selectedResources.includes(order.id)}
        position={index}
      >
        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {timeAgo(order.eventAt)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Link url={adminUrl} target="_blank" removeUnderline>
            #{numericId}
          </Link>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge>{platformLabel(order.platform)}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" fontWeight="semibold">
            {formatMoney(order.amount, order.currency)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm" tone="subdued">
            {order.currency}
          </Text>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <IndexTable
      resourceName={resourceName}
      itemCount={orders.length}
      selectedItemsCount={
        allResourcesSelected ? "All" : selectedResources.length
      }
      onSelectionChange={handleSelectionChange}
      selectable={false}
      headings={[
        { title: "Date" },
        { title: "Order" },
        { title: "Platform" },
        { title: "Amount" },
        { title: "Currency" },
      ]}
    >
      {rowMarkup}
    </IndexTable>
  );
}

import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Link,
  List,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import prisma from "~/db.server";
import { checkSitemap } from "~/services/crawler-access.server";

// Bing indexing guidance + sitemap reachability check.
//
// ChatGPT and Copilot answer shopping questions from the Bing index, so
// Bing indexation is how a store shows up in those answers. This page
// checks the storefront sitemap is reachable (the one automated, verifiable
// signal), walks the merchant through Bing Webmaster Tools, and is honest
// about why the app cannot auto-submit IndexNow (see the F5 spec: the key
// file cannot be hosted at the domain root from a Shopify app, and the
// redirect workaround's acceptance by IndexNow is undocumented).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Explicit field pick, never a row spread: the Store row carries the
  // access token, which must never reach the browser.
  const store = await prisma.store.findUnique({
    where: { shopifyDomain: session.shop },
    select: { shopifyDomain: true },
  });

  const sitemap = store
    ? await checkSitemap(store.shopifyDomain)
    : { fetched: false, sitemapUrl: "", kind: "unknown" as const, entryCount: 0 };

  return { sitemap };
};

export default function BingIndexingPage() {
  const { sitemap } = useLoaderData<typeof loader>();

  const sitemapEntryLabel =
    sitemap.kind === "urlset" ? "pages" : "child sitemaps";

  return (
    <Page>
      <TitleBar title="Bing Indexing" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {/* Why this page exists */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Why Bing matters for AI shopping
                </Text>
                <Text as="p" variant="bodyMd">
                  ChatGPT and Microsoft Copilot answer shopping questions from
                  the Bing search index. Getting your store indexed by Bing is
                  how your products can show up in those answers. Bing does not
                  guarantee that any page is indexed or cited, but a store that
                  Bing has never crawled cannot appear at all.
                </Text>
              </BlockStack>
            </Card>

            {/* Automated sitemap check */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="300" align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Your sitemap
                  </Text>
                  {sitemap.fetched ? (
                    <Badge tone="success">Sitemap is live</Badge>
                  ) : (
                    <Badge tone="warning">Could not reach your sitemap</Badge>
                  )}
                </InlineStack>

                {sitemap.fetched ? (
                  <Text as="p" variant="bodyMd">
                    Your store&apos;s sitemap is live at{" "}
                    <Link url={sitemap.sitemapUrl} target="_blank">
                      {sitemap.sitemapUrl}
                    </Link>{" "}
                    and lists {sitemap.entryCount} {sitemapEntryLabel}. Submit
                    this URL to Bing Webmaster Tools in the steps below.
                  </Text>
                ) : (
                  <Text as="p" variant="bodyMd">
                    We could not reach{" "}
                    {sitemap.sitemapUrl ? (
                      <Link url={sitemap.sitemapUrl} target="_blank">
                        {sitemap.sitemapUrl}
                      </Link>
                    ) : (
                      "your sitemap"
                    )}
                    . Shopify generates this file automatically, so if it is
                    unreachable, check that your primary domain is live and try
                    again.
                  </Text>
                )}

                <Text as="p" variant="bodySm" tone="subdued">
                  This checks that your sitemap is reachable, not whether Bing
                  has indexed your pages. Only Bing Webmaster Tools shows what
                  Bing has actually indexed.
                </Text>
              </BlockStack>
            </Card>

            {/* Bing Webmaster Tools steps */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Get indexed with Bing Webmaster Tools
                </Text>
                <List type="number">
                  <List.Item>
                    Sign in at{" "}
                    <Link url="https://www.bing.com/webmasters" target="_blank">
                      bing.com/webmasters
                    </Link>{" "}
                    with a Microsoft, Google, or Facebook account and add your
                    store domain. Importing from Google Search Console is the
                    fastest way to verify. Otherwise use DNS verification, since
                    Shopify stores cannot host the HTML or XML verification file.
                  </List.Item>
                  <List.Item>
                    Submit your sitemap URL (shown above) under Sitemaps.
                  </List.Item>
                  <List.Item>
                    Open Sitemaps and Index Coverage, or run URL Inspection on a
                    product page, to see what Bing has indexed.
                  </List.Item>
                </List>
                <Text as="p" variant="bodySm" tone="subdued">
                  The site: search operator is not a reliable way to check
                  indexation. Use Bing Webmaster Tools instead.
                </Text>
              </BlockStack>
            </Card>

            {/* Honest IndexNow note */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  About IndexNow
                </Text>
                <Text as="p" variant="bodyMd">
                  IndexNow lets a site tell Bing about new and changed pages
                  instantly. It requires hosting a key file at your domain root,
                  which Shopify does not let apps do, so GEO Rise cannot submit
                  your URLs for you. We will not ship an unofficial redirect
                  workaround until it is proven reliable. If you want IndexNow
                  now, Bing Webmaster Tools can enable it for your verified site.
                </Text>
                <Text as="p" variant="bodyMd">
                  <Link
                    url="https://www.bing.com/indexnow/getstarted"
                    target="_blank"
                  >
                    Learn about IndexNow in Bing Webmaster Tools
                  </Link>
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

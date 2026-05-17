import prisma from "~/db.server";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHOPIFY_API_VERSION = "2025-01";
const MAX_RETRIES = 3;

// ─── Shopify GraphQL Types ────────────────────────────────────────────────────

interface ShopifyImage {
  altText: string | null;
  url: string;
}

interface ShopifyVariant {
  title: string;
  price: string;
  availableForSale: boolean;
  sku: string | null;
}

interface ShopifyMetafield {
  namespace: string;
  key: string;
  value: string;
}

interface ShopifyProduct {
  id: string;
  title: string;
  descriptionHtml: string;
  handle: string;
  productType: string;
  vendor: string;
  status: string;
  tags: string[];
  priceRangeV2: {
    minVariantPrice: { amount: string; currencyCode: string };
  };
  totalVariants: number;
  images: { edges: { node: ShopifyImage }[] };
  variants: { edges: { node: ShopifyVariant }[] };
  metafields: { edges: { node: ShopifyMetafield }[] };
  onlineStoreUrl: string | null;
}

interface ShopifyCollection {
  id: string;
  title: string;
  description: string;
  handle: string;
  productsCount: { count: number };
}

interface ShopifyArticle {
  id: string;
  title: string;
  body: string;
  handle: string;
  publishedAt: string;
  blog: { title: string; handle: string };
}

interface GenerateResult {
  content: string;
  productCount: number;
  collectionCount: number;
  blogPostCount: number;
  fileSizeBytes: number;
}

// ─── HTML Utilities ───────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + "…";
}

// ─── Retry with Exponential Backoff ──────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
  delayMs = 500
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (retries === 0) throw err;
    const isRateLimit =
      err instanceof Error && err.message.includes("429");
    const wait = isRateLimit ? delayMs * 4 : delayMs;
    await new Promise((r) => setTimeout(r, wait));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}

// ─── Shopify GraphQL Client ───────────────────────────────────────────────────

async function shopifyGraphql<T>(
  domain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (response.status === 429) {
    throw new Error("429: Shopify rate limit reached");
  }

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }

  // Throttle if approaching rate limit (same logic as audit-engine)
  const rateLimitHeader = response.headers.get("X-Shopify-Shop-Api-Call-Limit");
  if (rateLimitHeader) {
    const [used, total] = rateLimitHeader.split("/").map(Number);
    if (total && used / total > 0.75) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const json = (await response.json()) as { data: T; errors?: unknown[] };

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ─── Shopify Data Fetchers ────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query GetProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          descriptionHtml
          handle
          productType
          vendor
          status
          tags
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
          }
          totalVariants
          images(first: 5) {
            edges { node { altText url } }
          }
          variants(first: 100) {
            edges {
              node { title price availableForSale sku }
            }
          }
          metafields(first: 10) {
            edges {
              node { namespace key value }
            }
          }
          onlineStoreUrl
        }
      }
    }
  }
`;

async function fetchAllProducts(
  domain: string,
  accessToken: string,
  maxProducts: number = Infinity
): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const pageSize = Math.min(
    250,
    Math.max(1, Number.isFinite(maxProducts) ? maxProducts : 250)
  );

  while (hasNextPage && products.length < maxProducts) {
    // eslint-disable-next-line no-loop-func -- closure is awaited
    // synchronously within the iteration, so capturing `cursor` is safe.
    const data = await withRetry(() =>
      shopifyGraphql<{
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: ShopifyProduct }[];
        };
      }>(domain, accessToken, PRODUCTS_QUERY, {
        first: pageSize,
        after: cursor,
      })
    );

    for (const edge of data.products.edges) {
      if (products.length >= maxProducts) break;
      if (edge.node.status === "ACTIVE") {
        products.push(edge.node);
      }
    }

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return products;
}

const COLLECTIONS_QUERY = `
  query GetCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, query: "published_status:published") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          description
          handle
          productsCount { count }
        }
      }
    }
  }
`;

async function fetchAllCollections(
  domain: string,
  accessToken: string
): Promise<ShopifyCollection[]> {
  const collections: ShopifyCollection[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    // eslint-disable-next-line no-loop-func -- closure awaited synchronously
    const data = await withRetry(() =>
      shopifyGraphql<{
        collections: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: ShopifyCollection }[];
        };
      }>(domain, accessToken, COLLECTIONS_QUERY, {
        first: 250,
        after: cursor,
      })
    );

    collections.push(...data.collections.edges.map((e) => e.node));
    hasNextPage = data.collections.pageInfo.hasNextPage;
    cursor = data.collections.pageInfo.endCursor;
  }

  return collections;
}

const BLOGS_QUERY = `
  query GetBlogs($first: Int!, $after: String) {
    blogs(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          title
          articles(first: 50) {
            edges {
              node {
                id
                title
                body
                handle
                publishedAt
                blog { title handle }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchAllArticles(
  domain: string,
  accessToken: string
): Promise<ShopifyArticle[]> {
  const articles: ShopifyArticle[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    // eslint-disable-next-line no-loop-func -- closure awaited synchronously
    const data = await withRetry(() =>
      shopifyGraphql<{
        blogs: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: {
            node: {
              title: string;
              articles: { edges: { node: ShopifyArticle }[] };
            };
          }[];
        };
      }>(domain, accessToken, BLOGS_QUERY, {
        first: 50,
        after: cursor,
      })
    );

    for (const blogEdge of data.blogs.edges) {
      articles.push(...blogEdge.node.articles.edges.map((e) => e.node));
    }

    hasNextPage = data.blogs.pageInfo.hasNextPage;
    cursor = data.blogs.pageInfo.endCursor;
  }

  return articles;
}

// ─── Store Info ───────────────────────────────────────────────────────────────

const SHOP_QUERY = `
  query GetShop {
    shop {
      name
      description
      email
      primaryDomain { url }
    }
  }
`;

interface ShopInfo {
  name: string;
  description: string | null;
  email: string;
  primaryDomain: { url: string };
}

async function fetchShopInfo(
  domain: string,
  accessToken: string
): Promise<ShopInfo> {
  const data = await withRetry(() =>
    shopifyGraphql<{ shop: ShopInfo }>(domain, accessToken, SHOP_QUERY)
  );
  return data.shop;
}

// ─── Content Formatters ───────────────────────────────────────────────────────

function formatProduct(product: ShopifyProduct, storeUrl: string): string {
  const url =
    product.onlineStoreUrl ?? `${storeUrl}/products/${product.handle}`;
  const description = product.descriptionHtml
    ? truncate(stripHtml(product.descriptionHtml), 300)
    : "No description available.";
  const { amount, currencyCode } = product.priceRangeV2.minVariantPrice;
  const variants = product.variants.edges.map((e) => e.node);
  const available = variants.some((v) => v.availableForSale) ? "yes" : "no";
  const variantSummary =
    variants.length === 1
      ? variants[0].title === "Default Title"
        ? "single variant"
        : variants[0].title
      : `${variants.length} variants`;

  const parts = [
    `[${product.title}](${url}): ${description}`,
    `Price: ${amount} ${currencyCode}.`,
    `Variants: ${variantSummary}.`,
    `Available: ${available}.`,
  ];

  if (product.productType) parts.push(`Type: ${product.productType}.`);
  if (product.vendor) parts.push(`Brand: ${product.vendor}.`);

  return parts.join(" ");
}

function formatCollection(
  collection: ShopifyCollection,
  storeUrl: string
): string {
  const url = `${storeUrl}/collections/${collection.handle}`;
  const description = collection.description
    ? truncate(stripHtml(collection.description), 200)
    : "";
  const count = collection.productsCount?.count ?? 0;
  const desc = description ? ` ${description}.` : "";
  return `[${collection.title}](${url}):${desc} ${count} products.`;
}

function formatArticle(article: ShopifyArticle, storeUrl: string): string {
  const url = `${storeUrl}/blogs/${article.blog.handle}/${article.handle}`;
  const summary = truncate(stripHtml(article.body), 200);
  const date = new Date(article.publishedAt).toISOString().split("T")[0];
  return `[${article.title}](${url}): ${summary} Published: ${date}.`;
}

// ─── Bot Permissions Header ───────────────────────────────────────────────────

function buildBotPermissions(settings: {
  allowChatGPT: boolean;
  allowClaude: boolean;
  allowGemini: boolean;
  allowPerplexity: boolean;
  allowDeepSeek: boolean;
  allowGrok: boolean;
}): string {
  const bots = [
    { name: "ChatGPT", allowed: settings.allowChatGPT },
    { name: "Claude", allowed: settings.allowClaude },
    { name: "Gemini", allowed: settings.allowGemini },
    { name: "Perplexity", allowed: settings.allowPerplexity },
    { name: "DeepSeek", allowed: settings.allowDeepSeek },
    { name: "Grok", allowed: settings.allowGrok },
  ];
  const lines = bots.map(
    (b) => `# ${b.name}: ${b.allowed ? "allowed" : "blocked"}`
  );
  return `# AI Bot Access\n${lines.join("\n")}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getOrCreateLlmsFile(storeId: string) {
  const existing = await prisma.llmsFile.findFirst({
    where: { storeId, marketCode: "default" },
  });
  if (existing) return existing;

  return prisma.llmsFile.create({
    data: { storeId, content: "", marketCode: "default" },
  });
}

export interface GenerateLlmsTxtOptions {
  /** Cap on how many products to include in the generated file. Plumbed
   *  through to `fetchAllProducts` so we stop paginating once the cap is
   *  hit — both an API-cost and a plan-enforcement measure. Callers MUST
   *  pass `PLAN_LIMITS[plan].maxProductsInLlmsTxt`; otherwise Free-plan
   *  stores end up with their entire catalog in the public llms.txt file. */
  maxProducts?: number;
}

export async function generateLlmsTxt(
  storeId: string,
  options: GenerateLlmsTxtOptions = {}
): Promise<GenerateResult> {
  // 1. Load store + settings
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
  });

  const llmsFile = await getOrCreateLlmsFile(storeId);
  const { shopifyDomain: domain, shopifyAccessToken: token } = store;
  const maxProducts = options.maxProducts ?? Infinity;

  // 2. Fetch data from Shopify
  const [shopInfo, products, collections, articles] = await Promise.all([
    fetchShopInfo(domain, token),
    llmsFile.includeProducts ? fetchAllProducts(domain, token, maxProducts) : [],
    llmsFile.includeCollections ? fetchAllCollections(domain, token) : [],
    llmsFile.includeBlogPosts ? fetchAllArticles(domain, token) : [],
  ]);

  const storeUrl = shopInfo.primaryDomain.url.replace(/\/$/, "");

  // 3. Build content sections
  const sections: string[] = [];

  // Header
  sections.push(buildBotPermissions(llmsFile));
  sections.push("");
  sections.push(`# ${shopInfo.name}`);
  if (shopInfo.description) {
    sections.push("");
    sections.push(shopInfo.description);
  }

  // Products
  if (llmsFile.includeProducts && products.length > 0) {
    sections.push("");
    sections.push("## Products");
    sections.push("");
    for (const product of products) {
      sections.push(`- ${formatProduct(product, storeUrl)}`);
    }
  }

  // Collections
  if (llmsFile.includeCollections && collections.length > 0) {
    sections.push("");
    sections.push("## Collections");
    sections.push("");
    for (const collection of collections) {
      sections.push(`- ${formatCollection(collection, storeUrl)}`);
    }
  }

  // Blog Posts
  if (llmsFile.includeBlogPosts && articles.length > 0) {
    sections.push("");
    sections.push("## Blog Posts");
    sections.push("");
    for (const article of articles) {
      sections.push(`- ${formatArticle(article, storeUrl)}`);
    }
  }

  // About
  sections.push("");
  sections.push("## About");
  sections.push("");
  sections.push(`Store: ${shopInfo.name}`);
  sections.push(`Domain: ${domain}`);
  if (shopInfo.email) sections.push(`Contact: ${shopInfo.email}`);

  const content = sections.join("\n");
  const fileSizeBytes = Buffer.byteLength(content, "utf8");

  // 4. Persist to database
  await prisma.llmsFile.update({
    where: { id: llmsFile.id },
    data: {
      content,
      productCount: products.length,
      collectionCount: collections.length,
      blogPostCount: articles.length,
      fileSizeBytes,
      lastGeneratedAt: new Date(),
    },
  });

  return {
    content,
    productCount: products.length,
    collectionCount: collections.length,
    blogPostCount: articles.length,
    fileSizeBytes,
  };
}

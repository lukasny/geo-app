import prisma from "~/db.server";
import { getMarketByCode } from "~/services/markets.server";
import type { StoreMarket } from "~/services/markets.server";
import { getFreshAccessToken } from "~/services/offline-admin.server";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHOPIFY_API_VERSION = "2025-07";
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

interface ShopifyTranslation {
  key: string;
  value: string | null;
}

/** GraphQL variables enabling market-specific content. All optional: an
 *  absent field omits that block from the query entirely, so the default
 *  market's query stays byte-identical to the original single-market one. */
interface MarketQueryVars {
  locale?: string;
  marketId?: string;
  country?: string;
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
  /** Present only on market queries (translations(locale:, marketId:)). */
  translations?: ShopifyTranslation[];
  /** Present only on market queries with a representative country.
   *  ProductContextualPricing has no direct minVariantPrice field on
   *  2025-07; the price lives under priceRange (same shape as
   *  priceRangeV2). */
  contextualPricing?: {
    priceRange: {
      minVariantPrice: { amount: string; currencyCode: string };
    };
  } | null;
}

interface ShopifyCollection {
  id: string;
  title: string;
  description: string;
  handle: string;
  productsCount: { count: number };
  translations?: ShopifyTranslation[];
}

interface ShopifyArticle {
  id: string;
  title: string;
  body: string;
  handle: string;
  publishedAt: string;
  blog: { title: string; handle: string };
  translations?: ShopifyTranslation[];
}

export interface GenerateResult {
  content: string;
  productCount: number;
  collectionCount: number;
  blogPostCount: number;
  fileSizeBytes: number;
}

// ─── HTML Utilities ───────────────────────────────────────────────────────────

/** Named HTML entities we decode to their characters. Case-sensitive, as
 *  HTML entity names are (&Aring; vs &aring;). `amp` is intentionally
 *  absent: &amp; must be decoded LAST (see decodeEntities) so that
 *  double-encoded text like "&amp;eacute;" comes out as the literal
 *  "&eacute;" the merchant's HTML actually renders, not as "e with acute". */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  // Typography
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "\u2014",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  // Currency
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  // Latin letters common in European merchant text (Nordic first: the
  // app's primary audience is Norwegian merchants)
  aring: "å",
  Aring: "Å",
  aelig: "æ",
  AElig: "Æ",
  oslash: "ø",
  Oslash: "Ø",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  Egrave: "È",
  agrave: "à",
  Agrave: "À",
  aacute: "á",
  acirc: "â",
  auml: "ä",
  Auml: "Ä",
  ouml: "ö",
  Ouml: "Ö",
  uuml: "ü",
  Uuml: "Ü",
  szlig: "ß",
  ccedil: "ç",
  Ccedil: "Ç",
  ntilde: "ñ",
  Ntilde: "Ñ",
};

/** Code points String.fromCodePoint can safely produce: positive, within
 *  the Unicode range, and not a lone surrogate. */
function isValidCodePoint(code: number): boolean {
  return (
    Number.isInteger(code) &&
    code > 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
  );
}

/** Decode HTML entities to their characters instead of deleting them
 *  (deleting corrupted merchant text in the public file: "Women&#8217;s"
 *  became "Womens", "Bl&aring;b&aelig;r" became "Blbr"). Numeric and hex
 *  entities are decoded via fromCodePoint; named entities via the map
 *  above; unknown or malformed entities are left literal; &amp; is decoded
 *  last so double-encoded entities stay literal text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (match, dec: string) => {
      const code = Number(dec);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) =>
      // hasOwnProperty guard: a plain object literal still has a prototype,
      // so "&constructor;" would otherwise look up Object.prototype.
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : match
    )
    .replace(/&amp;/g, "&");
}

function stripHtml(html: string): string {
  // Tags are stripped BEFORE entities are decoded: text that was visibly
  // "&lt;code&gt;" on the storefront correctly becomes "<code>" in the
  // plain-text output rather than being treated as markup.
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
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

/** Variable declarations and field blocks shared by the market-aware query
 *  builders. When `vars` is empty both helpers return empty strings and the
 *  queries behave exactly as the original single-market versions. */
function translationDecls(vars: MarketQueryVars): string {
  return vars.locale ? ", $locale: String!, $marketId: ID" : "";
}

function translationField(vars: MarketQueryVars): string {
  return vars.locale
    ? "translations(locale: $locale, marketId: $marketId) { key value }"
    : "";
}

function marketVariables(vars: MarketQueryVars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (vars.locale) {
    out.locale = vars.locale;
    out.marketId = vars.marketId ?? null;
  }
  if (vars.country) out.country = vars.country;
  return out;
}

function buildProductsQuery(vars: MarketQueryVars): string {
  const countryDecl = vars.country ? ", $country: CountryCode!" : "";
  const pricingField = vars.country
    ? "contextualPricing(context: { country: $country }) { priceRange { minVariantPrice { amount currencyCode } } }"
    : "";
  return `
  query GetProducts($first: Int!, $after: String${translationDecls(vars)}${countryDecl}) {
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
          ${translationField(vars)}
          ${pricingField}
        }
      }
    }
  }
`;
}

async function fetchAllProducts(
  domain: string,
  accessToken: string,
  maxProducts: number = Infinity,
  market: MarketQueryVars = {}
): Promise<ShopifyProduct[]> {
  const query = buildProductsQuery(market);
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
      }>(domain, accessToken, query, {
        first: pageSize,
        after: cursor,
        ...marketVariables(market),
      })
    );

    for (const edge of data.products.edges) {
      if (products.length >= maxProducts) break;
      // onlineStoreUrl is null exactly when the product is not published to
      // the Online Store sales channel (POS-only, B2B-only, deliberately
      // unlisted). Those must never reach the public llms.txt: the merchant
      // hid them from the web, and any fabricated /products/{handle} link
      // would 404. This also applies to market files, whose URLs are built
      // from the handle: channel publication is store-wide, so a product
      // with a null base onlineStoreUrl has no storefront page in ANY
      // market.
      if (edge.node.status === "ACTIVE" && edge.node.onlineStoreUrl !== null) {
        products.push(edge.node);
      }
    }

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  return products;
}

function buildCollectionsQuery(vars: MarketQueryVars): string {
  return `
  query GetCollections($first: Int!, $after: String${translationDecls(vars)}) {
    collections(first: $first, after: $after, query: "published_status:published") {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          description
          handle
          productsCount { count }
          ${translationField(vars)}
        }
      }
    }
  }
`;
}

async function fetchAllCollections(
  domain: string,
  accessToken: string,
  market: MarketQueryVars = {}
): Promise<ShopifyCollection[]> {
  const query = buildCollectionsQuery(market);
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
      }>(domain, accessToken, query, {
        first: 250,
        after: cursor,
        ...marketVariables(market),
      })
    );

    collections.push(...data.collections.edges.map((e) => e.node));
    hasNextPage = data.collections.pageInfo.hasNextPage;
    cursor = data.collections.pageInfo.endCursor;
  }

  return collections;
}

function articleFields(vars: MarketQueryVars): string {
  return `
                id
                title
                body
                handle
                publishedAt
                blog { title handle }
                ${translationField(vars)}`;
}

function buildBlogsQuery(vars: MarketQueryVars): string {
  return `
  query GetBlogs($first: Int!, $after: String${translationDecls(vars)}) {
    blogs(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          articles(first: 50) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {${articleFields(vars)}
              }
            }
          }
        }
      }
    }
  }
`;
}

/** Follow-up query for blogs whose nested articles connection had more than
 *  one page. The nested connection in buildBlogsQuery cannot be paginated in
 *  place, so each such blog is drained individually via blog(id:). */
function buildBlogArticlesQuery(vars: MarketQueryVars): string {
  return `
  query GetBlogArticles($blogId: ID!, $first: Int!, $after: String${translationDecls(vars)}) {
    blog(id: $blogId) {
      articles(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {${articleFields(vars)}
          }
        }
      }
    }
  }
`;
}

interface ArticlesPage {
  pageInfo: { hasNextPage: boolean; endCursor: string };
  edges: { node: ShopifyArticle }[];
}

async function fetchAllArticles(
  domain: string,
  accessToken: string,
  market: MarketQueryVars = {}
): Promise<ShopifyArticle[]> {
  const query = buildBlogsQuery(market);
  const articlesQuery = buildBlogArticlesQuery(market);
  const articles: ShopifyArticle[] = [];
  // Blogs whose nested articles connection reported another page; drained
  // with per-blog follow-up queries after the outer blogs loop.
  const pendingBlogs: { id: string; cursor: string }[] = [];
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
              id: string;
              title: string;
              articles: ArticlesPage;
            };
          }[];
        };
      }>(domain, accessToken, query, {
        first: 50,
        after: cursor,
        ...marketVariables(market),
      })
    );

    for (const blogEdge of data.blogs.edges) {
      const blog = blogEdge.node;
      articles.push(...blog.articles.edges.map((e) => e.node));
      if (blog.articles.pageInfo.hasNextPage) {
        pendingBlogs.push({ id: blog.id, cursor: blog.articles.pageInfo.endCursor });
      }
    }

    hasNextPage = data.blogs.pageInfo.hasNextPage;
    cursor = data.blogs.pageInfo.endCursor;
  }

  // Inner pagination: blogs with more than 50 posts (content-heavy stores,
  // exactly the ones buying a GEO app) continue here until exhausted.
  for (const pending of pendingBlogs) {
    let innerCursor: string | null = pending.cursor;
    let innerHasNext = true;

    while (innerHasNext) {
      // eslint-disable-next-line no-loop-func -- closure awaited synchronously
      const data = await withRetry(() =>
        shopifyGraphql<{ blog: { articles: ArticlesPage } | null }>(
          domain,
          accessToken,
          articlesQuery,
          {
            blogId: pending.id,
            first: 50,
            after: innerCursor,
            ...marketVariables(market),
          }
        )
      );

      // Blog deleted between pages: keep what we already have.
      if (!data.blog) break;

      articles.push(...data.blog.articles.edges.map((e) => e.node));
      innerHasNext = data.blog.articles.pageInfo.hasNextPage;
      innerCursor = data.blog.articles.pageInfo.endCursor;
    }
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

/** Translated value for a key with fallback to the default-language value.
 *  Shopify returns translations as { key, value } pairs and omits keys that
 *  were never translated; value can also be null for cleared translations. */
function pickTranslation(
  translations: ShopifyTranslation[] | undefined,
  key: string,
  fallback: string
): string {
  const match = translations?.find((t) => t.key === key);
  return match?.value ? match.value : fallback;
}

function formatProduct(
  product: ShopifyProduct,
  storeUrl: string,
  isMarketFile: boolean
): string {
  // Market files always build links from the market's base URL;
  // onlineStoreUrl points at the primary domain. fetchAllProducts only
  // returns products with a non-null onlineStoreUrl, so the default-file
  // fallback below is purely defensive for the type system.
  const url = isMarketFile
    ? `${storeUrl}/products/${product.handle}`
    : product.onlineStoreUrl ?? `${storeUrl}/products/${product.handle}`;
  const title = pickTranslation(product.translations, "title", product.title);
  const descriptionSource = pickTranslation(
    product.translations,
    "body_html",
    product.descriptionHtml
  );
  const description = descriptionSource
    ? truncate(stripHtml(descriptionSource), 300)
    : "No description available.";
  const { amount, currencyCode } =
    product.contextualPricing?.priceRange.minVariantPrice ??
    product.priceRangeV2.minVariantPrice;
  const variants = product.variants.edges.map((e) => e.node);
  const available = variants.some((v) => v.availableForSale) ? "yes" : "no";
  const variantSummary =
    variants.length === 1
      ? variants[0].title === "Default Title"
        ? "single variant"
        : variants[0].title
      : `${variants.length} variants`;

  const parts = [
    `[${title}](${url}): ${description}`,
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
  const title = pickTranslation(
    collection.translations,
    "title",
    collection.title
  );
  const descriptionSource = pickTranslation(
    collection.translations,
    "body_html",
    collection.description
  );
  const description = descriptionSource
    ? truncate(stripHtml(descriptionSource), 200)
    : "";
  const count = collection.productsCount?.count ?? 0;
  const desc = description ? ` ${description}.` : "";
  return `[${title}](${url}):${desc} ${count} products.`;
}

function formatArticle(article: ShopifyArticle, storeUrl: string): string {
  const url = `${storeUrl}/blogs/${article.blog.handle}/${article.handle}`;
  const title = pickTranslation(article.translations, "title", article.title);
  const bodySource = pickTranslation(
    article.translations,
    "body_html",
    article.body
  );
  const summary = truncate(stripHtml(bodySource), 200);
  const date = new Date(article.publishedAt).toISOString().split("T")[0];
  return `[${title}](${url}): ${summary} Published: ${date}.`;
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

// ─── Root /llms.txt Redirect ──────────────────────────────────────────────────

const URL_REDIRECT_CREATE_MUTATION = `
  mutation CreateLlmsTxtRedirect($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect { id }
      userErrors { field message }
    }
  }
`;

/** Shopify reports a duplicate redirect path only via the userError message
 *  ("Path has already been taken" / "already in use"); UrlRedirectErrorCode
 *  on 2025-07 has no dedicated duplicate value, so message text is the only
 *  signal we can key on. */
function isDuplicatePathError(message: string): boolean {
  return /already (been taken|exists|in use)/i.test(message);
}

/** Create the storefront redirect /llms.txt -> /a/llms-txt. AI crawlers
 *  request the root path, never the app-proxy path, so without this redirect
 *  the generated file is invisible to them. Requires the
 *  write_online_store_navigation scope (urlRedirectCreate).
 *
 *  Returns true when the redirect now exists (created, or a duplicate-path
 *  userError meaning it already existed) so the caller can stop retrying;
 *  returns false on any real failure (most commonly a missing-scope access
 *  error before the merchant re-authorizes) so it is reattempted on a later
 *  generation. Never throws: the generation that triggered it must not fail
 *  over a missing redirect. No withRetry: a missing-scope error is not
 *  transient, and the per-generation retry loop is the recovery path. */
export async function ensureRootLlmsRedirect(
  domain: string,
  accessToken: string
): Promise<boolean> {
  try {
    const data = await shopifyGraphql<{
      urlRedirectCreate: {
        urlRedirect: { id: string } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(domain, accessToken, URL_REDIRECT_CREATE_MUTATION, {
      urlRedirect: { path: "/llms.txt", target: "/a/llms-txt" },
    });

    const failures = data.urlRedirectCreate.userErrors.filter(
      (e) => !isDuplicatePathError(e.message)
    );
    if (failures.length > 0) {
      console.warn(
        `[llms.txt] root redirect creation failed for ${domain}: ${failures
          .map((e) => e.message)
          .join("; ")}`
      );
      return false;
    }
    // Created, or a tolerated duplicate-path error: the redirect exists.
    return true;
  } catch (err) {
    // Also lands here when the merchant has not yet re-authorized the
    // write_online_store_navigation scope (top-level access error).
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[llms.txt] root redirect creation failed for ${domain}: ${message}`
    );
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getOrCreateLlmsFile(
  storeId: string,
  marketCode = "default"
) {
  const existing = await prisma.llmsFile.findFirst({
    where: { storeId, marketCode },
  });
  if (existing) return existing;

  return prisma.llmsFile.create({
    data: { storeId, content: "", marketCode },
  });
}

export interface GenerateLlmsTxtOptions {
  /** Cap on how many products to include in the generated file. Plumbed
   *  through to `fetchAllProducts` so we stop paginating once the cap is
   *  hit - both an API-cost and a plan-enforcement measure. Callers MUST
   *  pass `PLAN_LIMITS[plan].maxProductsInLlmsTxt`; otherwise Free-plan
   *  stores end up with their entire catalog in the public llms.txt file. */
  maxProducts?: number;
  /** Shopify Market handle to generate for ("default" = the base file).
   *  Non-default codes fetch translated content, market prices and market
   *  URLs, and persist to that market's LlmsFile row. Callers must enforce
   *  PLAN_LIMITS[plan].multiMarketLlmsTxt before passing non-default codes. */
  marketCode?: string;
}

export async function generateLlmsTxt(
  storeId: string,
  options: GenerateLlmsTxtOptions = {}
): Promise<GenerateResult> {
  // 1. Load store + settings
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
  });

  const marketCode = options.marketCode ?? "default";
  const isMarketFile = marketCode !== "default";

  let market: StoreMarket | null = null;
  if (isMarketFile) {
    market = await getMarketByCode(storeId, marketCode);
    if (!market) {
      throw new Error(
        `Market "${marketCode}" was not found on this store. It may have been deleted in Shopify, or the app may still need re-authorization for the markets permission.`
      );
    }
  }

  const llmsFile = await getOrCreateLlmsFile(storeId, marketCode);
  const domain = store.shopifyDomain;
  // Fetched fresh once per generation: the app uses expiring offline access
  // tokens (~60 min lifetime), and only the Session-table copy refreshed by
  // the library stays valid. Never read Store.shopifyAccessToken here.
  const token = await getFreshAccessToken(domain);
  const maxProducts = options.maxProducts ?? Infinity;

  // Market context for the GraphQL queries: translated content needs the
  // locale (+ marketId for market-specific overrides), prices need a
  // representative country. Missing pieces simply degrade to defaults.
  const marketVars: MarketQueryVars = market
    ? {
        locale: market.defaultLocale ?? undefined,
        marketId: market.id,
        country: market.country ?? undefined,
      }
    : {};

  // 2. Fetch data from Shopify
  const [shopInfo, products, collections, articles] = await Promise.all([
    fetchShopInfo(domain, token),
    llmsFile.includeProducts
      ? fetchAllProducts(domain, token, maxProducts, marketVars)
      : [],
    llmsFile.includeCollections
      ? fetchAllCollections(domain, token, marketVars)
      : [],
    llmsFile.includeBlogPosts
      ? fetchAllArticles(domain, token, marketVars)
      : [],
  ]);

  const storeUrl = (market?.baseUrl ?? shopInfo.primaryDomain.url).replace(
    /\/$/,
    ""
  );

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
      sections.push(`- ${formatProduct(product, storeUrl, isMarketFile)}`);
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
  if (market) {
    const localeSuffix = market.defaultLocale
      ? ` (${market.defaultLocale})`
      : "";
    sections.push(`Market: ${market.name}${localeSuffix}`);
  }
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

  // Default market only, attempted whenever the redirect is not yet known
  // to exist. This covers stores that generated before the feature shipped
  // (rootRedirectCreated defaults false) and stores whose first attempt
  // failed because the write_online_store_navigation scope was not yet
  // approved; once it succeeds the flag is set and no further calls are made.
  if (!isMarketFile && !llmsFile.rootRedirectCreated) {
    const created = await ensureRootLlmsRedirect(domain, token);
    if (created) {
      await prisma.llmsFile.update({
        where: { id: llmsFile.id },
        data: { rootRedirectCreated: true },
      });
    }
  }

  return {
    content,
    productCount: products.length,
    collectionCount: collections.length,
    blogPostCount: articles.length,
    fileSizeBytes,
  };
}

export interface GenerateAllResult {
  /** The default file's generation result (counts for caller toasts). */
  defaultResult: GenerateResult;
  /** Market codes regenerated successfully, "default" always first. */
  generated: string[];
  /** Market codes whose regeneration failed (logged, not thrown), e.g. a
   *  market deleted in Shopify whose LlmsFile row still exists. */
  failed: { marketCode: string; error: string }[];
}

/** Regenerate the default llms.txt plus every EXISTING non-default market
 *  file (merchants opt markets in by generating them once in the UI; this
 *  never creates new market rows). A failure on the default file throws;
 *  per-market failures are collected so one stale market can't block the
 *  rest. Pass multiMarket = PLAN_LIMITS[plan].multiMarketLlmsTxt: when
 *  false only the default file refreshes, so downgraded stores keep their
 *  market rows but stop spending API budget on them. */
export async function generateAllLlmsFiles(
  storeId: string,
  options: { maxProducts?: number; multiMarket: boolean }
): Promise<GenerateAllResult> {
  const generated: string[] = [];
  const failed: { marketCode: string; error: string }[] = [];

  const defaultResult = await generateLlmsTxt(storeId, {
    maxProducts: options.maxProducts,
  });
  generated.push("default");

  if (!options.multiMarket) return { defaultResult, generated, failed };

  const marketRows = await prisma.llmsFile.findMany({
    where: { storeId, marketCode: { not: "default" } },
    select: { marketCode: true },
    orderBy: { marketCode: "asc" },
  });

  // Sequential on purpose: each generation paginates the full catalog and
  // the Shopify client already self-throttles; parallel market generation
  // would race straight into the API rate limit.
  for (const row of marketRows) {
    try {
      await generateLlmsTxt(storeId, {
        maxProducts: options.maxProducts,
        marketCode: row.marketCode,
      });
      generated.push(row.marketCode);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(
        `[llms.txt] market "${row.marketCode}" regeneration failed for store ${storeId}: ${error}`
      );
      failed.push({ marketCode: row.marketCode, error });
    }
  }

  return { defaultResult, generated, failed };
}

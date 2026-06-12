import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

// ─── Shared Shopify product write primitives ──────────────────────────────────
// Extracted from audit-engine.server.ts so AI auto-fix and manual bulk edit
// share one battle-tested write path. No AI calls and no Prisma writes in
// this module: callers own cache/issue bookkeeping.

export interface ProductSeo {
  title: string | null;
  description: string | null;
}

const GET_CURRENT_SEO_QUERY = `#graphql
  query GetCurrentSeo($id: ID!) {
    product(id: $id) { seo { title description } }
  }
`;

// Same mutation string as audit-engine's fixContentIssue uses for
// descriptionHtml updates; duplicated deliberately to keep this extraction
// mechanical and zero-risk for the auto-fix path.
const UPDATE_PRODUCT_MUTATION = `#graphql
  mutation UpdateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id descriptionHtml seo { title description } }
      userErrors { field message }
    }
  }
`;

const GET_PRODUCT_MEDIA_QUERY = `#graphql
  query GetProductImages($id: ID!) {
    product(id: $id) {
      media(first: 20) {
        edges {
          node {
            ... on MediaImage {
              id
              alt
              image { url }
            }
          }
        }
      }
    }
  }
`;

const UPDATE_IMAGE_ALT_MUTATION = `#graphql
  mutation UpdateProductMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
    productUpdateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id alt } }
      mediaUserErrors { field message }
    }
  }
`;

/** Current SEO fields, or null when the product no longer exists. */
export async function fetchProductSeo(
  admin: AdminApiContext,
  shopifyProductId: string
): Promise<ProductSeo | null> {
  const response = await admin.graphql(GET_CURRENT_SEO_QUERY, {
    variables: { id: shopifyProductId },
  });
  const json = (await response.json()) as {
    data: { product: { seo: ProductSeo } | null };
  };
  return json.data.product?.seo ?? null;
}

export type SeoWriteOutcome =
  | { result: "updated" }
  | {
      result: "failed";
      reason: "shopify_user_errors" | "persistence_verify_failed";
    };

/** Update one or both SEO fields. The productUpdate `seo:` input replaces
 *  the WHOLE seo object, so this always sends both fields, merging the
 *  requested changes over the current values (read-modify-write). It then
 *  verifies the echoed values because Shopify has been known to silently
 *  no-op (see project_known_fixes precedent). Pass `currentSeo` if you
 *  already fetched it to save one API call. */
export async function updateProductSeo(
  admin: AdminApiContext,
  shopifyProductId: string,
  fields: { title?: string; description?: string },
  currentSeo?: ProductSeo | null
): Promise<SeoWriteOutcome> {
  const current: ProductSeo =
    currentSeo !== undefined
      ? currentSeo ?? { title: null, description: null }
      : (await fetchProductSeo(admin, shopifyProductId)) ?? {
          title: null,
          description: null,
        };

  const seoUpdate: ProductSeo = {
    title: fields.title !== undefined ? fields.title : current.title,
    description:
      fields.description !== undefined
        ? fields.description
        : current.description,
  };

  const response = await admin.graphql(UPDATE_PRODUCT_MUTATION, {
    variables: { input: { id: shopifyProductId, seo: seoUpdate } },
  });
  const json = (await response.json()) as {
    data: {
      productUpdate: {
        product?: {
          seo?: { title?: string | null; description?: string | null };
        };
        userErrors: { field: string; message: string }[];
      };
    };
  };
  if (json.data.productUpdate.userErrors.length > 0) {
    console.error(
      `[GEO Rise product-mutations] SEO userErrors for ${shopifyProductId}:`,
      json.data.productUpdate.userErrors
    );
    return { result: "failed", reason: "shopify_user_errors" };
  }

  const updatedSeo = json.data.productUpdate.product?.seo;
  const persisted =
    (fields.title === undefined || updatedSeo?.title === seoUpdate.title) &&
    (fields.description === undefined ||
      updatedSeo?.description === seoUpdate.description);
  if (!persisted) {
    console.error(
      `[GEO Rise product-mutations] SEO persistence verify failed for ${shopifyProductId}`
    );
    return { result: "failed", reason: "persistence_verify_failed" };
  }

  return { result: "updated" };
}

export interface ProductMediaImage {
  id: string;
  alt: string | null;
  imageUrl: string | null;
}

/** MediaImage nodes (first 20) for a product. These gids are what
 *  productUpdateMedia needs - NOT the ProductImage ids from `images()`.
 *  Non-image media (video, 3D models) are filtered out. */
export async function fetchProductMediaImages(
  admin: AdminApiContext,
  shopifyProductId: string
): Promise<ProductMediaImage[]> {
  const response = await admin.graphql(GET_PRODUCT_MEDIA_QUERY, {
    variables: { id: shopifyProductId },
  });
  const json = (await response.json()) as {
    data: {
      product: {
        media: {
          edges: {
            node: {
              id?: string;
              alt?: string | null;
              image?: { url: string } | null;
            };
          }[];
        };
      } | null;
    };
  };
  const edges = json.data.product?.media.edges ?? [];
  return edges
    .filter((e) => typeof e.node.id === "string")
    .map((e) => ({
      id: e.node.id as string,
      alt: e.node.alt ?? null,
      imageUrl: e.node.image?.url ?? null,
    }));
}

export type AltWriteOutcome =
  | { result: "updated" }
  | {
      result: "failed";
      reason: "shopify_media_errors" | "persistence_verify_failed";
    };

/** Set alt text on specific media images, verifying every echoed value. */
export async function updateMediaAltText(
  admin: AdminApiContext,
  shopifyProductId: string,
  media: { id: string; alt: string }[]
): Promise<AltWriteOutcome> {
  const response = await admin.graphql(UPDATE_IMAGE_ALT_MUTATION, {
    variables: { productId: shopifyProductId, media },
  });
  const json = (await response.json()) as {
    data: {
      productUpdateMedia: {
        media?: { id: string; alt: string }[];
        mediaUserErrors: { field: string; message: string }[];
      };
    };
  };
  if (json.data.productUpdateMedia.mediaUserErrors.length > 0) {
    console.error(
      `[GEO Rise product-mutations] media userErrors for ${shopifyProductId}:`,
      json.data.productUpdateMedia.mediaUserErrors
    );
    return { result: "failed", reason: "shopify_media_errors" };
  }

  const returned = json.data.productUpdateMedia.media ?? [];
  const allPersisted = media.every((wanted) => {
    const got = returned.find((m) => m.id === wanted.id);
    return got && got.alt === wanted.alt;
  });
  if (!allPersisted) {
    console.error(
      `[GEO Rise product-mutations] media persistence verify failed for ${shopifyProductId}`
    );
    return { result: "failed", reason: "persistence_verify_failed" };
  }

  return { result: "updated" };
}

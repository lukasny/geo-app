// Shared AI shopping readiness constants - safe to import in both server and
// client code. Do NOT add server-only imports (prisma, shopify SDK, etc.) here.
//
// F4: the readiness rubric (scoreReadiness in audit-engine.server.ts) emits
// these gap keys per audited product; Product.readinessGaps persists them as
// a JSON array of these strings. The UI must render labels and hints ONLY
// from this module so copy stays in one place.

/** Closed union of every gap the readiness rubric can emit. Adding a key
 *  here without a matching rubric check (and label + hint below) is a bug:
 *  the Records below are exhaustively typed against this union. */
export type ReadinessGapKey =
  | "missing_category"
  | "broad_category"
  | "missing_barcodes"
  | "partial_barcodes"
  | "missing_vendor"
  | "missing_product_type"
  | "no_images"
  | "few_images"
  | "missing_skus"
  | "partial_skus"
  | "no_reviews"
  | "few_reviews"
  | "thin_specs";

/** Short merchant-facing labels naming each gap. Plain language, no
 *  placement or ranking promises. */
export const READINESS_GAP_LABELS: Record<ReadinessGapKey, string> = {
  missing_category: "No product category set",
  broad_category: "Product category is too broad",
  missing_barcodes: "No barcodes on variants",
  partial_barcodes: "Some variants missing barcodes",
  missing_vendor: "No brand or vendor set",
  missing_product_type: "No product type set",
  no_images: "No product images",
  few_images: "Fewer than 3 product images",
  missing_skus: "No SKUs on variants",
  partial_skus: "Some variants missing SKUs",
  no_reviews: "No customer reviews detected",
  few_reviews: "Fewer than 5 reviews detected",
  thin_specs: "Description has little spec detail",
};

/** One-line "where to fix it in Shopify admin" hints, rendered next to the
 *  label in the product detail modal. */
export const READINESS_GAP_HINTS: Record<ReadinessGapKey, string> = {
  missing_category:
    "Product page, Product organization section: pick the closest category from Shopify's taxonomy.",
  broad_category:
    "Product page, Product organization section: choose a more specific subcategory.",
  missing_barcodes:
    "Product page, variant details: add the GTIN, UPC, or EAN in the Barcode field for each variant.",
  partial_barcodes:
    "Product page, variant details: fill in the Barcode field on every variant.",
  missing_vendor:
    "Product page, Product organization section: set Vendor to your brand name.",
  missing_product_type:
    "Product page, Product organization section: fill in the Product type field.",
  no_images:
    "Product page, Media section: upload at least 3 product photos.",
  few_images:
    "Product page, Media section: add photos until you have at least 3 angles.",
  missing_skus:
    "Product page, variant details: add a unique SKU to every variant.",
  partial_skus:
    "Product page, variant details: fill in the SKU field on every variant.",
  no_reviews:
    "Install a review app (Judge.me, Loox, Okendo, or Yotpo) and send post-purchase review requests.",
  few_reviews:
    "Send post-purchase review requests from your review app to collect more reviews.",
  thin_specs:
    "Product page, Description: add concrete numbers such as dimensions, weight, capacity, or material percentages.",
};

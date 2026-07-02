-- Phase F4 - AI shopping readiness audit. A PARALLEL catalog-completeness
-- score computed in the same audit run as the GEO score but never mixed into
-- it: category taxonomy, barcodes, brand, images, SKUs, reviews, and spec
-- density. Product.readinessScore (0 to 100) and Product.readinessGaps (JSON
-- array of ReadinessGapKey strings from app/services/readiness.shared.ts)
-- are written per audited product; Store.readinessScore is the rounded mean
-- of the run's successful per-product scores. All three columns are nullable:
-- null means "not computed yet" (products audited before F4 keep null until
-- their next audit) and the UI renders a dash, never 0/100.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "readinessGaps" JSONB,
ADD COLUMN "readinessScore" INTEGER;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "readinessScore" INTEGER;

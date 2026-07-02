-- Phase F6 - FAQ generator. ProductFaq holds one row per generation run for
-- one product: Claude's answer-first Q/A pairs (questions JSON), reviewed on
-- screen, then published to the product's geo_rise.faq metafield so the theme
-- extension can render them as FAQPage JSON-LD. Regenerating a product is a
-- new row and counts again toward the monthly cap; soft-delete via status
-- "deleted" keeps monthly-usage counts honest. Store.faqMetafieldDefinitionCreated
-- records that the geo_rise.faq metafield definition was created (lazily, on the
-- store's first publish) so later publishes skip the definitionCreate call.

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "faqMetafieldDefinitionCreated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProductFaq" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductFaq_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductFaq_storeId_idx" ON "ProductFaq"("storeId");

-- CreateIndex
CREATE INDEX "ProductFaq_storeId_status_idx" ON "ProductFaq"("storeId", "status");

-- CreateIndex
CREATE INDEX "ProductFaq_storeId_createdAt_idx" ON "ProductFaq"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductFaq_storeId_shopifyProductId_idx" ON "ProductFaq"("storeId", "shopifyProductId");

-- AddForeignKey
ALTER TABLE "ProductFaq" ADD CONSTRAINT "ProductFaq_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

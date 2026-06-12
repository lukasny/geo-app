-- Composite index for the product-citation stats query: AiCitation rows
-- filtered by storeId plus a checkedAt window (product-citations.server.ts).
CREATE INDEX "AiCitation_storeId_checkedAt_idx" ON "AiCitation"("storeId", "checkedAt");

-- Citation Source Radar. AiCitation.sourcesCited persists the full source
-- URLs each AI platform consulted or cited per tracking check (string[],
-- capped at 20 urls of 500 chars each; null on rows written before this
-- shipped). SourcePresence holds one row per (store, source URL) on-demand
-- presence check: whether the store is named on that page and when we last
-- looked. Fetch failures never write a row, so absence honestly means
-- "not checked" rather than a fabricated miss.

-- AlterTable
ALTER TABLE "AiCitation" ADD COLUMN "sourcesCited" JSONB;

-- CreateTable
CREATE TABLE "SourcePresence" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "present" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourcePresence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourcePresence_storeId_url_key" ON "SourcePresence"("storeId", "url");

-- CreateIndex
CREATE INDEX "SourcePresence_storeId_checkedAt_idx" ON "SourcePresence"("storeId", "checkedAt");

-- AddForeignKey
ALTER TABLE "SourcePresence" ADD CONSTRAINT "SourcePresence_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

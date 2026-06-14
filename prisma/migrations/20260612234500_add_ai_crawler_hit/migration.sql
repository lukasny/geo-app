-- AiCrawlerHit: one counter row per (store, bot, UTC day), upserted
-- fire-and-forget by proxy.llms-txt.ts. The public proxy is unauthenticated,
-- so a row-per-request design let any client grow this table without bound;
-- the daily counter caps it at stores x bots x retained-days. botName is ""
-- (not null) for unclassified traffic so the unique key actually dedupes -
-- Postgres treats NULLs as distinct, which would defeat the upsert.

-- CreateTable
CREATE TABLE "AiCrawlerHit" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "botName" TEXT NOT NULL DEFAULT '',
    "day" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lastUserAgent" TEXT NOT NULL DEFAULT '',
    "lastHitAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCrawlerHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCrawlerHit_storeId_botName_day_key" ON "AiCrawlerHit"("storeId", "botName", "day");

-- CreateIndex
CREATE INDEX "AiCrawlerHit_storeId_day_idx" ON "AiCrawlerHit"("storeId", "day");

-- AddForeignKey
ALTER TABLE "AiCrawlerHit" ADD CONSTRAINT "AiCrawlerHit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

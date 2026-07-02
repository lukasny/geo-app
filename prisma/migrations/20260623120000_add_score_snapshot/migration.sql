-- ScoreSnapshot: one row per successful full audit, written fire-and-forget
-- by audit-engine right after the store score persists. Powers the dashboard
-- score sparkline and the weekly email delta. The wizard's 5-product starter
-- audit (and any audit capped at 5 products or fewer) never writes a row, so
-- the trend only compares like-for-like full audits.

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "auditedProducts" INTEGER NOT NULL,
    "issueCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScoreSnapshot_storeId_createdAt_idx" ON "ScoreSnapshot"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

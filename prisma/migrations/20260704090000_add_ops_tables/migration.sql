-- Day-one ops readiness. Three founder-facing tables, deliberately WITHOUT
-- foreign keys to "Store": ErrorEvent and OpsEvent must survive store
-- deletion (uninstall history and error history persist after the cascade
-- delete), and AiUsageDaily is a global counter with no store at all;
-- shopDomain is a plain string, never a relation. Growth is bounded by
-- design: ErrorEvent holds one row per distinct error signature per UTC day
-- (upsert increment, so volume tracks error variety, not traffic),
-- AiUsageDaily is at most three rows per day (one per AI vendor), and
-- OpsEvent is written on the three lifecycle moments only (install,
-- uninstall, plan_change).

-- CreateTable
CREATE TABLE "ErrorEvent" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stackHead" TEXT,
    "shopDomain" TEXT,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageDaily" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiUsageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErrorEvent_signature_day_key" ON "ErrorEvent"("signature", "day");

-- CreateIndex
CREATE INDEX "ErrorEvent_day_idx" ON "ErrorEvent"("day");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageDaily_day_vendor_key" ON "AiUsageDaily"("day", "vendor");

-- CreateIndex
CREATE INDEX "OpsEvent_createdAt_idx" ON "OpsEvent"("createdAt");

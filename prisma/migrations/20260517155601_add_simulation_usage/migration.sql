-- CreateTable
CREATE TABLE "SimulationUsage" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimulationUsage_storeId_idx" ON "SimulationUsage"("storeId");

-- CreateIndex
CREATE INDEX "SimulationUsage_storeId_createdAt_idx" ON "SimulationUsage"("storeId", "createdAt");

-- AddForeignKey
ALTER TABLE "SimulationUsage" ADD CONSTRAINT "SimulationUsage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

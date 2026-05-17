-- CreateEnum
CREATE TYPE "TrackingSchedule" AS ENUM ('MANUAL', 'DAILY', 'WEEKLY');

-- AlterTable
ALTER TABLE "TrackingPrompt" ADD COLUMN     "nextRunAt" TIMESTAMP(3),
ADD COLUMN     "schedule" "TrackingSchedule" NOT NULL DEFAULT 'MANUAL';

-- CreateIndex
CREATE INDEX "TrackingPrompt_nextRunAt_idx" ON "TrackingPrompt"("nextRunAt");

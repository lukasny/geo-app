-- Phase D3 — insight emails.
-- weeklyInsightEnabled defaults true so existing Growth+ stores receive
-- digests on the next cron tick after the merchant verifies their email.
-- FREE stores are filtered out at the plan-tier gate inside the digest
-- runner regardless of this column's value.

ALTER TABLE "Store"
  ADD COLUMN "weeklyInsightEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "lastInsightSentAt" TIMESTAMP(3);

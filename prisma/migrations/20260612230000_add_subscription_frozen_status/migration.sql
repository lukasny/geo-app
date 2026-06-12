-- Shopify pauses billing (shop paused / payment failure) via the FROZEN
-- subscription status; the webhook now persists it instead of ignoring it.
-- Safe on PG 12+: ADD VALUE is allowed in the migration transaction as long
-- as the new value isn't used in the same transaction (it isn't).
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'FROZEN';

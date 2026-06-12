-- Shopify delivers webhooks at-least-once, and the orders/paid handler did an
-- unconditional create, so a redelivery (e.g. after a Neon cold start pushed
-- the response past Shopify's ~5s timeout) would insert the same order twice
-- and inflate every revenue-attribution metric. This index makes the insert
-- idempotent; the handler treats the resulting P2002 as a duplicate delivery.
--
-- orderId is nullable and Postgres unique indexes treat NULLs as distinct,
-- so referral events without an order are unaffected.
--
-- Safe to create without deduping existing rows: the orders/paid subscription
-- has never been enabled in production (it is intentionally omitted from
-- shopify.app.toml pending Protected Customer Data approval), so no rows with
-- a non-null orderId exist yet.

CREATE UNIQUE INDEX "AiTrafficEvent_storeId_orderId_key" ON "AiTrafficEvent"("storeId", "orderId");

-- Phase D1 - competitor monitoring.
-- Prevent the same merchant from tracking the same domain twice.
-- Domains are stored already-normalized (hostname, lowercase, no protocol
-- or path or www prefix), so this dedupes at the DB layer.

CREATE UNIQUE INDEX "Competitor_storeId_domain_key" ON "Competitor"("storeId", "domain");

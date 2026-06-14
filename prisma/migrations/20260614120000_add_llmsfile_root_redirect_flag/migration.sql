-- Tracks whether the storefront /llms.txt -> /a/llms-txt redirect has been
-- created for this market file. Default-market generation attempts the
-- redirect whenever this is false, so the redirect is created at most once
-- per store after it succeeds, while existing stores (and stores that failed
-- before the write_online_store_navigation re-auth) still get it on a later
-- generation. Defaults to false so existing rows retry on next generation.
ALTER TABLE "LlmsFile" ADD COLUMN "rootRedirectCreated" BOOLEAN NOT NULL DEFAULT false;

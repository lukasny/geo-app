-- Phase F1 - blog post generation. Stored locally as a draft until
-- the merchant publishes to Shopify, then we stamp shopifyArticleId.
-- Monthly plan caps are enforced by counting rows from start-of-month.

CREATE TABLE "BlogPost" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "targetKeywords" JSONB,
  "tone" TEXT,
  "title" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "bodyHtml" TEXT NOT NULL,
  "tags" JSONB,
  "metaTitle" TEXT,
  "metaDescription" TEXT,
  "wordCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "shopifyArticleId" TEXT,
  "shopifyBlogId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BlogPost_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BlogPost_storeId_idx" ON "BlogPost"("storeId");
CREATE INDEX "BlogPost_storeId_status_idx" ON "BlogPost"("storeId", "status");
CREATE INDEX "BlogPost_storeId_createdAt_idx" ON "BlogPost"("storeId", "createdAt");

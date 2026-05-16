-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'GROWTH', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('SCHEMA', 'CONTENT', 'TECHNICAL', 'ACCESSIBILITY', 'IMAGES', 'META');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "AiPlatform" AS ENUM ('CHATGPT', 'GEMINI', 'PERPLEXITY', 'CLAUDE', 'GROK', 'GOOGLE_AI_OVERVIEW');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PENDING', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "shopifyDomain" TEXT NOT NULL,
    "shopifyAccessToken" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "email" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "geoScore" INTEGER NOT NULL DEFAULT 0,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "auditedProducts" INTEGER NOT NULL DEFAULT 0,
    "llmsTxtEnabled" BOOLEAN NOT NULL DEFAULT false,
    "schemaInjectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantIds" JSONB,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "handle" TEXT NOT NULL,
    "productType" TEXT,
    "vendor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "price" TEXT,
    "currency" TEXT,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "hasAltText" BOOLEAN NOT NULL DEFAULT false,
    "altTextQuality" INTEGER NOT NULL DEFAULT 0,
    "hasMetaTitle" BOOLEAN NOT NULL DEFAULT false,
    "hasMetaDescription" BOOLEAN NOT NULL DEFAULT false,
    "hasSchema" BOOLEAN NOT NULL DEFAULT false,
    "hasRichDescription" BOOLEAN NOT NULL DEFAULT false,
    "descriptionWordCount" INTEGER NOT NULL DEFAULT 0,
    "hasReviews" BOOLEAN NOT NULL DEFAULT false,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "averageRating" DOUBLE PRECISION,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "variantsComplete" BOOLEAN NOT NULL DEFAULT false,
    "hasTags" BOOLEAN NOT NULL DEFAULT false,
    "aiReadinessScore" INTEGER NOT NULL DEFAULT 0,
    "lastAuditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditResult" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT,
    "category" "AuditCategory" NOT NULL,
    "severity" "Severity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "autoFixable" BOOLEAN NOT NULL DEFAULT false,
    "fixed" BOOLEAN NOT NULL DEFAULT false,
    "fixedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmsFile" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL DEFAULT 'default',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "collectionCount" INTEGER NOT NULL DEFAULT 0,
    "blogPostCount" INTEGER NOT NULL DEFAULT 0,
    "includeProducts" BOOLEAN NOT NULL DEFAULT true,
    "includeCollections" BOOLEAN NOT NULL DEFAULT true,
    "includeBlogPosts" BOOLEAN NOT NULL DEFAULT true,
    "allowChatGPT" BOOLEAN NOT NULL DEFAULT true,
    "allowClaude" BOOLEAN NOT NULL DEFAULT true,
    "allowGemini" BOOLEAN NOT NULL DEFAULT true,
    "allowPerplexity" BOOLEAN NOT NULL DEFAULT true,
    "allowDeepSeek" BOOLEAN NOT NULL DEFAULT true,
    "allowGrok" BOOLEAN NOT NULL DEFAULT true,
    "autoRefresh" BOOLEAN NOT NULL DEFAULT true,
    "refreshInterval" TEXT NOT NULL DEFAULT 'daily',
    "fileSizeBytes" INTEGER NOT NULL DEFAULT 0,
    "lastGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmsFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCitation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "platform" "AiPlatform" NOT NULL,
    "prompt" TEXT NOT NULL,
    "promptCategory" TEXT,
    "cited" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER,
    "citationContext" TEXT,
    "sentiment" "Sentiment" NOT NULL DEFAULT 'NEUTRAL',
    "competitorsCited" JSONB,
    "productsCited" JSONB,
    "responseSnippet" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingPrompt" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "category" TEXT,
    "targetKeywords" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTrafficEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "platform" "AiPlatform" NOT NULL,
    "referrerUrl" TEXT,
    "landingPage" TEXT NOT NULL,
    "sessionId" TEXT,
    "convertedToOrder" BOOLEAN NOT NULL DEFAULT false,
    "orderId" TEXT,
    "orderRevenue" DOUBLE PRECISION,
    "orderCurrency" TEXT,
    "eventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTrafficEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifySubscriptionId" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_shopifyDomain_key" ON "Store"("shopifyDomain");

-- CreateIndex
CREATE INDEX "Product_storeId_idx" ON "Product"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_storeId_shopifyProductId_key" ON "Product"("storeId", "shopifyProductId");

-- CreateIndex
CREATE INDEX "AuditResult_storeId_idx" ON "AuditResult"("storeId");

-- CreateIndex
CREATE INDEX "AuditResult_productId_idx" ON "AuditResult"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "LlmsFile_storeId_marketCode_key" ON "LlmsFile"("storeId", "marketCode");

-- CreateIndex
CREATE INDEX "AiCitation_storeId_idx" ON "AiCitation"("storeId");

-- CreateIndex
CREATE INDEX "AiCitation_storeId_platform_idx" ON "AiCitation"("storeId", "platform");

-- CreateIndex
CREATE INDEX "AiCitation_checkedAt_idx" ON "AiCitation"("checkedAt");

-- CreateIndex
CREATE INDEX "TrackingPrompt_storeId_idx" ON "TrackingPrompt"("storeId");

-- CreateIndex
CREATE INDEX "Competitor_storeId_idx" ON "Competitor"("storeId");

-- CreateIndex
CREATE INDEX "AiTrafficEvent_storeId_idx" ON "AiTrafficEvent"("storeId");

-- CreateIndex
CREATE INDEX "AiTrafficEvent_storeId_eventAt_idx" ON "AiTrafficEvent"("storeId", "eventAt");

-- CreateIndex
CREATE INDEX "AiTrafficEvent_storeId_platform_idx" ON "AiTrafficEvent"("storeId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_storeId_key" ON "Subscription"("storeId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditResult" ADD CONSTRAINT "AuditResult_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditResult" ADD CONSTRAINT "AuditResult_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmsFile" ADD CONSTRAINT "LlmsFile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCitation" ADD CONSTRAINT "AiCitation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingPrompt" ADD CONSTRAINT "TrackingPrompt_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTrafficEvent" ADD CONSTRAINT "AiTrafficEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

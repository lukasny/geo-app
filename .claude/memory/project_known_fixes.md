---
name: Known Bugs Fixed & Shopify API Quirks
description: Bugs that were discovered and fixed, and Shopify API field quirks to remember
type: project
---

## Shopify GraphQL API 2025-01 quirks

- **Collections do NOT have `onlineStoreUrl`** — build the URL manually: `${storeUrl}/collections/${collection.handle}`
- **Articles do NOT have `onlineStoreUrl`** — build URL: `${storeUrl}/blogs/${article.blog.handle}/${article.handle}`
- **Articles use `body` not `contentHtml`** — the field for article body text is `body`
- **Collections query needs `query: "published_status:published"`** to filter to published only
- **Webhook API version** must be `2025-01` in shopify.app.toml, not future dates

## Webhook configuration (shopify.app.toml)

GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are **removed from dev config** because they require HTTPS URLs that Shopify validates. They cause "invalid topic" errors in development. Add them back before App Store submission with production URL.

## AuditResult productId fix

AuditResult records must have a `productId` (FK to Product table) for auto-fix to work. The original code never set this field. Fix: after creating AuditResult records, fetch all Products for the store, build a `shopifyProductId → dbId` map, and attach the correct `productId` to each record.

## AiCitation field name

The correct field for tracking when a simulation was run is `checkedAt`, not `detectedAt`. Used in the simulator monthly limit check.

## Subscription trialEndsAt

Calculated from webhook payload: `body.app_subscription.trial_days` + `body.app_subscription.created_at`. Not provided directly as a date.

**Why:** These were all discovered during live testing in May 2026. Documenting so they don't get re-introduced.
**How to apply:** Before writing any Shopify GraphQL query, check this list for known field name issues.

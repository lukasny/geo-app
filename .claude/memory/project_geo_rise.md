---
name: GEO Rise — Project Overview
description: What GEO Rise is, its business goal, tech stack, and current feature status
type: project
---

GEO Rise is a Shopify app that helps merchants get their products discovered and recommended by AI search engines (ChatGPT, Gemini, Perplexity, Claude). The practice is called Generative Engine Optimization (GEO).

**Business goal:** 30,000 NOK/month via $39/mo Growth and $79/mo Pro subscriptions.

**GitHub repo:** https://github.com/lukasny/geo-app

**Local path (main dev machine):** `/Users/lukas/Desktop/geo-rise`

**Tech stack:**
- Framework: Remix (Shopify official scaffold)
- Language: TypeScript (strict)
- UI: Shopify Polaris v12 + App Bridge React
- Database: Neon PostgreSQL (free tier — auto-suspends when idle) via Prisma ORM
- AI: Anthropic SDK — claude-sonnet-4-6
- Billing: Shopify native billing API (direct GraphQL mutations)
- Shopify CLI: @shopify/cli

**Plans:**
| Key | Name | Price | Trial |
|---|---|---|---|
| FREE | Free | $0 | — |
| GROWTH | Growth | $39/mo | 7 days |
| PRO | Pro | $79/mo | 7 days |
| ENTERPRISE | Enterprise | $199/mo | 7 days |

**Features built ✅**
- Prisma schema + Neon PostgreSQL
- llms.txt generator service + admin page
- App proxy (public llms.txt at /a/llms-txt)
- JSON-LD schema theme extension (app embed, injects into <head>)
- AI readiness audit engine + auto-fix (generates meta descriptions + alt text via Claude)
- Audit results page (IndexTable, filters, product detail modal)
- AI Simulator (Claude Sonnet 4.6 powered)
- Main dashboard + 4-step onboarding wizard
- Billing service (createSubscription, cancel, sync, plan limits)
- Pricing page (4-tier, Shopify native billing)
- Subscription webhook handler
- Products webhook handler (auto-regenerate llms.txt on change)
- App uninstall webhook (cascade delete)
- Privacy policy + Terms of Service pages

**Features NOT yet built ❌**
- AI visibility tracking page (/app/tracking)
- Competitor monitoring page
- Weekly insight email system
- Multi-market llms.txt
- Content engine
- EU compliance module / GDPR webhooks (removed from dev config)
- Shopify Flow integration
- Revenue attribution tracking

**Why:** Lukas is building toward App Store submission and $30k NOK/month revenue target.
**How to apply:** When suggesting new features, prioritize what moves the needle toward App Store approval and first paying customers. Don't gold-plate existing features.

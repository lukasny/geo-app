# AI crawler visibility (checker + analytics)

**Date:** 2026-06-12
**Author:** Lukas + Claude
**Status:** Approved, ready for implementation plan

## Goal

Roadmap items 1+2. Two linked deliverables: (1) make the existing AI-bot toggles honest by checking the store's real robots.txt and generating a matching robots.txt.liquid snippet; (2) stop throwing away the crawler traffic already hitting the llms.txt proxy: log it, classify it, and show "GPTBot fetched your llms.txt 14 times this week", the most persuasive retention stat in the category. Plus the root-path fix: AI crawlers request /llms.txt, not /a/llms-txt, so create a URL redirect on first generation.

## Scope

**In scope:**
- New `AiCrawlerHit` model (storeId, botName nullable, userAgent truncated, marketCode, hitAt; index [storeId, hitAt]) + hand-written migration. The proxy loader classifies the request's user agent against a doc-verified list of AI crawler UAs (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, GoogleOther, Bingbot, CCBot, Bytespider, meta-externalagent, Amazonbot, Applebot-Extended) and fire-and-forgets one row per request (never slowing or failing the response).
- Dashboard stat: "AI bot fetches, last 30 days" count (all plans; it is the acquisition teaser).
- llms.txt manager: an "AI crawler activity" card with per-bot counts and last-fetch recency over 30 days (Growth+ detail; FREE sees the total plus an upgrade hint).
- New `crawler-access.server.ts`: fetch the storefront's /robots.txt (primary domain via the existing markets/shop lookup, falling back to the myshopify domain), parse User-agent groups and Disallow rules, and report per-AI-bot allowed/blocked status. Conservative parser: a bot is "blocked" when its own group or the * group disallows "/" (path-level nuance out of scope).
- Checker UI on the llms.txt page next to the bot toggles, with honest copy that the toggles only annotate llms.txt while robots.txt is what crawlers obey; mismatch warnings (toggle says blocked, robots.txt allows, and vice versa); and a generated robots.txt.liquid snippet matching the toggles, with copy button and step-by-step theme instructions.
- Root redirect: on the FIRST successful default-market generation, create a Shopify URL redirect /llms.txt -> /a/llms-txt via urlRedirectCreate (implementer must doc-verify the required scope on 2025-07 and add it to shopify.app.toml if missing; it rides the pending re-auth). Idempotent: tolerate "already exists" userErrors. Surface the canonical root URL on the manager page once created.

**Out of scope (documented):**
- Synthetic fetches with AI user agents to detect WAF/Cloudflare blocking (future; needs careful rate limiting).
- One-click robots.txt.liquid apply (writing theme assets programmatically is restricted; copy-paste snippet only).
- Per-path robots rules; the checker reads root-level allow/block only.
- Alerting on crawler activity changes (future, with citation alerts).

## Decisions

1. Log ALL proxy hits with nullable botName (browsers and unknown UAs included): total volume is tiny, and "9 of 14 fetches were AI bots" is a better story than bot-only counts.
2. The checker is FREE (acquisition hook); per-bot analytics detail is Growth+ via the existing aiTracking-style inline gating.
3. The snippet maps each existing toggle to its real crawler UAs (ChatGPT -> GPTBot/OAI-SearchBot/ChatGPT-User, Claude -> ClaudeBot/Claude-User, Gemini -> Google-Extended, Perplexity -> PerplexityBot/Perplexity-User, DeepSeek -> DeepSeekBot, Grok -> xAI crawler UA as doc-verified) so toggling finally has a real-world counterpart.

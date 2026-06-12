# Crawler Visibility Implementation Plan

**Goal:** robots.txt AI-bot checker + snippet generator, AiCrawlerHit analytics on the llms.txt proxy, root /llms.txt redirect, dashboard fetch stat.

**Spec:** `docs/superpowers/specs/2026-06-12-crawler-visibility-design.md`

## Task 1: Data + proxy logging + dashboard stat
- [ ] AiCrawlerHit model + migration; UA classification map (doc-verified bot UA strings); fire-and-forget hit logging in proxy.llms-txt.ts; dashboard "AI bot fetches (30d)" count + stat card.

## Task 2: Checker service + manager page UI
- [ ] crawler-access.server.ts (robots.txt fetch via primary domain with myshopify fallback, group/Disallow parser, per-bot status, snippet builder from the six toggles); llms.txt page: checker section with mismatch warnings + copyable robots.txt.liquid snippet + honest toggle copy; AI crawler activity card (per-bot 30d counts, FREE teaser).

## Task 3: Root redirect + scope
- [ ] urlRedirectCreate /llms.txt -> /a/llms-txt on first default generation (idempotent); doc-verify required scope on 2025-07 and add to shopify.app.toml if needed; surface the root URL on the manager page banner.

## Task 4: Verify and ship
- [ ] prisma generate + tsc + build clean; em-dash scan; focused review; commit; push. Lukas smoke test: run the checker on boda-brands, fetch /a/llms-txt with curl -A "GPTBot" and see the hit appear.

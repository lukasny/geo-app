# Session checkpoint: 2026-06-23 (context-window save)

Compressed state of the June build sessions so any fresh session (no chat
context) can resume exactly here. Supersedes HANDOFF.md's "what shipped"
through this date. Repo: /Users/lukas/Desktop/geo-app (lukasny/geo-app, main).

## Where the product is RIGHT NOW

- DEPLOYED TO SHOPIFY: app version **geo-rise-6** released via
  `npx shopify app deploy --allow-updates` (CLI is now authenticated on this
  Mac). All activation steps done by Lukas: Render SCOPES env updated to the
  full 8-scope string, re-auth accepted on boda-brands, GEO Rise Schema theme
  embed toggled ON. Production (Render, auto-deploy from main) healthy.
- Smoke-tested live on boda-brands: branded ScoreRing (71, indigo arc + cyan
  node), RiseIllustration empty states, honest AI-revenue copy, tracking
  checks run live (real Claude web-search answers, competitor extraction),
  Pro plan active via test billing, market picker + robots checker present.
- KNOWN-EXPECTED: llms.txt shows Products: 0 because boda-brands products are
  not published to the Online Store channel (intentional dead-link filter in
  llms-generator; a warning banner now explains this in the UI, commit
  bda7770). Fix: publish products, then Regenerate.

## What shipped across the June sessions (all on main, all deployed)

1. Handoff-era tasks 1-3: product citation stats, multi-market llms.txt,
   bulk editing UI (with product-mutations.server.ts extraction).
2. UX polish batch (~70 findings), billing downgrade fix (plan switch
   replaces subscription, never cancels to Free), launch docs rewrite.
3. Full-app deep review: 46 confirmed bugs fixed incl. criticals (paid audits
   broken by GraphQL 1,000-point cost cap; CANCELLED webhook downgrading plan
   switchers; expiring offline tokens killing background services; orders
   dedupe; auto-fix overwriting real descriptions). Honesty pass on pricing/
   revenue/email. Dockerfile exec-form CMD.
4. Crawler visibility (roadmap items 1+2): robots.txt checker + snippet,
   AiCrawlerHit daily-counter analytics on the proxy (+60/min throttle),
   /llms.txt root redirect (rootRedirectCreated flag), dashboard bot stat.
5. Brand application per docs/superpowers/specs/2026-06-23-brand-application-
   design.md: tokens.ts + --gr-* CSS, ScoreRing, Mark, RiseIllustration,
   BrandEmptyState across 6 pages, unified scoreColor everywhere, perfection
   pass (trend timeline, step dots, scoreLabel bands aligned to 40/70).
   Favicons intentionally NOT in the app (iframe = Shopify's tab); the set +
   geo-rise-favicon.svg live in /Users/lukas/Desktop/geo_app (underscore
   folder, a drop spot, NOT a repo) for the future marketing site.
   CLAUDE.md carries the brand hard-constraints section.

## Hard rules a fresh session MUST keep (also in CLAUDE.md)

- Em-dash ban absolute (code, copy, docs, commits). Verify Shopify GraphQL
  shapes against shopify.dev for pinned 2025-07 (tsc cannot catch them; check
  requested query cost for Infinity-cap paths). Never recolor/restyle Polaris;
  brand color only via app/brand/tokens.ts on custom SVG/illustration/bespoke
  markup; scoreColor() from tokens only; BrandEmptyState renders its own Card.
  Native CSS grid, never Polaris Grid. Plan caps enforced server-side.
  Workflow per feature: spec in docs/superpowers/specs/ -> plan -> build ->
  adversarial review (findings verified before fixing) -> tsc + build +
  em-dash scan -> per-task commits -> push (Render auto-deploys) -> health
  check curl on https://geo-app-hkhi.onrender.com.

## NEXT STEP (agreed direction, not yet started)

Lukas asked for heavy building; recommendation accepted direction pending his
word: the **"make it feel alive" retention batch**, then the FAQ generator.
Batch contents (from docs/product-roadmap-2026-06.md):
1. GEO score history + trend: ScoreSnapshot row per audit, dashboard hero
   sparkline, "score rose N points" delta leading the weekly email (item 5).
2. AI traffic beacon: theme extension pings an app-proxy endpoint on
   AI-referred visits -> AiTrafficEvent visit rows now, no protected data;
   AI Revenue page shows visits today (item 3).
3. Citation alerts: first-ever citation, lost citation, competitor overtake;
   email lead + dashboard callout (data already in AiCitation).
4. Onboarding auto-seeds 2-3 weekly Intent Lab prompts for trial merchants.
Then: item 4 FAQ generator + FAQPage JSON-LD (biggest competitive parity),
then items 6-12 per the roadmap.

## Lukas-side items still open (not code)

- Publish boda-brands products to Online Store, then Regenerate llms.txt.
- Protected Customer Data application (Partner Dashboard) -> then un-comment
  orders/paid block in shopify.app.toml and redeploy (unlocks revenue
  attribution; required before App Store submission).
- Upload app-icon-1200.png as the Partner Dashboard listing icon.
- App Store submission per docs/launch-checklist.md PART 4 (screenshots,
  listing copy from docs/app-store-listing.md).

## Key file map (for orientation, all committed)

- HANDOFF.md (2026-06-14 snapshot; this file is the delta since).
- docs/product-roadmap-2026-06.md (ranked build queue + cut list).
- docs/launch-checklist.md (activation done; PART 3 test pass partially done,
  PART 4 submission pending).
- docs/superpowers/specs|plans/ (per-feature design docs incl. brand spec).
- app/brand/ (tokens, Mark, ScoreRing, RiseIllustration, BrandEmptyState).
- Claude memory (this Mac, outside repo): ~/.claude/projects/
  -Users-lukas-Desktop-geo-rise/memory/project_geo_app_active_repo.md.

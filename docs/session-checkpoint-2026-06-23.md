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

## UPDATE 2026-07-02: retention batch SHIPPED, evidence brief received

The retention batch above is BUILT, adversarially reviewed, and deployed
(commits 4eca014, 44e6604, a7b9dde, 0f78cbe; production health-checked, the
ScoreSnapshot migration applied at boot). Spec:
docs/superpowers/specs/2026-06-23-retention-batch-design.md. Review outcome:
7 confirmed findings fixed in the shipped commits, notably (a) the visit
beacon now fires ONLY on fresh referrer/utm detection, never from the 30-day
attribution cookie, and (b) a PRE-EXISTING leak where the dashboard loader
spread the raw Store row and serialized shopifyAccessToken to the browser;
loaders must return explicit field picks, never `...store`. Deferred by
decision: AiTrafficEvent visit-row retention/pruning (spec-accepted
row-per-visit + 60/min throttle; revisit if volume grows).

Also shipped 2026-07-02: /privacy and /terms are now 301 redirects to the
live marketing site https://georise.app (b1a21af).

INCIDENT 2026-07-02 (resolved, know why geo-rise-8 exists): Lukas ran
`npx shopify app deploy` from the DEPRECATED ~/Desktop/geo-rise snapshot
folder, releasing geo-rise-8 with stale config (application_url, app proxy,
and auth redirects all https://example.com; old 2025-01 webhooks; old scopes
incl. read_themes) and the old theme extension (no tracker, no beacon).
Fixed within the hour by re-releasing geo-rise-9 from ~/Desktop/geo-app.
Any webhooks fired during the window were lost (harmless on the dev store).
Prevention: the deprecated folder's shopify.app.toml is renamed to
shopify.app.toml.deprecated with a DEPRECATED-DO-NOT-DEPLOY.md beside it,
so the CLI can no longer deploy from there. Shopify deploys run ONLY from
~/Desktop/geo-app.

Lukas delivered a GEO evidence brief (from his strategy Claude); it sits at
~/Desktop/geo_app/geo-evidence-2026-07.md, fact-checked against the repo by
7 agents. Pending HIS go: (1) amend and save it as
docs/geo-evidence-2026-07.md + reference from CLAUDE.md (amendments: F1
crawler checker is ~90% built already, the llms regen pattern is a
latest-wins coalescer NOT an accumulating queue so IndexNow must not copy it
verbatim, F4 cost notes point at the wrong files); (2) honest-copy pass, 3
hard causal llms.txt claims: app.llms-txt.tsx lines ~677 and ~1296 (the
Growth upsell CalloutCard needs a new value prop, not softer verbs) and
docs/app-store-listing.md line 36, plus 4 soft claims; (3) his call whether
the "never claim llms.txt/schema drives citations" rule also covers
app-level taglines and the two unsourced "products with reviews are more
likely to be cited" lines; (4) next build: F3 citation source gap analysis
(listicle radar) recommended, then FAQ generator + FAQPage JSON-LD, then
items 6-12 per the roadmap.

## NEXT STEP

## Lukas-side items still open (not code)

- Run `npx shopify app deploy --allow-updates` (the visit beacon changed the
  theme extension; storefronts serve the old tracker until this runs).
- Smoke test the retention batch on boda-brands: run the audit twice (second
  run grows the dashboard sparkline), visit the storefront with
  `?utm_source=chatgpt` and confirm the AI Revenue page counts it, send a
  test weekly email.
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

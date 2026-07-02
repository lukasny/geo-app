# Retention batch: score history, traffic beacon, citation alerts, seeded prompts

**Date:** 2026-06-23. **Status:** approved. Spec and plan combined (context-economy session).

Goal: the app currently looks identical between visits. This batch makes data accrue unattended and every surface show deltas, which is what converts 7-day trials. Four pieces from docs/product-roadmap-2026-06.md (items 5, 3, and two retention fixes).

Hard rules: all CLAUDE.md constraints apply (em-dash ban, no Polaris recolor, brand tokens for bespoke visuals, native CSS grid, server-side plan gating, honest copy: plain units, "last 30 days", disclose what half-active features wait on). Public write paths must be throttled and validated (see crawler-hits precedent). Doc-verify any new Shopify API shape against 2025-07.

## 1. GEO score history + trend (item 5)

- New model ScoreSnapshot: id cuid, storeId, score Int, auditedProducts Int, issueCount Int, createdAt DateTime @default(now()), Store relation onDelete Cascade, @@index([storeId, createdAt]). Hand-written migration in existing style.
- audit-engine.server.ts: after a successful full audit persists the store score, create one snapshot row (never for the 5-product wizard starter audit: only when the audit was not capped below the previous auditedProducts, simplest honest rule: skip snapshot when options.maxProducts <= 5).
- NEW app/services/score-history.server.ts: `getScoreTrend(storeId, points = 12): Promise<{ snapshots: { score: number; createdAt: string }[]; deltaSincePrevious: number | null }>` (last N snapshots ascending, ISO dates; delta = latest minus previous snapshot, null with fewer than 2).
- Dashboard hero: a small bespoke SVG sparkline next to the ScoreRing (brand.indigo[600] line, cyan node on the latest point, aria-hidden with a text delta beside it like "up 6 since your last audit" / "down 3"). Only rendered with 2+ snapshots.
- Weekly email: when a delta exists, the subject and lead use it ("Your GEO score rose 6 points this week"); otherwise current behavior.

## 2. AI traffic beacon (item 3)

- Theme extension tracker (schema-injection.liquid): when an AI referral is detected (the existing detection that writes the __geo_rise_ai_ref cookie), ALSO send one beacon per session: navigator.sendBeacon (fallback fetch keepalive POST) to `/a/llms-txt/visit?platform={PLATFORM}` with a sessionStorage guard so repeat page views do not re-ping. No PII: platform only; the server records landing path from the signed proxy params if available, else null.
- NEW route app/routes/proxy.llms-txt.visit.ts: action (POST) authenticated via authenticate.public.appProxy (Shopify signs child-path proxy requests; doc-verify child-path pass-through works for POST, else accept GET too). Validate platform against the known enum values; throttle per store in-memory (reuse the crawler-hits pattern, 60/min); insert AiTrafficEvent { storeId, platform, landingPage: null-safe slice 250, referrerUrl: null, convertedToOrder: false }. Never throws to the storefront; respond 204 fast.
- revenue-attribution.server.ts: extend RevenueSummary with `visits30d: number` and `visitsByPlatform: { platform, count }[]` (bounded aggregate over AiTrafficEvent where convertedToOrder=false, eventAt >= 30d).
- app.revenue.tsx: show visits (stat + per-platform) with honest copy: visits are live now; order revenue activates when Shopify grants protected order data. The page no longer shows the setup empty state when visits exist.
- Dashboard AiRevenueCard: add one line "N AI-referred visits, last 30 days" when > 0.
- NOTE for Lukas at ship time: theme-extension changes require `npx shopify app deploy --allow-updates` to go live.

## 3. Citation alerts (retention fix)

- NEW app/services/citation-alerts.server.ts: `computeCitationAlerts(storeId): Promise<Alert[]>` where Alert = { type: "first_citation" | "lost_citation" | "competitor_overtake"; title: string; detail: string; occurredAt: string }. Bounded queries over AiCitation (+ Competitor):
  - first_citation: the store's first-ever cited=true row happened in the last 7 days.
  - lost_citation: a prompt whose PREVIOUS check (per platform) was cited and whose latest is not, latest within 7 days.
  - competitor_overtake: a tracked competitor appears in competitorsCited of the latest check of a prompt where the store is not cited, within 7 days. Cap output at 3 alerts, newest first. Plain honest copy, no em-dashes.
- Weekly email: when alerts exist, the top alert leads the email (above the action plan) and remaining alerts list below; first_citation may take over the subject ("Your store was cited by AI for the first time").
- Dashboard: when alerts exist, one Banner (tone success for first_citation, warning otherwise) under the hero showing the top alert with a "View tracking" url button.

## 4. Onboarding seeds Intent Lab prompts (retention fix)

- In app._index.tsx completeOnboarding action (and markSchemaEnabled completion path if that is the finish): if the plan allows tracking (maxTrackingPrompts > 0) and the store has zero TrackingPrompt rows, fire-and-forget: suggestTrackingPrompts(store.id, admin), create up to 3 of the suggestions as WEEKLY prompts (computeNextRunAt), log failures, never block onboarding. FREE stores: skip silently (no prompts allowed).

## Verification

Per house workflow: tsc + build clean, em-dash scan zero, prisma validate, adversarial review of the diff with findings verified, per-task commits, push, health check. Lukas smoke: re-run an audit twice to see the sparkline; visit the storefront with ?utm_source=chatgpt and see a visit row; check the email test send.

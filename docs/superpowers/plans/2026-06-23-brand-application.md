# Brand Application Implementation Plan

**Goal:** apply the GEO Rise brand inside the embedded admin, presentation only, without touching Polaris, plan gating, or billing.

**Spec:** `docs/superpowers/specs/2026-06-23-brand-application-design.md` (self-contained; hard constraints live there). Tokens: `app/brand/tokens.ts`.

**Hard constraints (carried from the spec, never violate):** Polaris owns the component layer (do NOT recolor/restyle/ wrap core Polaris controls; status = Polaris Badge tones); brand color and type only on the app's own non-Polaris surfaces (custom SVG/canvas data-viz, illustrations, bespoke markup) via `--gr-*` vars or the tokens module, NEVER override `--p-*`; native CSS grid, never Polaris Grid; em-dash ban with the three-layer enforcement and a zero-scan before done; copy voice (count real events in plain units, name rolling windows honestly, disclose half-active features, every empty state explains the feature + one primary action, sentence case); do not touch plan gating or billing; merchant-facing AI stays on claude-sonnet-4-6; accessibility (visible focus, labeled inputs, prefers-reduced-motion on the count-up, no color-only state); all upgrade links go to /app/pricing.

**Verification per surface:** `npx tsc --noEmit` clean, `npm run build` clean, em-dash scan zero on changed files, Built-for-Shopify check (no Polaris recolor, native grid, brand color confined to custom SVG/illustration), accessibility check, manual smoke on the dev store.

---

## Phase A: token-only surfaces (no logo dependency, start now)

### Task A1: Brand CSS variables
- Create `app/styles/brand-tokens.css` deriving `--gr-*` custom properties from `app/brand/tokens.ts` (indigo scale, cyan, ink, mist, neutrals, semantic). For custom surfaces ONLY; must never be applied to Polaris components. Load it once at the app root.

### Task A2: ScoreRing component (dashboard + onboarding reveal)
- Create `app/brand/ScoreRing.tsx`: inline SVG, indigo progress arc on a neutral track, a cyan node at the current value, score number centered. Ring accent + label color from `scoreColor()` in the tokens module (reconcile thresholds 40/70 with existing band logic, do not duplicate). Count-up ~1.2s ease-out, gated on `prefers-reduced-motion`. State not conveyed by color alone (number is always shown).
- Use it in the dashboard hero and the onboarding score reveal (both in `app/routes/app._index.tsx`), replacing the hand-rolled ring/spans. Commit as one surface.

### Task A3: Revenue chart platform colors
- In `app/routes/app.revenue.tsx`, replace the fixed platform colors in the stacked daily SVG chart and its legend with `platformColors` from the tokens module, keyed by the AiPlatform value. Keep the stacked-bar structure. Commit as one surface.

### Task A4: Other bespoke score/number visuals
- Audit/tracking/citation-stats custom (non-Polaris) score visuals use brand colors from the tokens (e.g. the shared ScorePill reconciles to tokens `scoreColor`). Polaris Badges stay on Polaris tones. Commit as one surface.

## Phase B: logo-dependent surfaces (after the real assets land in the repo)

Waiting on: `geo-rise-mark.svg`, `favicon-16/32.png`, `apple-touch-icon-180.png` (user is dropping these into the repo). The `geo-rise-tokens.css` is derived in A1, not needed from the user.

### Task B1: Mark component
- `app/brand/Mark.tsx` from `geo-rise-mark.svg`: inline, inherits currentColor, `tone` prop ("color" indigo strokes + cyan node, "ink", "white").

### Task B2: RiseIllustration component
- `app/brand/RiseIllustration.tsx` from the rising-to-node scene (faint indigo chevron, solid indigo chevron, cyan node). One reusable graphic, visually consistent with the Mark.

### Task B3: Favicons in the document head
- Copy the favicon set into `public/`; wire favicon + apple-touch icon into the root route head.

### Task B4: Empty states
- Every page with one (tracking, competitors, revenue, citation stats, blog, simulator, bulk edit): RiseIllustration + the standard copy pattern (what the feature is, how to get data in, one primary action). Replace bare/generic empty states.

### Task B5: Onboarding + discovery cards
- Onboarding welcome step shows the Mark; score reveal uses the branded ScoreRing (from A2). Discovery cards keep the Polaris Card, branded only via a small Mark/glyph and copy (no card recolor).

## Phase C: finish
- Adversarial review of the full diff against the hard constraints; fix findings.
- Paste the spec's hard-constraints section into `CLAUDE.md` so future sessions inherit the guardrails.
- Final tsc + build + em-dash scan; push. Lukas smoke test on the dev store; upload `app-icon-1200.png` as the listing icon in the Partner Dashboard (manual, not code).

# Brand application spec: GEO Rise embedded app

Goal: apply the GEO Rise brand inside the embedded Shopify admin app without breaking Polaris or the Built for Shopify bar. This is a presentation pass only. It is self-contained on purpose; do not assume access to any external project notes.

## Hard constraints (do not violate)

1. Polaris owns the component layer. Do NOT recolor, restyle, or wrap core Polaris controls (Button, Card, TextField, Select, DataTable, IndexTable, Badge, Banner, Modal, Tabs, and so on). Built for Shopify depends on standard Polaris. For status, use the Polaris Badge with standard tones (success, critical, warning, info, attention), not custom-colored chips.
2. Brand color and type apply ONLY to the app's own non-Polaris surfaces: SVG or canvas data-viz (the GEO score ring, the revenue chart, any sparkline), custom illustrations (empty states, onboarding visuals), and bespoke markup that is not a Polaris component. Define brand colors as `--gr-*` CSS custom properties or import the tokens module. NEVER override Polaris `--p-*` tokens.
3. Never use the Polaris Grid component (it misrenders inside the embedded iframe). Use native CSS grid.
4. Em-dash ban, absolute. No en dashes or em dashes anywhere: code, comments, UI copy, or AI-generated content. Use commas, colons, or hyphens. Write ranges as "30 to 40". Keep the existing three-layer enforcement (prompt instruction, output sanitizer, and the stripEmDashes style regex on generated content). Run an em-dash scan before declaring done.
5. Copy voice. Count real events in plain units: "mentions in 12 AI answers", never "12 conversations" or "12 checks". Name rolling windows honestly: "last 30 days", never "this month". Disclose what a half-active feature is waiting on (for example, "Order tracking is waiting on Shopify approval"). Every empty state explains what the feature is and how to get data into it, with one primary action. Keep an action's name through its whole flow (Publish to Published, not Submit to Success). Sentence case.
6. Do not touch plan gating (enforced server-side per route and in background jobs) or billing logic. This pass is visual only.
7. Any merchant-facing AI stays on claude-sonnet-4-6. Do not swap models.
8. Accessibility. Do not remove focus styling with custom wrappers. Keep visible labels on inputs. Any motion (the score count-up) must respect prefers-reduced-motion. Custom SVG that conveys state must not rely on color alone.
9. All upgrade or plan links go to /app/pricing. There is no /app/billing route.

## Files to add to the repo

- Brand tokens module (provided): place at `app/brand/tokens.ts`. Client-safe, imports nothing server-side. Source of truth for palette, semantic colors, the AI platform color map, score-band colors, and type roles. The score ring and charts import from here.
- Brand CSS variables (provided as geo-rise-tokens.css): place at `app/styles/brand-tokens.css` and load it once. These are `--gr-*` properties for custom surfaces only. Do not let them touch Polaris components.
- The mark as an inline SVG component: build `app/brand/Mark.tsx` from geo-rise-mark.svg (two rising chevrons plus a node). Inline so it inherits currentColor and stays crisp. Use indigo strokes with a cyan node by default; expose a `tone` prop for "color", "ink", and "white".
- The empty-state illustration as a component: build `app/brand/RiseIllustration.tsx` from the rising-to-node scene (faint indigo chevron, solid indigo chevron, cyan node). One small reusable graphic.
- Favicons: copy favicon.ico, favicon-32.png, favicon-16.png, and apple-touch-icon-180.png into `public/`, and wire them into the document head (root route head). 

Not code, do separately: upload app-icon-1200.png as the app listing icon in the Partner Dashboard. It is not consumed by the app.

## Surfaces to apply (specific)

1. Document head: favicon and apple-touch icon in the root route.
2. GEO score ring (dashboard, and the onboarding score reveal): indigo progress arc on a neutral track, a cyan node sitting at the current value, the score number centered. Use the score-band color from the tokens module for the ring accent and the label (reconcile with any existing band thresholds rather than duplicating them). Count-up animation about 1.2 seconds, ease-out, that respects prefers-reduced-motion. Build one reusable `ScoreRing` component and use it in both places.
3. Revenue page stacked daily SVG chart: replace the existing fixed platform colors with the platform color map from the tokens module, keyed by the Ai platform value. The legend uses the same map. Keep the stacked-bar structure.
4. Other custom score and chart visuals across audit, tracking, and citation stats: any bespoke SVG or number visual uses brand colors from the tokens. Polaris Badges stay on Polaris tones.
5. Empty states on every page that has one (tracking, competitors, revenue, citation stats, blog, simulator, bulk edit): use the RiseIllustration plus the standard copy pattern (what the feature is, how to get data in, one primary action). Replace bare or generic empty states.
6. Onboarding wizard: show the Mark on the welcome step; the score reveal uses the branded ScoreRing and its animation.
7. Dashboard discovery cards: keep the Polaris Card. Brand only through a small Mark or glyph and the copy. Do not recolor the card.
8. Logo placement: use the Mark only in custom headers and heroes (onboarding, empty states). Do not try to brand the App Bridge navigation or title bar; those are rendered by Shopify and cannot be styled.

## Workflow and verification

Follow the repo workflow: write a short design spec, then an implementation plan, then implement per surface with a commit per task, then an adversarial review of the diff. A surface is not done until it passes:

- `npx tsc --noEmit` clean and `npm run build` clean.
- Em-dash scan returns zero across changed files.
- Built for Shopify check: no core Polaris control was recolored or restyled; status uses Polaris Badge tones; native CSS grid only (no Polaris Grid); brand color is confined to custom SVG, illustrations, and bespoke markup.
- Accessibility: keyboard focus stays visible, inputs keep labels, the score animation honors prefers-reduced-motion, and no custom visual relies on color alone.
- Manual smoke test on the dev store: the score ring renders and animates, the revenue chart uses the platform colors, the empty states show the illustration and the right copy, and the favicon appears in the tab.

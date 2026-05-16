---
name: Coding Approach Feedback
description: How Lukas wants Claude to approach writing and fixing code in this project
type: feedback
---

**Do the work, don't explain it first.** When Lukas says "fix this" or pastes an error, fix it immediately. Don't ask clarifying questions for simple bugs — just fix and explain briefly after.

**Why:** Lukas is non-technical and trusts Claude to make the right call. Long back-and-forth wastes time.
**How to apply:** Read the relevant files, make the fix, summarize in 1-2 sentences what was wrong.

---

**Don't use Polaris `<Grid>` component.** It breaks inside Shopify's embedded app iframe.

**Why:** Polaris Grid renders incorrectly in embedded iframes — columns collapse or misalign. Discovered during testing session in May 2026.
**How to apply:** Always use native CSS grid (`display: grid`, `gridTemplateColumns`) for layout instead of Polaris Grid anywhere in this project.

---

**Import plan constants from `billing.shared.ts`, not `billing.server.ts`, in route files that have client-side components.**

**Why:** Remix enforces server/client boundaries — `.server.ts` files cannot be imported by client-side code. This caused Vite import-analysis errors. `billing.shared.ts` was created specifically to hold PLAN_DEFINITIONS and PLAN_LIMITS safely.
**How to apply:** In any route file that renders UI (and therefore runs client-side), import PLAN_DEFINITIONS/PLAN_LIMITS from `~/services/billing.shared`, and server-only functions (createSubscription, etc.) from `~/services/billing.server`.

---

**All internal links use `/app/pricing`, never `/app/billing`.** There is no `/app/billing` route.

**Why:** Multiple places originally had `/app/billing` which 404'd. The pricing page is at `/app/pricing`.
**How to apply:** Always use `/app/pricing` for upgrade/plan links throughout the app.

---

**Plan enforcement must be server-side, not just UI.** Don't rely on hiding UI elements to enforce plan limits.

**Why:** Client-side checks can be bypassed. Limits for audit products and simulator runs are now checked in the action/loader on the server.
**How to apply:** When adding new plan-gated features, add the limit check in the Remix action or loader, not just conditionally rendering a button.

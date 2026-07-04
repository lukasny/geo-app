# Day-one ops readiness (error tracking, AI spend guardrails, founder digest): design spec

Date: 2026-07-04. Rationale: the app ships to strangers' stores at launch and
today nothing tells Lukas when something breaks, nothing bounds total AI
spend across stores, and nothing summarizes the business (installs, plans,
errors) for a founder who reads email, not dashboards. Approved by Lukas
("start building" after the readiness-sprint recommendation).

Design stance: NO new external services or dependencies. Errors live in
Neon, alerts and the digest ride the existing Resend integration, and
everything degrades to console logging when the ops env vars are unset.
Sentry stays a documented future option if deep traces are ever needed.

## New env vars (all optional; absent = feature off, app unchanged)

- OPS_ALERT_EMAIL: where alerts and the digest go (Lukas's inbox). Unset =
  no ops emails at all.
- OPS_DIGEST: "daily" | "weekly" | "off". Default "weekly" (sent Mondays).
  Set "daily" during launch week.
- AI_FEATURES_DISABLED: "true" pauses every AI call app-wide with a
  merchant-safe message (the kill switch).
- AI_DAILY_CALL_BUDGET: integer; when today's global AI call count reaches
  it, SCHEDULED tracking checks pause (merchant-interactive calls continue,
  they are plan-capped) and one alert email fires. Unset/0 = unlimited.

## Data model (Agent A owns) - three small bounded tables

1. ErrorEvent: id cuid, signature String (sha1 of source + normalized
   message), source String, message String @db.Text (truncate 500),
   stackHead String? @db.Text (first 800 chars of the stack), shopDomain
   String?, day String (UTC YYYY-MM-DD), count Int @default(1),
   firstSeenAt DateTime @default(now()), lastSeenAt DateTime.
   @@unique([signature, day]), @@index([day]). One row per distinct error
   per day (upsert increment), so volume is bounded by error variety.
2. AiUsageDaily: id cuid, day String (UTC), vendor String (ANTHROPIC |
   OPENAI | PERPLEXITY), calls Int @default(0). @@unique([day, vendor]).
   Global counters: three rows per day maximum.
3. OpsEvent: id cuid, type String (install | uninstall | plan_change),
   shopDomain String, detail String?, createdAt DateTime @default(now()).
   @@index([createdAt]). Written on the three lifecycle moments only.

Hand-written migration prisma/migrations/20260704090000_add_ops_tables/ in
house style (CreateTable x3, indexes, no FKs: OpsEvent and ErrorEvent
deliberately survive store deletion so uninstall history and error history
persist; shopDomain is a plain string, never a relation).

## Services (Agent A owns; exact contracts for Agent B)

NEW app/services/ops-alerts.server.ts:
- `export async function sendOpsMail(subject: string, textBody: string,
  opts?: { countsTowardCap?: boolean }): Promise<boolean>` - sends plain
  text via Resend (same client + FROM_EMAIL pattern as
  insight-email.server.ts) to OPS_ALERT_EMAIL. Returns false (no-op) when
  RESEND_API_KEY or OPS_ALERT_EMAIL is unset. Alert cap: an in-memory
  per-UTC-day counter limits capped sends to 5/day (an error storm must not
  storm the inbox); opts.countsTowardCap defaults true; the digest passes
  false. Never throws.

NEW app/services/error-capture.server.ts:
- `export function captureError(source: string, err: unknown, ctx?: {
  shopDomain?: string }): void` - fire-and-forget (returns void, all async
  work internally caught). Behavior: always console.error first (existing
  logging is not replaced); build signature = sha1(source + message with
  digits, gids, emails, and hex ids normalized to #); upsert ErrorEvent on
  [signature, day] incrementing count and lastSeenAt; when the upsert
  CREATED the row (first time this signature is seen today), call
  sendOpsMail("GEO Rise error: " + source, message + stackHead + shop).
  A failure inside captureError only console.errors (no recursion, never
  throws, never blocks the caller).

NEW app/services/ai-usage.server.ts:
- `export type AiVendor = "ANTHROPIC" | "OPENAI" | "PERPLEXITY";`
- `export function recordAiCall(vendor: AiVendor): void` - fire-and-forget
  upsert increment on AiUsageDaily [day, vendor]. Never throws.
- `export async function getGlobalCallsToday(): Promise<number>` - sum of
  today's calls across vendors (0 on query failure, never throws).
- `export function aiKillSwitchOn(): boolean` - AI_FEATURES_DISABLED
  === "true".
- `export function aiDailyBudget(): number` - parsed AI_DAILY_CALL_BUDGET,
  0 when unset/invalid (0 = unlimited).

CHANGED app/services/ai-retry.server.ts:
- withRetry's third parameter becomes `opts?: { maxAttempts?: number;
  vendor?: AiVendor }` (recon verified NO call site passes the old
  positional maxAttempts, so this is safe; default maxAttempts 3 preserved).
- At the top of withRetry: if aiKillSwitchOn(), throw a merchant-safe Error
  ("AI features are temporarily unavailable. Please try again later.")
  BEFORE any vendor call; sanitizeAiVendorError must pass that message
  through unchanged (check its branches).
- recordAiCall(opts?.vendor ?? "ANTHROPIC") once per withRetry invocation
  (not per retry attempt: attempts are the same logical call).
- On FINAL failure (the throw paths after retries exhaust or permanent
  error), captureError("ai:" + label, err) before throwing.
- Import direction: ai-retry -> ai-usage -> prisma and ai-retry ->
  error-capture -> ops-alerts; no cycles.

Call-site vendor sweep (Agent A): pass { vendor: "OPENAI" } at the OpenAI
call sites (ai-simulator's ChatGPT extraction; tracking's askOpenAI) and
{ vendor: "PERPLEXITY" } at tracking's askPerplexity. All other sites keep
the ANTHROPIC default (verify each of the 15 AI-service call sites across
ai-simulator, audit-engine, blog-generation, faq-generation, tracking;
also verify how audit-engine imports withRetry). Do NOT touch the local
Shopify-GraphQL withRetry helpers in llms-generator and markets.

## Wiring (Agent B owns)

1. app/entry.server.tsx: add the Remix v2 `export function handleError(
   error, { request })` central hook: skip when request.signal.aborted;
   skip thrown Response instances (redirects and 4xx are control flow, not
   errors); otherwise captureError("route:" + pathname, error). Verify the
   exact handleError signature against the installed Remix version's types
   in node_modules before writing it.
2. app/services/scheduler.server.ts:
   - Tracking tick: before running, skip (console.log) when
     aiKillSwitchOn(); when aiDailyBudget() > 0 and getGlobalCallsToday()
     >= budget, skip the run and sendOpsMail once per day ("AI daily call
     budget reached; scheduled checks paused until tomorrow") - use a
     module-level last-alert-day guard.
   - Both existing catch blocks additionally captureError("cron:tracking" /
     "cron:insight-digest", err).
   - New ops-digest cron at 06:00 UTC daily: skip unless OPS_ALERT_EMAIL is
     set and OPS_DIGEST !== "off"; run when OPS_DIGEST === "daily", or on
     Mondays when weekly (the default). Own isRunning guard + catch with
     captureError("cron:ops-digest").
3. NEW app/services/ops-digest.server.ts: `export async function
   runOpsDigest(period: "daily" | "weekly")` - window = last 1 or 7 days.
   Plain-text email via sendOpsMail(subject, body, { countsTowardCap:
   false }). Contents (all bounded queries): new installs (Store.createdAt
   in window: count + up to 10 domains), OpsEvents in window grouped by
   type (uninstalls with domains, plan changes with details), current
   totals (store count, plan mix via groupBy), AI calls by vendor
   (AiUsageDaily in window), errors in window (top 10 ErrorEvent
   signatures by summed count: source, message first 120 chars, count),
   and a one-line health note (kill switch state, budget state). Subject:
   "GEO Rise ops digest: N installs, M errors, K AI calls (last X days)".
   Honest plain units; founder-facing, not merchant-facing.
4. app/routes/webhooks.app.uninstalled.tsx: BEFORE the store.delete, read
   the store's plan and create OpsEvent { type: "uninstall", shopDomain:
   shop, detail: plan } inside its own try/catch (an OpsEvent failure must
   never block the deletion).
5. app/routes/webhooks.app_subscriptions.update.tsx: wherever store.plan
   changes (ACTIVE switch branch and the CANCELLED/EXPIRED downgrade),
   fire-and-forget OpsEvent { type: "plan_change", shopDomain, detail:
   oldPlan + " to " + newPlan + " (" + status + ")" }.
6. app/routes/app._index.tsx: in the store-creation branch of the loader,
   fire-and-forget OpsEvent { type: "install", shopDomain }.
7. Docs: CLAUDE.md env-var section gains the four new vars with one-line
   descriptions; model count 16 -> 19 and the three models added to the
   schema table; feature list gains an ops-readiness entry.
   docs/launch-checklist.md PART 0 gains one item: set OPS_ALERT_EMAIL
   (and optionally OPS_DIGEST=daily and AI_DAILY_CALL_BUDGET) in Render
   before launch so error alerts and the founder digest are live on day
   one.

## Explicitly out of scope (v1)

Sentry or any external APM; client-side (browser) error capture; per-store
AI usage attribution; token-level (vs call-level) spend accounting; an
in-app ops dashboard or ops HTTP endpoint; retention jobs for the ops
tables (bounded growth: revisit at scale); alert channels other than email.

## Verification

Central: prisma generate + validate parse, tsc, build, dash scan.
Focused adversarial review dimensions: (1) the capture path can NEVER
throw, recurse, or block a request/webhook/cron (every path
fire-and-forget); (2) kill switch and budget gate semantics (interactive
vs cron, merchant-safe message passes sanitizeAiVendorError unchanged,
no call site broke from the withRetry signature change); (3) handleError
correctness (Responses skipped, aborts skipped, signature matches the
installed Remix types); (4) digest queries bounded + email content honest.
Fix confirmed findings, per-task commits (data+services, wiring+digest),
push, health check. Smoke: with OPS_ALERT_EMAIL set in Render, Lukas
should receive the first digest the next morning; an intentional error is
NOT needed (the next real one will alert).

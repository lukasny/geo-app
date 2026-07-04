// Shared retry + error-classification utilities for any code that calls a
// third-party AI vendor (Anthropic, OpenAI, Perplexity). Server-only because
// the helpers reference `console` and don't need to ship in the client bundle.
// Also the single choke point for the ops guardrails: every AI call passes
// through withRetry, so this is where the AI_FEATURES_DISABLED kill switch,
// the global per-vendor usage counters, and final-failure error capture live.
// Import direction is one-way (ai-retry -> ai-usage and ai-retry ->
// error-capture -> ops-alerts); nothing in those modules imports back.

import {
  aiKillSwitchOn,
  recordAiCall,
  type AiVendor,
} from "./ai-usage.server";
import { captureError } from "./error-capture.server";

// Thrown by withRetry before any vendor request when the kill switch is on.
// Merchant-safe by construction, and sanitizeAiVendorError passes it through
// verbatim so no context-specific rewrite ever replaces it.
const KILL_SWITCH_MESSAGE =
  "AI features are temporarily unavailable. Please try again later.";

/** A "permanent" error means: this won't recover by retrying. The user (or
 *  GEO Rise itself) needs to fix something external - top up credits, fix
 *  the API key, switch to a supported model. Detect these so retry loops
 *  bail immediately instead of burning seconds and dollars.
 *
 *  Patterns cover:
 *  - Anthropic: "Your credit balance is too low...", authentication_error,
 *    permission_error, invalid_api_key
 *  - OpenAI: "You exceeded your current quota", "Incorrect API key",
 *    "The model ... does not exist", "billing"
 *  - Perplexity (OpenAI-compatible): same shapes as OpenAI */
export function isPermanentApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /credit balance|insufficient_quota|authentication_error|permission_error|billing|invalid.api.key|incorrect.api.key|model.*does not exist|do.*not have access|exceeded.*quota/i.test(
    msg
  );
}

/** Transient errors worth retrying with backoff: 429s, 5xx, network drops,
 *  Anthropic's "overloaded" responses. Anything else (4xx that's not 429,
 *  permanent errors above) is NOT retried. */
export function isTransientApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|\b429\b|\b5\d\d\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|overloaded|service_unavailable|upstream|gateway/i.test(
    msg
  );
}

/** Map a raw AI-vendor error to a user-safe message. Anthropic/OpenAI return
 *  strings like "Your credit balance is too low" and "Plans & Billing" which
 *  mention vendor billing - a merchant would think these refer to their
 *  Shopify billing and panic. Always log the raw error server-side, return
 *  a clean message to the UI.
 *
 *  `context` is the user-facing label that appears in the fallback message,
 *  e.g. "Tracking", "Blog post generation". Keep it title-cased and short. */
export function sanitizeAiVendorError(
  err: unknown,
  opts: { context: string; logTag?: string }
): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.error(`[ai-error] ${opts.logTag ?? opts.context}:`, raw);
  // The kill-switch message is already merchant-safe; without this
  // pass-through the generic fallback below would rewrite it into
  // "<context> failed", losing the "temporarily unavailable" framing.
  if (raw === KILL_SWITCH_MESSAGE) {
    return raw;
  }
  if (/credit balance.*too low|insufficient_quota|billing/i.test(raw)) {
    return `${opts.context} is temporarily unavailable. Please try again in a few minutes.`;
  }
  if (/rate.?limit|\b429\b/i.test(raw)) {
    return "AI service is busy, please try again in a moment.";
  }
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(raw)) {
    return "AI service didn't respond in time. Please try again.";
  }
  if (/overloaded|service_unavailable/i.test(raw)) {
    return "AI service is overloaded right now. Please try again in a moment.";
  }
  if (/authentication_error|invalid.api.key|incorrect.api.key/i.test(raw)) {
    return `${opts.context} is temporarily misconfigured. We've been notified.`;
  }
  return `${opts.context} failed. Please try again in a moment.`;
}

/** Retry an async AI call up to `opts.maxAttempts` times (default 3) with
 *  exponential backoff. Bails immediately on permanent errors
 *  (credit/auth/bad model) so we don't waste time retrying things that will
 *  never succeed.
 *
 *  Ops guardrails, all before/around the vendor call and none of them able
 *  to block it: the AI_FEATURES_DISABLED kill switch throws the
 *  merchant-safe KILL_SWITCH_MESSAGE before any vendor request; each
 *  invocation counts ONCE toward the global daily usage counter for
 *  `opts.vendor` (default "ANTHROPIC" - retries are the same logical call,
 *  so they are not re-counted); and the FINAL failure of a call (permanent
 *  error, non-transient error, or retries exhausted) is recorded via
 *  captureError("ai:" + label) before the throw.
 *
 *  Backoff schedule: 500ms, 1s, 2s (between attempts 1→2, 2→3, 3→4).
 *  `maxAttempts: 3` total means 1 initial try + 2 retries. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: { maxAttempts?: number; vendor?: AiVendor }
): Promise<T> {
  if (aiKillSwitchOn()) {
    // Deliberately NOT captured: while the switch is on, every merchant
    // click would otherwise generate an error row and alert email.
    throw new Error(KILL_SWITCH_MESSAGE);
  }
  const maxAttempts = opts?.maxAttempts ?? 3;
  recordAiCall(opts?.vendor ?? "ANTHROPIC");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isPermanentApiError(err)) {
        captureError(`ai:${label}`, err);
        throw err;
      }
      if (attempt === maxAttempts || !isTransientApiError(err)) {
        captureError(`ai:${label}`, err);
        throw err;
      }
      const backoffMs = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s
      console.warn(
        `[ai-retry] ${label} attempt ${attempt} failed (${
          err instanceof Error ? err.message : String(err)
        }), retrying in ${backoffMs}ms`
      );
      await new Promise<void>((r) => setTimeout(r, backoffMs));
    }
  }
  // Unreachable with maxAttempts >= 1 (the loop always returns or throws);
  // kept for completeness, and captured like the throws above.
  captureError(`ai:${label}`, lastErr);
  throw lastErr;
}

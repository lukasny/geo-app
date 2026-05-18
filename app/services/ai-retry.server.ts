// Shared retry + error-classification utilities for any code that calls a
// third-party AI vendor (Anthropic, OpenAI, Perplexity). Server-only because
// the helpers reference `console` and don't need to ship in the client bundle.

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

/** Retry an async AI call up to `maxAttempts` times with exponential backoff.
 *  Bails immediately on permanent errors (credit/auth/bad model) so we don't
 *  waste time retrying things that will never succeed.
 *
 *  Backoff schedule: 500ms, 1s, 2s (between attempts 1→2, 2→3, 3→4).
 *  `maxAttempts: 3` total means 1 initial try + 2 retries. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isPermanentApiError(err)) {
        throw err;
      }
      if (attempt === maxAttempts || !isTransientApiError(err)) {
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
  throw lastErr;
}

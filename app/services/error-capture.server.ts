// Server-side error capture: one bounded DB row per distinct error per UTC
// day, plus one ops alert email the first time a signature appears that day.
// This is the app's whole error tracker (no Sentry, no new services): errors
// live in Neon and alerts ride the existing Resend integration via
// ops-alerts.server.ts. Every path in here is fire-and-forget: captureError
// returns void, all async work is internally caught, and a failure inside
// the capture path only console.errors. It must NEVER throw, recurse, or
// block the request, webhook, or cron that called it.

import { createHash } from "node:crypto";
import prisma from "~/db.server";
import { sendOpsMail } from "./ops-alerts.server";

// Bounded columns: a pathological or hostile error message must not bloat
// rows. 500 chars of message and 800 of stack are plenty to identify a bug.
const MESSAGE_CAP = 500;
const STACK_HEAD_CAP = 800;

/** Collapse the volatile parts of an error message so recurrences of the
 *  same bug share one signature: Shopify gids, email addresses, long hex
 *  ids, and digit runs all become "#". Order matters: gids and emails
 *  contain digits, so they are replaced before the digit pass. */
function normalizeMessage(message: string): string {
  return message
    .replace(/gid:\/\/shopify\/\w+\/\d+/g, "#")
    .replace(/[\w.+-]+@[\w.-]+/g, "#")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+/g, "#");
}

/** Record an error: always console.error first (existing logging is not
 *  replaced), then upsert-increment the ErrorEvent row for [signature, day]
 *  and email an ops alert when this is the signature's first occurrence
 *  today. Fire-and-forget: returns void immediately, never throws. */
export function captureError(
  source: string,
  err: unknown,
  ctx?: { shopDomain?: string }
): void {
  try {
    console.error(`[GEO Rise error] ${source}:`, err);

    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = rawMessage.slice(0, MESSAGE_CAP);
    const stackHead =
      err instanceof Error && err.stack
        ? err.stack.slice(0, STACK_HEAD_CAP)
        : null;
    const signature = createHash("sha1")
      .update(source + normalizeMessage(rawMessage))
      .digest("hex");
    const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const now = new Date();

    void prisma.errorEvent
      .upsert({
        where: { signature_day: { signature, day } },
        create: {
          signature,
          source,
          message,
          stackHead,
          shopDomain: ctx?.shopDomain ?? null,
          day,
          count: 1,
          lastSeenAt: now,
        },
        update: { count: { increment: 1 }, lastSeenAt: now },
      })
      .then((row) => {
        // create writes count 1 and every update increments past it, so
        // count === 1 means the upsert CREATED the row: this signature's
        // first occurrence today. Alerting only here dedupes the email on
        // the same unique key as the row itself; sendOpsMail's own daily
        // cap bounds a many-distinct-errors storm on top of that.
        if (row.count !== 1) return undefined;
        const lines = [
          `Source: ${source}`,
          ...(ctx?.shopDomain ? [`Shop: ${ctx.shopDomain}`] : []),
          `Day (UTC): ${day}`,
          "",
          message,
          ...(stackHead ? ["", stackHead] : []),
        ];
        return sendOpsMail(`GEO Rise error: ${source}`, lines.join("\n")).then(
          () => undefined
        );
      })
      .catch((captureFailure) => {
        // Plain console.error only: routing this through captureError again
        // would recurse forever on a persistent DB failure.
        console.error(
          "[GEO Rise error-capture] failed to persist/alert:",
          captureFailure
        );
      });
  } catch (captureFailure) {
    console.error(
      "[GEO Rise error-capture] unexpected sync failure:",
      captureFailure
    );
  }
}

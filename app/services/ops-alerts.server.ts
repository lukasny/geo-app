// Founder-facing ops email: error alerts, budget alerts, and the ops digest,
// all plain text to OPS_ALERT_EMAIL (Lukas's inbox, never a merchant's).
// Replicates the tiny Resend client + sender setup from
// insight-email.server.ts rather than importing it: that module carries the
// whole merchant-digest compose pipeline (action plans, competitor stats)
// which the ops path must never pull in. Degrades to a no-op (returns false)
// when RESEND_API_KEY or OPS_ALERT_EMAIL is unset, and never throws: every
// caller sits on a fire-and-forget path inside a request, webhook, or cron.

import { Resend } from "resend";

// ─── Setup ────────────────────────────────────────────────────────────────────

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Unlike merchant digests, the resend.dev default sender is fine here even
// in production: Resend delivers onboarding@resend.dev mail to the account
// owner's own address, and the account owner IS the ops audience.
const FROM_EMAIL =
  process.env.INSIGHT_FROM_EMAIL ?? "GEO Rise <onboarding@resend.dev>";

// ─── Daily alert cap ──────────────────────────────────────────────────────────

// An error storm must not storm the inbox: capped sends (alerts) are limited
// to 5 per UTC day; the ops digest passes countsTowardCap: false and always
// goes out. In-memory state is fine here: Render runs a single process (the
// same assumption the cron singleton makes), and the worst case after a
// restart is a fresh allowance of 5.
const DAILY_ALERT_CAP = 5;
let capDay = "";
let cappedSendsToday = 0;

/** Send a plain-text ops email to OPS_ALERT_EMAIL. Returns true only when
 *  Resend accepted the send; false covers "feature off" (env vars unset),
 *  "daily alert cap reached", and any Resend rejection or throw. Never
 *  throws. `opts.countsTowardCap` defaults to true; only the digest passes
 *  false. */
export async function sendOpsMail(
  subject: string,
  textBody: string,
  opts?: { countsTowardCap?: boolean }
): Promise<boolean> {
  try {
    const to = process.env.OPS_ALERT_EMAIL;
    if (!resend || !to) return false;

    if (opts?.countsTowardCap ?? true) {
      const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
      if (today !== capDay) {
        capDay = today;
        cappedSendsToday = 0;
      }
      if (cappedSendsToday >= DAILY_ALERT_CAP) {
        console.warn(
          `[GEO Rise ops-alerts] daily alert cap (${DAILY_ALERT_CAP}) reached, dropping: ${subject}`
        );
        return false;
      }
      // Count the attempt, not the success: a Resend outage must not turn
      // into an uncapped alert stream the moment it recovers.
      cappedSendsToday++;
    }

    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      text: textBody,
    });
    if (result.error) {
      console.error(
        `[GEO Rise ops-alerts] Resend rejected "${subject}":`,
        result.error
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[GEO Rise ops-alerts] send threw for "${subject}":`, err);
    return false;
  }
}

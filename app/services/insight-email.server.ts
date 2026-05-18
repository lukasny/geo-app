import { Resend } from "resend";
import prisma from "~/db.server";
import { PLAN_LIMITS } from "./billing.shared";
import { getActionPlan } from "./action-plan.server";
import { getCompetitorOverview } from "./competitor-monitoring.server";

// ─── Setup ────────────────────────────────────────────────────────────────────

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Default sender uses Resend's dev domain so the app can boot even before
// Lukas verifies his own domain. For production, set INSIGHT_FROM_EMAIL to
// something like "GEO Rise <notify@georise.app>" once the domain is verified
// in Resend.
const FROM_EMAIL =
  process.env.INSIGHT_FROM_EMAIL ?? "GEO Rise <onboarding@resend.dev>";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComposedEmail {
  subject: string;
  html: string;
  text: string;
}

export type SendResult =
  | { sent: true }
  | { sent: false; reason: string; recoverable: boolean };

// ─── Compose ──────────────────────────────────────────────────────────────────

/** Build the weekly insight digest for one store. Returns `null` if the store
 *  isn't eligible (wrong plan, no email, no audit data yet). */
export async function composeInsightEmail(
  storeId: string
): Promise<ComposedEmail | null> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: {
      shopName: true,
      shopifyDomain: true,
      plan: true,
      geoScore: true,
      auditedProducts: true,
      totalProducts: true,
    },
  });
  if (!store) return null;

  const planLimits =
    PLAN_LIMITS[store.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.FREE;
  if (!planLimits.insightEmails) return null;

  const productLimit = Number.isFinite(planLimits.maxAuditProducts)
    ? planLimits.maxAuditProducts
    : undefined;

  const [actionPlan, competitorOverview] = await Promise.all([
    getActionPlan(storeId, { productLimit }),
    planLimits.competitorMonitoring
      ? getCompetitorOverview(storeId)
      : Promise.resolve(null),
  ]);

  // Cited rate from the most recent tracking citations.
  const recentCitations = await prisma.aiCitation.findMany({
    where: { storeId },
    orderBy: { checkedAt: "desc" },
    take: 100,
    select: { cited: true },
  });
  const totalChecks = recentCitations.length;
  const citedCount = recentCitations.filter((c) => c.cited).length;
  const citedRate =
    totalChecks > 0 ? Math.round((citedCount / totalChecks) * 100) : null;

  // Top competitor by citedCount, if any.
  const topCompetitor = competitorOverview?.competitors
    .slice()
    .sort((a, b) => b.citedCount - a.citedCount)[0];

  // Shopify admin deep link. We can't know the app's "handle" reliably, so
  // we use the app's public URL - clicking it triggers Shopify's normal
  // embedded-app handoff back into the admin.
  const appBaseUrl =
    process.env.SHOPIFY_APP_URL ?? "https://geo-app-hkhi.onrender.com";
  const actionPlanUrl = `${appBaseUrl}/app/action-plan`;
  const dashboardUrl = `${appBaseUrl}/app`;

  // ── Build subject ──
  // Earlier draft used `${count} ${title.toLowerCase()} to fix`, which
  // produced broken English on audit titles starting with "No"
  // ("15 no customer reviews to fix"). The current form sidesteps
  // pluralization / preposition concerns by treating the title as the
  // standalone label of the top action.
  const top = actionPlan.actions[0];
  const subject =
    top !== undefined
      ? `Your GEO Score ${store.geoScore}/100 - top action: ${top.title}`
      : `Your GEO Score ${store.geoScore}/100 - all clear`;

  // ── Build plain text (for accessibility / non-HTML clients) ──
  const textLines: string[] = [];
  textLines.push(`Hi ${store.shopName},`);
  textLines.push("");
  textLines.push(`Your AI visibility update for the past week:`);
  textLines.push("");
  textLines.push(`GEO Score: ${store.geoScore}/100`);
  textLines.push(
    `Audited products: ${store.auditedProducts} of ${store.totalProducts}`
  );
  if (citedRate !== null) {
    textLines.push(
      `AI tracking: cited in ${citedCount} of the last ${totalChecks} checks (${citedRate}%)`
    );
  }
  if (topCompetitor) {
    textLines.push(
      `Top competitor cited: ${topCompetitor.competitor.name} (${topCompetitor.citedCount} times)`
    );
  }
  textLines.push("");
  if (actionPlan.actions.length > 0) {
    textLines.push(`Top actions to take this week:`);
    for (let i = 0; i < Math.min(3, actionPlan.actions.length); i++) {
      const a = actionPlan.actions[i];
      textLines.push(
        `  ${i + 1}. [${a.severity}] ${a.title} (${a.count} ${
          a.count === 1 ? "issue" : "issues"
        }${a.autoFixable ? " - auto-fixable" : ""})`
      );
    }
    textLines.push("");
    textLines.push(`Open your action plan: ${actionPlanUrl}`);
  } else {
    textLines.push(`No unfixed issues right now - your store is in good shape.`);
    textLines.push(`Open dashboard: ${dashboardUrl}`);
  }
  textLines.push("");
  textLines.push(`- GEO Rise (Boda Apps)`);
  textLines.push(
    `Manage email preferences in your GEO Rise dashboard.`
  );
  const text = textLines.join("\n");

  // ── Build HTML ──
  // Minimal inline-styled email - emails clients are notoriously
  // stylesheet-stripping, so all styling is inline.
  const scoreColor =
    store.geoScore < 40 ? "#E24B4A" : store.geoScore < 70 ? "#EF9F27" : "#1D9E75";
  const actionItemsHtml = actionPlan.actions
    .slice(0, 3)
    .map(
      (a, i) => `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #eee;">
            <div style="font-size: 14px; font-weight: 600; color: #202223;">
              ${i + 1}. ${escapeHtml(a.title)}
            </div>
            <div style="font-size: 12px; color: #6D7175; margin-top: 4px;">
              ${a.severity} severity · ${a.count} ${a.count === 1 ? "issue" : "issues"}${
        a.autoFixable ? " · one-click auto-fix available" : ""
      }
            </div>
          </td>
        </tr>`
    )
    .join("");

  const competitorBlockHtml = topCompetitor
    ? `
      <div style="margin: 20px 0; padding: 14px 16px; background: #f6f6f7; border-radius: 8px;">
        <div style="font-size: 13px; color: #6D7175; margin-bottom: 4px;">Most-cited competitor</div>
        <div style="font-size: 16px; font-weight: 600; color: #202223;">
          ${escapeHtml(topCompetitor.competitor.name)}
        </div>
        <div style="font-size: 13px; color: #6D7175; margin-top: 4px;">
          Cited ${topCompetitor.citedCount} ${
        topCompetitor.citedCount === 1 ? "time" : "times"
      } in your recent tracking. Your store: ${
        topCompetitor.storeCitedSameQueries
      } overlap.
        </div>
      </div>`
    : "";

  const trackingBlockHtml =
    citedRate !== null
      ? `
        <div style="margin: 20px 0; padding: 14px 16px; background: #f6f6f7; border-radius: 8px;">
          <div style="font-size: 13px; color: #6D7175; margin-bottom: 4px;">AI tracking</div>
          <div style="font-size: 16px; font-weight: 600; color: #202223;">
            Cited in ${citedCount} of ${totalChecks} checks (${citedRate}%)
          </div>
        </div>`
      : "";

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <div style="max-width: 560px; margin: 24px auto; background: #ffffff; border-radius: 12px; overflow: hidden;">
      <div style="padding: 28px 32px 0;">
        <div style="font-size: 13px; color: #6D7175; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;">
          Your weekly GEO Rise update
        </div>
        <h1 style="margin: 6px 0 24px; font-size: 22px; color: #202223;">
          Hi ${escapeHtml(store.shopName)} 👋
        </h1>
      </div>

      <div style="padding: 0 32px;">
        <div style="display: inline-block; padding: 16px 20px; background: #f6f6f7; border-radius: 12px; margin-bottom: 16px;">
          <div style="font-size: 13px; color: #6D7175; margin-bottom: 4px;">GEO Score</div>
          <div style="font-size: 36px; font-weight: 700; color: ${scoreColor}; line-height: 1;">
            ${store.geoScore}<span style="font-size: 18px; color: #6D7175;">/100</span>
          </div>
          <div style="font-size: 13px; color: #6D7175; margin-top: 6px;">
            ${store.auditedProducts} of ${store.totalProducts} products audited
          </div>
        </div>

        ${trackingBlockHtml}
        ${competitorBlockHtml}

        ${
          actionPlan.actions.length > 0
            ? `
        <h2 style="font-size: 16px; color: #202223; margin: 28px 0 8px;">
          Top ${Math.min(3, actionPlan.actions.length)} action${
                actionPlan.actions.length === 1 ? "" : "s"
              } this week
        </h2>
        <table cellspacing="0" cellpadding="0" style="width: 100%; border-collapse: collapse;">
          ${actionItemsHtml}
        </table>
        <div style="margin: 24px 0;">
          <a href="${actionPlanUrl}"
             style="display: inline-block; background: #008060; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Open my action plan →
          </a>
        </div>`
            : `
        <h2 style="font-size: 16px; color: #202223; margin: 28px 0 12px;">
          ✅ No unfixed issues right now
        </h2>
        <p style="font-size: 14px; color: #6D7175; margin: 0 0 24px;">
          Your store is in good shape. Re-run the audit periodically to catch
          drift as you add new products.
        </p>
        <div style="margin: 24px 0;">
          <a href="${dashboardUrl}"
             style="display: inline-block; background: #008060; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 600;">
            Open dashboard →
          </a>
        </div>`
        }
      </div>

      <div style="padding: 24px 32px; border-top: 1px solid #eee; font-size: 12px; color: #8C9196;">
        You're getting this because you opted in to weekly insights on your
        ${escapeHtml(store.plan)} plan. Manage preferences in your GEO Rise
        dashboard.
        <br /><br />
        - Boda Apps / GEO Rise
      </div>
    </div>
  </body>
</html>`;

  return { subject, html, text };
}

// ─── Send ─────────────────────────────────────────────────────────────────────

/** Compose + send the insight email for one store. Returns a detailed result
 *  so the caller (manual "send test" button or weekly cron) can react
 *  appropriately - `recoverable: true` means transient and worth retrying
 *  next tick; `recoverable: false` means a config gap that won't fix itself. */
export async function sendInsightEmail(storeId: string): Promise<SendResult> {
  if (!resend) {
    return {
      sent: false,
      reason: "Email service not configured (RESEND_API_KEY missing).",
      recoverable: false,
    };
  }

  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { email: true },
  });
  if (!store) {
    return { sent: false, reason: "Store not found.", recoverable: false };
  }
  if (!store.email) {
    return {
      sent: false,
      reason: "No email on file for this store.",
      recoverable: false,
    };
  }

  const composed = await composeInsightEmail(storeId);
  if (!composed) {
    return {
      sent: false,
      reason: "Store not eligible (plan tier or insufficient data).",
      recoverable: false,
    };
  }

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: store.email,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
    });
    if (result.error) {
      console.error(
        `[GEO Rise insight-email] Resend rejected for store ${storeId}:`,
        result.error
      );
      return {
        sent: false,
        reason: `Email service rejected: ${result.error.message ?? "unknown error"}`,
        // Transient 5xx / rate-limit vs permanent auth/bad-recipient - Resend
        // doesn't always type the error well, so treat as transient.
        recoverable: true,
      };
    }
    await prisma.store.update({
      where: { id: storeId },
      data: { lastInsightSentAt: new Date() },
    });
    return { sent: true };
  } catch (err) {
    console.error(
      `[GEO Rise insight-email] send threw for store ${storeId}:`,
      err
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "Unknown error",
      recoverable: true,
    };
  }
}

// ─── Weekly cron entry point ──────────────────────────────────────────────────

const EMAIL_LIMIT_PER_TICK = 100;

export interface DigestRunResult {
  considered: number;
  sent: number;
  skippedNotEligible: number;
  failed: number;
}

/** Find stores due for their weekly insight digest and send. Called by the
 *  daily cron in `scheduler.server.ts`. A store is "due" when it's on Growth+,
 *  opted in, has an email on file, AND its last digest was more than 6.5 days
 *  ago (or never sent). */
export async function runWeeklyInsightDigest(): Promise<DigestRunResult> {
  // 6.5-day cutoff gives some slack - running the cron daily-ish means
  // each store's digest cycle slides between 6.5–7.5 days, not strictly
  // 7. Avoids a "missed by 90 minutes, has to wait another full week"
  // failure mode.
  const cutoff = new Date(Date.now() - 6.5 * 24 * 60 * 60 * 1000);

  const due = await prisma.store.findMany({
    where: {
      weeklyInsightEnabled: true,
      email: { not: null },
      plan: { not: "FREE" },
      OR: [
        { lastInsightSentAt: null },
        { lastInsightSentAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
    take: EMAIL_LIMIT_PER_TICK,
  });

  let sent = 0;
  let skippedNotEligible = 0;
  let failed = 0;

  for (const store of due) {
    const result = await sendInsightEmail(store.id);
    if (result.sent) {
      sent++;
    } else if (!result.recoverable) {
      // Permanent: not eligible / no email / API key missing. Don't retry
      // next tick; counts as "skipped" rather than "failed."
      skippedNotEligible++;
    } else {
      failed++;
    }
  }

  return { considered: due.length, sent, skippedNotEligible, failed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal HTML-entity escape for merchant-provided strings (shop name,
 *  competitor names, action titles). Stops a `</style>` or `<script>` in a
 *  shop name from breaking the email template. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

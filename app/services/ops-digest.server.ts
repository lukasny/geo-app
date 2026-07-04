import prisma from "~/db.server";
import { sendOpsMail } from "./ops-alerts.server";
import {
  aiDailyBudget,
  aiKillSwitchOn,
  getGlobalCallsToday,
} from "./ai-usage.server";

// ─── Founder ops digest ───────────────────────────────────────────────────────

// Summarizes the business (installs, uninstalls, plan changes, current plan
// mix, AI spend, errors) into one plain-text email to OPS_ALERT_EMAIL.
// Founder-facing, not merchant-facing: shop domains appear because Lukas
// should see them; nothing here ever goes to a merchant. Called by the
// 06:00 UTC cron in scheduler.server.ts, which also decides the cadence
// (OPS_DIGEST: daily / weekly / off). Every query below is bounded so a
// busy launch week cannot turn the digest into a slow full-table scan.

/** Shop domains listed per section before collapsing to "and N more". */
const DOMAINS_SHOWN = 10;

/** OpsEvents are only written on install/uninstall/plan-change, so this cap
 *  is a safety bound, not an expected limit. If it ever trips, the digest
 *  says so instead of silently under-reporting. */
const OPS_EVENT_LIMIT = 200;

/** Distinct error signatures listed in the digest, ranked by summed count. */
const TOP_ERRORS = 10;

/** Display order for the plan mix and anything plan-keyed. */
const PLAN_ORDER = ["FREE", "GROWTH", "PRO", "ENTERPRISE"];

/** Display order for AI vendors; unknown vendor strings append after. */
const VENDOR_ORDER = ["ANTHROPIC", "OPENAI", "PERPLEXITY"];

/** UTC day string ("YYYY-MM-DD"), the same keying used by the `day` columns
 *  on ErrorEvent and AiUsageDaily. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day strings from `days` ago through today, inclusive. The day-keyed
 *  tables only resolve to whole UTC days, so the digest counts both end
 *  days rather than pretending sub-day precision it does not have (the
 *  body says so next to the window line). */
function dayStringsBack(days: number): string[] {
  const out: string[] = [];
  for (let i = days; i >= 0; i--) {
    out.push(utcDay(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
  }
  return out;
}

/** Compose and send the founder ops digest for the last 1 (daily) or 7
 *  (weekly) days. Returns sendOpsMail's result: true when the email was
 *  handed to Resend, false when ops email is not configured or the send
 *  was rejected. Query failures propagate to the scheduler tick, whose
 *  catch runs captureError("cron:ops-digest"). */
export async function runOpsDigest(
  period: "daily" | "weekly"
): Promise<boolean> {
  const days = period === "daily" ? 1 : 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const dayKeys = dayStringsBack(days);
  const windowLabel = days === 1 ? "last 1 day" : `last ${days} days`;

  const [
    installCount,
    installDomains,
    opsEvents,
    storeCount,
    planMix,
    aiUsageRows,
    errorTotals,
    topErrorGroups,
  ] = await Promise.all([
    // Store has installedAt (no createdAt column), same meaning.
    prisma.store.count({ where: { installedAt: { gte: cutoff } } }),
    prisma.store.findMany({
      where: { installedAt: { gte: cutoff } },
      orderBy: { installedAt: "desc" },
      take: DOMAINS_SHOWN,
      select: { shopifyDomain: true },
    }),
    prisma.opsEvent.findMany({
      where: { createdAt: { gte: cutoff } },
      orderBy: { createdAt: "asc" },
      take: OPS_EVENT_LIMIT,
      select: { type: true, shopDomain: true, detail: true },
    }),
    prisma.store.count(),
    prisma.store.groupBy({ by: ["plan"], _count: true }),
    // At most 3 vendor rows per day, so this is bounded by the window.
    prisma.aiUsageDaily.findMany({
      where: { day: { in: dayKeys } },
      select: { vendor: true, calls: true },
    }),
    prisma.errorEvent.aggregate({
      where: { day: { in: dayKeys } },
      _sum: { count: true },
    }),
    prisma.errorEvent.groupBy({
      by: ["signature"],
      where: { day: { in: dayKeys } },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: TOP_ERRORS,
    }),
  ]);

  // Source + message for the top signatures. One row per signature per day,
  // so this is bounded by TOP_ERRORS x window days. Newest row wins: the
  // raw message can drift day to day even when the normalized signature is
  // stable.
  const topSignatures = topErrorGroups.map((g) => g.signature);
  const errorRows =
    topSignatures.length > 0
      ? await prisma.errorEvent.findMany({
          where: { signature: { in: topSignatures }, day: { in: dayKeys } },
          orderBy: { lastSeenAt: "desc" },
          select: { signature: true, source: true, message: true },
        })
      : [];
  const detailBySignature = new Map<string, { source: string; message: string }>();
  for (const row of errorRows) {
    if (!detailBySignature.has(row.signature)) {
      detailBySignature.set(row.signature, {
        source: row.source,
        message: row.message,
      });
    }
  }

  const uninstalls = opsEvents.filter((e) => e.type === "uninstall");
  const planChanges = opsEvents.filter((e) => e.type === "plan_change");

  const aiCallsByVendor = new Map<string, number>();
  let aiCallsTotal = 0;
  for (const row of aiUsageRows) {
    aiCallsByVendor.set(
      row.vendor,
      (aiCallsByVendor.get(row.vendor) ?? 0) + row.calls
    );
    aiCallsTotal += row.calls;
  }
  const vendors = [
    ...VENDOR_ORDER.filter((v) => aiCallsByVendor.has(v)),
    ...[...aiCallsByVendor.keys()].filter((v) => !VENDOR_ORDER.includes(v)),
  ];

  const errorTotal = errorTotals._sum.count ?? 0;

  const planCountByKey = new Map<string, number>(
    planMix.map((row) => [String(row.plan), row._count])
  );
  const planMixLabel = PLAN_ORDER.map(
    (plan) => `${plan} ${planCountByKey.get(plan) ?? 0}`
  ).join(", ");

  // Health note: kill switch + budget state, one line at the bottom.
  const killSwitch = aiKillSwitchOn();
  const budget = aiDailyBudget();
  const callsToday = await getGlobalCallsToday();
  const healthLine =
    (killSwitch
      ? "AI kill switch is ON (AI_FEATURES_DISABLED=true), every AI call is paused"
      : "AI kill switch off") +
    "; " +
    (budget > 0
      ? `daily AI call budget ${budget}, ${callsToday} calls so far today${
          callsToday >= budget
            ? " (budget reached, scheduled checks paused)"
            : ""
        }`
      : "no daily AI call budget set (unlimited)") +
    ".";

  // ── Plain-text body ──
  const lines: string[] = [];
  lines.push(`GEO Rise ops digest (${windowLabel})`);
  lines.push(
    `Window: ${dayKeys[0]} to ${dayKeys[dayKeys.length - 1]} UTC. Day-level counters (AI calls, errors) cover whole UTC days, so both end days are included.`
  );
  lines.push("");

  lines.push(`NEW INSTALLS: ${installCount}`);
  for (const s of installDomains) {
    lines.push(`- ${s.shopifyDomain}`);
  }
  if (installCount > installDomains.length) {
    lines.push(`- and ${installCount - installDomains.length} more`);
  }
  lines.push("");

  lines.push(`UNINSTALLS: ${uninstalls.length}`);
  for (const e of uninstalls.slice(0, DOMAINS_SHOWN)) {
    lines.push(`- ${e.shopDomain}${e.detail ? ` (was on ${e.detail})` : ""}`);
  }
  if (uninstalls.length > DOMAINS_SHOWN) {
    lines.push(`- and ${uninstalls.length - DOMAINS_SHOWN} more`);
  }
  lines.push("");

  lines.push(`PLAN CHANGES: ${planChanges.length}`);
  for (const e of planChanges.slice(0, DOMAINS_SHOWN)) {
    lines.push(`- ${e.shopDomain}: ${e.detail ?? "no detail recorded"}`);
  }
  if (planChanges.length > DOMAINS_SHOWN) {
    lines.push(`- and ${planChanges.length - DOMAINS_SHOWN} more`);
  }
  if (opsEvents.length === OPS_EVENT_LIMIT) {
    lines.push(
      `(lifecycle event list hit the ${OPS_EVENT_LIMIT}-row safety cap for this window; counts above may be low)`
    );
  }
  lines.push("");

  lines.push("CURRENT TOTALS");
  lines.push(`Stores installed: ${storeCount}`);
  lines.push(`Plan mix: ${planMixLabel}`);
  lines.push("");

  lines.push(`AI CALLS (${windowLabel}): ${aiCallsTotal}`);
  if (vendors.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const vendor of vendors) {
      lines.push(`- ${vendor}: ${aiCallsByVendor.get(vendor) ?? 0}`);
    }
  }
  lines.push("");

  lines.push(
    `ERRORS (${windowLabel}): ${errorTotal} ${
      errorTotal === 1 ? "occurrence" : "occurrences"
    }`
  );
  if (topErrorGroups.length === 0) {
    lines.push("- none recorded");
  } else {
    for (const g of topErrorGroups) {
      const detail = detailBySignature.get(g.signature);
      const message = (detail?.message ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 120);
      lines.push(
        `- ${g._sum.count ?? 0}x ${detail?.source ?? "unknown"}: ${message}`
      );
    }
    if (topErrorGroups.length === TOP_ERRORS) {
      lines.push(`(showing the top ${TOP_ERRORS} error signatures by count)`);
    }
  }
  lines.push("");

  lines.push(`HEALTH: ${healthLine}`);
  lines.push("");
  lines.push("- GEO Rise ops digest (automated, see scheduler.server.ts)");

  const subject = `GEO Rise ops digest: ${installCount} ${
    installCount === 1 ? "install" : "installs"
  }, ${errorTotal} ${errorTotal === 1 ? "error" : "errors"}, ${aiCallsTotal} AI ${
    aiCallsTotal === 1 ? "call" : "calls"
  } (${windowLabel})`;

  // countsTowardCap: false - the digest must not compete with error alerts
  // for the 5-per-day alert budget in ops-alerts.server.ts.
  return sendOpsMail(subject, lines.join("\n"), { countsTowardCap: false });
}

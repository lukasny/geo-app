// Global AI spend guardrails: call-level (not token-level) counters per
// vendor per UTC day, plus the env-var switches the retry layer and the
// scheduler consult. Counters are app-wide across all stores by design: the
// AI_DAILY_CALL_BUDGET bounds Lukas's total vendor bill, and per-store
// attribution is explicitly out of scope for v1. Everything here degrades
// cleanly: with the env vars unset the switches report "off"/"unlimited"
// and the counters keep recording quietly.

import prisma from "~/db.server";

export type AiVendor = "ANTHROPIC" | "OPENAI" | "PERPLEXITY";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

/** Count one logical AI call against today's global counter for `vendor`.
 *  withRetry calls this once per invocation, never per retry attempt
 *  (retries are the same logical call). Fire-and-forget: returns void
 *  immediately and never throws; a failed increment only console.errors so
 *  the vendor call it annotates is never blocked. */
export function recordAiCall(vendor: AiVendor): void {
  const day = todayUtc();
  void prisma.aiUsageDaily
    .upsert({
      where: { day_vendor: { day, vendor } },
      create: { day, vendor, calls: 1 },
      update: { calls: { increment: 1 } },
    })
    .catch((err) => {
      console.error(`[GEO Rise ai-usage] failed to count ${vendor} call:`, err);
    });
}

/** Today's total AI calls across all vendors. Returns 0 on query failure
 *  (never throws): the budget gate fails open, pausing nothing, which is
 *  the safe direction for a guardrail that only exists to stop runaway
 *  scheduled work. */
export async function getGlobalCallsToday(): Promise<number> {
  try {
    const result = await prisma.aiUsageDaily.aggregate({
      where: { day: todayUtc() },
      _sum: { calls: true },
    });
    return result._sum.calls ?? 0;
  } catch (err) {
    console.error("[GEO Rise ai-usage] failed to sum today's calls:", err);
    return 0;
  }
}

/** The app-wide kill switch: AI_FEATURES_DISABLED=true pauses every AI call
 *  (withRetry throws a merchant-safe message before any vendor request). */
export function aiKillSwitchOn(): boolean {
  return process.env.AI_FEATURES_DISABLED === "true";
}

/** Parsed AI_DAILY_CALL_BUDGET. 0 means unlimited (unset, unparseable, or
 *  non-positive). When positive and today's global count has reached it,
 *  the scheduler pauses SCHEDULED tracking checks until tomorrow;
 *  merchant-interactive calls continue, they are plan-capped. */
export function aiDailyBudget(): number {
  const parsed = Number.parseInt(process.env.AI_DAILY_CALL_BUDGET ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

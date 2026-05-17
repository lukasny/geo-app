import prisma from "~/db.server";
import { runTrackingCheck } from "./tracking.server";
import {
  computeNextRunAt,
  type TrackingSchedule,
} from "./tracking-scheduler.shared";

// Re-export so callers that already pull from this file keep working.
export { computeNextRunAt };
export type { TrackingSchedule };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DueChecksResult {
  considered: number;
  succeeded: number;
  failed: number;
}

// Safety cap so a stuck/flooded scheduler can't spend the entire Claude budget
// in one tick if many prompts are due simultaneously (e.g. after a migration
// or after the server has been down for a while). Anything beyond this rolls
// over to the next tick.
const SCHEDULED_CHECK_LIMIT_PER_TICK = 25;

// ─── Scheduler Tick ───────────────────────────────────────────────────────────

/** Find all tracking prompts whose `nextRunAt` is due and run them. Called by
 *  the in-process cron in `scheduler.server.ts` every 15 minutes. Safe to call
 *  manually too — e.g. from a "Run all due now" admin button.
 *
 *  Filters:
 *  - schedule != MANUAL
 *  - nextRunAt <= now
 *  - isActive
 *  - store.plan != FREE — FREE stores cannot schedule (maxTrackingPrompts is
 *    0 on FREE). Without this filter, a merchant who scheduled prompts on a
 *    paid plan and then downgraded would keep consuming Claude API credits
 *    indefinitely. */
export async function runDueTrackingChecks(): Promise<DueChecksResult> {
  const now = new Date();

  const due = await prisma.trackingPrompt.findMany({
    where: {
      schedule: { not: "MANUAL" },
      nextRunAt: { lte: now },
      isActive: true,
      store: { plan: { not: "FREE" } },
    },
    orderBy: { nextRunAt: "asc" },
    take: SCHEDULED_CHECK_LIMIT_PER_TICK,
  });

  let succeeded = 0;
  let failed = 0;

  for (const prompt of due) {
    // Claim the work BEFORE running: push `nextRunAt` forward immediately so
    // an overlapping tick won't re-pick it up while the check is in flight.
    // We accept the trade-off that a server crash mid-check means losing one
    // cycle for that prompt — for DAILY/WEEKLY that's acceptable.
    //
    // Anchor the next-run computation to the ORIGINAL `nextRunAt` (not to
    // `now`), so a daily prompt scheduled for 11:00 keeps running at 11:00
    // every day instead of drifting forward by the check duration each day.
    const originalAt = prompt.nextRunAt ?? now;
    let nextAt = computeNextRunAt(
      prompt.schedule as TrackingSchedule,
      originalAt
    );
    // Severe catch-up: if the server was offline long enough that even after
    // advancing by one interval the next slot is still in the past, jump to
    // a fresh schedule anchored on `now`. This bounds API spend at one check
    // per prompt per tick instead of cascading dozens of catch-up runs.
    if (nextAt && nextAt < now) {
      nextAt = computeNextRunAt(prompt.schedule as TrackingSchedule, now);
    }
    await prisma.trackingPrompt.update({
      where: { id: prompt.id },
      data: { nextRunAt: nextAt },
    });

    try {
      await runTrackingCheck(prompt.id);
      succeeded++;
    } catch (err) {
      console.error(
        `[tracking-scheduler] check failed for prompt ${prompt.id}:`,
        err
      );
      failed++;
    }
  }

  return { considered: due.length, succeeded, failed };
}

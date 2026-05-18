// Pure types + helpers for the tracking scheduler that are safe to import
// from route files (which have client components). The `.server.ts` companion
// holds the DB + cron-running logic and is server-only.

export type TrackingSchedule = "MANUAL" | "DAILY" | "WEEKLY";

/** Compute when a prompt with the given schedule should next run. Returns null
 *  for MANUAL - manual prompts have no `nextRunAt`. */
export function computeNextRunAt(
  schedule: TrackingSchedule,
  from: Date = new Date()
): Date | null {
  if (schedule === "MANUAL") return null;
  const next = new Date(from);
  if (schedule === "DAILY") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (schedule === "WEEKLY") {
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return next;
}

/**
 * GEO score history for the dashboard sparkline and weekly email delta.
 *
 * Reads the ScoreSnapshot rows that audit-engine writes after each
 * successful full audit (the 5-product wizard starter audit and other
 * small-cap audits never write one, see runFullAudit step 6b). Dates are
 * serialized to ISO strings here so loaders can return the result as-is.
 */
import prisma from "~/db.server";

export interface ScoreTrend {
  /** Last N snapshots in ascending (oldest to newest) order, for charting. */
  snapshots: { score: number; createdAt: string }[];
  /** Latest score minus the previous snapshot's score. Null when there are
   *  fewer than 2 snapshots, so callers can hide the delta honestly instead
   *  of showing a fake "up 0". */
  deltaSincePrevious: number | null;
}

export async function getScoreTrend(
  storeId: string,
  points = 12
): Promise<{
  snapshots: { score: number; createdAt: string }[];
  deltaSincePrevious: number | null;
}> {
  // Fetch newest-first so `take` grabs the most recent N, then reverse into
  // ascending order for the sparkline. Tenant-scoped and bounded.
  const rows = await prisma.scoreSnapshot.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, points),
    select: { score: true, createdAt: true },
  });
  rows.reverse();

  const snapshots = rows.map((r) => ({
    score: r.score,
    createdAt: r.createdAt.toISOString(),
  }));

  const deltaSincePrevious =
    snapshots.length >= 2
      ? snapshots[snapshots.length - 1].score -
        snapshots[snapshots.length - 2].score
      : null;

  return { snapshots, deltaSincePrevious };
}

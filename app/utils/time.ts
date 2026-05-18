// Shared time-formatting helpers. Replaces four near-identical
// implementations that previously lived in each route file, and fixes
// the "-1m ago" bug that one of them had (Math.floor of a negative diff
// rounded to -1 instead of clamping at 0).
//
// Safe to import from anywhere: pure JS, no Prisma, no server-only refs.

/** Format a timestamp as a relative "time ago" string. Handles two edge
 *  cases the old implementations missed:
 *    - Very recent timestamps (< 60s): returns "just now" so we never
 *      render "0m ago" or "-1m ago" when server / client clocks drift.
 *    - Future timestamps (server clock ahead of browser): still returns
 *      "just now" instead of a negative number.
 *
 *  Accepts either a Date, an ISO string, or `null` (renders "Never").
 *  Calling with a malformed string yields "Never" as well, never throws. */
export function timeAgo(input: Date | string | null | undefined): string {
  if (input === null || input === undefined) return "Never";
  const then =
    input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (Number.isNaN(then)) return "Never";

  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now";

  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Format a future timestamp as a relative "in N units" string. Inverse of
 *  `timeAgo`. Returns "any moment now" if the timestamp is already in the
 *  past (e.g. a scheduled tracking check that's overdue). */
export function relativeFuture(input: Date | string | null | undefined): string {
  if (input === null || input === undefined) return "-";
  const then =
    input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (Number.isNaN(then)) return "-";

  const diffMs = then - Date.now();
  if (diffMs <= 0) return "any moment now";

  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;

  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;

  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

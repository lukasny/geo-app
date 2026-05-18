import cron from "node-cron";
import { runDueTrackingChecks } from "./tracking-scheduler.server";
import { runWeeklyInsightDigest } from "./insight-email.server";

// ─── HMR-safe singleton ───────────────────────────────────────────────────────

// In Remix dev, server modules can re-evaluate on file changes. A plain
// module-level boolean would reset, leaking a fresh cron task each time. Store
// the state on globalThis so it survives module reloads.

interface SchedulerState {
  registered: boolean;
  /** True while the tracking-check tick is mid-run, prevents overlap. */
  isRunning: boolean;
  /** Separate guard for the weekly digest tick - it runs much less often
   *  than tracking, but conceivably could overlap on slow days. */
  isDigestRunning: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __geoRiseScheduler__: SchedulerState | undefined;
}

const state: SchedulerState =
  globalThis.__geoRiseScheduler__ ??
  (globalThis.__geoRiseScheduler__ = {
    registered: false,
    isRunning: false,
    isDigestRunning: false,
  });

// ─── Cron registration ────────────────────────────────────────────────────────

// Optional kill switch - if `SCHEDULER_ENABLED=false`, the cron tick is never
// registered. Useful for one-off Node scripts that should not start background
// timers when they import services from this codebase.
const ENABLED =
  process.env.SCHEDULER_ENABLED !== "false" && process.env.NODE_ENV !== "test";

if (ENABLED && !state.registered) {
  state.registered = true;

  // Every 15 minutes. Lets us honor "daily" and "weekly" schedules with at
  // most ~15 minutes of latency, while keeping API spend low even if many
  // prompts come due near the same hour.
  cron.schedule("*/15 * * * *", async () => {
    if (state.isRunning) {
      console.log(
        "[scheduler] previous tracking tick still running, skipping this one"
      );
      return;
    }
    state.isRunning = true;
    const startedAt = Date.now();
    try {
      const result = await runDueTrackingChecks();
      if (result.considered > 0) {
        console.log(
          `[scheduler] tracking tick: considered=${result.considered} succeeded=${result.succeeded} failed=${result.failed} in ${Date.now() - startedAt}ms`
        );
      }
    } catch (err) {
      console.error("[scheduler] tracking tick failed:", err);
    } finally {
      state.isRunning = false;
    }
  });

  console.log(
    "[scheduler] registered tracking-check cron (every 15 minutes)"
  );

  // Daily insight-digest tick at 09:00 UTC. The runner finds stores whose
  // last digest was >6.5 days ago, so running this daily means each store's
  // cycle slides between 6.5–7.5 days. Daily-ish cadence beats weekly-strict
  // for missed-tick recovery.
  cron.schedule("0 9 * * *", async () => {
    if (state.isDigestRunning) {
      console.log(
        "[scheduler] previous insight-digest tick still running, skipping this one"
      );
      return;
    }
    state.isDigestRunning = true;
    const startedAt = Date.now();
    try {
      const result = await runWeeklyInsightDigest();
      if (result.considered > 0) {
        console.log(
          `[scheduler] insight-digest tick: considered=${result.considered} sent=${result.sent} skipped=${result.skippedNotEligible} failed=${result.failed} in ${Date.now() - startedAt}ms`
        );
      }
    } catch (err) {
      console.error("[scheduler] insight-digest tick failed:", err);
    } finally {
      state.isDigestRunning = false;
    }
  });

  console.log(
    "[scheduler] registered weekly insight-digest cron (daily @ 09:00 UTC)"
  );
}

export {}; // make this a module

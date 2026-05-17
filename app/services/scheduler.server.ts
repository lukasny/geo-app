import cron from "node-cron";
import { runDueTrackingChecks } from "./tracking-scheduler.server";

// ─── HMR-safe singleton ───────────────────────────────────────────────────────

// In Remix dev, server modules can re-evaluate on file changes. A plain
// module-level boolean would reset, leaking a fresh cron task each time. Store
// the state on globalThis so it survives module reloads.

interface SchedulerState {
  registered: boolean;
  isRunning: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __geoRiseScheduler__: SchedulerState | undefined;
}

const state: SchedulerState =
  globalThis.__geoRiseScheduler__ ??
  (globalThis.__geoRiseScheduler__ = { registered: false, isRunning: false });

// ─── Cron registration ────────────────────────────────────────────────────────

// Optional kill switch — if `SCHEDULER_ENABLED=false`, the cron tick is never
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
}

export {}; // make this a module

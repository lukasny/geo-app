import cron from "node-cron";
import { runDueTrackingChecks } from "./tracking-scheduler.server";
import { runWeeklyInsightDigest } from "./insight-email.server";
import { runOpsDigest } from "./ops-digest.server";
import { captureError } from "./error-capture.server";
import { sendOpsMail } from "./ops-alerts.server";
import {
  aiDailyBudget,
  aiKillSwitchOn,
  getGlobalCallsToday,
} from "./ai-usage.server";

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
  /** Guard for the founder ops-digest tick (06:00 UTC). */
  isOpsDigestRunning: boolean;
  /** UTC day ("YYYY-MM-DD") the AI-budget alert last fired. A paused
   *  scheduler should email the founder once per day, not once per
   *  15-minute tick; keeping the guard in the HMR-safe state also stops
   *  dev reloads from re-alerting. */
  budgetAlertDay: string | null;
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
    isOpsDigestRunning: false,
    budgetAlertDay: null,
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
    // Ops guardrails (day-one ops readiness). The kill switch pauses ALL AI
    // work app-wide; the global daily call budget pauses SCHEDULED checks
    // only - merchant-interactive AI calls continue, they are plan-capped.
    // Neither gate applies to the digest ticks below: those send email, not
    // AI calls.
    if (aiKillSwitchOn()) {
      console.log(
        "[scheduler] AI kill switch on (AI_FEATURES_DISABLED=true), skipping tracking tick"
      );
      return;
    }
    const budget = aiDailyBudget();
    if (budget > 0) {
      const callsToday = await getGlobalCallsToday();
      if (callsToday >= budget) {
        const today = new Date().toISOString().slice(0, 10);
        if (state.budgetAlertDay !== today) {
          state.budgetAlertDay = today;
          // Fire-and-forget: sendOpsMail never throws, and a slow email
          // must not hold the tick open.
          void sendOpsMail(
            "GEO Rise: AI daily call budget reached",
            `Today's global AI call count (${callsToday}) reached AI_DAILY_CALL_BUDGET (${budget}). ` +
              "Scheduled tracking checks are paused until tomorrow (UTC). " +
              "Merchant-triggered AI features keep working; they are capped per plan."
          );
        }
        console.log(
          `[scheduler] AI daily call budget reached (${callsToday}/${budget}), skipping tracking tick`
        );
        return;
      }
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
      captureError("cron:tracking", err);
    } finally {
      state.isRunning = false;
    }
  });

  console.log(
    "[scheduler] registered tracking-check cron (every 15 minutes)"
  );

  // Daily insight-digest tick at 09:00 UTC. The runner finds stores whose
  // last digest was >6.5 days ago, so running this daily means each store's
  // cycle slides between 6.5-7.5 days. Daily-ish cadence beats weekly-strict
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
      captureError("cron:insight-digest", err);
    } finally {
      state.isDigestRunning = false;
    }
  });

  console.log(
    "[scheduler] registered weekly insight-digest cron (daily @ 09:00 UTC)"
  );

  // Founder ops digest at 06:00 UTC. Cadence comes from OPS_DIGEST: "daily",
  // "weekly" (the default, sent Mondays; unrecognized values fall back to
  // weekly), or "off". Requires OPS_ALERT_EMAIL - without it the tick is a
  // silent no-op, matching the ops rule that unset env vars leave the app
  // behaving exactly as before. Email work only, so the AI kill switch and
  // call budget above deliberately do not gate this tick.
  cron.schedule("0 6 * * *", async () => {
    const cadence = process.env.OPS_DIGEST ?? "weekly";
    if (!process.env.OPS_ALERT_EMAIL || cadence === "off") return;
    if (cadence !== "daily" && new Date().getUTCDay() !== 1) return;
    if (state.isOpsDigestRunning) {
      console.log(
        "[scheduler] previous ops-digest tick still running, skipping this one"
      );
      return;
    }
    state.isOpsDigestRunning = true;
    const startedAt = Date.now();
    try {
      const sent = await runOpsDigest(cadence === "daily" ? "daily" : "weekly");
      console.log(
        `[scheduler] ops-digest tick: sent=${sent} in ${Date.now() - startedAt}ms`
      );
    } catch (err) {
      console.error("[scheduler] ops-digest tick failed:", err);
      captureError("cron:ops-digest", err);
    } finally {
      state.isOpsDigestRunning = false;
    }
  });

  console.log("[scheduler] registered ops-digest cron (daily @ 06:00 UTC)");
}

export {}; // make this a module

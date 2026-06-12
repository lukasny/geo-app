// ─── Per-store llms.txt regeneration queue ────────────────────────────────────
// Coalesces bursts of regeneration triggers into at most one running and one
// pending regeneration per store. The trigger storm is real: every product
// mutation fires a products/update webhook back at us, so a 50-product bulk
// edit would otherwise launch 50 parallel full-catalog regenerations.
// Latest-wins is correct because every runner regenerates from Shopify's
// CURRENT state: one trailing run after the last trigger covers everything.
// In-memory state is safe here: the app runs as a single long-lived Node
// process on Render (node-cron in scheduler.server.ts relies on the same).

type Runner = () => Promise<void>;

interface QueueState {
  running: boolean;
  pending: Runner | null;
}

const queues = new Map<string, QueueState>();

/** Run (or coalesce) an llms.txt regeneration for a store. Never throws;
 *  never blocks the caller. */
export function requestLlmsRegeneration(storeId: string, run: Runner): void {
  const state = queues.get(storeId) ?? { running: false, pending: null };
  queues.set(storeId, state);

  if (state.running) {
    state.pending = run;
    return;
  }

  state.running = true;
  void (async () => {
    let next: Runner | null = run;
    while (next) {
      try {
        await next();
      } catch (err) {
        console.error(
          `[GEO Rise] llms.txt regeneration failed for store ${storeId}:`,
          err
        );
      }
      next = state.pending;
      state.pending = null;
    }
    state.running = false;
  })();
}

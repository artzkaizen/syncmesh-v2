import type { QueryCall } from "./api.js";

/**
 * A watchdog (book ch. 20): detection is a subscription over **state**, enforcement is whatever
 * `react` writes — typically an authority correction with a reason. Watching state rather than
 * procedures is the point: a violation can be born with no call to blame (two valid writes,
 * merged), and a check attached to a procedure would miss every other route to the same rows.
 *
 * Reactions run one at a time, latest rows win: a burst of folds during a slow reaction becomes
 * one more run, never a queue. A converging reaction stops matching once it has corrected, so
 * re-running corrects nothing — that is the fixed point, not a suppressed loop.
 *
 * @example
 * const off = watch(api.products.list({}), async (products) => {
 *   for (const p of products) if (p.priceCents < floor) await fixPrice(p);
 * });
 */
export function watch<T>(
  call: QueryCall<T>,
  react: (rows: readonly T[]) => Promise<void> | void,
): () => void {
  const live = call.live();
  let running = false;
  let queued: readonly T[] | undefined;

  const run = (rows: readonly T[]): void => {
    if (running) {
      queued = rows;
      return;
    }
    running = true;
    void Promise.resolve(react(rows))
      .catch((cause: unknown) => {
        // a thrower never decides the data; the failure is evidence for the operator
        console.warn(`watch(${call.path}) reaction failed:`, cause);
      })
      .finally(() => {
        running = false;
        if (queued === undefined) return;
        const next = queued;
        queued = undefined;
        run(next);
      });
  };

  const offRows = live.subscribe(run);
  void live.ready.then(run, () => undefined); // the first complete result set, once stable
  return () => {
    offRows();
    live.release();
  };
}

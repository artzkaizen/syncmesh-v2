import type { Transport } from "@syncmesh/transport";

/**
 * How many flushes run at once. Tie it to whatever the storage underneath actually runs out of —
 * a file-descriptor ceiling on a server, ~6 concurrent connections per origin on HTTP/1.1, ~100
 * streams on HTTP/2 — rather than to how many transports there happen to be. A mesh with one
 * relay never reaches it; a mesh with a transport per tenant does, and unbounded is how a flush
 * that was supposed to make a shutdown safe becomes the thing that fails it.
 */
const FLUSH_CONCURRENCY = 20;

/**
 * Runs every job with at most `cap` in flight and **settles regardless** — a job that rejects is
 * one flush that failed, not a reason to abandon the flushes still queued behind it. That is what
 * makes `mesh.flush()` safe to `await` on a path that must not throw, which is every shutdown.
 */
export async function settleAll(
  jobs: readonly (() => Promise<void>)[],
  cap: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++];
      // the failure is already reported where it happened (`engine.onError` for a save, the
      // bridge's own hub for a send); swallowing it here loses nothing and drops nobody's turn
      if (job !== undefined) await job().catch(() => undefined);
    }
  };
  const width = Math.max(1, Math.min(cap, jobs.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
}

export interface FlushDeps {
  readonly transports: () => readonly Transport[];
  readonly concurrency?: number;
}

/**
 * `mesh.flush()`: every transport's queue of taken-in-but-not-yet-saved work has run out.
 *
 * A frame that arrived is folded on a queue, and the save at the end of that queue is what a
 * process exiting loses — so a shutdown, a test that asserts on rows, and a handler that must
 * know its writes are down all want the same wait. It never rejects and never stops early: a
 * store that failed one commit has already reported it on `engine.onError`, and the log still
 * holds the truth, so the honest ending is "the queues are empty", not a throw from the middle.
 *
 * Nothing here is a barrier for writes made *after* it starts. Flush what you have; a mesh that
 * is still being written to has no quiet moment to promise.
 */
export function createFlush(deps: FlushDeps): () => Promise<void> {
  const cap = deps.concurrency ?? FLUSH_CONCURRENCY;
  return () =>
    settleAll(
      // bound to their transport, never lifted off it: a class-based transport's `flush` reads
      // `this`, and a detached method is the shape that works until someone writes one
      deps
        .transports()
        .filter((transport) => transport.flush !== undefined)
        .map((transport) => () => transport.flush?.() ?? Promise.resolve()),
      cap,
    );
}

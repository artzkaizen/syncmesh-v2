import type { Unsubscribe } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";

import { MeshStopped } from "./errors.js";

/** Whether a transport set has opened and whether it has stopped, as one value both ends read. */
export interface Lifecycle {
  readonly begun: () => boolean;
  readonly stopped: () => boolean;
  /** `true` between `start()` and `stop()`. */
  readonly running: () => boolean;
  /**
   * `wait`, deferred to `start()`; resolves without running it when `stop()` comes first, since a
   * set that never opened has nothing to wait for.
   */
  readonly whenOpen: (wait: () => Promise<void>) => () => Promise<void>;
  /** Runs `begin` once and keeps what it hands back to let go of; `MeshStopped` once stopped. */
  readonly start: () => Result<void, MeshStopped>;
  /** Marks the set stopped and lets go of what `begin` subscribed; answers whether it ever began. */
  readonly stop: () => boolean;
}

/** The once-only gate between a transport set that exists and one whose links are open (E24). */
export function createLifecycle(begin: () => readonly Unsubscribe[]): Lifecycle {
  let begun = false;
  let stopped = false;
  const opening = Promise.withResolvers<void>();
  const held: Unsubscribe[] = [];
  return {
    begun: () => begun,
    stopped: () => stopped,
    running: () => begun && !stopped,
    whenOpen: (wait) => async () => {
      await opening.promise;
      if (begun) await wait();
    },
    start: () => {
      if (stopped)
        return Result.err(
          new MeshStopped({ message: "the mesh has stopped; a stopped mesh does not start again" }),
        );
      if (!begun) {
        begun = true;
        held.push(...begin());
        opening.resolve();
      }
      return Result.ok(undefined);
    },
    stop: () => {
      stopped = true;
      opening.resolve();
      for (const off of held.splice(0)) off();
      return begun;
    },
  };
}

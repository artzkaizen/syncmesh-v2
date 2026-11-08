import type { EventId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";

import { eventTarget } from "./delivered.js";
import { NoSuchCapability } from "./errors.js";

export interface SyncedOptions {
  /** The event a durable hop must hold; a local id panics, as it does for `delivered`. */
  readonly event: EventId;
}

/**
 * `mesh.synced`: settles once a hop whose log outlives it holds the event (D42) — *may I close
 * the laptop?* Any running transport declaring `durable` can answer, and the first to does.
 *
 * Not an acknowledgement: the relay holds no device key, so nothing here touches
 * `engine.acknowledge`, and no reader of `mesh.peers` or the sync column ever sees a relay as a
 * peer. A mesh with no such transport answers {@link NoSuchCapability} at once; one whose only
 * relay keeps its log in memory waits, because that room's acks are not durability.
 */
export function createSynced(
  transports: () => readonly Transport[],
): (options: SyncedOptions) => Promise<Result<void, NoSuchCapability>> {
  return async ({ event }) => {
    // a local id panics here, as it does for `delivered`: it never travels, so nothing could hold it
    eventTarget(event);
    const answers = transports().flatMap((t) =>
      t.durable === undefined ? [] : [t.durable(event)],
    );
    if (answers.length === 0)
      return Result.err(
        new NoSuchCapability({
          capability: "durable",
          message: "no transport here keeps a log that outlives it",
        }),
      );
    await Promise.race(answers);
    return Result.ok(undefined);
  };
}

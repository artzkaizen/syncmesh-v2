import type { EventId } from "@syncmesh/kernel";
import type { DurabilityLost, Transport } from "@syncmesh/transport";

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
 *
 * {@link DurabilityLost} once every hop it waited on replaced its log first (D42, decided
 * 2026-11-08): what the old log held is not held by the new one. A hop that neither acks nor
 * replaces its log keeps the answer open, so one hop lost and another silent means no answer at
 * all. There is no timeout; a caller that wants one races its own.
 */
export function createSynced(
  transports: () => readonly Transport[],
): (options: SyncedOptions) => Promise<Result<void, NoSuchCapability | DurabilityLost>> {
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
    return firstHeld(answers);
  };
}

/** The first hop to hold the event, or the last loss once every hop has lost it. */
const firstHeld = (
  answers: readonly Promise<Result<void, DurabilityLost>>[],
): Promise<Result<void, DurabilityLost>> =>
  new Promise((resolve) => {
    let lost = 0;
    for (const answer of answers)
      void answer.then((held) => {
        if (held.isOk()) return resolve(held);
        lost += 1;
        if (lost === answers.length) resolve(held);
      });
  });

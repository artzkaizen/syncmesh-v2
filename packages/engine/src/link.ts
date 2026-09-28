import type { SyncEvent } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { Engine } from "./engine.js";
import type { StoreFailure } from "./store.js";

import { createHub, type Unsubscribe } from "./listeners.js";
import {
  generateSyncMessage,
  initialSyncState,
  receiveSyncMessage,
  type SyncDoc,
  type SyncState,
} from "./sync.js";

export interface LinkOptions {
  /** Stamps the acks a cursor exchange records; defaults to the wall clock. */
  readonly now?: () => Temporal.Instant;
}

/**
 * `catchUp` was asked of a link that is not carrying anything, so nothing was exchanged.
 *
 * Its own error rather than `Result.ok(undefined)`, which is what this used to answer. A success
 * that did nothing is indistinguishable from a success that did everything, and both sides of
 * that ambiguity read as "these two engines now agree" — so a test asserting convergence over a
 * link somebody forgot to bring back up passes, and a caller that drives `catchUp` in a loop
 * spins forever against a link that will never speak.
 */
export class LinkOffline extends TaggedError("LinkOffline")<{ message: string }> {}

export interface Link {
  /** A live-forwarded event could not be stored on the receiving side. */
  readonly onError: (listener: (error: StoreFailure) => void) => Unsubscribe;
  readonly setOnline: (online: boolean) => void;
  readonly online: () => boolean;
  /**
   * Runs the sync protocol both ways until neither side has anything to send, or
   * {@link LinkOffline} when the link is down and there was never a chance of it.
   */
  readonly catchUp: () => Promise<Result<void, StoreFailure | LinkOffline>>;
  /** Waits for live forwarding already in progress. */
  readonly flush: () => Promise<void>;
  readonly close: () => void;
}

/** Two engines in one process: live forwarding while online, cursor-driven catch-up on demand. */
export function createLink(a: Engine, b: Engine, options: LinkOptions = {}): Link {
  const { now = () => Temporal.Now.instant() } = options;
  let online = true;
  let queue: Promise<unknown> = Promise.resolve();
  let stateA = initialSyncState;
  let stateB = initialSyncState;
  const errors = createHub<StoreFailure>();

  const forward = (to: Engine) => (event: SyncEvent) => {
    if (!online) return;
    queue = queue.then(async () => {
      const r = await to.receive({ event });
      if (r.isErr()) errors.emit(r.error);
    });
  };
  const subscriptions: Unsubscribe[] = [a.onOutbound(forward(b)), b.onOutbound(forward(a))];

  const docOf = (engine: Engine) =>
    Result.gen(async function* () {
      const cursors = yield* Result.await(engine.cursors());
      const all = yield* Result.await(engine.eventsSince(new Map()));
      const doc: SyncDoc = {
        cursors,
        ahead: engine.ahead(),
        eventsSince: (theirs) =>
          all.filter(({ event: e }) => (theirs.get(e.peerId) ?? 0) < e.seqNum),
      };
      return Result.ok(doc);
    });

  const step = (from: Engine, to: Engine, fromState: SyncState, toState: SyncState) =>
    Result.gen(async function* () {
      const doc = yield* Result.await(docOf(from));
      const [nextFrom, message] = generateSyncMessage(fromState, doc);
      // Silence is an acknowledgement. `to` is waiting on a reply to what it sent last round —
      // which `from` has already received, since that is what gave it the cursors it just found
      // nothing to say about. Leaving `to.inFlight` set here wedges that direction permanently:
      // `generateSyncMessage` refuses to speak while a message is outstanding, so the peer never
      // sends again and the device quietly stops receiving, with nothing anywhere reporting it.
      if (message === undefined)
        return Result.ok({ from: nextFrom, to: { ...toState, inFlight: false }, sent: false });
      const [nextTo, events] = receiveSyncMessage(toState, message);
      to.acknowledge(from.peerId, message.cursors, now());
      yield* Result.await(to.receiveBatch(events));
      return Result.ok({ from: nextFrom, to: nextTo, sent: true });
    });

  const catchUp: Link["catchUp"] = () =>
    Result.gen(async function* () {
      await queue;
      if (!online)
        return Result.err(
          new LinkOffline({ message: "the link is offline: nothing was exchanged" }),
        );
      for (;;) {
        const ab = yield* Result.await(step(a, b, stateA, stateB));
        stateA = ab.from;
        stateB = ab.to;
        const ba = yield* Result.await(step(b, a, stateB, stateA));
        stateB = ba.from;
        stateA = ba.to;
        if (!ab.sent && !ba.sent) return Result.ok(undefined);
      }
    });

  return {
    onError: errors.subscribe,
    setOnline: (next) => void (online = next),
    online: () => online,
    catchUp,
    flush: async () => void (await queue),
    close: () => {
      for (const off of subscriptions) off();
      online = false;
    },
  };
}

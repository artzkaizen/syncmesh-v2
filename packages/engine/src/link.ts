import type { SyncEvent } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
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

export interface Link {
  /** A live-forwarded event could not be stored on the receiving side. */
  readonly onError: (listener: (error: StoreFailure) => void) => Unsubscribe;
  readonly setOnline: (online: boolean) => void;
  readonly online: () => boolean;
  /** Runs the sync protocol both ways until neither side has anything to send. */
  readonly catchUp: () => Promise<Result<void, StoreFailure>>;
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
      const r = await to.receive(event);
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
        eventsSince: (theirs) => all.filter((e) => (theirs.get(e.peerId) ?? 0) < e.seqNum),
      };
      return Result.ok(doc);
    });

  const step = (from: Engine, to: Engine, fromState: SyncState, toState: SyncState) =>
    Result.gen(async function* () {
      const doc = yield* Result.await(docOf(from));
      const [nextFrom, message] = generateSyncMessage(fromState, doc);
      if (message === undefined) return Result.ok({ from: nextFrom, to: toState, sent: false });
      const [nextTo, events] = receiveSyncMessage(toState, message);
      to.acknowledge(from.peerId, message.cursors, now());
      yield* Result.await(to.receiveBatch(events));
      return Result.ok({ from: nextFrom, to: nextTo, sent: true });
    });

  const catchUp: Link["catchUp"] = () =>
    Result.gen(async function* () {
      await queue;
      if (!online) return Result.ok(undefined);
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

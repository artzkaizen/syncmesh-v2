import type { Hlc, PeerId } from "@syncmesh/kernel";

import { compareHlc } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { EventId, SeqNum, SyncEvent } from "./event.js";

export class StoreFailure extends TaggedError("StoreFailure")<{
  message: string;
  cause?: unknown;
}> {}

export type SeqScope = "synced" | "local";

/** Durable, append-only home of events; the outbox is the log itself. Async per D05. See RFC-0004. */
export interface EventStore {
  /** Idempotent by event id. */
  readonly append: (event: SyncEvent) => Promise<Result<void, StoreFailure>>;
  readonly has: (id: EventId) => Promise<Result<boolean, StoreFailure>>;
  readonly all: () => Promise<Result<readonly SyncEvent[], StoreFailure>>;
  /** Highest sequence number this peer has appended in the scope, if any. */
  readonly lastSeq: (
    peer: PeerId,
    scope: SeqScope,
  ) => Promise<Result<SeqNum | undefined, StoreFailure>>;
  readonly maxHlc: () => Promise<Result<Hlc | undefined, StoreFailure>>;
}

export function createMemoryEventStore(): EventStore {
  const events = new Map<EventId, SyncEvent>();
  const ok = <T>(value: T) => Promise.resolve(Result.ok(value));

  return {
    append: (event) => {
      if (!events.has(event.id)) events.set(event.id, event);
      return ok(undefined);
    },
    has: (id) => ok(events.has(id)),
    all: () => ok([...events.values()]),
    lastSeq: (peer, scope) => {
      let last: SeqNum | undefined;
      for (const event of events.values()) {
        const inScope = (event.local === true) === (scope === "local");
        if (event.peerId === peer && inScope && (last === undefined || event.seqNum > last))
          last = event.seqNum;
      }
      return ok(last);
    },
    maxHlc: () => {
      let max: Hlc | undefined;
      for (const event of events.values()) {
        if (max === undefined || compareHlc(event.hlc, max) > 0) max = event.hlc;
      }
      return ok(max);
    },
  };
}

import type { Hlc, PeerId } from "@syncmesh/kernel";
import type { EventId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { SignedEvent } from "@syncmesh/wire";

import { compareHlc } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { Coverage, Cursors } from "./sync.js";

export class StoreFailure extends TaggedError("StoreFailure")<{
  message: string;
  cause?: unknown;
}> {}

export type SeqScope = "synced" | "local";

/**
 * What the log keeps for one event: the event, and the exact core bytes the author signed
 * together with that signature, where this device ever held them.
 *
 * The pair is {@link SignedEvent} because it belongs to the wire, not to any one store: what
 * produces it is `decodeAndVerify` for an event that arrived under its own signature, `signEvent`
 * for one this device signs, and `receiveChunk` for a run verified as a whole — which yields the
 * core with no signature beside it, because a chunk carries one certificate instead of one
 * signature each. A forwarder ships the held bytes with `relayEnvelope` rather than re-encoding
 * the decoded event. Own writes carry neither until they leave through a bridge, which signs and
 * encodes in one step; relayed events must keep the original — no other peer can re-sign them.
 */
export type StoredEvent = SignedEvent;

/** Durable, append-only home of events; the outbox is the log itself. Async per D05. See RFC-0004. */
export interface EventStore {
  /** Idempotent by event id. */
  readonly append: (entry: StoredEvent) => Promise<Result<void, StoreFailure>>;
  /** All or nothing where the backend can promise it; idempotent by event id. */
  readonly appendBatch: (entries: readonly StoredEvent[]) => Promise<Result<void, StoreFailure>>;
  readonly has: (id: EventId) => Promise<Result<boolean, StoreFailure>>;
  readonly all: () => Promise<Result<readonly StoredEvent[], StoreFailure>>;
  /** Events in the scope above the given per-author cursors, ordered by author then sequence. Synced by default. */
  readonly allSince: (
    cursors: Cursors,
    scope?: SeqScope,
  ) => Promise<Result<readonly StoredEvent[], StoreFailure>>;
  /** Highest sequence number this peer has appended in the scope, if any. */
  readonly lastSeq: (
    peer: PeerId,
    scope: SeqScope,
  ) => Promise<Result<SeqNum | undefined, StoreFailure>>;
  readonly maxHlc: () => Promise<Result<Hlc | undefined, StoreFailure>>;
  /** Deletes events in the scope at or below `floor` and stamped before `olderThan`; returns how many, and remembers the floor for `compactedBelow`. */
  readonly compactBelow: (
    floor: Cursors,
    scope: SeqScope,
    olderThan: Temporal.Instant,
  ) => Promise<Result<number, StoreFailure>>;
  /** Per author and scope, the highest sequence number compaction has removed; empty until the first compaction. */
  readonly compactedBelow: () => Promise<Result<Coverage, StoreFailure>>;
}

/** What compaction removed for one author in one scope: the highest sequence and stamp gone. */
interface Floor {
  readonly seq: SeqNum;
  readonly hlc: Hlc;
}

const inScope = (event: SyncEvent, scope: SeqScope) =>
  (event.local === true) === (scope === "local");

export function createMemoryEventStore(): EventStore {
  const events = new Map<EventId, StoredEvent>();
  const floors = { synced: new Map<PeerId, Floor>(), local: new Map<PeerId, Floor>() };
  const ok = <T>(value: T) => Promise.resolve(Result.ok(value));

  return {
    append: (entry) => {
      if (!events.has(entry.event.id)) events.set(entry.event.id, entry);
      return ok(undefined);
    },
    appendBatch: (batch) => {
      for (const entry of batch) if (!events.has(entry.event.id)) events.set(entry.event.id, entry);
      return ok(undefined);
    },
    has: (id) => ok(events.has(id)),
    all: () => ok([...events.values()]),
    allSince: (cursors, scope = "synced") =>
      ok(
        [...events.values()]
          .filter(({ event: e }) => inScope(e, scope) && (cursors.get(e.peerId) ?? 0) < e.seqNum)
          .sort(({ event: x }, { event: y }) =>
            x.peerId < y.peerId ? -1 : x.peerId > y.peerId ? 1 : x.seqNum - y.seqNum,
          ),
      ),
    lastSeq: (peer, scope) => {
      let last = floors[scope].get(peer)?.seq;
      for (const { event } of events.values()) {
        if (
          event.peerId === peer &&
          inScope(event, scope) &&
          (last === undefined || event.seqNum > last)
        )
          last = event.seqNum;
      }
      return ok(last);
    },
    compactBelow: (floor, scope, olderThan) => {
      let removed = 0;
      const recorded = floors[scope];
      for (const [id, { event }] of events) {
        const below = event.seqNum <= (floor.get(event.peerId) ?? 0);
        const old = Temporal.Instant.compare(event.hlc[0], olderThan) < 0;
        if (!inScope(event, scope) || !below || !old) continue;
        events.delete(id);
        removed += 1;
        const known = recorded.get(event.peerId);
        recorded.set(event.peerId, {
          seq: known === undefined || known.seq < event.seqNum ? event.seqNum : known.seq,
          hlc: known === undefined || compareHlc(known.hlc, event.hlc) < 0 ? event.hlc : known.hlc,
        });
      }
      return ok(removed);
    },
    compactedBelow: () =>
      ok({
        synced: new Map([...floors.synced].map(([peer, f]) => [peer, f.seq])),
        local: new Map([...floors.local].map(([peer, f]) => [peer, f.seq])),
      }),
    maxHlc: () => {
      let max: Hlc | undefined;
      const consider = (hlc: Hlc) => {
        if (max === undefined || compareHlc(hlc, max) > 0) max = hlc;
      };
      for (const { event } of events.values()) consider(event.hlc);
      for (const f of floors.synced.values()) consider(f.hlc);
      for (const f of floors.local.values()) consider(f.hlc);
      return ok(max);
    },
  };
}

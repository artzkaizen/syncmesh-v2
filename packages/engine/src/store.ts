import type { Hlc, PeerId } from "@syncmesh/kernel";
import type { EventId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { SignedEvent } from "@syncmesh/wire";

import { compareHlc } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { EventHeader, RecentEvents } from "./recent.js";
import type { Coverage, Cursors } from "./sync.js";

import { isStranded } from "./stranded.js";

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
  /**
   * The log's tail by stamp, newest first, as headers and never as entries — both scopes, so a
   * local write shows up where `allSince` can never carry one.
   *
   * Optional because it is a read the backing store either has an index for or does not. A
   * database answers it over the stamp index without touching a core; a store whose events are
   * already objects in memory has nothing cheaper to offer than the walk `recentHeaders` does on
   * its behalf, and declaring nothing is how it says so.
   */
  readonly recent?: (
    options: RecentEvents,
  ) => Promise<Result<readonly EventHeader[], StoreFailure>>;
  /**
   * Entries with no signature beside them whose author is not `mine` — the writes this device can
   * never send, because nobody here can sign for the key that made them ({@link StrandedWrites}).
   *
   * Required, unlike `recent`, and that is the point. `openEngine` asks it at every boot, which
   * is the one moment a device that rotated its key over a kept log can still be told so, and a
   * store allowed to decline would put the silence back exactly where it was. It is also the
   * question a log is best placed to answer cheaply: a database asks it as a predicate over a
   * column it already has, and hands back the empty set every healthy log holds.
   *
   * Boot must not read the whole log to get this. A store with no index for it should still
   * answer from what it holds rather than making the caller walk — `createMemoryEventStore` walks
   * its own map, which is the cheapest form the question has there.
   */
  readonly stranded: (mine: PeerId) => Promise<Result<readonly StoredEvent[], StoreFailure>>;
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
  /**
   * Deletes these events and remembers nothing of them — what a purge does when this device may
   * no longer read them (D45). Unlike compaction it records no floor: an evicted event is one this
   * device does not hold, so a later delivery of it is stored and folded again. Never asked for
   * this device's own writes, so `lastSeq` for its own author does not move. Answers how many went.
   */
  readonly evict: (ids: readonly EventId[]) => Promise<Result<number, StoreFailure>>;
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
  /**
   * The highest sequence ever appended, per scope and author, so `lastSeq` — asked on every
   * write — answers without walking the log. Never lowered: the only removal is compaction, and
   * it records what it removed as a floor at least this high.
   */
  const heads = { synced: new Map<PeerId, SeqNum>(), local: new Map<PeerId, SeqNum>() };
  const ok = <T>(value: T) => Promise.resolve(Result.ok(value));
  const add = (entry: StoredEvent) => {
    const { event } = entry;
    if (events.has(event.id)) return;
    events.set(event.id, entry);
    const head = heads[event.local === true ? "local" : "synced"];
    const known = head.get(event.peerId);
    if (known === undefined || event.seqNum > known) head.set(event.peerId, event.seqNum);
  };

  return {
    append: (entry) => {
      add(entry);
      return ok(undefined);
    },
    appendBatch: (batch) => {
      for (const entry of batch) add(entry);
      return ok(undefined);
    },
    has: (id) => ok(events.has(id)),
    all: () => ok([...events.values()]),
    stranded: (mine) => ok([...events.values()].filter((entry) => isStranded(entry, mine))),
    allSince: (cursors, scope = "synced") =>
      ok(
        [...events.values()]
          .filter(({ event: e }) => inScope(e, scope) && (cursors.get(e.peerId) ?? 0) < e.seqNum)
          .sort(({ event: x }, { event: y }) =>
            x.peerId < y.peerId ? -1 : x.peerId > y.peerId ? 1 : x.seqNum - y.seqNum,
          ),
      ),
    lastSeq: (peer, scope) => {
      const floor = floors[scope].get(peer)?.seq;
      const head = heads[scope].get(peer);
      return ok(floor === undefined || (head !== undefined && head > floor) ? head : floor);
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
    evict: (ids) => ok(ids.filter((id) => events.delete(id)).length),
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

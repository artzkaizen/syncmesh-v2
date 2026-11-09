import type { Hlc, PeerId } from "@syncmesh/kernel";
import type { EventId, SeqNum, SyncEvent } from "@syncmesh/kernel";
import type { SignedEvent } from "@syncmesh/wire";

import { compareHlc } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { EngineError } from "./errors.js";
import type { SeqRun } from "./floor-holes.js";
import type { EventHeader, RecentEvents } from "./recent.js";
import type { Coverage, Cursors } from "./sync.js";

import { higherFloor } from "./coverage.js";
import { createFloorHoles, unheldRuns } from "./floor-holes.js";
import { isStranded } from "./stranded.js";

export class StoreFailure extends TaggedError("StoreFailure")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * One run of one author's events, in one scope, that the log held and a read found gone (D39):
 * every sequence from `from` to `to`, both included. A `local` run is of this device's
 * local-only events, which never travel: no peer can give it back.
 */
export type TornRun = SeqRun;

/**
 * The cause of a {@link StoreFailure} a read of the log refused because events it held are gone —
 * a page the disk lost (D39). The runs are what a peer would have to send again; {@link tornRuns}
 * reads them off any error.
 */
export class LogTorn extends TaggedError("LogTorn")<{
  readonly runs: readonly TornRun[];
  message: string;
}> {}

/** The runs a refused read of the log found gone, or `undefined` for any other error. */
export const tornRuns = (error: EngineError): readonly TornRun[] | undefined =>
  error instanceof StoreFailure && error.cause instanceof LogTorn ? error.cause.runs : undefined;

/**
 * Says a refused read of a torn log once per tear (D39): every peer asking for history meets the
 * same refusal until the runs are reopened, and one report of it is the report.
 */
export function sayTears(say: (failure: StoreFailure) => void) {
  let last: string | undefined;
  return {
    /** A read failed: said when it is a tear, and not the same tear as the last one said. */
    seen: (failure: StoreFailure): void => {
      const runs = tornRuns(failure);
      if (runs === undefined) return;
      const key = runs.map(({ peer, local, from, to }) => `${peer}:${local}:${from}:${to}`).join();
      if (key === last) return;
      last = key;
      say(failure);
    },
  };
}

/** Inside an `atomic` body a store's `Err` must abort the transaction: thrown as itself, caught above. */
export const orThrow = <T>(result: Result<T, StoreFailure>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

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
  /**
   * Which of `ids` the log holds: what `has` answers one id at a time, in one read. Optional: a
   * store whose events are objects in memory has nothing cheaper than `has` to offer, and
   * declaring nothing is how it says so.
   */
  readonly holding?: (
    ids: readonly EventId[],
  ) => Promise<Result<ReadonlySet<EventId>, StoreFailure>>;
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
   * Whether compaction removed this event: the log does not hold it, it is at or below its
   * author's floor in its scope ({@link EventStore.compactedBelow}), and it is not in a run below
   * that floor the log never held — one withheld or scoped out of what this device was sent (D23,
   * D40), or evicted (D45), which a later delivery still brings. An event this answers `true` for
   * already stands in the folded state, and taking it again would put it back in the log below
   * its floor (gaps U1).
   */
  readonly compacted: (event: SyncEvent) => Promise<Result<boolean, StoreFailure>>;
  /**
   * Per author, the highest synced sequence a snapshot install took coverage for with no events
   * behind it (D46): history this log never held, which only the folded state stands for. Kept in
   * the log as well as with the state's cursors, so a state that is lost or never read still
   * says it held rows the log cannot rebuild (gaps U33). Empty until an install raises it.
   */
  readonly installedBelow: () => Promise<Result<Cursors, StoreFailure>>;
  /** Raises {@link EventStore.installedBelow} to `floor`, per author; never lowers it. */
  readonly recordInstalled: (floor: Cursors) => Promise<Result<void, StoreFailure>>;
  /**
   * Deletes these events and remembers nothing of them — what a purge does when this device may
   * no longer read them (D45). Unlike compaction it records no floor: an evicted event is one this
   * device does not hold, so a later delivery of it is stored and folded again. Never asked for
   * this device's own writes, so `lastSeq` for its own author does not move. Answers how many went.
   */
  readonly evict: (ids: readonly EventId[]) => Promise<Result<number, StoreFailure>>;
}

/**
 * What compaction removed for one author in one scope: the highest sequence and stamp gone. A
 * floor a store was seeded with may carry no stamp: that store keeps its clock mark elsewhere.
 */
interface Floor {
  readonly seq: SeqNum;
  readonly hlc?: Hlc;
}

/** What a memory store starts from: the marks a persisted log kept for it (`localStorageEventStore`). */
export interface MemorySeed {
  /** Per author and scope, what compaction removed before this store opened. */
  readonly floors?: Coverage;
  /** The runs below those floors the log never held (`MemoryEventStore.holes`). */
  readonly holes?: readonly SeqRun[];
  /** The floor a snapshot install left (`EventStore.installedBelow`). */
  readonly installed?: Cursors;
}

/** The memory store, with what a store persisting it has to keep beside its entries. */
export interface MemoryEventStore extends EventStore {
  /** The runs below the compaction floors the log never held, ordered by author and start. */
  readonly holes: () => readonly SeqRun[];
}

const inScope = (event: SyncEvent, scope: SeqScope) =>
  (event.local === true) === (scope === "local");

/** A floor once compaction has removed `event` too: the higher sequence, and the higher stamp. */
const raisedFloor = (known: Floor | undefined, event: SyncEvent): Floor => {
  const stamp = known?.hlc;
  return {
    seq: known === undefined || known.seq < event.seqNum ? event.seqNum : known.seq,
    hlc: stamp === undefined || compareHlc(stamp, event.hlc) < 0 ? event.hlc : stamp,
  };
};

const seeded = (cursors: Cursors | undefined) =>
  new Map<PeerId, Floor>([...(cursors ?? [])].map(([peer, seq]) => [peer, { seq }]));

/**
 * The part of each run at or below its author's floor. A persisted log can save its runs before its
 * floors and die between the two; a run above the floor that did land is no hole, and kept, it
 * would never be filled by the event that later arrives inside it (gaps U1).
 */
const underFloors = (runs: readonly SeqRun[], floors: Record<SeqScope, Map<PeerId, Floor>>) =>
  runs.flatMap((run) => {
    const floor = floors[run.local ? "local" : "synced"].get(run.peer)?.seq;
    if (floor === undefined || run.from > floor) return [];
    return [run.to > floor ? { ...run, to: floor } : run];
  });

export function createMemoryEventStore(seed: MemorySeed = {}): MemoryEventStore {
  const events = new Map<EventId, StoredEvent>();
  const floors = { synced: seeded(seed.floors?.synced), local: seeded(seed.floors?.local) };
  const holes = createFloorHoles(underFloors(seed.holes ?? [], floors));
  let installed: Cursors = new Map(seed.installed);
  const below = (event: SyncEvent): boolean =>
    event.seqNum <= (floors[event.local === true ? "local" : "synced"].get(event.peerId)?.seq ?? 0);
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
    if (below(event)) holes.fill(event.peerId, event.local === true, event.seqNum);
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
      const local = scope === "local";
      // what the log held per author before the run: a sequence it passes and never held is a hole
      const held = new Map<PeerId, SeqNum[]>();
      const before = new Map(recorded);
      for (const [id, { event }] of events) {
        if (!inScope(event, scope)) continue;
        const seqs = held.get(event.peerId) ?? [];
        seqs.push(event.seqNum);
        held.set(event.peerId, seqs);
        const below = event.seqNum <= (floor.get(event.peerId) ?? 0);
        const old = Temporal.Instant.compare(event.hlc[0], olderThan) < 0;
        if (!below || !old) continue;
        events.delete(id);
        removed += 1;
        recorded.set(event.peerId, raisedFloor(recorded.get(event.peerId), event));
      }
      for (const [peer, { seq }] of recorded) {
        const was = before.get(peer)?.seq ?? 0;
        for (const run of unheldRuns(peer, local, held.get(peer) ?? [], was, seq)) holes.add(run);
      }
      return ok(removed);
    },
    compactedBelow: () =>
      ok({
        synced: new Map([...floors.synced].map(([peer, f]) => [peer, f.seq])),
        local: new Map([...floors.local].map(([peer, f]) => [peer, f.seq])),
      }),
    compacted: (event) =>
      ok(
        !events.has(event.id) &&
          below(event) &&
          !holes.holds(event.peerId, event.local === true, event.seqNum),
      ),
    installedBelow: () => ok(new Map(installed)),
    recordInstalled: (floor) => {
      installed = higherFloor(installed, floor);
      return ok(undefined);
    },
    holes: holes.runs,
    evict: (ids) => {
      const gone = ids.flatMap((id) => {
        const entry = events.get(id);
        return entry !== undefined && events.delete(id) ? [entry.event] : [];
      });
      // an evicted event below the floor is one a later delivery brings back, not a compacted one
      for (const event of gone)
        if (below(event))
          holes.add({
            peer: event.peerId,
            local: event.local === true,
            from: event.seqNum,
            to: event.seqNum,
          });
      return ok(gone.length);
    },
    maxHlc: () => {
      let max: Hlc | undefined;
      const consider = (hlc: Hlc | undefined) => {
        if (hlc !== undefined && (max === undefined || compareHlc(hlc, max) > 0)) max = hlc;
      };
      for (const { event } of events.values()) consider(event.hlc);
      for (const f of floors.synced.values()) consider(f.hlc);
      for (const f of floors.local.values()) consider(f.hlc);
      return ok(max);
    },
  };
}

import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { Temporal, addToInstant } from "@syncmesh/temporal";

import type { StateCorrupt, StateStore } from "./state-store.js";
import type { EventStore, StoreFailure } from "./store.js";
import type { Coverage, Cursors } from "./sync.js";

import { CompactionRefused } from "./errors.js";
import { EMPTY_COVERAGE } from "./sync.js";

/** What a peer last told us it holds, and when. */
export interface Ack {
  readonly cursors: Cursors;
  readonly at: Temporal.Instant;
}

export interface CompactOptions {
  readonly now: Temporal.Instant;
  /** Events younger than this stay whatever the floor says, so a peer back from a short absence still delta-syncs. */
  readonly keepAtLeast?: Temporal.Duration;
  /** A peer silent for longer no longer pins the floor; if it returns below it, it rejoins from state (RFC-0015 §3). Absent, every peer ever heard from pins. */
  readonly forgetPeersAfter?: Temporal.Duration;
  /** Measured now: given, compaction runs only when `dueForCompaction` says the log has earned it, and otherwise removes nothing. Absent, the caller has already decided and it always runs. */
  readonly sizes?: LogSizes;
}

/** What the log costs a boot, against what the state it can be opened from costs instead. */
export interface LogSizes {
  /** Bytes of log above the persisted state — what a boot would have to refold. */
  readonly incrementalBytes: number;
  /** Bytes of persisted state — what a boot would open in its place. */
  readonly snapshotBytes: number;
}

/** Under this a snapshot is small enough that rewriting it costs less than deciding not to. */
const TINY_SNAPSHOT_BYTES = 1024;

/**
 * Whether the log has grown enough to be worth compacting — automerge-repo's rule, adopted in D05.
 * A count of events says nothing about a boot: a thousand one-cell edits refold faster than ten
 * events carrying a photo's worth of metadata. Bytes above the state are what a boot actually reads,
 * so bytes are what triggers.
 *
 * The decision is local by construction. It says when a device reclaims its own disk, never what
 * anyone concludes from the events, and compaction is unobservable (RFC-0015 §2) — so two peers
 * holding the same events converge whether one of them has compacted, both have, or neither.
 */
export const dueForCompaction = ({ incrementalBytes, snapshotBytes }: LogSizes): boolean =>
  incrementalBytes >= snapshotBytes || snapshotBytes < TINY_SNAPSHOT_BYTES;

export interface Compaction {
  readonly removed: number;
  /** The floor actually applied, after clamping to what the state store had persisted; empty when `sizes` said the log had not earned a compaction. */
  readonly floor: Coverage;
}

export type CompactError = CompactionRefused | StoreFailure | StateCorrupt;

interface CompactDeps {
  readonly store: EventStore;
  readonly stateStore: StateStore | undefined;
  readonly acks: ReadonlyMap<PeerId, Ack>;
}

/** The lowest cursor per author across the peers still counted; an author no peer has acked floors at 0. */
export function ackFloor(acks: Iterable<Ack>, authors: Iterable<PeerId>): Cursors {
  const list = [...acks];
  const floor = new Map<PeerId, SeqNum>();
  if (list.length === 0) return floor;
  for (const author of authors) {
    let min: SeqNum | undefined;
    for (const ack of list) {
      const seq = ack.cursors.get(author);
      if (seq === undefined) {
        min = undefined;
        break;
      }
      if (min === undefined || seq < min) min = seq;
    }
    if (min !== undefined) floor.set(author, min);
  }
  return floor;
}

/** Never above what is persisted: a device cannot refold what it deleted. */
export const clampToPersisted = (floor: Cursors, persisted: Cursors): Cursors => {
  const clamped = new Map<PeerId, SeqNum>();
  for (const [peer, seq] of floor) {
    const held = persisted.get(peer);
    if (held !== undefined) clamped.set(peer, seq < held ? seq : held);
  }
  return clamped;
};

const livePeers = (acks: ReadonlyMap<PeerId, Ack>, options: CompactOptions): Ack[] => {
  const { now, forgetPeersAfter } = options;
  if (forgetPeersAfter === undefined) return [...acks.values()];
  const since = addToInstant(now, forgetPeersAfter.negated());
  return [...acks.values()].filter((ack) => Temporal.Instant.compare(ack.at, since) >= 0);
};

export function compactLog(
  deps: CompactDeps,
  options: CompactOptions,
): Promise<Result<Compaction, CompactError>> {
  const { store, stateStore, acks } = deps;
  const { now, keepAtLeast } = options;
  if (stateStore === undefined) {
    return Promise.resolve(
      Result.err(
        new CompactionRefused({ message: "no state store: the log is the only copy of state" }),
      ),
    );
  }
  if (options.sizes !== undefined && !dueForCompaction(options.sizes)) {
    return Promise.resolve(Result.ok({ removed: 0, floor: EMPTY_COVERAGE }));
  }
  return Result.gen(async function* () {
    const persisted = yield* Result.await(stateStore.loadCursors());
    const synced = clampToPersisted(
      ackFloor(livePeers(acks, options), persisted.synced.keys()),
      persisted.synced,
    );
    const local = persisted.local;
    const olderThan = keepAtLeast === undefined ? now : addToInstant(now, keepAtLeast.negated());
    const a = yield* Result.await(store.compactBelow(synced, "synced", olderThan));
    const b = yield* Result.await(store.compactBelow(local, "local", olderThan));
    return Result.ok({ removed: a + b, floor: { synced, local } });
  });
}

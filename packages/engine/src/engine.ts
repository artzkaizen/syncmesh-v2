import type { HlcClock, MergeSpec, PeerId, RowKey, State, TableName } from "@syncmesh/kernel";

import { applyChange, emptyState } from "@syncmesh/kernel";
import { Result, TaggedError } from "@syncmesh/result";

import type { EventStore, StoreFailure } from "./store.js";
import type { Cursors } from "./sync.js";

import {
  eventId,
  stampOf,
  type PartitionKey,
  type Procedure,
  type SeqNum,
  type SyncEvent,
} from "./event.js";
import { record, type Tx } from "./tx.js";

export class EmptyMutation extends TaggedError("EmptyMutation")<{
  procedure: Procedure;
  message: string;
}> {}

export interface MutateOptions {
  readonly partition?: PartitionKey;
  readonly local?: boolean;
}

export type MutateError = EmptyMutation | StoreFailure;

export type FoldSource = "local" | "remote";

/** One notification per fold, however many events it covered. `writeKeys` is exact: live queries (E10) trust it. */
export interface FoldBatch {
  readonly source: FoldSource;
  readonly eventCount: number;
  readonly writeTables: ReadonlySet<TableName>;
  readonly writeKeys: ReadonlyMap<TableName, ReadonlySet<RowKey>>;
}

export interface ReceiveReport {
  readonly folded: number;
  /** Own events, duplicates within the batch, and events already stored. */
  readonly skipped: number;
}

export type Unsubscribe = () => void;

export interface Engine {
  readonly peerId: PeerId;
  /** Records, stamps, numbers, appends, folds, then hands the event to `onOutbound` — a write is real once appended. */
  readonly mutate: (
    procedure: Procedure,
    fn: (tx: Tx) => void,
    options?: MutateOptions,
  ) => Promise<Result<SyncEvent, MutateError>>;
  /** Folds events from another peer once each; own and already-stored events are skipped. */
  readonly receiveBatch: (
    events: readonly SyncEvent[],
  ) => Promise<Result<ReceiveReport, StoreFailure>>;
  readonly receive: (event: SyncEvent) => Promise<Result<ReceiveReport, StoreFailure>>;
  readonly state: () => State;
  /** Highest synced sequence number held per author. */
  readonly cursors: () => Promise<Result<Cursors, StoreFailure>>;
  /** Synced events the holder of `theirs` lacks. */
  readonly eventsSince: (theirs: Cursors) => Promise<Result<readonly SyncEvent[], StoreFailure>>;
  readonly onFoldBatch: (listener: (batch: FoldBatch) => void) => Unsubscribe;
  /** Fires for every synced event this engine authors, never for `local` ones. */
  readonly onOutbound: (listener: (event: SyncEvent) => void) => Unsubscribe;
}

export interface EngineOptions {
  readonly peerId: PeerId;
  readonly clock: HlcClock;
  readonly store: EventStore;
  readonly merge?: MergeSpec;
}

export function createEngine(options: EngineOptions): Engine {
  const { peerId, clock, store, merge } = options;
  let state = emptyState();
  const foldListeners = new Set<(batch: FoldBatch) => void>();
  const outboundListeners = new Set<(event: SyncEvent) => void>();

  const fold = (events: readonly SyncEvent[], source: FoldSource): void => {
    if (events.length === 0) return;
    const writeKeys = new Map<TableName, Set<RowKey>>();
    for (const event of events) {
      const stamp = stampOf(event);
      for (const change of event.changes) {
        state = applyChange(state, change, stamp, merge);
        const keys = writeKeys.get(change.table) ?? new Set<RowKey>();
        keys.add(change.key);
        writeKeys.set(change.table, keys);
      }
    }
    const batch: FoldBatch = {
      source,
      eventCount: events.length,
      writeTables: new Set(writeKeys.keys()),
      writeKeys,
    };
    for (const listener of foldListeners) listener(batch);
  };

  const mutate: Engine["mutate"] = (procedure, fn, mutateOptions = {}) =>
    Result.gen(async function* () {
      const changes = record(fn);
      if (changes.length === 0) {
        return Result.err(
          new EmptyMutation({ procedure, message: `${procedure} changed nothing` }),
        );
      }
      const hlc = clock.tick();
      const scope = mutateOptions.local === true ? "local" : "synced";
      const last = yield* Result.await(store.lastSeq(peerId, scope));
      const event = build(procedure, hlc, nextSeq(last), changes, mutateOptions);
      yield* Result.await(store.append(event));
      fold([event], "local");
      if (event.local !== true) for (const listener of outboundListeners) listener(event);
      return Result.ok(event);
    });

  const receiveBatch: Engine["receiveBatch"] = (events) =>
    Result.gen(async function* () {
      const fresh: SyncEvent[] = [];
      const seen = new Set<string>();
      for (const event of events) {
        if (event.peerId === peerId || seen.has(event.id)) continue;
        seen.add(event.id);
        if (yield* Result.await(store.has(event.id))) continue;
        fresh.push(event);
      }
      for (const event of fresh) {
        clock.receive(event.hlc);
        yield* Result.await(store.append(event));
      }
      fold(fresh, "remote");
      return Result.ok({ folded: fresh.length, skipped: events.length - fresh.length });
    });

  const build = (
    procedure: Procedure,
    hlc: SyncEvent["hlc"],
    seqNum: SeqNum,
    changes: SyncEvent["changes"],
    { partition, local }: MutateOptions,
  ): SyncEvent => {
    const base = {
      v: 1 as const,
      id: eventId(peerId, seqNum),
      peerId,
      seqNum,
      hlc,
      procedure,
      changes,
    };
    if (partition !== undefined && local === true) return { ...base, partition, local };
    if (partition !== undefined) return { ...base, partition };
    if (local === true) return { ...base, local };
    return base;
  };

  const subscribe =
    <L>(listeners: Set<L>) =>
    (listener: L): Unsubscribe => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };

  const cursors: Engine["cursors"] = () =>
    Result.gen(async function* () {
      const all = yield* Result.await(store.allSince(new Map()));
      const max = new Map<PeerId, SeqNum>();
      for (const e of all) if ((max.get(e.peerId) ?? 0) < e.seqNum) max.set(e.peerId, e.seqNum);
      return Result.ok(max);
    });

  return {
    peerId,
    mutate,
    receiveBatch,
    receive: (event) => receiveBatch([event]),
    state: () => state,
    cursors,
    eventsSince: (theirs) => store.allSince(theirs),
    onFoldBatch: subscribe(foldListeners),
    onOutbound: subscribe(outboundListeners),
  };
}

const nextSeq = (last: SeqNum | undefined): SeqNum => {
  // SAFETY: last is a SeqNum (positive safe integer) or absent; +1 from 0 or from it stays one
  return ((last ?? 0) + 1) as SeqNum;
};

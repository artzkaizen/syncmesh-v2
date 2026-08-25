import type { HlcClock, MergeSpec, PeerId, RowKey, State, TableName } from "@syncmesh/kernel";

import { applyChange, emptyState, readRow } from "@syncmesh/kernel";
import {
  eventId,
  stampOf,
  type EventId,
  type PartitionKey,
  type Procedure,
  type SeqNum,
  type SyncEvent,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { EventStore, StoreFailure } from "./store.js";
import type { Cursors } from "./sync.js";
import type { ProbeEvent, RowLookup, Validator } from "./validate.js";

import { admit } from "./admit.js";
import {
  CannotRevert,
  EmptyMutation,
  ListenerFailure,
  type ValidationError,
  type EngineError,
  type MutateError,
  type RevertError,
} from "./errors.js";
import { createHub, type Unsubscribe } from "./listeners.js";
import { timed, type TelemetryEvent, type TelemetryListener } from "./telemetry.js";
import { record, type Tx } from "./tx.js";
import { invert, replay, REVERT, type Undo } from "./undo.js";

export interface MutateOptions {
  readonly partition?: PartitionKey;
  readonly local?: boolean;
}

export type FoldSource = "local" | "remote" | "boot";

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
  /** Refused by validation; reported through `onQuarantine`, never stored or folded. */
  readonly quarantined: number;
}

export interface Quarantined {
  readonly event: SyncEvent;
  readonly reason: ValidationError;
}

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
  /** Writes the compensating event for one of this engine's last `undoDepth` writes, in that event's partition. */
  readonly revert: (id: EventId) => Promise<Result<SyncEvent, RevertError>>;
  readonly canRevert: (id: EventId) => boolean;
  /** Highest synced sequence number held per author. */
  readonly cursors: () => Promise<Result<Cursors, StoreFailure>>;
  /** Synced events the holder of `theirs` lacks. */
  readonly eventsSince: (theirs: Cursors) => Promise<Result<readonly SyncEvent[], StoreFailure>>;
  readonly onFoldBatch: (listener: (batch: FoldBatch) => void) => Unsubscribe;
  /** Fires for every synced event this engine authors, never for `local` ones. */
  readonly onOutbound: (listener: (event: SyncEvent) => void) => Unsubscribe;
  /** A listener threw; the fold itself is unaffected. */
  readonly onError: (listener: (error: EngineError) => void) => Unsubscribe;
  readonly onQuarantine: (listener: (q: Quarantined) => void) => Unsubscribe;
  readonly onTelemetry: (listener: TelemetryListener) => Unsubscribe;
}

export interface EngineOptions {
  readonly peerId: PeerId;
  readonly clock: HlcClock;
  readonly store: EventStore;
  readonly merge?: MergeSpec;
  /** How many of this engine's own writes stay revertable. Default 0. */
  readonly undoDepth?: number;
  /** Runs on a probe before a local write gets a sequence number, and on every received event before it is stored. */
  readonly validate?: Validator;
  /** Events the store already holds, folded before any listener can attach; `openEngine` supplies them. */
  readonly replay?: readonly SyncEvent[];
}

/** Boots an engine over what `store` holds: folds every stored event and moves the clock past the highest stored stamp before any write is numbered. */
export function openEngine(options: EngineOptions): Promise<Result<Engine, StoreFailure>> {
  return Result.gen(async function* () {
    const replay = yield* Result.await(options.store.all());
    const max = yield* Result.await(options.store.maxHlc());
    if (max !== undefined) options.clock.receive(max);
    return Result.ok(createEngine({ ...options, replay }));
  });
}

export function createEngine(options: EngineOptions): Engine {
  const { peerId, clock, store, merge, undoDepth = 0, validate, replay: stored = [] } = options;
  let state = emptyState();
  const undo: Undo[] = [];
  const errors = createHub<EngineError>();
  const report = (hook: ListenerFailure["hook"]) => (cause: unknown) =>
    errors.emit(new ListenerFailure({ hook, message: `${hook} listener threw`, cause }));
  const folds = createHub<FoldBatch>(report("onFoldBatch"));
  const outbound = createHub<SyncEvent>(report("onOutbound"));
  const telemetry = createHub<TelemetryEvent>();
  const quarantine = createHub<Quarantined>();
  const before: RowLookup = (table, key) => readRow(state, table, key);

  const fold = (events: readonly SyncEvent[], source: FoldSource): void => {
    if (events.length === 0) return;
    const [batch, duration] = timed((): FoldBatch => {
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
      return {
        source,
        eventCount: events.length,
        writeTables: new Set(writeKeys.keys()),
        writeKeys,
      };
    });
    const keys = [...batch.writeKeys.values()].reduce((n, set) => n + set.size, 0);
    telemetry.emit({ type: "engine.fold", sizes: { events: events.length, keys }, duration });
    folds.emit(batch);
  };
  fold(stored, "boot");

  const mutate: Engine["mutate"] = (procedure, fn, mutateOptions = {}) =>
    Result.gen(async function* () {
      const [changes, duration] = timed(() => record(fn));
      if (changes.length === 0) {
        return Result.err(
          new EmptyMutation({ procedure, message: `${procedure} changed nothing` }),
        );
      }
      if (validate !== undefined) {
        const probe: ProbeEvent =
          mutateOptions.local === true ? { peerId, changes, local: true } : { peerId, changes };
        const verdict = validate.validate(
          mutateOptions.partition === undefined
            ? probe
            : { ...probe, partition: mutateOptions.partition },
          before,
        );
        if (verdict.isErr()) return verdict;
      }
      const inverse = undoDepth > 0 ? invert(state, changes) : [];
      const hlc = clock.tick();
      const scope = mutateOptions.local === true ? "local" : "synced";
      const last = yield* Result.await(store.lastSeq(peerId, scope));
      const event = buildEvent(peerId, procedure, hlc, nextSeq(last), changes, mutateOptions);
      yield* Result.await(store.append(event));
      telemetry.emit({ type: "engine.mutate", sizes: { changes: changes.length }, duration });
      fold([event], "local");
      if (undoDepth > 0) {
        undo.push({ event, inverse });
        if (undo.length > undoDepth) undo.shift();
      }
      if (event.local !== true) outbound.emit(event);
      return Result.ok(event);
    });

  const receiveBatch: Engine["receiveBatch"] = (events) =>
    Result.gen(async function* () {
      const { fresh, quarantined } = yield* Result.await(
        admit(events, { peerId, store, validate, before, quarantine }),
      );
      for (const event of fresh) clock.receive(event.hlc);
      yield* Result.await(store.appendBatch(fresh));
      fold(fresh, "remote");
      return Result.ok({
        folded: fresh.length,
        skipped: events.length - fresh.length - quarantined,
        quarantined,
      });
    });

  const revert: Engine["revert"] = (id) => {
    const index = undo.findIndex((u) => u.event.id === id);
    const entry = undo[index];
    if (entry === undefined) {
      return Promise.resolve(
        Result.err(
          new CannotRevert({
            eventId: id,
            message: `not among the last ${undoDepth} writes of this engine`,
          }),
        ),
      );
    }
    undo.splice(index, 1);
    const { partition, local } = entry.event;
    const options: MutateOptions = {};
    if (partition !== undefined) Object.assign(options, { partition });
    if (local === true) Object.assign(options, { local });
    return mutate(REVERT, (tx) => replay(tx, entry.inverse), options);
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
    revert,
    canRevert: (id) => undo.some((u) => u.event.id === id),
    cursors,
    eventsSince: (theirs) => store.allSince(theirs),
    onFoldBatch: folds.subscribe,
    onOutbound: outbound.subscribe,
    onError: errors.subscribe,
    onQuarantine: quarantine.subscribe,
    onTelemetry: telemetry.subscribe,
  };
}

const nextSeq = (last: SeqNum | undefined): SeqNum => {
  // SAFETY: last is a SeqNum (positive safe integer) or absent; +1 from 0 or from it stays one
  return ((last ?? 0) + 1) as SeqNum;
};

function buildEvent(
  peerId: PeerId,
  procedure: Procedure,
  hlc: SyncEvent["hlc"],
  seqNum: SeqNum,
  changes: SyncEvent["changes"],
  { partition, local }: MutateOptions,
): SyncEvent {
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
}

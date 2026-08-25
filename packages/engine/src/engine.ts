import type { HlcClock, MergeSpec, PeerId, Row, RowKey, State, TableName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { applyChange, emptyState, getRecord, readRow, readRowsIn } from "@syncmesh/kernel";
import {
  stampOf,
  type EventId,
  type PartitionKey,
  type Procedure,
  type SyncEvent,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Boot } from "./boot.js";
import type { Ack, CompactError, CompactOptions, Compaction } from "./compaction.js";
import type { StateStore } from "./state-store.js";
import type { EventStore, StoreFailure, StoredEvent } from "./store.js";
import type { Coverage, Cursors } from "./sync.js";
import type { ProbeEvent, StateLookup, Validator } from "./validate.js";

import { admit } from "./admit.js";
import { buildEvent, nextSeq } from "./build-event.js";
import { compactLog } from "./compaction.js";
import { trackCoverage } from "./coverage.js";
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
import { rowsFor, writeKeysOf } from "./state-store.js";
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
  /** Folds entries from another peer once each; own and already-stored events are skipped. A relayed event keeps its author's signature — pass it. */
  readonly receiveBatch: (
    entries: readonly StoredEvent[],
  ) => Promise<Result<ReceiveReport, StoreFailure>>;
  readonly receive: (entry: StoredEvent) => Promise<Result<ReceiveReport, StoreFailure>>;
  readonly state: () => State;
  /** The visible rows of `table` that belong to `partition`. */
  readonly rowsIn: (table: TableName, partition: PartitionKey) => ReadonlyMap<RowKey, Row>;
  /** Writes the compensating event for one of this engine's last `undoDepth` writes, in that event's partition. */
  readonly revert: (id: EventId) => Promise<Result<SyncEvent, RevertError>>;
  readonly canRevert: (id: EventId) => boolean;
  /** Highest synced sequence number held per author. */
  readonly cursors: () => Promise<Result<Cursors, StoreFailure>>;
  /** What this engine has folded, per author and scope. */
  readonly coverage: () => Coverage;
  /** Records what `peer` holds, as of `at`; links call it on every cursor exchange. Feeds `compact`. */
  readonly acknowledge: (peer: PeerId, cursors: Cursors, at: Temporal.Instant) => void;
  /** Removes events every counted peer has acked and the state store has persisted; unobservable to peers. See RFC-0015 §2. */
  readonly compact: (options: CompactOptions) => Promise<Result<Compaction, CompactError>>;
  /** Synced events the holder of `theirs` lacks. */
  readonly eventsSince: (theirs: Cursors) => Promise<Result<readonly StoredEvent[], StoreFailure>>;
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
  /** Where folded rows are kept between runs; absent, every boot refolds the log. */
  readonly stateStore?: StateStore;
  /** What to start from; `openEngine` builds it. Absent, the engine starts empty. */
  readonly boot?: Boot;
}

export function createEngine(options: EngineOptions): Engine {
  const { peerId, clock, store, merge, undoDepth = 0, validate, stateStore, boot } = options;
  let state = boot?.state ?? emptyState();
  const coverage = trackCoverage(boot?.coverage);
  const undo: Undo[] = [];
  const errors = createHub<EngineError>();
  const report = (hook: ListenerFailure["hook"]) => (cause: unknown) =>
    errors.emit(new ListenerFailure({ hook, message: `${hook} listener threw`, cause }));
  const folds = createHub<FoldBatch>(report("onFoldBatch"));
  const outbound = createHub<SyncEvent>(report("onOutbound"));
  const telemetry = createHub<TelemetryEvent>();
  const quarantine = createHub<Quarantined>();
  const before = {
    row: (table, key) => readRow(state, table, key),
    partition: (table, key) => getRecord(state, table, key)?.partition,
  } satisfies StateLookup;
  const acks = new Map<PeerId, Ack>();

  const fold = (events: readonly SyncEvent[], source: FoldSource): FoldBatch => {
    const [batch, duration] = timed((): FoldBatch => {
      const writeKeys = writeKeysOf(events);
      for (const event of events) {
        coverage.note(event);
        const stamp = stampOf(event);
        for (const change of event.changes)
          state = applyChange(state, change, stamp, merge, event.partition);
      }
      return {
        source,
        eventCount: events.length,
        writeTables: new Set(writeKeys.keys()),
        writeKeys,
      };
    });
    if (events.length === 0) return batch;
    const keys = [...batch.writeKeys.values()].reduce((n, set) => n + set.size, 0);
    telemetry.emit({ type: "engine.fold", sizes: { events: events.length, keys }, duration });
    folds.emit(batch);
    return batch;
  };
  fold(boot?.replay ?? [], "boot");

  /** Writes the rows a fold touched to the state store; a failure is reported, not returned — the log already holds the truth. */
  const persist = async (batch: FoldBatch): Promise<void> => {
    if (stateStore === undefined || batch.eventCount === 0) return;
    const written = await stateStore.commit(rowsFor(state, batch.writeKeys), coverage.current());
    if (written.isErr()) errors.emit(written.error);
  };

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
      yield* Result.await(store.append({ event }));
      telemetry.emit({ type: "engine.mutate", sizes: { changes: changes.length }, duration });
      await persist(fold([event], "local"));
      if (undoDepth > 0) {
        undo.push({ event, inverse });
        if (undo.length > undoDepth) undo.shift();
      }
      if (event.local !== true) outbound.emit(event);
      return Result.ok(event);
    });

  const receiveBatch: Engine["receiveBatch"] = (entries) =>
    Result.gen(async function* () {
      const { fresh, quarantined } = yield* Result.await(
        admit(entries, { peerId, store, validate, before, quarantine }),
      );
      for (const { event } of fresh) clock.receive(event.hlc);
      yield* Result.await(store.appendBatch(fresh));
      await persist(
        fold(
          fresh.map((f) => f.event),
          "remote",
        ),
      );
      return Result.ok({
        folded: fresh.length,
        skipped: entries.length - fresh.length - quarantined,
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

  return {
    peerId,
    mutate,
    receiveBatch,
    receive: (entry) => receiveBatch([entry]),
    state: () => state,
    rowsIn: (table, partition) => readRowsIn(state, table, partition),
    revert,
    canRevert: (id) => undo.some((u) => u.event.id === id),
    cursors: () => Promise.resolve(Result.ok(coverage.current().synced)),
    coverage: coverage.current,
    acknowledge: (peer, cursors, at) => void acks.set(peer, { cursors, at }),
    compact: (options) => compactLog({ store, stateStore, acks }, options),
    eventsSince: (theirs) => store.allSince(theirs),
    onFoldBatch: folds.subscribe,
    onOutbound: outbound.subscribe,
    onError: errors.subscribe,
    onQuarantine: quarantine.subscribe,
    onTelemetry: telemetry.subscribe,
  };
}

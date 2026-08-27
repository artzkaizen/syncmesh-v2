import type { HlcClock, MergeSpec, PeerId, Row, RowKey, State, TableName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import {
  applyChange,
  emptyState,
  getRecord,
  mergeRecord,
  readRow,
  readRowsIn,
} from "@syncmesh/kernel";
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
import type { RepairApi } from "./digest.js";
import type { FeedApi } from "./feed.js";
import type { Interest } from "./interest.js";
import type { SnapshotApi } from "./snapshot.js";
import type { StateStore } from "./state-store.js";
import type { EventStore, StoredEvent } from "./store.js";
import type { StoreFailure } from "./store.js";
import type { Coverage, Cursors } from "./sync.js";
import type { Tx } from "./tx.js";
import type { StateLookup, Validator } from "./validate.js";

import { admit } from "./admit.js";
import { compactLog } from "./compaction.js";
import { trackCoverage } from "./coverage.js";
import { createRepairPath } from "./digest.js";
import {
  ListenerFailure,
  type ValidationError,
  type EngineError,
  type MutateError,
  type RevertError,
} from "./errors.js";
import { createFeedPath, trackFeeds } from "./feed.js";
import { eventsWanted } from "./interest.js";
import { createHub, type Unsubscribe } from "./listeners.js";
import { createSnapshotPath } from "./snapshot.js";
import { rowsFor, writeKeysOf } from "./state-store.js";
import { timed, type TelemetryEvent, type TelemetryListener } from "./telemetry.js";
import { createRevert, type Undo } from "./undo.js";
import { createWritePath } from "./writes.js";

export interface MutateOptions {
  readonly partition?: PartitionKey;
  readonly local?: boolean;
}

/** Where a batch came from; `repair` carries no cursors (RFC-0014), `snapshot` adopts them last (RFC-0019). */
export type FoldSource = "local" | "remote" | "boot" | "repair" | "snapshot";

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

export interface Engine extends FeedApi, RepairApi, SnapshotApi {
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
  /** What each peer was last acknowledged as holding. */
  readonly acks: () => ReadonlyMap<PeerId, Cursors>;
  /** Fires after `acknowledge` records what a peer holds. */
  readonly onAcknowledge: (listener: (peer: PeerId) => void) => Unsubscribe;
  /** Removes events every counted peer has acked and the state store has persisted; unobservable to peers. See RFC-0015 §2. */
  readonly compact: (options: CompactOptions) => Promise<Result<Compaction, CompactError>>;
  /**
   * Synced events the holder of `theirs` lacks, narrowed to what they asked for (E13). The
   * filter runs **here**, at the sender, so an uninterested event never becomes bytes — and it
   * only ever narrows: what the reader may see at all is the read policy's to decide.
   */
  readonly eventsSince: (
    theirs: Cursors,
    interest?: Interest,
  ) => Promise<Result<readonly StoredEvent[], StoreFailure>>;
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
  /**
   * Runs a write's store calls in one transaction: the event appended to the log and its rows
   * committed to the state store land together or not at all. The callback gets the stores to
   * use inside; absent, each store commits on its own and the cursor sidecar recovers the gap.
   */
  readonly atomic?: <T>(fn: (scoped: AtomicStores) => Promise<T>) => Promise<T>;
}

/** What a write touches inside `atomic`: the log, and the state store when there is one. */
export interface AtomicStores {
  readonly events: EventStore;
  readonly state?: StateStore;
}

export function createEngine(options: EngineOptions): Engine {
  const {
    peerId,
    clock,
    store,
    merge,
    undoDepth = 0,
    validate,
    stateStore,
    boot,
    atomic,
  } = options;
  const plain: AtomicStores =
    stateStore === undefined ? { events: store } : { events: store, state: stateStore };
  const atomically = <T>(fn: (scoped: AtomicStores) => Promise<T>): Promise<T> =>
    atomic === undefined ? fn(plain) : atomic((scoped) => fn(scoped));
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
  const ackHub = createHub<PeerId>(report("onAcknowledge"));
  const before = {
    row: (table, key) => readRow(state, table, key),
    records: (table) => state.get(table),
    partition: (table, key) => getRecord(state, table, key)?.partition,
  } satisfies StateLookup;
  const acks = new Map<PeerId, Ack>();
  // declared before `fold`, which advances an author's chain as its events land — boot replay included
  const feeds = trackFeeds();

  const fold = (events: readonly SyncEvent[], source: FoldSource): FoldBatch => {
    const [batch, duration] = timed((): FoldBatch => {
      const writeKeys = writeKeysOf(events);
      for (const event of events) {
        coverage.note(event);
        feeds.note(event);
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
    // a boot fold has no persist step of its own; every other fold notifies after it (persist)
    if (source === "boot") folds.emit(batch);
    return batch;
  };
  fold(boot?.replay ?? [], "boot");

  /**
   * Writes the rows a fold touched to the state store. A failure is reported, not returned: the
   * log already holds the truth — unless the write runs inside `atomic`, where it fails the
   * transaction and takes the append down with it.
   */
  const persist = async (batch: FoldBatch, into: StateStore | undefined): Promise<void> => {
    if (batch.eventCount === 0 || into === undefined) return;
    const written = await into.commit(rowsFor(state, batch.writeKeys), coverage.current());
    if (written.isErr()) {
      if (atomic !== undefined) throw written.error;
      errors.emit(written.error);
    }
  };
  /** After the transaction, so a listener that re-reads the tables (D20's live queries) sees committed rows. */
  const notify = (batch: FoldBatch): void => {
    if (batch.eventCount > 0) folds.emit(batch);
  };

  const snapshotDeps = {
    stateOf: () => state,
    setState: (next: State) => void (state = next),
    coverageOf: coverage.current,
    adopt: coverage.adopt,
    persist: (batch: FoldBatch) => persist(batch, stateStore),
    notify,
  };
  if (merge !== undefined) Object.assign(snapshotDeps, { merge });
  const snapshots = createSnapshotPath(snapshotDeps);

  const repair = createRepairPath({
    stateOf: () => state,
    mergeInto: (table, key, record) => void (state = mergeRecord(state, table, key, record, merge)),
    persist: (batch) => persist(batch, stateStore),
    notify,
  });

  const { mutate, receiveBatch } = createWritePath({
    peerId,
    clock,
    validate,
    before,
    undoDepth,
    undo,
    atomically,
    stateOf: () => state,
    fold,
    persist,
    notify,
    outbound,
    telemetry,
    admitEntries: (entries) => admit(entries, { peerId, store, validate, before, quarantine }),
  });

  const revert = createRevert({ undo, undoDepth, mutate });

  const chains = createFeedPath({ store, feeds, receiveBatch });

  return {
    peerId,
    mutate,
    receiveBatch,
    receive: (entry) => receiveBatch([entry]),
    ...chains,
    state: () => state,
    rowsIn: (table, partition) => readRowsIn(state, table, partition),
    revert,
    canRevert: (id) => undo.some((u) => u.event.id === id),
    cursors: () => Promise.resolve(Result.ok(coverage.current().synced)),
    coverage: coverage.current,
    acknowledge: (peer, cursors, at) => {
      acks.set(peer, { cursors, at });
      ackHub.emit(peer);
    },
    acks: () => new Map([...acks].map(([peer, ack]) => [peer, ack.cursors])),
    onAcknowledge: ackHub.subscribe,
    compact: (options) => compactLog({ store, stateStore, acks }, options),
    ...snapshots,
    eventsSince: (theirs, interest) => eventsWanted(store, theirs, interest),
    ...repair,
    onFoldBatch: folds.subscribe,
    onOutbound: outbound.subscribe,
    onError: errors.subscribe,
    onQuarantine: quarantine.subscribe,
    onTelemetry: telemetry.subscribe,
  };
}

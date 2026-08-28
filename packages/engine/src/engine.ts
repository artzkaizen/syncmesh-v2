import type { HlcClock, MergeSpec, PeerId, Row, RowKey, State, TableName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { emptyState, getRecord, mergeRecord, readRow, readRowsIn } from "@syncmesh/kernel";
import { type EventId, type PartitionKey, type Procedure, type SyncEvent } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Boot } from "./boot.js";
import type { Ack, CompactError, CompactOptions, Compaction } from "./compaction.js";
import type { RepairApi } from "./digest.js";
import type { FeedApi } from "./feed.js";
import type { Interest } from "./interest.js";
import type { Parked, UnknownHandling } from "./quarantine.js";
import type { SnapshotApi } from "./snapshot.js";
import type { StateStore } from "./state-store.js";
import type { EventStore, StoredEvent } from "./store.js";
import type { StoreFailure } from "./store.js";
import type { Ahead, Coverage, Cursors } from "./sync.js";
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
import { createFoldPath } from "./fold.js";
import { eventsWanted } from "./interest.js";
import { createHub, type Unsubscribe } from "./listeners.js";
import { createQuarantine, retryQuarantined } from "./quarantine.js";
import { createSnapshotPath } from "./snapshot.js";
import { mergeAhead } from "./sync.js";
import { type TelemetryEvent, type TelemetryListener } from "./telemetry.js";
import { createRevert, type Undo } from "./undo.js";
import { createWritePath } from "./writes.js";

export interface MutateOptions {
  readonly partition?: PartitionKey;
  readonly local?: boolean;
}

/** Where a batch came from; `repair` carries no cursors (RFC-0014), `snapshot` adopts them last (RFC-0019). */
export type FoldSource = "local" | "remote" | "boot" | "repair" | "snapshot";

/** One notification per fold, however many events it covered. `writeKeys` is exact: live queries trust it. */
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
  /** Refused by validation; parked in the quarantine with the verdict, and never folded. */
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
  /**
   * Per author, the highest sequence number below which this engine holds **every** event — the
   * contiguous half of D13's pair, and the only half anti-entropy can ask a question with.
   */
  readonly cursors: () => Promise<Result<Cursors, StoreFailure>>;
  /**
   * The other half: per author, what this device has **folded** above that cursor — the far side
   * of a gap. Advisory, so a peer that ignores it re-sends a run this device then skips; a peer
   * that reads it sends the hole alone instead of the whole tail above it.
   *
   * A parked event is deliberately not here. Saying we hold it would stop every peer offering it
   * again, and re-offering is the only thing that heals a verdict something outside the event
   * reversed — a grant that arrives a moment later, a device that is un-revoked. What a parked
   * event must not do is stall the author's run, and that is {@link Engine.holding}'s job.
   */
  readonly ahead: () => Ahead;
  /**
   * Per author, every sequence above the cursor this device has the bytes for — folded past a
   * gap, or parked below one. What a receiver walks an author's run with: waiting on a parked
   * event instead would hold back everything after it for as long as the quarantine keeps it,
   * which for a refusal no upgrade reverses is forever.
   */
  readonly holding: () => Ahead;
  /** What this engine has folded, per author and scope. */
  readonly coverage: () => Coverage;
  /**
   * Takes on a coverage that events already folded stand for (D23) — what a filtered catch-up
   * hands over at its end. Raises each author's cursor, never lowers one, and takes on the
   * `scope` that makes the numbers true.
   *
   * Separate from `installSnapshot` because there are no rows to install: the events themselves
   * arrived and were folded, and what is being adopted is the claim about the ones that were
   * filtered out — the only thing that can move a cursor past a hole nobody is going to fill.
   */
  readonly adoptCoverage: (coverage: Coverage) => void;
  /** Records what `peer` holds, as of `at`; links call it on every cursor exchange. Feeds `compact`. */
  readonly acknowledge: (peer: PeerId, cursors: Cursors, at: Temporal.Instant) => void;
  /** What each peer was last acknowledged as holding. */
  readonly acks: () => ReadonlyMap<PeerId, Cursors>;
  /** Fires after `acknowledge` records what a peer holds. */
  readonly onAcknowledge: (listener: (peer: PeerId) => void) => Unsubscribe;
  /** Removes events every counted peer has acked and the state store has persisted; unobservable to peers. See RFC-0015 §2. */
  readonly compact: (options: CompactOptions) => Promise<Result<Compaction, CompactError>>;
  /**
   * Synced events the holder of `theirs` lacks, narrowed to what they asked for. The
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
  /** The events this build could not take, with the bytes they arrived as (D13). */
  readonly quarantine: () => readonly Parked[];
  /**
   * Re-offers every parked event to the ordinary receive path. What an app calls after an update:
   * anything the new build understands folds and closes the gap below it, anything it still does
   * not is parked again.
   */
  readonly retryQuarantined: () => Promise<Result<ReceiveReport, StoreFailure>>;
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
  /**
   * How loudly this mesh is told about an event no build here can read (D13). Per mesh, never
   * per event: all three settings park it and none of them folds it, so a mesh whose devices were
   * configured by two different people still converges. Default `"warn"`.
   */
  readonly unknownHandling?: UnknownHandling;
  /** Parked events kept per reason before the oldest is dropped — loudly, on `onError`. */
  readonly quarantineLimit?: number;
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
    unknownHandling = "warn",
    quarantineLimit,
  } = options;
  const plain: AtomicStores =
    stateStore === undefined ? { events: store } : { events: store, state: stateStore };
  const atomically = <T>(fn: (scoped: AtomicStores) => Promise<T>): Promise<T> =>
    atomic === undefined ? fn(plain) : atomic((scoped) => fn(scoped));
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
  const acks = new Map<PeerId, Ack>();
  // declared before the fold path, which advances an author's chain as its events land
  const feeds = trackFeeds();
  const parked = createQuarantine({
    limit: quarantineLimit,
    onEvict: errors.emit,
    cursors: () => coverage.current().synced,
  });

  const { stateOf, setState, fold, persist, notify } = createFoldPath({
    merge,
    coverage,
    feeds,
    folds,
    telemetry,
    errors,
    atomic: atomic !== undefined,
    initial: boot?.state ?? emptyState(),
  });
  fold(boot?.replay ?? [], "boot");

  const before = {
    row: (table, key) => readRow(stateOf(), table, key),
    records: (table) => stateOf().get(table),
    partition: (table, key) => getRecord(stateOf(), table, key)?.partition,
  } satisfies StateLookup;

  const snapshotDeps = {
    stateOf,
    setState,
    coverageOf: coverage.current,
    adopt: coverage.adopt,
    persist: (batch: FoldBatch) => persist(batch, stateStore),
    notify,
  };
  if (merge !== undefined) Object.assign(snapshotDeps, { merge });
  const snapshots = createSnapshotPath(snapshotDeps);

  const repair = createRepairPath({
    stateOf,
    mergeInto: (table, key, record) => setState(mergeRecord(stateOf(), table, key, record, merge)),
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
    stateOf,
    fold,
    persist,
    notify,
    outbound,
    telemetry,
    admitEntries: (entries) =>
      admit(entries, {
        peerId,
        store,
        validate,
        before,
        parked,
        quarantine,
        errors,
        unknownHandling,
      }),
  });

  const revert = createRevert({ undo, undoDepth, mutate });

  const chains = createFeedPath({ store, feeds, receiveBatch });

  return {
    peerId,
    mutate,
    receiveBatch,
    receive: (entry) => receiveBatch([entry]),
    ...chains,
    state: stateOf,
    rowsIn: (table, partition) => readRowsIn(stateOf(), table, partition),
    revert,
    canRevert: (id) => undo.some((u) => u.event.id === id),
    cursors: () => Promise.resolve(Result.ok(coverage.current().synced)),
    ahead: coverage.ahead,
    holding: () => mergeAhead(coverage.ahead(), parked.ahead()),
    coverage: coverage.current,
    adoptCoverage: coverage.adopt,
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
    quarantine: parked.list,
    retryQuarantined: () => retryQuarantined(parked, receiveBatch),
    onQuarantine: quarantine.subscribe,
    onTelemetry: telemetry.subscribe,
  };
}

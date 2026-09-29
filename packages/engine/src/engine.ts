import type { PeerId, Row, RowKey, Stamp, State, TableName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import {
  emptyState,
  getRecord,
  isVisible,
  mergeRecord,
  readRow,
  readRowsIn,
} from "@syncmesh/kernel";
import { type EventId, type PartitionKey, type Procedure, type SyncEvent } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Ack, CompactError, CompactOptions, Compaction } from "./compaction.js";
import type { RepairApi } from "./digest.js";
import type { FeedApi } from "./feed.js";
import type { Interest } from "./interest.js";
import type { AtomicStores, EngineOptions } from "./options.js";
import type { Parked } from "./quarantine.js";
import type { EventHeader, RecentEvents } from "./recent.js";
import type { SnapshotApi } from "./snapshot.js";
import type { StoredEvent } from "./store.js";
import type { StoreFailure } from "./store.js";
import type { Ahead, Coverage, Cursors } from "./sync.js";
import type { Tx } from "./tx.js";
import type { StateLookup } from "./validate.js";

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
import { createQuarantine, retryQuarantined, withRetry } from "./quarantine.js";
import { recentHeaders } from "./recent.js";
import { createSnapshotPath } from "./snapshot.js";
import { strandedWrites, type StrandedWrites } from "./stranded.js";
import { mergeAhead } from "./sync.js";
import { type TelemetryEvent, type TelemetryListener } from "./telemetry.js";
import { createRevert, type Undo } from "./undo.js";
import { createWritePath, type OwnPositionApi } from "./writes.js";

export type { AtomicStores, EngineOptions } from "./options.js";

export interface MutateOptions {
  readonly partition?: PartitionKey;
  readonly local?: boolean;
  /**
   * Runs inside the same transaction as the append, once the event is built — the operation
   * record's seat (book ch. 10): record and event land together or neither does. A throw here
   * rolls the whole write back.
   */
  readonly record?: (event: SyncEvent) => Promise<void>;
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
  /** Unsigned own events, duplicates within the batch, and events already stored. */
  readonly skipped: number;
  /** Refused by validation; parked in the quarantine with the verdict, and never folded. */
  readonly quarantined: number;
}

export interface Quarantined {
  readonly event: SyncEvent;
  readonly reason: ValidationError;
}

export interface Engine extends FeedApi, RepairApi, SnapshotApi, OwnPositionApi {
  readonly peerId: PeerId;
  /** Records, stamps, numbers, appends, folds, then hands the event to `onOutbound` — a write is real once appended. */
  readonly mutate: (
    procedure: Procedure,
    fn: (tx: Tx) => void,
    options?: MutateOptions,
  ) => Promise<Result<SyncEvent, MutateError>>;
  /** Folds entries once each; already-stored events are skipped, and an own event only when unsigned (G7: a signed own event the log lacks is a write it lost). A relayed event keeps its author's signature — pass it. */
  readonly receiveBatch: (
    entries: readonly StoredEvent[],
  ) => Promise<Result<ReceiveReport, StoreFailure>>;
  readonly receive: (entry: StoredEvent) => Promise<Result<ReceiveReport, StoreFailure>>;
  readonly state: () => State;
  /** The visible rows of `table` that belong to `partition`. */
  readonly rowsIn: (table: TableName, partition: PartitionKey) => ReadonlyMap<RowKey, Row>;
  /**
   * The delete that is currently hiding the row — `undefined` for a row that is visible, and for
   * one this device has never held.
   *
   * The named way to ask a question the row reads cannot answer. A tombstoned record leaves every
   * read above it — {@link Engine.rowsIn}, `readRow`, and the app's own tables, which the storage
   * projection hard-deletes from — so *deleted* and *never heard of* arrive at a screen as the
   * same empty answer, and a detail view has no way to tell them apart. The record itself is kept
   * regardless, because a concurrent edit has to be able to beat the delete (RFC-0014 §1), so the
   * fact was always here; what was missing was a name for it.
   *
   * The stamp rather than a boolean, because it is what the kernel holds and both halves are real:
   * the peer is the **device** that deleted the row and the HLC is that device's clock. Neither is
   * an account and neither is this device's wall time, so what a screen can honestly draw from
   * this is that the row was deleted — the rest wants the event log to join against.
   */
  readonly deletedAt: (table: TableName, key: RowKey) => Stamp | undefined;
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
  /**
   * The same answer with the time it was given, which is the difference between "that peer is
   * behind" and "that peer has not been heard from since Tuesday". Both readings are diagnoses
   * and only one of them is about sync.
   *
   * {@link Engine.acks} stays as it is because nothing that consumes it — the compaction floor,
   * the link budget, churn — has any use for the stamp, and a Map they have to unwrap is a cost
   * paid on every sweep for one reader's benefit.
   */
  readonly acksAt: () => ReadonlyMap<PeerId, Ack>;
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
  /**
   * The log's tail as headers, newest first — what a log viewer reads, and the only read here
   * that shows a write which never left the device.
   *
   * {@link Engine.eventsSince} cannot answer this and should not be made to. It is anti-entropy's
   * question: ordered by author and sequence because that is how a peer walks a run, unbounded
   * because a peer wants everything it lacks, and confined to the synced half because no peer is
   * owed a local write. A person asking what this device has been doing wants the opposite of
   * all three.
   *
   * Headers rather than entries, so that reading the shape of the traffic cannot quietly become
   * reading its contents ({@link EventHeader}).
   */
  readonly recentEvents: (
    options?: RecentEvents,
  ) => Promise<Result<readonly EventHeader[], StoreFailure>>;
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
  /**
   * Every author this device holds writes for that it can never send — empty on a device that
   * has not rotated its key, which is almost all of them.
   *
   * The question a device has to be able to answer about itself. `openEngine` asks it once at
   * boot and reports what it finds on `onError`; this is the same answer on demand, for a screen
   * that wants it now rather than a listener that was attached too late. It reads the log rather
   * than a cache, so a rotation that happens while the process is running is visible to it.
   */
  readonly stranded: () => Promise<Result<readonly StrandedWrites[], StoreFailure>>;
  readonly onTelemetry: (listener: TelemetryListener) => Unsubscribe;
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
  if (options.onError !== undefined) errors.subscribe(options.onError);
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

  const { getState, setState, fold, persist, notify } = createFoldPath({
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
    row: (table, key) => readRow(getState(), table, key),
    records: (table) => getState().get(table),
    partition: (table, key) => getRecord(getState(), table, key)?.partition,
  } satisfies StateLookup;

  const snapshotDeps = {
    getState,
    setState,
    coverageOf: coverage.current,
    adopt: coverage.adopt,
    persist: (batch: FoldBatch) => persist(batch, stateStore),
    notify,
  };
  if (merge !== undefined) Object.assign(snapshotDeps, { merge });
  const snapshots = createSnapshotPath(snapshotDeps);

  const repair = createRepairPath({
    getState,
    mergeInto: (table, key, record) => setState(mergeRecord(getState(), table, key, record, merge)),
    persist: (batch) => persist(batch, stateStore),
    notify,
  });

  const { receiveBatch, ...writes } = createWritePath({
    peerId,
    clock,
    validate,
    before,
    undoDepth,
    undo,
    atomically,
    getState,
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

  const revert = createRevert({ undo, undoDepth, mutate: writes.mutate });

  const chains = createFeedPath({ store, feeds, receiveBatch });

  const receiveAndRetry = withRetry(receiveBatch, parked);

  return {
    peerId,
    ...writes,
    receiveBatch: receiveAndRetry,
    receive: (entry) => receiveAndRetry([entry]),
    ...chains,
    state: getState,
    rowsIn: (table, partition) => readRowsIn(getState(), table, partition),
    deletedAt: (table, key) => {
      const record = getRecord(getState(), table, key);
      // a visible row is not deleted even when it carries a tombstone: an edit stamped above the
      // delete is the CRDT's answer to a concurrent pair, and `isVisible` is where that is decided
      return record === undefined || isVisible(record) ? undefined : record.deleteStamp;
    },
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
    acksAt: () => new Map(acks),
    onAcknowledge: ackHub.subscribe,
    compact: (options) => compactLog({ store, stateStore, acks }, options),
    ...snapshots,
    eventsSince: (theirs, interest) => eventsWanted(store, theirs, interest),
    recentEvents: (options = {}) => store.recent?.(options) ?? recentHeaders(store, options),
    ...repair,
    onFoldBatch: folds.subscribe,
    onOutbound: outbound.subscribe,
    onError: errors.subscribe,
    quarantine: parked.list,
    retryQuarantined: () => retryQuarantined(parked, receiveAndRetry),
    onQuarantine: quarantine.subscribe,
    stranded: () => strandedWrites(store, peerId),
    onTelemetry: telemetry.subscribe,
  };
}

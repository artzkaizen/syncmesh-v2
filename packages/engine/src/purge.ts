import type {
  AdapterId,
  MergeSpec,
  PartitionKey,
  PeerId,
  RowKey,
  RowRecord,
  State,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { applyChange, docLineage, getRecord, eventStamp } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { CoverageTracker } from "./coverage.js";
import type { FoldBatch } from "./fold.js";
import type { Hub } from "./listeners.js";
import type { AtomicStores } from "./options.js";
import type { QuarantineStore } from "./quarantine.js";
import type { RowWrite, WriteKeys } from "./state-store.js";
import type { StoredEvent } from "./store.js";

import { foldable } from "./columns.js";
import { docAppends, recordDocs } from "./doc-log.js";
import { rowWrites } from "./state-store.js";
import { StoreFailure } from "./store.js";

/**
 * What a narrowed entitlement no longer covers on this device (D45): the held events it may no
 * longer read, and the held rows — a lost partition's, which may hold state no event still names.
 */
export interface PurgeScope {
  /**
   * Whether this device may no longer read a held event. Asked only of other devices' synced
   * events: this device's own writes are kept whatever the answer, because it wrote them, and one
   * not yet delivered may still be valid where it is going.
   */
  readonly events: (event: SyncEvent) => boolean;
  /** Whether this device may no longer read a held row; absent, only the events decide. */
  readonly rows?: (record: RowRecord) => boolean;
}

/**
 * What this device was just told it may no longer read (D45), as an app's `onNarrowed` hears it
 * before anything is removed.
 */
export interface Narrowed {
  /** Partitions this device's own grant named and its new one does not (D40). */
  readonly partitions: readonly PartitionKey[];
  /**
   * Authority-visibility tables (D24) the authority's gate now withholds rows of from this device,
   * with no partition changing: the relay re-paged it and did not send them again.
   */
  readonly tables: readonly TableName[];
}

/** What a purge took off this device. */
export interface Purged {
  /** Other devices' events deleted from the log, and from the quarantine. */
  readonly events: number;
  /**
   * Every row the purge touched: dropped, or rebuilt from the events this device still holds for
   * it — its own writes, and events of others the scope did not match.
   */
  readonly rows: WriteKeys;
  /** Those rows as they stood before the purge, for whatever the caller keeps beside them. */
  readonly before: readonly RowWrite[];
}

/** The engine's half of D45. */
export interface PurgeApi {
  /**
   * Forgets what a narrowed entitlement no longer covers (D45): other devices' events the scope
   * matches leave the log and the quarantine, and the rows they wrote — with any the scope names
   * directly — are dropped and rebuilt from what this device still holds, its own writes always
   * among it. Writes no event and lowers no cursor, only the held run custody receipts sign
   * (D32); listeners hear one fold with source `purge`.
   *
   * @example
   * ```ts
   * await engine.purge({
   *   events: (event) => event.partition === payroll,
   *   rows: (record) => record.partition === payroll,
   * });
   * ```
   */
  readonly purge: (scope: PurgeScope) => Promise<Result<Purged, StoreFailure>>;
}

export interface PurgeDeps {
  readonly peerId: PeerId;
  readonly merge?: MergeSpec | undefined;
  readonly hasAdapter: (adapter: AdapterId) => boolean;
  readonly parked: QuarantineStore;
  readonly coverageOf: CoverageTracker["current"];
  /** Takes the evicted events out of the held run, so the commit below persists it lowered. */
  readonly unhold: CoverageTracker["evict"];
  readonly getState: () => State;
  readonly setState: (next: State) => void;
  /** The stores in one transaction, with no write running beside it (the gate's exclusive turn). */
  readonly exclusive: <T>(fn: (scoped: AtomicStores) => Promise<T>) => Promise<T>;
  readonly folds: Hub<FoldBatch>;
}

/** One more row in a set of keys. */
const add = (keys: Map<TableName, Set<RowKey>>, table: TableName, key: RowKey): void => {
  const set = keys.get(table) ?? new Set<RowKey>();
  set.add(key);
  keys.set(table, set);
};

/**
 * Every row a purge touches: each one an evicted event's changes name, documents included, and
 * each held row the scope names directly.
 */
const rowsTouched = (
  evicted: readonly StoredEvent[],
  state: State,
  rows: PurgeScope["rows"],
): Map<TableName, Set<RowKey>> => {
  const keys = new Map<TableName, Set<RowKey>>();
  for (const { event } of evicted)
    for (const change of event.changes) if (foldable(change)) add(keys, change.table, change.key);
  if (rows === undefined) return keys;
  for (const [table, records] of state)
    for (const [key, record] of records) if (rows(record)) add(keys, table, key);
  return keys;
};

/** Takes the matching events out of the quarantine and answers how many there were. */
const unpark = (parked: QuarantineStore, gone: (event: SyncEvent) => boolean): number => {
  const all = parked.take();
  const kept = all.filter(({ entry }) => !gone(entry.event));
  for (const entry of kept) parked.park(entry);
  return all.length - kept.length;
};

/** `state` with `keys` refolded from the events still held for them, and nothing else. */
const rebuilt = (
  state: State,
  keys: WriteKeys,
  kept: readonly StoredEvent[],
  merge: MergeSpec | undefined,
): State => {
  let next = without(state, keys);
  for (const { event } of kept) {
    const stamp = eventStamp(event);
    for (const change of event.changes)
      if (foldable(change) && keys.get(change.table)?.has(change.key) === true)
        next = applyChange(next, change, stamp, merge, event.partition);
  }
  return next;
};

/** `state` without the rows in `keys`; only the tables they are in are copied. */
const without = (state: State, keys: WriteKeys): State => {
  const next = new Map(state);
  for (const [table, set] of keys) {
    const records = state.get(table);
    if (records === undefined) continue;
    next.set(table, new Map([...records].filter(([key]) => !set.has(key))));
  }
  return next;
};

/**
 * The purge D45 decides: a device whose entitlement narrowed forgets what it may no longer read.
 *
 * Other devices' events the scope matches leave the log — not only the rows — because the log is
 * what a boot refolds from when there is no state store, and an event left there would put the
 * row back on the next start. The rows they wrote, and the rows the scope names directly, are
 * dropped and rebuilt from the events still held for them: this device's own writes, kept because
 * it wrote them and because one not yet delivered may still be accepted where it is going; and
 * other events the scope did not match. A row nothing held still writes is gone. Doc logs of
 * those rows go with them, and are re-recorded from what is kept.
 *
 * It writes no event: the log of every other peer is untouched, and cursors are not lowered; the
 * held run a custody receipt signs (D32) is, below the lowest event evicted of each author. A
 * later widening is what brings the rows back — it re-pages this device from nothing (D23), and
 * the events, no longer in the log, fold again. Content that reached a row only through a
 * compaction of this device's own log, with no event left, is not rebuilt; that re-page restores
 * whatever its source still holds.
 */
export function createPurge(deps: PurgeDeps) {
  const { peerId, merge, hasAdapter, parked, coverageOf, getState, setState } = deps;

  return async (scope: PurgeScope): Promise<Result<Purged, StoreFailure>> => {
    const theirs = (event: SyncEvent): boolean =>
      event.local !== true && event.peerId !== peerId && scope.events(event);
    const stored = await Result.tryPromise({
      try: () =>
        deps.exclusive(async (scoped) => {
          const held = await scoped.events.all();
          if (held.isErr()) throw held.error;
          const evicted = held.value.filter(({ event }) => theirs(event));
          const keys = rowsTouched(evicted, getState(), scope.rows);
          if (keys.size === 0 && evicted.length === 0) return { events: 0, keys, before: [] };

          const gone = new Set(evicted.map(({ event }) => event.id));
          const touches = (event: SyncEvent): boolean =>
            event.changes.some((change) => keys.get(change.table)?.has(change.key) === true);
          const kept = held.value.filter(({ event }) => !gone.has(event.id) && touches(event));
          const docs = docAppends(
            kept.map(({ event }) => event),
            hasAdapter,
          ).filter(({ entry }) => keys.get(entry.table)?.has(entry.key) === true);

          const removed = await scoped.events.evict([...gone]);
          if (removed.isErr()) throw removed.error;
          // before the commit, which persists it: a holder signs no receipt for what it evicted
          deps.unhold(evicted.map(({ event }) => event));
          const drafted = rebuilt(getState(), keys, kept, merge);
          const writes = [
            await scoped.state?.remove(keys),
            await scoped.state?.commit(rowWrites(drafted, keys), coverageOf()),
            await scoped.docs?.forget(keys),
            scoped.docs === undefined
              ? undefined
              : await recordDocs(
                  scoped.docs,
                  docs,
                  (doc) => docLineage(getRecord(drafted, doc.table, doc.key), doc.column),
                  hasAdapter,
                ),
          ];
          for (const written of writes) if (written?.isErr() === true) throw written.error;
          // rebuilt again from the state as it is now, with no await before it is set: a snapshot
          // or a repair merged in while the stores were written is kept, outside the touched rows
          const current = getState();
          setState(rebuilt(current, keys, kept, merge));
          return { events: removed.value, keys, before: rowWrites(current, keys) };
        }),
      catch: (cause) =>
        cause instanceof StoreFailure
          ? cause
          : new StoreFailure({ message: "the purge did not commit", cause }),
    });
    if (stored.isErr()) return Result.err(stored.error);
    // after the commit, so a purge that failed leaves the quarantine as it was
    const dropped = unpark(parked, theirs);
    const { events, keys, before } = stored.value;
    if (keys.size > 0 || events > 0)
      deps.folds.emit({
        source: "purge",
        eventCount: events,
        writeTables: new Set(keys.keys()),
        writeKeys: keys,
      });
    return Result.ok({ events: events + dropped, rows: keys, before });
  };
}

import type { AdapterId, DocColumns, MergeSpec, RowKey, State, TableName } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { applyChange, getRecord, docLineage, eventStamp, isVisible } from "@syncmesh/kernel";

import type { CoverageTracker } from "./coverage.js";
import type { DocAddress, DocAppend, DocStore, LineageMove } from "./doc-log.js";
import type { EngineError } from "./errors.js";
import type { FeedTracker } from "./feed.js";
import type { Hub } from "./listeners.js";
import type { DerivedRow, DocColumnBytes, StateStore, WriteKeys } from "./state-store.js";
import type { StoreFailure, StoredEvent } from "./store.js";
import type { TelemetryEvent } from "./telemetry.js";

import { foldable } from "./columns.js";
import { docColumnWrites, docsReseated } from "./doc-column.js";
import { docAppends, recordDocs } from "./doc-log.js";
import { relabelMoved } from "./lineage-moves.js";
import { rowWrites, eventWriteKeys } from "./state-store.js";
import { timed } from "./telemetry.js";

/**
 * Where a batch came from; `repair` carries no cursors (RFC-0014), `snapshot` adopts them last
 * (RFC-0019), `purge` dropped rows this device may no longer read (D45). `derive` folds no event:
 * a replica wrote derived columns it computed from a document (RFC-0023 §16.4), and only the rows'
 * app tables moved.
 */
export type FoldSource = "local" | "remote" | "boot" | "repair" | "snapshot" | "purge" | "derive";

/** One notification per fold, however many events it covered. `writeKeys` is exact: live queries trust it. */
export interface FoldBatch {
  readonly source: FoldSource;
  readonly eventCount: number;
  readonly writeTables: ReadonlySet<TableName>;
  readonly writeKeys: ReadonlyMap<TableName, ReadonlySet<RowKey>>;
  /**
   * The doc changes the batch folded, as the doc-log entries they appended; absent when there were
   * none. A document handle watches these for remote updates — a doc edit moves no `writeKeys`.
   */
  readonly docs?: readonly DocAppend[];
  /**
   * The documents whose winning lineage a snapshot or repair moved by joining their lineage
   * cells, with no doc change behind it; absent when there were none. Their doc log is relabelled
   * in the batch's persist step (RFC-0023 §5.3).
   */
  readonly lineageMoves?: readonly LineageMove[];
  /**
   * The rows the batch made visible: absent or tombstoned before it, visible after — inserted, or
   * deleted and inserted again. The projection writes each afresh, so its derived columns start
   * over until a replica computes them (RFC-0023 §16.4); absent when there were none. A snapshot
   * or repair batch does not name them: every row it writes is rewritten.
   */
  readonly appeared?: WriteKeys;
}

export interface FoldDeps {
  readonly merge: MergeSpec | undefined;
  readonly coverage: CoverageTracker;
  readonly feeds: FeedTracker;
  readonly folds: Hub<FoldBatch>;
  readonly telemetry: Hub<TelemetryEvent>;
  readonly errors: Hub<EngineError>;
  /** True when writes run inside a transaction, where a refused state commit must abort it. */
  readonly atomic: boolean;
  readonly initial: State;
  /**
   * Whether this build can materialise a column merged by `adapter`. It moves only how a doc
   * entry is labelled — `tail` or `adapter-missing` — and never what folds (RFC-0023 §6.4).
   */
  readonly hasAdapter: (adapter: AdapterId) => boolean;
  /**
   * The schema's document columns: a row the batch inserts or rewrites, and a document whose
   * winning lineage it moves, has its column's bytes written again from the snapshot held
   * (RFC-0023 §6.1).
   */
  readonly docs?: DocColumns | undefined;
}

/** Where a fold's persist step writes: the state cache and the doc log, whichever the engine has. */
export interface PersistInto {
  readonly state?: StateStore | undefined;
  readonly docs?: DocStore | undefined;
}

/**
 * The three steps every source of rows shares — fold, persist, notify — and the state they move.
 *
 * They are one seam and not three because their **order** is the contract: rows are committed
 * inside the write's transaction and listeners are called after it, so a live query that re-reads
 * a table on notification never sees a row the transaction went on to roll back. Every caller
 * that writes state — a mutation, a received batch, a snapshot install, a repair — takes these
 * three, which is what keeps that order from being re-decided once per caller.
 */
export interface FoldPath {
  readonly getState: () => State;
  readonly setState: (next: State) => void;
  /**
   * Folds events into state, advancing each author's cursor and feed chain as they land.
   *
   * Entries rather than bare events, because the feed chain is a hash of the bytes the author
   * signed and the entry is the only thing that still holds them.
   */
  readonly fold: (entries: readonly StoredEvent[], source: FoldSource) => FoldBatch;
  /**
   * Writes the rows a fold touched to the state store. A failure is reported, not returned: the
   * log already holds the truth — unless the write runs inside `atomic`, where it fails the
   * transaction and takes the append down with it.
   */
  readonly persist: (batch: FoldBatch, into: PersistInto) => Promise<void>;
  /**
   * Writes the coverage alone, with no rows: what a snapshot install does once it has adopted, so
   * the cursors and the floor it raised outlive a restart without waiting for the next fold (D46).
   * Reported as `persist` reports, and resolves `true` only when a state store committed it.
   */
  readonly persistCoverage: (into: PersistInto) => Promise<boolean>;
  /** After the transaction, so a listener that re-reads the tables (D20) sees committed rows. */
  readonly notify: (batch: FoldBatch) => void;
  /**
   * Writes derived values into the app's rows (RFC-0023 §16.4), reported as `persist` reports: a
   * failure inside `atomic` fails the transaction, outside it reaches `onError`.
   */
  readonly derive: (rows: readonly DerivedRow[], into: PersistInto) => Promise<void>;
  /** After the derived write's transaction: one `derive` batch naming the rows it wrote. */
  readonly notifyDerived: (rows: readonly DerivedRow[]) => void;
  /**
   * Writes document columns' snapshots into the app's rows (RFC-0023 §6.1), reported as `persist`
   * reports.
   */
  readonly writeDocColumns: (writes: readonly DocColumnBytes[], into: PersistInto) => Promise<void>;
}

/** The keys derived values were written under, joined onto what a fold already touched. */
export function withDerivedKeys(batch: FoldBatch, rows: readonly DerivedRow[]): FoldBatch {
  if (rows.length === 0) return batch;
  const keys = new Map([...batch.writeKeys].map(([table, set]) => [table, new Set(set)]));
  for (const { table, key } of rows) keys.set(table, (keys.get(table) ?? new Set()).add(key));
  return { ...batch, writeTables: new Set(keys.keys()), writeKeys: keys };
}

/** The keys whose rows `state` does not show — or, with `shown`, the ones it does. */
function hiddenKeys(state: State, keys: WriteKeys, shown = false): WriteKeys {
  const out = new Map<TableName, Set<RowKey>>();
  for (const [table, set] of keys)
    for (const key of set) {
      const record = getRecord(state, table, key);
      if ((record !== undefined && isVisible(record)) !== shown) continue;
      out.set(table, (out.get(table) ?? new Set()).add(key));
    }
  return out;
}

const NO_KEYS: FoldBatch = {
  source: "derive",
  eventCount: 0,
  writeTables: new Set(),
  writeKeys: new Map(),
};

export function createFoldPath(deps: FoldDeps): FoldPath {
  const { merge, coverage, feeds, folds, telemetry, errors, atomic, initial, hasAdapter, docs } =
    deps;
  let state = initial;
  const report = (written: Result<void, StoreFailure>) => {
    if (written.isOk()) return;
    if (atomic) throw written.error;
    errors.emit(written.error);
  };

  const fold = (entries: readonly StoredEvent[], source: FoldSource): FoldBatch => {
    const [batch, duration] = timed((): FoldBatch => {
      const writeKeys = eventWriteKeys(entries.map((entry) => entry.event));
      const hidden = hiddenKeys(state, writeKeys);
      for (const entry of entries) {
        const { event } = entry;
        coverage.note(event);
        feeds.note(entry);
        const stamp = eventStamp(event);
        // `admit` parked anything this build cannot fold before it reached here (D22-A); the
        // guard is what narrows the type, and reaching it at all would be that ladder failing
        for (const change of event.changes)
          if (foldable(change)) state = applyChange(state, change, stamp, merge, event.partition);
      }
      const docs = docAppends(
        entries.map((entry) => entry.event),
        hasAdapter,
      );
      const appeared = hiddenKeys(state, hidden, true);
      return {
        source,
        eventCount: entries.length,
        writeTables: new Set(writeKeys.keys()),
        writeKeys,
        ...(docs.length > 0 && { docs }),
        ...(appeared.size > 0 && { appeared }),
      };
    });
    if (entries.length === 0) return batch;
    const keys = [...batch.writeKeys.values()].reduce((n, set) => n + set.size, 0);
    telemetry.emit({ type: "engine.fold", sizes: { events: entries.length, keys }, duration });
    // a boot fold has no persist step of its own; every other fold notifies after it (persist)
    if (source === "boot") folds.emit(batch);
    return batch;
  };

  return {
    getState: () => state,
    setState: (next) => void (state = next),
    fold,
    persist: async (batch, into) => {
      if (batch.eventCount === 0 || into === undefined) return;
      if (into.state !== undefined)
        report(await into.state.commit(rowWrites(state, batch.writeKeys), coverage.current()));
      const docWinner = (doc: DocAddress) =>
        docLineage(getRecord(state, doc.table, doc.key), doc.column);
      if (into.docs !== undefined && batch.docs !== undefined)
        report(await recordDocs(into.docs, batch.docs, docWinner, hasAdapter));
      if (into.docs !== undefined && batch.lineageMoves !== undefined)
        report(await relabelMoved(into.docs, batch.lineageMoves, docWinner, hasAdapter));
      // after the relabel: the column follows the lineage the doc log now says wins
      const reseated = docsReseated(batch, docs);
      if (
        into.docs !== undefined &&
        into.state?.writeDocColumns !== undefined &&
        reseated.length > 0
      ) {
        const writes = await docColumnWrites(into.docs, reseated, docWinner);
        report(writes.isOk() ? await into.state.writeDocColumns(writes.value) : writes);
      }
    },
    persistCoverage: async (into) => {
      if (into.state === undefined) return false;
      const committed = await into.state.commit([], coverage.current());
      report(committed);
      return committed.isOk();
    },
    notify: (batch) => {
      if (batch.eventCount > 0) folds.emit(batch);
    },
    derive: async (rows, into) => {
      const derive = into.state?.derive;
      if (rows.length > 0 && derive !== undefined) report(await derive(rows));
    },
    notifyDerived: (rows) => {
      if (rows.length > 0) folds.emit(withDerivedKeys(NO_KEYS, rows));
    },
    writeDocColumns: async (writes, into) => {
      const write = into.state?.writeDocColumns;
      if (writes.length > 0 && write !== undefined) report(await write(writes));
    },
  };
}

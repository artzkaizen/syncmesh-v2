import type { AdapterId, MergeSpec, RowKey, State, TableName } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";

import { applyChange, getRecord, lineageOf, stampOf } from "@syncmesh/kernel";

import type { CoverageTracker } from "./coverage.js";
import type { DocStore } from "./doc-log.js";
import type { DocAppend } from "./doc-log.js";
import type { EngineError } from "./errors.js";
import type { FeedTracker } from "./feed.js";
import type { Hub } from "./listeners.js";
import type { StateStore } from "./state-store.js";
import type { StoreFailure, StoredEvent } from "./store.js";
import type { TelemetryEvent } from "./telemetry.js";

import { foldable } from "./columns.js";
import { docAppends, recordDocs } from "./doc-log.js";
import { rowsFor, writeKeysOf } from "./state-store.js";
import { timed } from "./telemetry.js";

/** Where a batch came from; `repair` carries no cursors (RFC-0014), `snapshot` adopts them last (RFC-0019). */
export type FoldSource = "local" | "remote" | "boot" | "repair" | "snapshot";

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
  readonly stateOf: () => State;
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
  /** After the transaction, so a listener that re-reads the tables (D20) sees committed rows. */
  readonly notify: (batch: FoldBatch) => void;
}

export function createFoldPath(deps: FoldDeps): FoldPath {
  const { merge, coverage, feeds, folds, telemetry, errors, atomic, initial, hasAdapter } = deps;
  let state = initial;

  const fold = (entries: readonly StoredEvent[], source: FoldSource): FoldBatch => {
    const [batch, duration] = timed((): FoldBatch => {
      const writeKeys = writeKeysOf(entries.map((entry) => entry.event));
      for (const entry of entries) {
        const { event } = entry;
        coverage.note(event);
        feeds.note(entry);
        const stamp = stampOf(event);
        // `admit` parked anything this build cannot fold before it reached here (D22-A); the
        // guard is what narrows the type, and reaching it at all would be that ladder failing
        for (const change of event.changes)
          if (foldable(change)) state = applyChange(state, change, stamp, merge, event.partition);
      }
      const docs = docAppends(
        entries.map((entry) => entry.event),
        hasAdapter,
      );
      return {
        source,
        eventCount: entries.length,
        writeTables: new Set(writeKeys.keys()),
        writeKeys,
        ...(docs.length > 0 && { docs }),
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
    stateOf: () => state,
    setState: (next) => void (state = next),
    fold,
    persist: async (batch, into) => {
      if (batch.eventCount === 0) return;
      const report = (written: Result<void, StoreFailure>) => {
        if (written.isOk()) return;
        if (atomic) throw written.error;
        errors.emit(written.error);
      };
      if (into.state !== undefined)
        report(await into.state.commit(rowsFor(state, batch.writeKeys), coverage.current()));
      if (into.docs !== undefined && batch.docs !== undefined)
        report(
          await recordDocs(
            into.docs,
            batch.docs,
            (doc) => lineageOf(getRecord(state, doc.table, doc.key), doc.column),
            hasAdapter,
          ),
        );
    },
    notify: (batch) => {
      if (batch.eventCount > 0) folds.emit(batch);
    },
  };
}

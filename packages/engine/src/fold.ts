import type { MergeSpec, State } from "@syncmesh/kernel";

import { applyChange, stampOf } from "@syncmesh/kernel";

import type { CoverageTracker } from "./coverage.js";
import type { FoldBatch, FoldSource } from "./engine.js";
import type { EngineError } from "./errors.js";
import type { FeedTracker } from "./feed.js";
import type { Hub } from "./listeners.js";
import type { StateStore } from "./state-store.js";
import type { StoredEvent } from "./store.js";
import type { TelemetryEvent } from "./telemetry.js";

import { foldable } from "./columns.js";
import { rowsFor, writeKeysOf } from "./state-store.js";
import { timed } from "./telemetry.js";

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
  readonly persist: (batch: FoldBatch, into: StateStore | undefined) => Promise<void>;
  /** After the transaction, so a listener that re-reads the tables (D20) sees committed rows. */
  readonly notify: (batch: FoldBatch) => void;
}

export function createFoldPath(deps: FoldDeps): FoldPath {
  const { merge, coverage, feeds, folds, telemetry, errors, atomic, initial } = deps;
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
      return {
        source,
        eventCount: entries.length,
        writeTables: new Set(writeKeys.keys()),
        writeKeys,
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
      if (batch.eventCount === 0 || into === undefined) return;
      const written = await into.commit(rowsFor(state, batch.writeKeys), coverage.current());
      if (written.isErr()) {
        if (atomic) throw written.error;
        errors.emit(written.error);
      }
    },
    notify: (batch) => {
      if (batch.eventCount > 0) folds.emit(batch);
    },
  };
}

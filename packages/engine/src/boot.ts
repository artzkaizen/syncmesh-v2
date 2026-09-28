import type { State } from "@syncmesh/kernel";

import { emptyState, getRecord, lineageOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Engine, EngineOptions } from "./engine.js";
import type { StateStore } from "./state-store.js";
import type { EventStore, StoreFailure, StoredEvent } from "./store.js";
import type { Coverage } from "./sync.js";

import { docAppends, recordDocs } from "./doc-log.js";
import { createEngine } from "./engine.js";
import { StateCorrupt, allRows, rowsFor, writeKeysOf } from "./state-store.js";
import { strandedWrites } from "./stranded.js";
import { EMPTY_COVERAGE } from "./sync.js";

/** What `createEngine` starts from: persisted state, what it covers, and the log tail above it. */
export interface Boot {
  readonly state: State;
  readonly coverage: Coverage;
  /** Entries, not events: the feed chain a boot rebuilds is over the bytes each author signed. */
  readonly replay: readonly StoredEvent[];
}

interface Cached {
  readonly state: State;
  readonly coverage: Coverage;
}

/**
 * Boots an engine over its stores: opens persisted state when there is one, folds only the log above
 * its coverage, and moves the clock past the highest stored stamp before any write is numbered.
 * A corrupt or absent state store is rebuilt from the whole log — unless the log has been compacted,
 * in which case boot fails with `StateCorrupt` rather than open a partial state.
 *
 * **It also audits the log for writes this device can never send** ({@link StrandedWrites}) and
 * reports them on `options.onError`. Boot is the moment that matters: opening a log under a key
 * different from the one that wrote part of it is what strands those events, and it is the last
 * point at which anybody could still be told. It reports rather than refuses — every database
 * this has already happened to would be bricked by a refusal, and the events are folded and
 * standing in the state either way — so a caller that wants to *stop* is told in time to.
 */
export function openEngine(
  options: EngineOptions,
): Promise<Result<Engine, StoreFailure | StateCorrupt>> {
  const { store, stateStore, clock } = options;
  return Result.gen(async function* () {
    for (const report of yield* Result.await(strandedWrites(store, options.peerId)))
      options.onError?.(report);
    const cached =
      stateStore === undefined ? undefined : yield* Result.await(load(store, stateStore));
    const state = cached?.state ?? emptyState();
    const coverage = cached?.coverage ?? EMPTY_COVERAGE;
    const synced = yield* Result.await(store.allSince(coverage.synced, "synced"));
    const local = yield* Result.await(store.allSince(coverage.local, "local"));
    const replay = [...synced, ...local];
    const max = yield* Result.await(store.maxHlc());
    if (max !== undefined) clock.receive(max);

    const engine = createEngine({ ...options, boot: { state, coverage, replay } });
    if (stateStore !== undefined) {
      const rows =
        cached === undefined
          ? allRows(engine.state())
          : rowsFor(engine.state(), writeKeysOf(replay.map((entry) => entry.event)));
      if (cached === undefined || rows.length > 0)
        yield* Result.await(stateStore.commit(rows, engine.coverage()));
    }
    // the replayed tail's doc entries, for a log that was appended outside a transaction with them;
    // a re-append of what is already there is a no-op, so an atomic store loses nothing by it
    const { docStore, docAdapters } = options;
    if (docStore !== undefined) {
      const state = engine.state();
      yield* Result.await(
        recordDocs(
          docStore,
          docAppends(
            replay.map((entry) => entry.event),
            (adapter) => docAdapters?.has(adapter) === true,
          ),
          (doc) => lineageOf(getRecord(state, doc.table, doc.key), doc.column),
          (adapter) => docAdapters?.has(adapter) === true,
        ),
      );
    }
    return Result.ok(engine);
  });
}

/** The cache if it is usable; `undefined` when it is empty or was corrupt and has been cleared. */
function load(
  store: EventStore,
  stateStore: StateStore,
): Promise<Result<Cached | undefined, StoreFailure | StateCorrupt>> {
  return Result.gen(async function* () {
    /**
     * Whether the log can still answer for everything, which is what "rebuild it from the log"
     * quietly assumes.
     *
     * Compaction deletes events once the state that stood for them was persisted, so a log with a
     * floor above zero **is not** a complete history: replaying it rebuilds whatever sits above
     * the floor and silently drops the rest. Refusing is the only honest answer — the rows are on
     * a peer, and `rejoin` is how this device gets them.
     */
    const floors = yield* Result.await(store.compactedBelow());
    const partial = floors.synced.size > 0 || floors.local.size > 0;

    /**
     * **An absent state store is checked too, and this used to return before it was.**
     *
     * The corrupt path below has always asked; the empty one went straight to a full replay. For
     * most of this system's life those were the same thing, because an empty state store meant a
     * database nobody had written yet and a fresh log has no floor. It stops being the same thing
     * the moment the state store can be *discarded* — a schema change that opens a new state file
     * (RFC-0022), an operator clearing a cache — and then the difference is a device that rebuilds
     * two thirds of its rows and reports itself healthy.
     */
    if (yield* Result.await(stateStore.isEmpty())) {
      if (partial)
        return Result.err(
          new StateCorrupt({
            message:
              "there is no folded state and the log is compacted below what would rebuild it — rejoin from a peer",
          }),
        );
      return Result.ok(undefined);
    }
    const loaded = Result.all([await stateStore.loadAll(), await stateStore.loadCursors()]);
    if (loaded.isOk()) {
      const [state, coverage] = loaded.value;
      return Result.ok({ state, coverage });
    }
    if (loaded.error._tag === "StoreFailure") return Result.err(loaded.error);
    if (partial) {
      return Result.err(
        new StateCorrupt({
          message: `${loaded.error.message}; the log is compacted below it — rejoin from a peer`,
        }),
      );
    }
    yield* Result.await(stateStore.clear());
    return Result.ok(undefined);
  });
}

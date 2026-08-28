import type { State } from "@syncmesh/kernel";

import { emptyState } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { Engine, EngineOptions } from "./engine.js";
import type { StateStore } from "./state-store.js";
import type { EventStore, StoreFailure, StoredEvent } from "./store.js";
import type { Coverage } from "./sync.js";

import { createEngine } from "./engine.js";
import { StateCorrupt, allRows, rowsFor, writeKeysOf } from "./state-store.js";
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
 */
export function openEngine(
  options: EngineOptions,
): Promise<Result<Engine, StoreFailure | StateCorrupt>> {
  const { store, stateStore, clock } = options;
  return Result.gen(async function* () {
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
    return Result.ok(engine);
  });
}

/** The cache if it is usable; `undefined` when it is empty or was corrupt and has been cleared. */
function load(
  store: EventStore,
  stateStore: StateStore,
): Promise<Result<Cached | undefined, StoreFailure | StateCorrupt>> {
  return Result.gen(async function* () {
    if (yield* Result.await(stateStore.isEmpty())) return Result.ok(undefined);
    const loaded = Result.all([await stateStore.loadAll(), await stateStore.loadCursors()]);
    if (loaded.isOk()) {
      const [state, coverage] = loaded.value;
      return Result.ok({ state, coverage });
    }
    if (loaded.error._tag === "StoreFailure") return Result.err(loaded.error);
    const floors = yield* Result.await(store.compactedBelow());
    if (floors.synced.size > 0 || floors.local.size > 0) {
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

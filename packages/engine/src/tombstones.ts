import type {
  DocColumns,
  Hlc,
  PeerId,
  RowKey,
  RowRecord,
  Stamp,
  State,
  TableName,
} from "@syncmesh/kernel";

import { compareHlc, getRecord, isVisible } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AtomicStores } from "./options.js";
import type { WriteKeys } from "./state-store.js";
import type { EventStore } from "./store.js";
import type { Cursors } from "./sync.js";

import { StoreFailure } from "./store.js";

/**
 * The stamp every tombstone compaction may collect is at or below (gaps O1): the oldest of the
 * stamps compaction removed each author's events up to, over every author the state holds
 * events from. Absent when any of them has no such stamp — nothing is collected until each has.
 *
 * Why it is safe: an author's stamps rise with its sequence, so an event of `a` not yet folded
 * here is above `a`'s floor stamp, which is at or above this one. Every event stamped at or below
 * it is under its author's floor, which compaction raises only once every counted peer has acked
 * it — so every counted peer holds the delete, and no event any author has yet to deliver can
 * reach the row with a stamp that loses to it.
 */
export const tombstoneFrontier = (
  authors: Iterable<PeerId>,
  stamps: ReadonlyMap<PeerId, Hlc>,
): Hlc | undefined => {
  let frontier: Hlc | undefined;
  for (const author of authors) {
    const stamp = stamps.get(author);
    if (stamp === undefined) return undefined;
    if (frontier === undefined || compareHlc(stamp, frontier) < 0) frontier = stamp;
  }
  return frontier;
};

/**
 * The stamp of the delete that hides a row, or `undefined` for a row that is visible or absent —
 * collected, or never written. A visible row is not deleted even when it carries a delete stamp:
 * an edit stamped above the delete is the CRDT's answer to a concurrent pair (`isVisible`).
 */
export const deleteStamp = (state: State, table: TableName, key: RowKey): Stamp | undefined => {
  const record = getRecord(state, table, key);
  return record === undefined || isVisible(record) ? undefined : record.deleteStamp;
};

/** Whether a tombstone is settled under `frontier`: every stamp it carries at or below it. */
const settled = (record: RowRecord, frontier: Hlc): boolean => {
  const below = (hlc: Hlc) => compareHlc(hlc, frontier) <= 0;
  if (record.deleteStamp === undefined || !below(record.deleteStamp.hlc)) return false;
  if (record.writeStamp !== undefined && !below(record.writeStamp.hlc)) return false;
  for (const cell of record.cells.values()) if (!below(cell.stamp.hlc)) return false;
  return true;
};

/**
 * The tombstones of `state` among `candidates` that compaction may collect under `frontier`:
 * deleted and not written since, every stamp settled, in a table with no document column (a
 * collected row would take its lineage with it, and its doc log is not compaction's to drop).
 */
export function collectable(
  state: State,
  candidates: WriteKeys,
  frontier: Hlc,
  docs: DocColumns | undefined,
): WriteKeys {
  const keys = new Map<TableName, Set<RowKey>>();
  for (const [table, set] of candidates) {
    if (docs?.has(table) === true) continue;
    for (const key of set) {
      const record = getRecord(state, table, key);
      if (record === undefined || isVisible(record) || !settled(record, frontier)) continue;
      keys.set(table, (keys.get(table) ?? new Set()).add(key));
    }
  }
  return keys;
}

export interface CollectDeps {
  readonly store: EventStore;
  readonly docs: DocColumns | undefined;
  /** The authors the state holds events from: every author with a synced cursor. */
  readonly authors: () => Cursors;
  readonly getState: () => State;
  readonly tombstones: () => WriteKeys;
  readonly forget: (keys: WriteKeys) => void;
  /** The engine's exclusive turn, so no fold writes a row between its check and its removal. */
  readonly exclusive: <T>(fn: (stores: AtomicStores) => Promise<T>) => Promise<T>;
}

/**
 * Drops every tombstone settled under the frontier from the state and the state store; answers
 * how many rows went. A store that keeps no floor stamps collects nothing.
 */
export const collectTombstones = (deps: CollectDeps): Promise<Result<number, StoreFailure>> =>
  Result.gen(async function* () {
    if (deps.store.compactedStamps === undefined) return Result.ok(0);
    const stamps = yield* Result.await(deps.store.compactedStamps());
    const frontier = tombstoneFrontier(deps.authors().keys(), stamps);
    if (frontier === undefined) return Result.ok(0);
    const removed = yield* Result.await(
      Result.tryPromise({
        try: () =>
          deps.exclusive(async (scoped) => {
            const keys = collectable(deps.getState(), deps.tombstones(), frontier, deps.docs);
            if (keys.size === 0) return 0;
            const gone = await scoped.state?.remove(keys);
            if (gone?.isErr() === true) throw gone.error;
            deps.forget(keys);
            return [...keys.values()].reduce((n, set) => n + set.size, 0);
          }),
        catch: (cause) =>
          cause instanceof StoreFailure
            ? cause
            : new StoreFailure({ message: "collecting tombstones did not commit", cause }),
      }),
    );
    return Result.ok(removed);
  });

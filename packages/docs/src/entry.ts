import type { DocAddress, DocAppend } from "@syncmesh/engine";
import type { LineageId, PartitionKey, Procedure, SyncEvent } from "@syncmesh/kernel";

import { getRecord, docLineage } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { bytesEqual } from "@syncmesh/wire";

import type { AnyAdapter, UpdateRejected } from "./adapter.js";
import type { Derive, DocsEngine } from "./materialise.js";

import { FlushRefused, HandleInvalidated, UpdateTooLarge } from "./errors.js";

/** Where an open document stands against the log (RFC-0023 §4.3). */
export type DocStatus = "current" | "behind" | "invalidated";

export type FlushError = UpdateTooLarge | FlushRefused | HandleInvalidated;

/** One open replica, however many handles share it. */
export interface Entry {
  readonly adapter: AnyAdapter;
  /** The lineage the replica was loaded on; a genesis that moves it invalidates the handle. */
  readonly lineage: LineageId | undefined;
  readonly doc: unknown;
  refs: number;
  status: DocStatus;
  /** The version last exported; what the next flush is `since`. */
  flushed: Uint8Array;
  /** Local updates exported ahead of a remote apply, waiting for the next flush. */
  readonly stash: Uint8Array[];
  readonly listeners: Set<() => void>;
  readonly stop: () => void;
  timers: { idle?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout> };
}

const notify = (entry: Entry) => {
  for (const listener of entry.listeners) listener();
};

/** The winning lineage of the document `address` names, as this engine's state holds it. */
const winnerAt = (engine: DocsEngine, address: DocAddress) =>
  docLineage(getRecord(engine.state(), address.table, address.key), address.column);

/**
 * Applies one document's folded changes to its open replica, unless the winning lineage moved off
 * the one the replica was loaded on (§5.3): two histories never share a replica, so the handle is
 * invalidated and the app reopens.
 */
export function deliver(engine: DocsEngine, held: Entry, appends: readonly DocAppend[]) {
  const [first] = appends;
  if (first === undefined || held.status === "invalidated") return;
  if (winnerAt(engine, first.entry) !== held.lineage) return invalidate(held);
  const live = appends.filter(
    ({ entry }) => entry.state !== "orphaned" && entry.lineage === held.lineage,
  );
  applyTo(
    held,
    live.flatMap(({ update }) => (update.bytes === undefined ? [] : [update.bytes])),
  );
}

/** Folded updates onto an open replica; a refused one stays in the log, `failed` when materialised (§10). */
function applyTo(entry: Entry, updates: readonly Uint8Array[]) {
  if (updates.length === 0) return;
  // local ops that could not be exported would no longer be told apart from the folded ones
  if (stashLocal(entry).isErr()) return invalidate(entry);
  const applied = entry.adapter.apply(entry.doc, updates);
  entry.flushed = entry.adapter.version(entry.doc);
  if (applied.isOk() && applied.value) notify(entry);
}

// export what is pending, so a remote apply that follows never rides along in our next flush
const stashLocal = (entry: Entry): Result<void, UpdateRejected> => {
  if (bytesEqual(entry.adapter.version(entry.doc), entry.flushed)) return Result.ok(undefined);
  return entry.adapter.since(entry.doc, entry.flushed).map((bytes) => {
    entry.stash.push(bytes);
    entry.flushed = entry.adapter.version(entry.doc);
  });
};

const invalidate = (entry: Entry) => {
  entry.status = "invalidated";
  entry.stop();
  clearTimers(entry);
  notify(entry);
};

/**
 * Sends what the handle committed since its last flush as one event: a doc change per stashed
 * part. The row's derived columns, computed from the replica that holds exactly what is sent, land
 * in the same write's transaction (RFC-0023 §6.3), so a live query reads the title with the edit.
 */
export async function flush(
  engine: DocsEngine,
  procedure: Procedure,
  address: DocAddress,
  entry: Entry,
  derive?: Derive<unknown>,
): Promise<Result<SyncEvent | undefined, FlushError>> {
  clearTimers(entry);
  if (entry.status === "invalidated")
    return Result.err(new HandleInvalidated({ message: "this document handle was invalidated" }));
  // a genesis that folded since the replica was loaded: its history would land on another lineage
  if (winnerAt(engine, address) !== entry.lineage) {
    invalidate(entry);
    return Result.err(
      new HandleInvalidated({ message: "another lineage of this document won; reopen it" }),
    );
  }
  const stashed = stashLocal(entry);
  if (stashed.isErr()) {
    invalidate(entry);
    return Result.err(
      new FlushRefused({ message: "the adapter could not export the burst", cause: stashed.error }),
    );
  }
  const parts = entry.stash.splice(0);
  if (parts.length === 0) return Result.ok(undefined);
  const limit = entry.adapter.limits.maxUpdateBytes;
  const over = parts.find((p) => p.length > limit);
  if (over !== undefined) {
    invalidate(entry);
    return Result.err(
      new UpdateTooLarge({
        size: over.length,
        limit,
        message: "the burst is over the inline bound",
      }),
    );
  }
  const record = getRecord(engine.state(), address.table, address.key);
  const { lineage } = entry;
  const derived = derive?.(entry.doc);
  const written = await engine.mutate(
    procedure,
    (tx) => {
      for (const bytes of parts)
        tx.doc(address.table, address.key, {
          column: address.column,
          adapter: entry.adapter.id,
          update: { bytes },
          ...(lineage !== undefined && { lineage }),
        });
    },
    {
      ...partitionOption(record?.partition),
      ...(derived !== undefined && {
        derived: [{ table: address.table, key: address.key, values: derived }],
      }),
    },
  );
  if (written.isErr()) {
    invalidate(entry);
    return Result.err(
      new FlushRefused({ message: "the engine refused the flush", cause: written.error }),
    );
  }
  return Result.ok(written.value);
}

export const clearTimers = (entry: Entry) => {
  if (entry.timers.idle !== undefined) clearTimeout(entry.timers.idle);
  if (entry.timers.max !== undefined) clearTimeout(entry.timers.max);
  entry.timers = {};
};

const partitionOption = (partition: PartitionKey | undefined) =>
  partition === undefined ? {} : { partition };

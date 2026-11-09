import type { DocAddress, DocAppend, DocEntryRef } from "@syncmesh/engine";
import type {
  DocBlobRef,
  DocChange,
  LineageId,
  PartitionKey,
  Procedure,
  SyncEvent,
} from "@syncmesh/kernel";

import { docEntryId } from "@syncmesh/engine";
import { getRecord, docLineage } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { bytesEqual } from "@syncmesh/wire";

import type { AnyAdapter, UpdateRejected } from "./adapter.js";
import type { DocBlobs } from "./blobs.js";
import type { BlobUnavailable, UpdateTooLarge } from "./errors.js";
import type { Derive, DocsEngine } from "./materialise.js";

import { carry, fetchUpdate } from "./blobs.js";
import { FlushRefused, HandleInvalidated } from "./errors.js";

/** Where an open document stands against the log (RFC-0023 §4.3). */
export type DocStatus = "current" | "behind" | "invalidated";

export type FlushError = UpdateTooLarge | FlushRefused | HandleInvalidated | BlobUnavailable;

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
  /**
   * The doc-log entries of its lineage the replica was given — loaded, delivered, or its own
   * flushes coming back — whether the adapter took them or not: what derived values computed
   * from it include (RFC-0023 §16.4).
   */
  readonly seen: Map<string, DocEntryRef>;
  readonly listeners: Set<() => void>;
  readonly stop: () => void;
  timers: { idle?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout> };
}

/** Blob-carried updates each replica is still fetching: while any is, the replica is `behind`. */
const fetching = new WeakMap<Entry, number>();

/**
 * Keeps a replica `behind` for `missing` blob-carried updates its load could not fetch: they wait
 * for the next open or materialisation, and no later delivery marks the replica `current` meanwhile.
 */
export const holdBehind = (entry: Entry, missing: number) => {
  if (missing > 0) fetching.set(entry, (fetching.get(entry) ?? 0) + missing);
};

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
export function deliver(
  engine: DocsEngine,
  held: Entry,
  appends: readonly DocAppend[],
  blobs?: DocBlobs,
) {
  const [first] = appends;
  if (first === undefined || held.status === "invalidated") return;
  if (winnerAt(engine, first.entry) !== held.lineage) return invalidate(held);
  const live = appends.filter(
    ({ entry }) => entry.state !== "orphaned" && entry.lineage === held.lineage,
  );
  for (const { entry } of live) held.seen.set(docEntryId(entry), entry);
  applyTo(
    held,
    live.flatMap(({ update }) => (update.bytes === undefined ? [] : [update.bytes])),
  );
  for (const { entry, update } of live)
    if (update.blob !== undefined) void deliverBlob(engine, held, entry, update.blob, blobs);
}

/**
 * A blob-carried update reaches an open replica once its bytes are fetched (RFC-0023 §5.4) — on
 * the lineage it was folded on, and only while the replica is still on it; until then the
 * document is `behind`. One no carrier holds yet waits for the next open or materialisation.
 */
async function deliverBlob(
  engine: DocsEngine,
  held: Entry,
  entry: DocAppend["entry"],
  blob: DocBlobRef,
  blobs: DocBlobs | undefined,
) {
  if (blobs === undefined) return;
  fetching.set(held, (fetching.get(held) ?? 0) + 1);
  if (held.status === "current") {
    held.status = "behind";
    notify(held);
  }
  const bytes = await fetchUpdate(blobs, blob);
  const left = (fetching.get(held) ?? 1) - 1;
  fetching.set(held, left);
  if (held.status === "invalidated" || winnerAt(engine, entry) !== held.lineage) return;
  if (bytes === undefined) return;
  applyTo(held, [bytes]);
  if (left === 0 && held.status === "behind" && !held.adapter.pending(held.doc)) {
    held.status = "current";
    notify(held);
  }
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

/** Whether the replica holds local operations no flush has exported yet. */
export const unflushed = (entry: Entry) =>
  entry.stash.length > 0 || !bytesEqual(entry.adapter.version(entry.doc), entry.flushed);

/** Stops a replica for good: its handles refuse every flush, and the app reopens the document. */
export const invalidate = (entry: Entry) => {
  entry.status = "invalidated";
  entry.stop();
  clearTimers(entry);
  notify(entry);
};

/**
 * Takes what the replica committed since its last export as the parts of one burst, moving its
 * flushed version past them: refused, and the replica invalidated, when its lineage lost since it
 * was loaded or the adapter cannot export. Empty when nothing was committed.
 */
export function exportBurst(
  engine: DocsEngine,
  address: DocAddress,
  entry: Entry,
): Result<readonly Uint8Array[], FlushError> {
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
  return Result.ok(entry.stash.splice(0));
}

/**
 * The burst as the doc changes of one write, each carried inline or, past the inline bound with a
 * blob store, by reference (see {@link carry}). A burst that cannot be carried invalidates the
 * replica, whose operations then never leave it.
 */
export async function burstChanges(
  address: DocAddress,
  entry: Entry,
  parts: readonly Uint8Array[],
  blobs: DocBlobs | undefined,
  partition: PartitionKey | undefined,
): Promise<Result<readonly DocChange[], FlushError>> {
  const carried = await carry(entry.adapter, parts, blobs, partition);
  if (carried.isErr()) invalidate(entry);
  const { lineage } = entry;
  return carried.map((updates) =>
    updates.map((update): DocChange => ({
      kind: "doc",
      table: address.table,
      key: address.key,
      column: address.column,
      adapter: entry.adapter.id,
      update,
      ...(lineage !== undefined && { lineage }),
    })),
  );
}

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
  blobs?: DocBlobs,
): Promise<Result<SyncEvent | undefined, FlushError>> {
  const parts = exportBurst(engine, address, entry);
  if (parts.isErr()) return parts;
  if (parts.value.length === 0) return Result.ok(undefined);
  const partition = getRecord(engine.state(), address.table, address.key)?.partition;
  const derived = derive?.(entry.doc);
  const changes = await burstChanges(address, entry, parts.value, blobs, partition);
  if (changes.isErr()) return changes;
  const written = await engine.mutate(
    procedure,
    (tx) => {
      for (const { table, key, kind: _kind, ...write } of changes.value) tx.doc(table, key, write);
    },
    {
      ...partitionOption(partition),
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

export const partitionOption = (partition: PartitionKey | undefined) =>
  partition === undefined ? {} : { partition };

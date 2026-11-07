import type { DocAddress, FoldBatch, StoreFailure } from "@syncmesh/engine";
import type {
  AdapterId,
  DocColumns,
  LineageId,
  PartitionKey,
  Procedure,
  SyncEvent,
} from "@syncmesh/kernel";

import { docKey } from "@syncmesh/engine";
import { getRecord, lineageOf } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { bytesEqual } from "@syncmesh/wire";

import type { AnyAdapter, UpdateRejected } from "./adapter.js";
import type { AdapterMissing, NotADocColumn } from "./errors.js";
import type { DocsEngine } from "./materialise.js";

import { columnAdapter } from "./adapter.js";
import { FlushRefused, HandleInvalidated, UpdateTooLarge } from "./errors.js";
import { load } from "./materialise.js";
import { replicaId } from "./replica.js";

/** Where an open document stands against the log (RFC-0023 §4.3). */
export type DocStatus = "current" | "behind" | "invalidated";

export type OpenError = AdapterMissing | NotADocColumn | UpdateRejected | StoreFailure;
export type FlushError = UpdateTooLarge | FlushRefused | HandleInvalidated;

/**
 * An open document: the library's own document as `value`, edited with the library's own API.
 * Local commits are flushed as one doc change per burst; remote updates are applied as they fold.
 */
export interface OpenDoc<D> extends AsyncDisposable {
  readonly value: D;
  readonly address: DocAddress;
  readonly status: () => DocStatus;
  /** Fires after remote updates were applied, and when the status moves. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Sends what was committed since the last flush now, rather than when the pacing says. */
  readonly flush: () => Promise<Result<SyncEvent | undefined, FlushError>>;
  /** Flushes, then lets go of this handle; the document closes with its last handle. */
  readonly close: () => Promise<Result<SyncEvent | undefined, FlushError>>;
}

/** How local edits are paced into events (RFC-0023 §5.4): after `idle` of quiet, at most every `max`. */
export interface Pacing {
  readonly idle: Temporal.Duration;
  readonly max: Temporal.Duration;
}

export const DEFAULT_PACING = {
  idle: Temporal.Duration.from({ milliseconds: 300 }),
  max: Temporal.Duration.from({ milliseconds: 1000 }),
} as const satisfies Pacing;

export interface OpenDeps {
  readonly engine: DocsEngine;
  readonly docs: DocColumns;
  readonly adapters: ReadonlyMap<AdapterId, AnyAdapter>;
  readonly procedure: Procedure;
  readonly pacing: Pacing;
  readonly nonce: () => Uint8Array;
}

interface Entry {
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

/** The handle registry one runtime keeps: one replica per document, however many handles. */
export function createHandles(deps: OpenDeps) {
  const { engine, adapters } = deps;
  const open = new Map<string, Entry>();
  /** Opens still reading their tail: a second open waits for the first, never loads a second replica. */
  const loading = new Map<string, Promise<Result<Entry, OpenError>>>();
  const arrivals = new Map<string, Uint8Array[]>(); // what folded while those reads ran
  const ms = (d: Temporal.Duration) => d.total({ unit: "milliseconds" });

  const flushEntry = (address: DocAddress, entry: Entry) => flush(deps, address, entry);

  const schedule = (address: DocAddress, entry: Entry) => {
    if (entry.timers.idle !== undefined) clearTimeout(entry.timers.idle);
    const fire = () => void flushEntry(address, entry);
    entry.timers.idle = setTimeout(fire, ms(deps.pacing.idle));
    entry.timers.max ??= setTimeout(fire, ms(deps.pacing.max));
  };

  const applyRemote = (batch: FoldBatch) => {
    if (batch.source === "local" || batch.docs === undefined) return;
    const byDoc = new Map<string, Uint8Array[]>();
    for (const { entry, update } of batch.docs) {
      const key = docKey(entry);
      const held = open.get(key);
      if (held === undefined) {
        // folded after the opening read of the tail: applied once the replica exists
        if (update.bytes !== undefined) arrivals.get(key)?.push(update.bytes);
        continue;
      }
      const winner = lineageOf(getRecord(engine.state(), entry.table, entry.key), entry.column);
      if (winner !== held.lineage && held.status !== "invalidated") invalidate(held);
      if (entry.state === "orphaned" || update.bytes === undefined) continue;
      byDoc.set(key, [...(byDoc.get(key) ?? []), update.bytes]);
    }
    for (const [key, updates] of byDoc) {
      const entry = open.get(key);
      if (entry !== undefined) applyTo(entry, updates);
    }
  };

  const applyTo = (entry: Entry, updates: readonly Uint8Array[]) => {
    if (entry.status === "invalidated" || updates.length === 0) return;
    stashLocal(entry);
    const applied = entry.adapter.apply(entry.doc, updates);
    // a refused update stays in the log, `failed` at the next materialisation (§10)
    if (applied.isOk() && applied.value) entry.flushed = entry.adapter.version(entry.doc);
    notify(entry);
  };

  const handle = <D>(address: DocAddress, entry: Entry): OpenDoc<D> => {
    let released = false;
    const close = async () => {
      if (released) return Result.ok(undefined);
      released = true;
      const flushed = await flushEntry(address, entry);
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.stop();
        open.delete(docKey(address));
      }
      return flushed;
    };
    return {
      // SAFETY: an entry is created by the adapter the column declares, whose document type is D
      value: entry.doc as D,
      address,
      status: () => entry.status,
      subscribe: (listener) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      flush: () => flushEntry(address, entry),
      close,
      [Symbol.asyncDispose]: async () => {
        await close();
      },
    };
  };

  const openDoc = async <D>(address: DocAddress): Promise<Result<OpenDoc<D>, OpenError>> => {
    const key = docKey(address);
    const held = open.get(key);
    if (held !== undefined) return Result.ok(share<D>(address, held));
    const pending = loading.get(key);
    if (pending !== undefined) return (await pending).map((entry) => share<D>(address, entry));
    arrivals.set(key, []);
    const loaded = loadEntry(address);
    loading.set(key, loaded);
    const entry = await loaded;
    loading.delete(key);
    if (entry.isOk()) applyTo(entry.value, arrivals.get(key) ?? []);
    arrivals.delete(key);
    return entry.map((e) => handle<D>(address, e));
  };

  const share = <D>(address: DocAddress, entry: Entry) => {
    entry.refs += 1;
    return handle<D>(address, entry);
  };

  const loadEntry = (address: DocAddress): Promise<Result<Entry, OpenError>> =>
    Result.gen(async function* () {
      const adapter = yield* columnAdapter(deps.docs, adapters, address);
      const tail = yield* Result.await(engine.docTail(address));
      const loaded = yield* load(adapter, tail, replicaId(engine.peerId, deps.nonce()));
      const entry: Entry = {
        adapter,
        lineage: tail.lineage,
        doc: loaded.doc,
        refs: 1,
        status: loaded.missing.length > 0 || loaded.pending ? "behind" : "current",
        flushed: adapter.version(loaded.doc),
        stash: [],
        listeners: new Set(),
        stop: () => {},
        timers: {},
      };
      const unwatch = adapter.watchLocal(loaded.doc, () => schedule(address, entry));
      Object.assign(entry, { stop: unwatch });
      open.set(docKey(address), entry);
      return Result.ok(entry);
    });

  const unfold = engine.onFoldBatch(applyRemote);
  return {
    open: openDoc,
    stop: () => {
      unfold();
      for (const entry of open.values()) {
        clearTimers(entry);
        entry.stop();
      }
      open.clear();
    },
  };
}

const notify = (entry: Entry) => {
  for (const listener of entry.listeners) listener();
};

// export what is pending, so a remote apply that follows never rides along in our next flush
const stashLocal = (entry: Entry) => {
  if (bytesEqual(entry.adapter.version(entry.doc), entry.flushed)) return;
  entry.stash.push(entry.adapter.since(entry.doc, entry.flushed).unwrap());
  entry.flushed = entry.adapter.version(entry.doc);
};

const invalidate = (entry: Entry) => {
  entry.status = "invalidated";
  entry.stop();
  clearTimers(entry);
  notify(entry);
};

/** Sends what the handle committed since its last flush as one event: a doc change per stashed part. */
async function flush(
  deps: OpenDeps,
  address: DocAddress,
  entry: Entry,
): Promise<Result<SyncEvent | undefined, FlushError>> {
  const { engine } = deps;
  clearTimers(entry);
  if (entry.status === "invalidated")
    return Result.err(new HandleInvalidated({ message: "this document handle was invalidated" }));
  stashLocal(entry);
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
  const lineage = lineageOf(record, address.column);
  const written = await engine.mutate(
    deps.procedure,
    (tx) => {
      for (const bytes of parts)
        tx.doc(address.table, address.key, {
          column: address.column,
          adapter: entry.adapter.id,
          update: { bytes },
          ...(lineage !== undefined && { lineage }),
        });
    },
    partitionOf(record?.partition),
  );
  if (written.isErr()) {
    invalidate(entry);
    return Result.err(
      new FlushRefused({ message: "the engine refused the flush", cause: written.error }),
    );
  }
  return Result.ok(written.value);
}

const clearTimers = (entry: Entry) => {
  if (entry.timers.idle !== undefined) clearTimeout(entry.timers.idle);
  if (entry.timers.max !== undefined) clearTimeout(entry.timers.max);
  entry.timers = {};
};

const partitionOf = (partition: PartitionKey | undefined) =>
  partition === undefined ? {} : { partition };

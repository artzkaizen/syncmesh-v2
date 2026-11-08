import type { DocAddress, DocAppend, FoldBatch, StoreFailure } from "@syncmesh/engine";
import type { AdapterId, DocColumns, Procedure, SyncEvent } from "@syncmesh/kernel";

import { docKey } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { AnyAdapter, UpdateRejected } from "./adapter.js";
import type { DocStatus, Entry, FlushError } from "./entry.js";
import type { AdapterMissing, NotADocColumn } from "./errors.js";
import type { DocsEngine } from "./materialise.js";

import { columnAdapter } from "./adapter.js";
import { clearTimers, deliver, flush } from "./entry.js";
import { FlushRefused } from "./errors.js";
import { load } from "./materialise.js";
import { replicaId } from "./replica.js";

export type OpenError = AdapterMissing | NotADocColumn | UpdateRejected | StoreFailure;
export type { DocStatus, FlushError } from "./entry.js";

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
  /** Where a paced flush that failed goes; the handle's status says it too. */
  readonly onError?: (error: FlushError) => void;
}

/** The handle registry one runtime keeps: one replica per document, however many handles. */
export function createHandles(deps: OpenDeps) {
  const { engine, adapters } = deps;
  const open = new Map<string, Entry>();
  /** Opens still reading their tail: a second open waits for the first, never loads a second replica. */
  const loading = new Map<string, Promise<Result<Entry, OpenError>>>();
  const arrivals = new Map<string, DocAppend[]>(); // what folded while those reads ran
  const ms = (d: Temporal.Duration) => d.total({ unit: "milliseconds" });

  const flushEntry = (address: DocAddress, entry: Entry) =>
    flush(engine, deps.procedure, address, entry);

  const schedule = (address: DocAddress, entry: Entry) => {
    if (entry.timers.idle !== undefined) clearTimeout(entry.timers.idle);
    const fire = () => {
      flushEntry(address, entry).then(
        (flushed) => {
          if (flushed.isErr()) deps.onError?.(flushed.error);
        },
        (cause: unknown) => deps.onError?.(new FlushRefused({ message: "the flush threw", cause })),
      );
    };
    entry.timers.idle = setTimeout(fire, ms(deps.pacing.idle));
    entry.timers.max ??= setTimeout(fire, ms(deps.pacing.max));
  };

  // local batches too: a genesis or a doc write this device made outside the handle moves the
  // document as surely as a remote one, and re-importing the handle's own flush changes nothing
  const applyFolded = (batch: FoldBatch) => {
    if (batch.docs === undefined) return;
    const byDoc = new Map<string, DocAppend[]>();
    for (const append of batch.docs) {
      const key = docKey(append.entry);
      byDoc.set(key, [...(byDoc.get(key) ?? []), append]);
    }
    for (const [key, appends] of byDoc) {
      const held = open.get(key);
      // folded after the opening read of the tail: delivered once the replica exists
      if (held === undefined) arrivals.get(key)?.push(...appends);
      else deliver(engine, held, appends);
    }
  };

  const handle = <D>(address: DocAddress, entry: Entry): OpenDoc<D> => {
    let released = false;
    const close = async () => {
      if (released) return Result.ok(undefined);
      released = true;
      const flushed = await flushEntry(address, entry);
      entry.refs -= 1;
      // an invalidated entry may already have given its place to the document reopened after it
      if (entry.refs === 0) {
        entry.stop();
        if (open.get(docKey(address)) === entry) open.delete(docKey(address));
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
    // reopening is what an invalidated handle asks for: a fresh replica, not the dead one. Dropping
    // it from `open` is safe only because invalidation already stopped it and cleared its timers
    if (held?.status === "invalidated") open.delete(key);
    else if (held !== undefined) return Result.ok(share<D>(address, held));
    const pending = loading.get(key);
    if (pending !== undefined) return (await pending).map((entry) => share<D>(address, entry));
    arrivals.set(key, []);
    const loaded = loadEntry(address);
    loading.set(key, loaded);
    const entry = await loaded;
    loading.delete(key);
    if (entry.isOk()) deliver(engine, entry.value, arrivals.get(key) ?? []);
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

  const unfold = engine.onFoldBatch(applyFolded);
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

import type { DerivedFrom, DocAddress, FoldBatch, StoreFailure, WriteKeys } from "@syncmesh/engine";
import type { AdapterId, DocColumns, Row, TableName } from "@syncmesh/kernel";
import type { DeriveFailed, Derivers } from "@syncmesh/schema";

import { docEntryId, docKey } from "@syncmesh/engine";
import { compareValue, getRecord, isVisible } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { AnyAdapter, UpdateRejected } from "./adapter.js";
import type { Entry } from "./entry.js";
import type { DocsEngine } from "./materialise.js";

import { entryRef, load } from "./materialise.js";

/** What recomputing a row's derived columns outside a flush or a cover can fail with. */
export type RederiveError = DeriveFailed | UpdateRejected | StoreFailure;

export interface RederiveDeps {
  readonly engine: DocsEngine;
  readonly docs: DocColumns;
  readonly adapters: ReadonlyMap<AdapterId, AnyAdapter>;
  readonly derive: Derivers;
  /** A fresh replica id, for a document read from its snapshot and tail. */
  readonly replica: () => bigint;
  /** The replica open at an address, if one is. */
  readonly held: (address: DocAddress) => Entry | undefined;
  readonly onError?: (error: RederiveError) => void;
}

/** Whether two derived rows hold the same value in every column. */
const sameValues = (a: Row, b: Row) =>
  a.size === b.size &&
  [...a].every(([column, value]) => {
    const other = b.get(column);
    return other !== undefined && compareValue(value, other) === 0;
  });

/**
 * Keeps every row's derived columns caught up with its document between flushes and covers
 * (RFC-0023 §16.4, gaps U25). A document is recomputed when the fold hands it a doc change — a
 * remote edit to an open document or a closed one, a `replace()` — when its lineage moves, when
 * its row appears (an insert landing after the document, a delete and re-insert), when a
 * snapshot or repair rewrites the row, and once for every row when the runtime starts, which is
 * how a rebuilt state file and a changed derive function catch up.
 *
 * One document at a time, in the background. An open replica is read as it stands; a closed
 * document is loaded from its snapshot and tail. Each write is guarded by what it was computed
 * from (`engine.writeDerived`), so a recomputation overtaken by a newer edit writes nothing and
 * the newer edit's own recomputation follows it.
 */
export function createRederive(deps: RederiveDeps) {
  const { engine, docs, adapters, derive } = deps;
  const queue = new Map<string, DocAddress>();
  /** Per document, the values its row was last given here or by a flush, so a recomputation that changes nothing writes nothing. */
  const written = new Map<string, Row>();
  /**
   * A flush's values — absent when its derive failed — and the entries its replica held when
   * they were computed, until the fold of the write they rode on says it committed.
   */
  const flushing = new Map<string, { readonly values?: Row; readonly seen: ReadonlySet<string> }>();
  const idle: (() => void)[] = [];
  let draining = false;
  let stopped = false;

  const deriverAt = (address: DocAddress) => derive.get(address.table)?.get(address.column);
  const adapterAt = (address: DocAddress) => {
    const id = docs.get(address.table)?.get(address.column);
    return id === undefined ? undefined : adapters.get(id);
  };

  const computed = async (
    address: DocAddress,
  ): Promise<Result<{ values: Row; from: DerivedFrom } | undefined, RederiveError>> => {
    const deriver = deriverAt(address);
    const adapter = adapterAt(address);
    if (deriver === undefined || adapter === undefined) return Result.ok(undefined);
    const open = deps.held(address);
    if (open !== undefined)
      return deriver.compute(open.doc).map((values) => ({
        values,
        from: {
          doc: address,
          ...(open.lineage !== undefined && { lineage: open.lineage }),
          includes: [...open.seen.values()],
        },
      }));
    return Result.gen(async function* () {
      const tail = yield* Result.await(engine.docTail(address));
      // an empty document has nothing to say: its columns stay as the row was written
      if (tail.snapshot === undefined && tail.updates.length === 0) return Result.ok(undefined);
      const loaded = yield* load(adapter, tail, deps.replica());
      const values = yield* deriver.compute(loaded.doc);
      return Result.ok({
        values,
        from: {
          doc: address,
          ...(tail.lineage !== undefined && { lineage: tail.lineage }),
          includes: tail.updates.map(entryRef),
        },
      });
    });
  };

  const refresh = async (address: DocAddress): Promise<Result<void, RederiveError>> => {
    const record = getRecord(engine.state(), address.table, address.key);
    // no row to write into: its insert brings it back here
    if (record === undefined || !isVisible(record)) return Result.ok(undefined);
    const key = docKey(address);
    return Result.gen(async function* () {
      const made = yield* Result.await(computed(address));
      if (made === undefined) return Result.ok(undefined);
      const last = written.get(key);
      if (last !== undefined && sameValues(last, made.values)) return Result.ok(undefined);
      const row = { table: address.table, key: address.key, values: made.values };
      if (yield* Result.await(engine.writeDerived(row, made.from))) written.set(key, made.values);
      return Result.ok(undefined);
    });
  };

  // a document marked while it runs is queued again behind the ones already waiting
  const drain = async () => {
    try {
      for (const [key, address] of queue) {
        if (stopped) break;
        queue.delete(key);
        const done = await refresh(address);
        if (done.isErr()) deps.onError?.(done.error);
      }
    } finally {
      draining = false;
      for (const resolve of idle.splice(0)) resolve();
    }
  };

  const mark = (address: DocAddress, rewritten = false) => {
    if (stopped || deriverAt(address) === undefined || adapterAt(address) === undefined) return;
    const key = docKey(address);
    // the row was written afresh: whatever was written into it before is gone
    if (rewritten) written.delete(key);
    queue.set(key, address);
    if (draining) return;
    draining = true;
    // after every fold listener has run: an open replica is handed the batch's updates by one
    queueMicrotask(() => void drain());
  };

  /** Every document column of `table` that derives something, at `key`. */
  const markRow = (table: TableName, key: DocAddress["key"], rewritten: boolean) => {
    for (const column of derive.get(table)?.keys() ?? []) mark({ table, key, column }, rewritten);
  };
  const markRows = (keys: WriteKeys, rewritten: boolean) => {
    for (const [table, set] of keys) {
      if (!derive.has(table)) continue;
      for (const key of set) markRow(table, key, rewritten);
    }
  };

  /**
   * Whether a document a local batch names needs recomputing: not when a flush wrote its values
   * with the batch from a replica that has since been given nothing new.
   */
  const afterFlush = (batch: FoldBatch, key: string, address: DocAddress, own: Set<string>) => {
    const flushed = batch.source === "local" ? flushing.get(key) : undefined;
    flushing.delete(key);
    if (flushed === undefined) return true;
    if (flushed.values !== undefined) written.set(key, flushed.values);
    const seen = deps.held(address)?.seen.keys() ?? [];
    return [...seen].some((id) => !flushed.seen.has(id) && !own.has(id));
  };

  const onFold = (batch: FoldBatch) => {
    if (batch.source === "derive") return;
    const own = new Map<string, Set<string>>();
    for (const { entry } of batch.docs ?? []) {
      const key = docKey(entry);
      own.set(key, (own.get(key) ?? new Set()).add(docEntryId(entry)));
    }
    for (const [key, ids] of own) {
      const append = batch.docs?.find(({ entry }) => docKey(entry) === key);
      if (append !== undefined && afterFlush(batch, key, append.entry, ids)) mark(append.entry);
    }
    for (const move of batch.lineageMoves ?? []) mark(move);
    if (batch.source === "snapshot" || batch.source === "repair") markRows(batch.writeKeys, true);
    else if (batch.appeared !== undefined) markRows(batch.appeared, true);
  };
  const unfold = engine.onFoldBatch(onFold);

  /** Resolves once nothing is queued. */
  const settled = () =>
    !draining && queue.size === 0 ? Promise.resolve() : new Promise<void>((r) => idle.push(r));

  return {
    /**
     * Recomputes `address`, or every row with derived columns when absent, and resolves once
     * nothing is queued. Values already written are written again: what an app calls when it
     * rewrote rows outside syncmesh.
     */
    rederive: (address?: DocAddress) => {
      if (address !== undefined) mark(address, true);
      else
        for (const table of derive.keys())
          for (const key of engine.state().get(table)?.keys() ?? []) markRow(table, key, true);
      return settled();
    },
    /**
     * A flush is writing `values` (absent: its derive failed) with its doc change, computed from a
     * replica that held `seen`; they count once its fold lands.
     */
    flushing: (address: DocAddress, values: Row | undefined, seen: ReadonlySet<string>) =>
      void flushing.set(docKey(address), { ...(values !== undefined && { values }), seen }),
    stop: () => {
      stopped = true;
      unfold();
      queue.clear();
      flushing.clear();
      for (const resolve of idle.splice(0)) resolve();
    },
  };
}

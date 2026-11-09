import type { DocColumns, LineageId } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";

import type { DocAddress, DocStore } from "./doc-log.js";
import type { FoldBatch, FoldSource } from "./fold.js";
import type { DocColumnBytes, RowWrite } from "./state-store.js";
import type { StoreFailure } from "./store.js";

import { docKey } from "./doc-log.js";

/**
 * The app's document column (RFC-0023 §6.1): the snapshot bytes of the winning lineage, written by
 * every cover and kept in step by the fold wherever a batch can leave it behind.
 *
 * @module
 */

/** The batches that write each row they name afresh, so its document columns start over. */
const REWRITES: ReadonlySet<FoldSource> = new Set(["snapshot", "repair", "purge"]);

/**
 * The documents whose column a batch may have left behind: each document column of a row it
 * inserted or rewrote (the projection writes those rows without their documents' bytes), each
 * document whose lineage a snapshot or repair moved, and each document a doc change landed on
 * in a row the same batch wrote — a genesis is the one doc change that writes its row.
 */
export function docsReseated(batch: FoldBatch, docs: DocColumns | undefined): DocAddress[] {
  if (docs === undefined || docs.size === 0) return [];
  const out = new Map<string, DocAddress>();
  const add = (address: DocAddress) => out.set(docKey(address), address);
  const rows = (keys: FoldBatch["writeKeys"]) => {
    for (const [table, set] of keys) {
      const columns = docs.get(table);
      if (columns === undefined) continue;
      for (const key of set) for (const column of columns.keys()) add({ table, key, column });
    }
  };
  if (REWRITES.has(batch.source)) rows(batch.writeKeys);
  if (batch.appeared !== undefined) rows(batch.appeared);
  for (const move of batch.lineageMoves ?? [])
    add({ table: move.table, key: move.key, column: move.column });
  for (const { entry } of batch.docs ?? [])
    if (batch.writeKeys.get(entry.table)?.has(entry.key) === true)
      add({ table: entry.table, key: entry.key, column: entry.column });
  return [...out.values()];
}

/**
 * Each document column of `rows`: what a boot that committed them writes afresh, because the
 * commit projects rows without their documents' bytes and a rebuilt state starts with none.
 */
export function rowDocs(rows: readonly RowWrite[], docs: DocColumns | undefined): DocAddress[] {
  if (docs === undefined || docs.size === 0) return [];
  return rows.flatMap(({ table, key }) =>
    [...(docs.get(table)?.keys() ?? [])].map((column) => ({ table, key, column })),
  );
}

/**
 * What each document's column holds now: the snapshot `store` keeps of it when that snapshot is
 * of the lineage that wins, and `NULL` otherwise — no snapshot of the winner is held yet, so the
 * column claims nothing it does not have.
 */
export function docColumnWrites(
  store: DocStore,
  addresses: readonly DocAddress[],
  winner: (doc: DocAddress) => LineageId | undefined,
): Promise<Result<DocColumnBytes[], StoreFailure>> {
  return Result.gen(async function* () {
    const writes: DocColumnBytes[] = [];
    for (const doc of addresses) {
      const held = yield* Result.await(store.snapshotOf(doc));
      const current = held !== undefined && held.lineage === winner(doc) ? held.bytes : undefined;
      writes.push({ ...doc, ...(current !== undefined && { bytes: current }) });
    }
    return Result.ok(writes);
  });
}

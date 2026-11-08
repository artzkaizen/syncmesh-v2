import type { AdapterId, DocColumns, KeyedRecord, LineageId, State } from "@syncmesh/kernel";

import { docLineage, getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { DocAddress, DocStore, LineageMove } from "./doc-log.js";
import type { StoreFailure } from "./store.js";

import { docKey, relabelDocs } from "./doc-log.js";

/**
 * {@link relabelDocs} for documents a joined lineage cell moved, skipping each one that holds no
 * doc-log entries: it has nothing to relabel, and a head is only kept for a document with entries.
 */
export function relabelMoved(
  store: DocStore,
  moves: readonly LineageMove[],
  docWinner: (doc: DocAddress) => LineageId | undefined,
  hasAdapter: (adapter: AdapterId) => boolean,
): Promise<Result<void, StoreFailure>> {
  return Result.gen(async function* () {
    const held: LineageMove[] = [];
    for (const move of moves)
      if ((yield* Result.await(store.entriesOf(move))).length > 0) held.push(move);
    return Result.ok(yield* Result.await(relabelDocs(store, held, docWinner, hasAdapter)));
  });
}

/**
 * The documents among `rows` whose winning lineage differs between `before` and `after`: what a
 * snapshot install or a repair, which join lineage cells with no doc change, must relabel the doc
 * log for at once rather than at the document's next append (RFC-0023 §5.3).
 */
export function lineageMoves(
  before: State,
  after: State,
  rows: Iterable<KeyedRecord>,
  docs: DocColumns,
): readonly LineageMove[] {
  const moves = new Map<string, LineageMove>();
  for (const { table, key } of rows)
    for (const [column, adapter] of docs.get(table) ?? []) {
      const winner = (state: State) => docLineage(getRecord(state, table, key), column);
      if (winner(before) !== winner(after))
        moves.set(docKey({ table, key, column }), { table, key, column, adapter });
    }
  return [...moves.values()];
}

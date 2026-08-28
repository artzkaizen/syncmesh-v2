import type { RowKey, TableName } from "./change.js";
import type { CounterEntry } from "./counter.js";
import type { PartitionKey } from "./partition.js";
import type { Cell, CellValue, ColumnName } from "./record.js";
import type { SetAdd, SetTag } from "./set.js";
import type { Stamp } from "./stamp.js";
import type { State } from "./state.js";
import type { MergeSpec } from "./strategy.js";

import { mergeRecord } from "./apply.js";

/**
 * A write that merges inside a cell rather than replacing it (E26, D04-C). Three kinds, one per
 * operation the two rich column kinds have: `increment` for a `counter`, `add` and `remove` for a
 * `set`. Each is its own change kind on the wire so that a peer which does not know the kind
 * refuses the event instead of folding the payload as an ordinary value and mangling the column.
 * Nothing emits one yet: `SyncEvent.changes` carries row-level changes only, so the codec below
 * it is the contract for the build that adds them rather than a path this one takes (E26).
 *
 * Everything else stays as it was: these fold into the same {@link RowRecord}, under the same
 * stamps, past the same tombstones, and a row may mix them with ordinary columns freely.
 */
export type CellChange =
  | {
      readonly kind: "increment";
      readonly table: TableName;
      readonly key: RowKey;
      /** The author's running totals per column — never the step. See `counterAdvance`. */
      readonly counts: ReadonlyMap<ColumnName, CounterEntry>;
    }
  | {
      readonly kind: "add";
      readonly table: TableName;
      readonly key: RowKey;
      readonly adds: ReadonlyMap<ColumnName, SetAdd>;
    }
  | {
      readonly kind: "remove";
      readonly table: TableName;
      readonly key: RowKey;
      /** Only the ids the remover had already seen: an id it never saw is an add that survives. */
      readonly drops: ReadonlyMap<ColumnName, readonly SetTag[]>;
    };

const cells = <T>(
  source: ReadonlyMap<ColumnName, T>,
  value: (payload: T) => CellValue,
  stamp: Stamp,
): ReadonlyMap<ColumnName, Cell> =>
  new Map([...source].map(([column, payload]) => [column, { stamp, value: value(payload) }]));

/**
 * The cells one cell-change writes: a fragment of the column's lattice — one peer's totals, one
 * tagged add, one batch of tombstones — carrying nothing it did not observe. The fragment is a
 * whole lattice value, so the column's strategy joins it with what is already there by exactly the
 * rule a whole snapshot row would take.
 */
export function cellsFor(change: CellChange, stamp: Stamp): ReadonlyMap<ColumnName, Cell> {
  if (change.kind === "increment")
    return cells(change.counts, (e) => ({ [stamp.peer]: { dec: e.dec, inc: e.inc } }), stamp);
  if (change.kind === "add")
    return cells(change.adds, (add) => ({ [add.tag]: [add.value] }), stamp);
  return cells(change.drops, (drops) => Object.fromEntries(drops.map((t) => [t, []])), stamp);
}

/**
 * Folds one cell-change into the state — the sibling of `applyChange`, and the same join underneath.
 * It writes `writeStamp` like any other write, so an increment revives a row a later delete had
 * hidden exactly as an update would, and the column's strategy in `merge` decides the cell.
 */
export function applyCellChange(
  state: State,
  change: CellChange,
  stamp: Stamp,
  merge?: MergeSpec,
  partition?: PartitionKey,
): State {
  const base = { cells: cellsFor(change, stamp), writeStamp: stamp };
  const incoming = partition === undefined ? base : { ...base, partition };
  return mergeRecord(state, change.table, change.key, incoming, merge);
}

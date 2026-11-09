import type { FoldableChange, Row, RowKey, TableName } from "./change.js";
import type { DocChange } from "./doc.js";
import type { PartitionKey } from "./partition.js";
import type { Cell, ColumnName, RowRecord } from "./record.js";
import type { State, TableState } from "./state.js";
import type { MergeSpec } from "./strategy.js";

import { cellRules, lineageCell, type CellRule } from "./lineage.js";
import { withEntry } from "./persistent-map.js";
import { compareStamp, type Stamp } from "./stamp.js";

type ColumnStrategies = ReadonlyMap<ColumnName, CellRule> | undefined;

const later = (a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareStamp(a, b) > 0 ? a : b;
};

const EMPTY_RECORD: RowRecord = { cells: new Map() };

/**
 * Folds one change into the state and returns the new state; the input is untouched.
 *
 * Every step is a max-based join — cells by their column's strategy, `writeStamp` and
 * `deleteStamp` by stamp — so any order and any replay of the same changes converge.
 * `insert` and `update` both merge column by column (RFC-0014 §1); `merge` names the
 * strategy per column, defaulting to `lww`. `partition` is the event's; a row keeps the first it saw.
 *
 * A `doc` change touches state only when it is a genesis, and then only its column's lineage cell
 * (RFC-0023 §5.3); every other doc change leaves the state as it was, because its update belongs
 * to the doc log and not to any cell.
 */
export function applyChange(
  state: State,
  change: FoldableChange,
  stamp: Stamp,
  merge?: MergeSpec,
  partition?: PartitionKey,
): State {
  if (change.kind === "doc") return applyGenesis(state, change, stamp, merge, partition);
  const base: RowRecord =
    change.kind === "delete"
      ? { cells: new Map(), deleteStamp: stamp }
      : {
          cells: stampAll(change.kind === "insert" ? change.row : change.patch, stamp),
          writeStamp: stamp,
        };
  const incoming = partition === undefined ? base : { ...base, partition };
  return mergeRecord(state, change.table, change.key, incoming, merge);
}

/**
 * A genesis adds itself — its lineage, the lineage it replaced, its stamp — to the column's cell,
 * with the anchor it settles the walk at when it carries one (gaps U21), and nothing else: no `writeStamp`, because a
 * document edit is not a row write and must not resurrect a deleted row or outlive a later delete.
 * The column is joined by the lineage rule whatever `merge` says, since the change itself is what
 * names the column as a document.
 */
function applyGenesis(
  state: State,
  change: DocChange,
  stamp: Stamp,
  merge: MergeSpec | undefined,
  partition: PartitionKey | undefined,
): State {
  if (change.genesis !== true || change.legacy === true || change.lineage === undefined)
    return state;
  const genesis = { lineage: change.lineage, parent: change.parent, stamp };
  const cells = new Map([[change.column, lineageCell(genesis, change.settles)]]);
  const rules = new Map<ColumnName, CellRule>(merge?.get(change.table) ?? []);
  rules.set(change.column, "lineage");
  const spec = new Map(merge ?? []).set(change.table, rules);
  const incoming = partition === undefined ? { cells } : { cells, partition };
  return mergeRecord(state, change.table, change.key, incoming, spec);
}

/** Joins a whole record — a snapshot row — into the state; equivalent to folding its cells and stamps as changes. */
export function mergeRecord(
  state: State,
  table: TableName,
  key: RowKey,
  record: RowRecord,
  merge?: MergeSpec,
): State {
  const tableState = state.get(table) ?? new Map<RowKey, RowRecord>();
  const current = tableState.get(key) ?? EMPTY_RECORD;
  const partition = current.partition ?? record.partition;
  const joined = {
    cells: mergeCells(current.cells, record.cells, merge?.get(table)),
    ...stampFields(
      later(current.writeStamp, record.writeStamp),
      later(current.deleteStamp, record.deleteStamp),
    ),
  };
  return withRecord(
    state,
    table,
    tableState,
    key,
    partition === undefined ? joined : { ...joined, partition },
  );
}

const stampAll = (row: Row, stamp: Stamp): ReadonlyMap<ColumnName, Cell> =>
  new Map([...row].map(([column, value]) => [column, { value, stamp }]));

function mergeCells(
  current: ReadonlyMap<ColumnName, Cell>,
  incoming: ReadonlyMap<ColumnName, Cell>,
  columnStrategies: ColumnStrategies,
): ReadonlyMap<ColumnName, Cell> {
  // one write per incoming column, never a copy of the others: a wide row pays for what changed
  let cells = current;
  for (const [column, candidate] of incoming) {
    const existing = cells.get(column);
    const strategy = cellRules[columnStrategies?.get(column) ?? "lww"];
    // A first arrival passes `undefined` so `counter` can tell an increment landing on nothing
    // from one landing on totals; storing the sender's raw shape instead would leave two peers
    // digesting the same cell differently.
    cells = withEntry(cells, column, strategy(candidate, existing));
  }
  return cells;
}

function stampFields(
  writeStamp: Stamp | undefined,
  deleteStamp: Stamp | undefined,
): Pick<RowRecord, "writeStamp" | "deleteStamp"> {
  if (writeStamp !== undefined && deleteStamp !== undefined) return { writeStamp, deleteStamp };
  if (writeStamp !== undefined) return { writeStamp };
  if (deleteStamp !== undefined) return { deleteStamp };
  return {};
}

/** The state with one record replaced — O(1), sharing everything else with `state` (see `withEntry`). */
const withRecord = (
  state: State,
  name: TableName,
  table: TableState,
  key: RowKey,
  record: RowRecord,
): State => withEntry(state, name, withEntry(table, key, record));

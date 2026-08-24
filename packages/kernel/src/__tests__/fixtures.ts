import { Temporal } from "@syncmesh/temporal";

import type { Change, Row, RowKey, TableName } from "../change.js";
import type { Hlc, Logical } from "../hlc.js";
import type { Cell, CellValue, ColumnName, RowRecord } from "../record.js";
import type { Stamp } from "../stamp.js";
import type { MergeSpec } from "../strategy.js";

import { applyChange } from "../apply.js";
import { parsePeerId, type PeerId } from "../peer-id.js";
import { emptyState, type State } from "../state.js";

export const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

export const hlc = (ms: number, l: number): Hlc => {
  // SAFETY: test fixture; l is always a small non-negative integer
  return [at(ms), l as Logical];
};

export const stamp = (ms: number, l: number, peer: PeerId): Stamp => ({ hlc: hlc(ms, l), peer });

export const plain = ([physical, logical]: Hlc): [number, number] => [
  physical.epochMilliseconds,
  logical,
];

export const PEER_A = parsePeerId("a".repeat(64)).unwrap();
export const PEER_B = parsePeerId("b".repeat(64)).unwrap();

export const fakeClock = (start: number) => {
  let ms = start;
  return {
    now: () => at(ms),
    set: (next: number) => {
      ms = next;
    },
  };
};

export const column = (name: string): ColumnName => {
  // SAFETY: test fixture; column naming rules arrive with the schema (E05)
  return name as ColumnName;
};

export const cell = (value: CellValue, at: Stamp): Cell => ({ value, stamp: at });

export const record = (
  writeStamp: Stamp,
  cells: readonly (readonly [string, Cell])[] = [],
  deleteStamp?: Stamp,
): RowRecord => {
  const base: RowRecord = {
    cells: new Map(cells.map(([name, c]) => [column(name), c])),
    writeStamp,
  };
  return deleteStamp === undefined ? base : { ...base, deleteStamp };
};

export const table = (name: string): TableName => {
  // SAFETY: test fixture; table naming rules arrive with the schema (E05)
  return name as TableName;
};

export const key = (value: string): RowKey => {
  // SAFETY: test fixture; keys are opaque strings in the kernel
  return value as RowKey;
};

export const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

export const NOTES = table("notes");
export const N1 = key("n1");

export const insert = (values: Readonly<Record<string, CellValue>>, at: Stamp): Stamped => ({
  change: { kind: "insert", table: NOTES, key: N1, row: row(values) },
  stamp: at,
});
export const update = (values: Readonly<Record<string, CellValue>>, at: Stamp): Stamped => ({
  change: { kind: "update", table: NOTES, key: N1, patch: row(values) },
  stamp: at,
});
export const remove = (at: Stamp): Stamped => ({
  change: { kind: "delete", table: NOTES, key: N1 },
  stamp: at,
});

export interface Stamped {
  readonly change: Change;
  readonly stamp: Stamp;
}

export const applyAll = (changes: readonly Stamped[], merge?: MergeSpec): State =>
  changes.reduce(
    (state, { change, stamp }) => applyChange(state, change, stamp, merge),
    emptyState(),
  );

/** JSON-comparable view of a state: `{ table: { key: { visible, cells: { col: [value, ms, logical, peer] }, write?, delete? } } }`. */
export const plainState = (state: State) =>
  Object.fromEntries(
    [...state].map(([t, rows]) => [
      t,
      Object.fromEntries(
        [...rows].map(([k, r]) => [
          k,
          {
            cells: Object.fromEntries(
              [...r.cells].map(([c, cell]) => [c, [cell.value, ...plainStamp(cell.stamp)]]),
            ),
            write: r.writeStamp === undefined ? null : plainStamp(r.writeStamp),
            delete: r.deleteStamp === undefined ? null : plainStamp(r.deleteStamp),
          },
        ]),
      ),
    ]),
  );

const plainStamp = (s: Stamp) => [...plain(s.hlc), s.peer] as const;

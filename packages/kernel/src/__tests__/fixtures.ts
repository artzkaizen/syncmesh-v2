import { Temporal } from "@syncmesh/temporal";

import type { FoldableChange } from "../change.js";
import type { Hlc, Logical } from "../hlc.js";
import type { PeerId } from "../peer-id.js";
import type { Cell, CellValue, JsonValue, RowRecord } from "../record.js";
import type { Stamp } from "../stamp.js";
import type { MergeSpec } from "../strategy.js";

import { applyChange } from "../apply.js";
import { canonicalJson } from "../record.js";
import { emptyState, type State } from "../state.js";
import { PEER_A, PEER_B, PEER_C, column, key, row, table } from "../test-fixtures/index.js";

export { PEER_A, PEER_B, PEER_C, column, key, row, table };

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

export const fakeClock = (start: number) => {
  let ms = start;
  return {
    now: () => at(ms),
    set: (next: number) => {
      ms = next;
    },
  };
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

export const NOTES = table("notes");
export const N1 = key("n1");

export const LIKES = column("likes");
export const TAGS = column("tags");

/** Two columns that pick by value rather than by stamp, for the strategies that do. */
export const MERGE: MergeSpec = new Map([
  [
    NOTES,
    new Map([
      [LIKES, "max" as const],
      [TAGS, "min" as const],
    ]),
  ],
]);

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
  readonly change: FoldableChange;
  readonly stamp: Stamp;
}

export const applyAll = (changes: readonly Stamped[], merge?: MergeSpec): State =>
  changes.reduce(
    (state, { change, stamp }) => applyChange(state, change, stamp, merge),
    emptyState(),
  );

/**
 * The state as one canonical string. `toEqual` on {@link plainState} compares objects, and two
 * objects with the same fields in different orders pass it — which is exactly the divergence a
 * CRDT cell can carry, so the CRDT tests compare this instead.
 */
export const canonicalState = (state: State): string => {
  // SAFETY: plainState is built from cell values, stamps and nulls — all JSON, apart from a blob
  // cell, which none of the tests that compare canonical states writes
  return canonicalJson(plainState(state) as JsonValue);
};

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

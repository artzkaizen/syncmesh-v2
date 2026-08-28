import type { CellChange, JsonValue, State } from "@syncmesh/kernel";

import {
  applyCellChange,
  canonicalJson,
  cellsFor,
  counterValue,
  emptyState,
  getRecord,
  setValue,
} from "@syncmesh/kernel";
import {
  CELL_KIND,
  bytesToHex,
  decodeCbor,
  decodeCellChange,
  encodeCbor,
  encodeCellChange,
  hexToBytes,
} from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../cell-vectors.json" with { type: "json" };
import { CELL_MERGE, COLUMNS, N1, NOTES, STAMP, cellVectors } from "../generate-cell-vectors.js";

const decoded = (wireHex: string): CellChange =>
  decodeCellChange(decodeCbor(hexToBytes(wireHex).unwrap()).unwrap()).unwrap();

/** The cells one change writes, as the canonical text the vector freezes. */
const written = (change: CellChange): string => {
  const cells = [...cellsFor(change, STAMP)].map(([name, cell]) => {
    // SAFETY: the three cell kinds write JSON lattice fragments — counter totals, tagged adds,
    // tombstones — and never bytes, which is the only CellValue that is not a JsonValue
    return [String(name), cell.value as JsonValue] as const;
  });
  return canonicalJson(Object.fromEntries(cells));
};

/** A peer that received exactly these bytes, in this order, and folded them into one row. */
const peerHolding = (order: readonly string[]): State =>
  order.reduce<State>(
    (state, wireHex) => applyCellChange(state, decoded(wireHex), STAMP, CELL_MERGE),
    emptyState(),
  );

const cellsOf = (state: State) => getRecord(state, NOTES, N1)?.cells;

describe("cell-change vectors — frozen", () => {
  test("the generator still produces the frozen file byte-for-byte (change the wire, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(cellVectors()))).toEqual(raw);
  });

  test("the kinds continue the row-level numbering, so an older peer refuses rather than folds", () => {
    expect(CELL_KIND).toEqual({ increment: 3, add: 4, remove: 5 });
    for (const v of raw.vectors) {
      const change = decodeCbor(hexToBytes(v.wireHex).unwrap()).unwrap();
      expect(change instanceof Map && change.get(0)).toBeGreaterThanOrEqual(3);
    }
  });

  for (const v of raw.vectors) {
    test(v.description, () => {
      const change = decoded(v.wireHex);
      expect(bytesToHex(encodeCbor(encodeCellChange(change)))).toBe(v.wireHex);
      expect(written(change)).toBe(v.cellsJson);
    });
  }
});

describe("what a port must agree on, not merely decode", () => {
  const order = raw.vectors.map((v) => v.wireHex);

  test("two peers given the same bytes in opposite orders hold the same row", () => {
    const straight = peerHolding(order);
    const reversed = peerHolding([...order].reverse());
    const redelivered = peerHolding([...order, ...order].reverse());
    expect(cellsOf(reversed)).toEqual(cellsOf(straight));
    expect(cellsOf(redelivered)).toEqual(cellsOf(straight));
  });

  test("and read the same values out of it", () => {
    const cells = cellsOf(peerHolding([...order].reverse()));
    expect(counterValue(cells?.get(COLUMNS.views)?.value)).toBe(7);
    expect(counterValue(cells?.get(COLUMNS.balance)?.value)).toBe(-25);
    expect(setValue(cells?.get(COLUMNS.tags)?.value)).toEqual([]);
    expect(setValue(cells?.get(COLUMNS.assignees)?.value)).toEqual([
      { name: "ada", id: 42, roles: ["admin", "author"] },
    ]);
  });
});

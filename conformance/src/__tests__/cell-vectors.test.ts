import type {
  Change,
  CellChange,
  JsonValue,
  RowKey,
  State,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import {
  applyCellChange,
  canonicalJson,
  cellsFor,
  counterValue,
  createHlcClock,
  emptyState,
  eventId,
  getRecord,
  parsePeerId,
  parseSeqNum,
  setValue,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import {
  CELL_KIND,
  bytesToHex,
  createIdentity,
  decodeAndVerify,
  decodeCbor,
  decodeCellChange,
  encodeCbor,
  encodeCellChange,
  encodeEventCore,
  hexToBytes,
  isSafeNonNegative,
  isString,
  signEvent,
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

  test("the kinds continue the row-level numbering, so an older peer parks rather than folds", () => {
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

/** The frozen change as a build with no fold for its tag reads it (D22-A). */
const asUnknown = (wireHex: string): Change => {
  const map = decodeCbor(hexToBytes(wireHex).unwrap()).unwrap();
  if (!(map instanceof Map)) throw new Error("a cell change is a CBOR map");
  const [tag, table, key, data] = [map.get(0), map.get(1), map.get(2), map.get(3)];
  if (!isSafeNonNegative(tag) || !isString(table) || !isString(key))
    throw new Error("a cell change carries a tag, a table and a key");
  // SAFETY: the brands' naming rules belong to the schema; these came out of the frozen vectors
  return { kind: "unknown", tag, table: table as TableName, key: key as RowKey, data };
};

const older = () =>
  createEngine({
    peerId: parsePeerId("b".repeat(64)).unwrap(),
    clock: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(100) }),
    store: createMemoryEventStore(),
  });

describe("what a build with no fold for these kinds does with them", () => {
  const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 * i + 1)).unwrap();
  const eventOf = (change: Change, seq: number): SyncEvent => {
    const seqNum = parseSeqNum(seq).unwrap();
    return {
      v: 1,
      id: eventId(author.peerId, seqNum),
      peerId: author.peerId,
      seqNum,
      hlc: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(1000 + seq) }).tick(),
      // SAFETY: the procedure's naming rules belong to the schema, which this package has none of
      procedure: "notes.create" as SyncEvent["procedure"],
      changes: [change],
    };
  };

  test("carries them through the codec untouched, so the signature still covers what it parks", () => {
    for (const v of raw.vectors) {
      const wire = signEvent(eventOf(asUnknown(v.wireHex), 1), author).wire;
      const verified = decodeAndVerify(wire).unwrap();
      // a build that could not re-emit these bytes could not serve the run they sit in, and the
      // later build that understands them would never be offered the event at all
      expect(verified.event.changes[0]).toEqual(asUnknown(v.wireHex));
      expect(bytesToHex(verified.core)).toBe(bytesToHex(encodeEventCore(verified.event)));
    }
  });

  test("parks them as unknown-kind and holds the author's run open at their sequence", async () => {
    const engine = older();
    const entries = raw.vectors.map((v, i) => {
      const wire = signEvent(eventOf(asUnknown(v.wireHex), i + 1), author).wire;
      return decodeAndVerify(wire).unwrap();
    });
    const report = (await engine.receiveBatch(entries)).unwrap();

    expect(report.quarantined).toBe(entries.length);
    expect(report.folded).toBe(0);
    expect(new Set(engine.quarantine().map((p) => p.reason))).toEqual(new Set(["unknown-kind"]));
    // nothing folded, so no row moved — the whole point of parking rather than guessing
    expect(cellsOf(engine.state())).toBeUndefined();
    // and the cursor stays below the first of them, where a later build picks the run back up
    expect(engine.coverage().synced.get(author.peerId)).toBeUndefined();
  });

  test("keeps the author's own bytes for each, not a re-encode of what it could read", async () => {
    const engine = older();
    const wires = raw.vectors.map((v, i) =>
      signEvent(eventOf(asUnknown(v.wireHex), i + 1), author),
    );
    (await engine.receiveBatch(wires.map((w) => decodeAndVerify(w.wire).unwrap()))).unwrap();

    const cores = engine.quarantine().map((p) => bytesToHex(p.entry.core ?? new Uint8Array()));
    for (const signed of wires) expect(cores).toContain(bytesToHex(signed.core));
  });
});

/**
 * The lineage cells of `conformance/doc-vectors.json` (RFC-0023 §16.1, gaps U21, U39): records
 * whose doc column holds a cell of each version and shape, and the verdict `parseLineageCells`
 * reaches on each. Both runtimes decode every record and must reach the same verdict.
 */
import {
  getRecord,
  hlcOf,
  docLineage,
  isJsonArray,
  parseLineageCells,
  type CellValue,
  type PeerId,
  type RowRecord,
} from "@syncmesh/kernel";
import { bytesToHex, encodeRecord } from "@syncmesh/wire";

import { CONTENT, DOCS, N1, NOTES, T0 } from "./doc-names.js";
import { foldGeneses, id16 } from "./lineage-trees.js";

/** The tag at the head of a lineage cell's value. */
const cellVersion = (value: CellValue | undefined) => {
  const [version] = isJsonArray(value) ? value : [];
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- reading back a cell this file wrote */
  return typeof version === "number" ? version : undefined;
};

/** The record with its lineage cell's value replaced, stamp and all else kept. */
const withCell = (record: RowRecord, value: CellValue): RowRecord => {
  const cell = record.cells.get(CONTENT);
  if (cell === undefined) throw new Error("the record holds no lineage cell");
  return { ...record, cells: new Map(record.cells).set(CONTENT, { ...cell, value }) };
};

/**
 * Lineage cells as snapshot pages, repair records and persisted state carry them (RFC-0023
 * §16.1, gaps U21, U39): the two shapes of the rule this build runs, read — rule 3's with no
 * anchor and with one — and the ones it refuses: cells of rules 1 and 2, whose join kept an
 * equivocated lineage's first copy, an untagged cell from before cells were versioned, the lineage
 * id the last-writer-wins rule kept, a rule-3 cell in a shape it never writes, and a cell of a
 * later version. Both runtimes decode each record and must reach the same verdict.
 */
export const lineageCellVectors = (author: PeerId, producer: PeerId) => {
  const held = getRecord(
    foldGeneses([
      { lineage: id16("a1"), parent: undefined, ms: T0 + 1, logical: 0, peer: author },
      { lineage: id16("c1"), parent: id16("a1"), ms: T0 + 3, logical: 0, peer: producer },
    ]),
    NOTES,
    N1,
  );
  const value = held?.cells.get(CONTENT)?.value;
  if (held === undefined || !isJsonArray(value)) throw new Error("the fold wrote no tagged cell");
  const [, geneses = null] = value;
  const settled = getRecord(
    foldGeneses([
      { lineage: id16("a1"), parent: undefined, ms: T0 + 1, logical: 0, peer: author },
      {
        lineage: id16("c1"),
        parent: id16("a1"),
        ms: T0 + 3,
        logical: 0,
        peer: producer,
        settles: { lineage: id16("a1"), stamp: { hlc: hlcOf(T0 + 1, 0), peer: author } },
      },
    ]),
    NOTES,
    N1,
  );
  const settledValue = settled?.cells.get(CONTENT)?.value;
  if (settled === undefined || !isJsonArray(settledValue))
    throw new Error("the fold wrote no settled cell");
  const [, settledGeneses = null, anchor = null] = settledValue;
  const cells = [
    ["a cell of rule 3: read, and walked to its winner", held],
    ["a cell of rule 3 with an anchor: read, and walked from its anchor", settled],
    [
      "a cell of rule 1: refused, its join kept an equivocated lineage's first copy",
      withCell(held, [1, geneses]),
    ],
    [
      "a cell of rule 2: refused, its join kept an equivocated lineage's first copy",
      withCell(held, [2, settledGeneses, anchor]),
    ],
    ["an untagged cell, written before cells were versioned: refused", withCell(held, geneses)],
    ["the last-writer-wins rule's cell, a bare lineage id: refused", withCell(held, id16("a1"))],
    [
      "a cell tagged 3 with an anchor that is not one: refused, a shape rule 3 never writes",
      withCell(held, [3, geneses, id16("a1")]),
    ],
    ["a cell of version 4: refused, never read as the root", withCell(held, [4, geneses])],
  ] as const;
  return cells.map(([description, record]) => {
    const parsed = parseLineageCells([{ table: NOTES, key: N1, record }], DOCS);
    return {
      description,
      recordHex: bytesToHex(encodeRecord(record)),
      refused: parsed.isErr(),
      version: parsed.isErr()
        ? parsed.error.version
        : (cellVersion(record.cells.get(CONTENT)?.value) ?? null),
      winner: parsed.isErr() ? null : (docLineage(record, CONTENT) ?? null),
    };
  });
};

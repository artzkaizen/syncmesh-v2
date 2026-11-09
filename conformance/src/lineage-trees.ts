/**
 * The lineage trees of `conformance/doc-vectors.json` (RFC-0023 §16.1): geneses of one document,
 * the lineage the first-genesis tree settles on, and the lineage cell's record bytes. Both
 * runtimes fold every permutation and must land on the same record and the same winner.
 */
import {
  applyChange,
  emptyState,
  getRecord,
  hlcOf,
  docLineage,
  isJsonArray,
  parseLineageCells,
  parseLineageId,
  type CellValue,
  type LineageId,
  type PeerId,
  type RowRecord,
  type SettledLineage,
} from "@syncmesh/kernel";
import { bytesToHex, encodeRecord } from "@syncmesh/wire";

import { CONTENT, DOCS, LORO, N1, NOTES, T0 } from "./doc-names.js";

const id16 = (fill: string): LineageId => parseLineageId(fill.repeat(16)).unwrap();

type Who = "author" | "producer";

/**
 * Geneses of one document as `[lineage fill, parent fill | undefined, ms after T0, author,
 * anchor?]` — the anchor a genesis of rule 2 settles the walk at, `[lineage fill, ms after T0,
 * author]` (gaps U21) — and the lineage the first-genesis tree settles on (RFC-0023 §16.1). Each
 * is folded in the order listed; both runtimes also fold every permutation and must land on the
 * same record bytes.
 */
const LINEAGE_TREES: readonly {
  readonly description: string;
  readonly geneses: readonly (
    | readonly [string, string | undefined, number, Who]
    | readonly [string, string | undefined, number, Who, readonly [string, number, Who]]
  )[];
  readonly winner: string | undefined;
}[] = [
  {
    description: "two replaces of the root: the first wins",
    geneses: [
      ["b1", undefined, 5, "producer"],
      ["a1", undefined, 1, "author"],
    ],
    winner: "a1",
  },
  {
    description: "a restore on top of the winner wins, however late",
    geneses: [
      ["a1", undefined, 1, "author"],
      ["b1", undefined, 5, "producer"],
      ["c1", "a1", 9, "producer"],
    ],
    winner: "c1",
  },
  {
    description: "a genesis whose parent is not held hangs off nothing: the root stays",
    geneses: [["c1", "a1", 2, "producer"]],
    winner: undefined,
  },
  {
    description: "a deeper tree: the walk follows the first child of each winner",
    geneses: [
      ["a1", undefined, 1, "author"],
      ["b1", "a1", 4, "author"],
      ["c1", "a1", 3, "producer"],
      ["d1", "b1", 2, "producer"],
      ["e1", "c1", 6, "author"],
    ],
    winner: "e1",
  },
  {
    description: "an anchor drops every genesis it passed, and the walk starts there (gaps U21)",
    geneses: [
      ["a1", undefined, 1, "author"],
      ["b1", undefined, 5, "producer"],
      ["c1", "a1", 9, "producer"],
      ["d1", "c1", 20, "author", ["c1", 9, "producer"]],
    ],
    winner: "d1",
  },
  {
    description: "a genesis stamped below the anchor never wins, whenever it lands",
    geneses: [
      ["a1", undefined, 1, "author"],
      ["c1", "a1", 9, "producer"],
      ["e1", "a1", 3, "producer"],
      ["d1", "c1", 20, "author", ["c1", 9, "producer"]],
    ],
    winner: "d1",
  },
  {
    description: "of two anchors the later one holds",
    geneses: [
      ["a1", undefined, 1, "author"],
      ["b1", "a1", 4, "author", ["a1", 1, "author"]],
      ["c1", "b1", 8, "producer", ["b1", 4, "author"]],
    ],
    winner: "c1",
  },
  {
    description: "an anchor whose own genesis is not held still starts the walk",
    geneses: [["d1", "c1", 20, "author", ["c1", 9, "producer"]]],
    winner: "d1",
  },
];

interface HeldGenesis {
  readonly lineage: LineageId;
  readonly parent: LineageId | undefined;
  readonly ms: number;
  readonly logical: number;
  readonly peer: PeerId;
  readonly settles?: SettledLineage | undefined;
}

/** Folds geneses of `notes/n1.content` into an empty state, in the order given. */
export const foldGeneses = (geneses: readonly HeldGenesis[]) =>
  geneses.reduce(
    (state, g) =>
      applyChange(
        state,
        {
          kind: "doc",
          table: NOTES,
          key: N1,
          column: CONTENT,
          adapter: LORO,
          update: { bytes: new Uint8Array(0) },
          lineage: g.lineage,
          genesis: true,
          ...(g.parent !== undefined && { parent: g.parent }),
          ...(g.settles !== undefined && { settles: g.settles }),
        },
        { hlc: hlcOf(g.ms, g.logical), peer: g.peer },
      ),
    emptyState(),
  );

/** The trees as the vector file holds them, authored by `author` and `producer`. */
export const lineageTreeVectors = (author: PeerId, producer: PeerId) =>
  LINEAGE_TREES.map(({ description, geneses, winner }) => {
    const peer = (who: Who) => (who === "author" ? author : producer);
    const held = geneses.map(([fill, parent, ms, who, anchor]) => ({
      lineage: id16(fill),
      parent: parent === undefined ? undefined : id16(parent),
      ms: T0 + ms,
      logical: 0,
      peer: peer(who),
      settles:
        anchor === undefined
          ? undefined
          : {
              lineage: id16(anchor[0]),
              stamp: { hlc: hlcOf(T0 + anchor[1], 0), peer: peer(anchor[2]) },
            },
    }));
    const record = getRecord(foldGeneses(held), NOTES, N1);
    const settled = docLineage(record, CONTENT);
    if (settled !== (winner === undefined ? undefined : id16(winner)))
      throw new Error(`${description}: the rule settled on ${settled ?? "the root"}`);
    return {
      description,
      geneses: held.map(({ settles, ...g }) => ({
        ...g,
        parent: g.parent ?? null,
        settles:
          settles === undefined
            ? null
            : {
                lineage: settles.lineage,
                ms: settles.stamp.hlc[0].epochMilliseconds,
                logical: settles.stamp.hlc[1],
                peer: settles.stamp.peer,
              },
      })),
      winner: settled ?? null,
      recordHex: record === undefined ? "" : bytesToHex(encodeRecord(record)),
    };
  });

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
 * §16.1, gaps U21): one of each version this build runs, read — rule 1's, and rule 2's with its
 * anchor — and four it refuses: an untagged cell from before cells were versioned, the lineage id
 * the last-writer-wins rule kept, a rule-2 cell with no anchor, and a cell of a version after
 * both. Both runtimes decode each record and must reach the same verdict.
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
  if (settled === undefined) throw new Error("the fold wrote no settled cell");
  const cells = [
    ["a cell of rule 1: read, and walked to its winner", held],
    ["a cell of rule 2: read, and walked from its anchor", settled],
    ["an untagged cell, written before cells were versioned: refused", withCell(held, geneses)],
    ["the last-writer-wins rule's cell, a bare lineage id: refused", withCell(held, id16("a1"))],
    [
      "a cell tagged 2 with no anchor: refused, a shape rule 2 never writes",
      withCell(held, [2, geneses]),
    ],
    ["a cell of version 3: refused, never read as the root", withCell(held, [3, geneses])],
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

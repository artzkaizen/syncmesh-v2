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
  parseLineageId,
  type LineageId,
  type PeerId,
  type SettledLineage,
} from "@syncmesh/kernel";
import { bytesToHex, encodeRecord } from "@syncmesh/wire";

import { CONTENT, LORO, N1, NOTES, T0 } from "./doc-names.js";

/** A lineage id of one repeated byte, written as two hex characters. */
export const id16 = (fill: string): LineageId => parseLineageId(fill.repeat(16)).unwrap();

type Who = "author" | "producer";

/**
 * Geneses of one document as `[lineage fill, parent fill | undefined, ms after T0, author,
 * anchor?]` — the anchor a genesis settles the walk at, `[lineage fill, ms after T0, author]`
 * (gaps U21) — and the lineage the first-genesis tree settles on (RFC-0023 §16.1). A fill listed
 * twice is an author that signed two geneses of one lineage (gaps U39). Each tree is folded in
 * the order listed; both runtimes also fold every permutation and must land on the same record
 * bytes.
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
  {
    description:
      "an author signed two geneses of one lineage, one each side of an anchor: the later copy stands in every order (gaps U39)",
    geneses: [
      ["c1", undefined, 4, "producer"],
      ["e1", "c1", 3, "author"],
      ["e1", "c1", 6, "author"],
      ["d1", "c1", 10, "producer", ["c1", 4, "producer"]],
    ],
    winner: "e1",
  },
  {
    description:
      "two copies of one lineage under different parents: the later copy places it (gaps U39)",
    geneses: [
      ["a1", undefined, 1, "producer"],
      ["e1", undefined, 2, "author"],
      ["e1", "a1", 5, "author"],
    ],
    winner: "e1",
  },
  {
    description:
      "two copies of one lineage at one stamp: the copy under a parent goes after the root's and stands (gaps U39)",
    geneses: [
      ["a1", undefined, 1, "producer"],
      ["e1", undefined, 5, "author"],
      ["e1", "a1", 5, "author"],
    ],
    winner: "e1",
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

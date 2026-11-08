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
} from "@syncmesh/kernel";
import { bytesToHex, encodeRecord } from "@syncmesh/wire";

import { CONTENT, LORO, N1, NOTES, T0 } from "./doc-names.js";

const id16 = (fill: string): LineageId => parseLineageId(fill.repeat(16)).unwrap();

/**
 * Geneses of one document as `[lineage fill, parent fill | undefined, ms after T0, author]`, and
 * the lineage the first-genesis tree settles on (RFC-0023 §16.1). Each is folded in the order
 * listed; both runtimes also fold every permutation and must land on the same record bytes.
 */
const LINEAGE_TREES: readonly {
  readonly description: string;
  readonly geneses: readonly (readonly [
    string,
    string | undefined,
    number,
    "author" | "producer",
  ])[];
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
];

interface HeldGenesis {
  readonly lineage: LineageId;
  readonly parent: LineageId | undefined;
  readonly ms: number;
  readonly logical: number;
  readonly peer: PeerId;
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
        },
        { hlc: hlcOf(g.ms, g.logical), peer: g.peer },
      ),
    emptyState(),
  );

/** The trees as the vector file holds them, authored by `author` and `producer`. */
export const lineageTreeVectors = (author: PeerId, producer: PeerId) =>
  LINEAGE_TREES.map(({ description, geneses, winner }) => {
    const held = geneses.map(([fill, parent, ms, who]) => ({
      lineage: id16(fill),
      parent: parent === undefined ? undefined : id16(parent),
      ms: T0 + ms,
      logical: 0,
      peer: who === "author" ? author : producer,
    }));
    const record = getRecord(foldGeneses(held), NOTES, N1);
    const settled = docLineage(record, CONTENT);
    if (settled !== (winner === undefined ? undefined : id16(winner)))
      throw new Error(`${description}: the rule settled on ${settled ?? "the root"}`);
    return {
      description,
      geneses: held.map((g) => ({ ...g, parent: g.parent ?? null })),
      winner: settled ?? null,
      recordHex: record === undefined ? "" : bytesToHex(encodeRecord(record)),
    };
  });

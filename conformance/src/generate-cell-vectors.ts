/**
 * Regenerates conformance/cell-vectors.json from fixed seeds. Run only when the cell-change wire
 * deliberately changes (README rule 3): `bun conformance/src/generate-cell-vectors.ts`.
 */
import type {
  CellChange,
  ColumnName,
  JsonValue,
  MergeSpec,
  RowKey,
  SetTag,
  StrategyName,
  TableName,
} from "@syncmesh/kernel";

import { canonicalJson, cellsFor, hlcOf } from "@syncmesh/kernel";
import { bytesToHex, createIdentity, encodeCbor, encodeCellChange } from "@syncmesh/wire";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 101 + i);
const AUTHOR = createIdentity(DEVICE_SEED).unwrap().peerId;

/** The one stamp every vector is written under, so a port folds them from exactly these bytes. */
export const STAMP = { hlc: hlcOf(1_700_000_000_000, 3), peer: AUTHOR };

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixed vector names; the grammar for each is the schema's (E05), and a vector is not where it is enforced */
const table = (name: string) => name as TableName;
const key = (name: string) => name as RowKey;
const column = (name: string) => name as ColumnName;
const tag = (name: string) => name as SetTag;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

export const NOTES = table("notes");
export const N1 = key("n1");

/** Two counter columns and two set columns, named once for the generator and the test alike. */
export const COLUMNS = {
  assignees: column("assignees"),
  balance: column("balance"),
  tags: column("tags"),
  views: column("views"),
};

/**
 * The strategies the vectors' columns carry. None is declared: `views` and `balance` merge by
 * `counter` and `tags` and `assignees` by `set` because that is what their column kinds are (E26),
 * which is the same rule `strategyOf` applies when a schema builds a `MergeSpec`.
 */
export const CELL_MERGE: MergeSpec = new Map([
  [
    NOTES,
    new Map<ColumnName, StrategyName>([
      [COLUMNS.views, "counter"],
      [COLUMNS.balance, "counter"],
      [COLUMNS.tags, "set"],
      [COLUMNS.assignees, "set"],
    ]),
  ],
]);

/**
 * One change of every cell-level kind, each pinned twice: the canonical CBOR a peer sends, and the
 * cells it writes into the row. A port that reproduces the first has the codec; a port that
 * reproduces the second has the payload's *meaning* — that an increment carries running totals and
 * not a step, that a remove carries ids and not values.
 */
const cases = [
  {
    description: "increment, one column, an author that has only ever added",
    change: {
      kind: "increment",
      table: NOTES,
      key: N1,
      counts: new Map([[COLUMNS.views, { dec: 0, inc: 7 }]]),
    },
  },
  {
    description: "increment, two columns out of name order, one of them net negative",
    change: {
      kind: "increment",
      table: NOTES,
      key: N1,
      counts: new Map([
        [COLUMNS.views, { dec: 2, inc: 9 }],
        [COLUMNS.balance, { dec: 40, inc: 15 }],
      ]),
    },
  },
  {
    description: "add, one text element",
    change: {
      kind: "add",
      table: NOTES,
      key: N1,
      adds: new Map([[COLUMNS.tags, { tag: tag(`1700000000000.3.0@${AUTHOR}`), value: "urgent" }]]),
    },
  },
  {
    description: "add, an object element whose keys were built out of order",
    change: {
      kind: "add",
      table: NOTES,
      key: N1,
      adds: new Map([
        [
          COLUMNS.assignees,
          {
            tag: tag(`1700000000000.3.1@${AUTHOR}`),
            value: { name: "ada", id: 42, roles: ["admin", "author"] },
          },
        ],
      ]),
    },
  },
  {
    description: "remove, three ids given out of order — the wire sorts them",
    change: {
      kind: "remove",
      table: NOTES,
      key: N1,
      drops: new Map([
        [
          COLUMNS.tags,
          [
            tag(`1700000000000.9.0@${AUTHOR}`),
            tag(`1700000000000.3.0@${AUTHOR}`),
            tag(`1699999999999.0.2@${AUTHOR}`),
          ],
        ],
      ]),
    },
  },
  {
    description: "remove, an id no add of this build's ever carried — a tombstone is still written",
    change: {
      kind: "remove",
      table: NOTES,
      key: N1,
      drops: new Map([[COLUMNS.tags, [tag("from-another-implementation")]]]),
    },
  },
] satisfies readonly { description: string; change: CellChange }[];

/** The cells a change writes, as canonical text: object keys sorted at every level, values as JSON. */
const cellsJson = (change: CellChange): string => {
  const cells = [...cellsFor(change, STAMP)].map(([name, cell]) => {
    // SAFETY: the three cell kinds write JSON lattice fragments — counter totals, tagged adds,
    // tombstones — and never bytes, which is the only CellValue that is not a JsonValue
    return [String(name), cell.value as JsonValue] as const;
  });
  return canonicalJson(Object.fromEntries(cells));
};

export function cellVectors() {
  return {
    peerId: AUTHOR,
    hlc: [STAMP.hlc[0].epochMilliseconds, STAMP.hlc[1]],
    vectors: cases.map(({ description, change }) => ({
      description,
      wireHex: bytesToHex(encodeCbor(encodeCellChange(change))),
      cellsJson: cellsJson(change),
    })),
  };
}

if (import.meta.main) {
  const out = new URL("../cell-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(cellVectors(), null, 2)}\n`);
}

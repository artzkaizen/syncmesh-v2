/**
 * The paths whose **shape** this repo is claiming, and the gate that holds them to it.
 *
 * One entry per thing that has to stay the same cost as the data grows. A path is added here when
 * somebody notices a cost that a small fixture hides — which is every scale bug this codebase has
 * had, because the test suite runs on 120 seeded issues and the bugs live at half a million.
 *
 * `bun run --cwd bench scale`. Non-zero exit on a regression, so it can be a CI step.
 */
import type {
  Cell,
  CellValue,
  ColumnName,
  Logical,
  Procedure,
  Row,
  RowKey,
  RowRecord,
  State,
  TableName,
} from "@syncmesh/kernel";

import {
  applyChange,
  emptyState,
  stampOf,
  eventId,
  parseSeqNum,
  parsePeerId,
} from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { encodeCbor, newContentKey, sealPayload } from "@syncmesh/wire";

import { path, runScale } from "./harness.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- bench fixtures; naming is not what is measured */
const NOTES = "notes" as TableName;
const PROCEDURE = "notes.write" as Procedure;
const ZERO = 0 as Logical;
const column = (name: string) => name as ColumnName;
const key = (n: number) => `n${n}` as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const PEER = parsePeerId("a".repeat(64)).unwrap();

const row = (seq: number): Row =>
  new Map<ColumnName, CellValue>([
    [column("title"), `note ${seq}`],
    [column("done"), seq % 2 === 0],
    [column("body"), "x".repeat(120)],
  ]);

const event = (seq: number, rows: number) => ({
  v: 1 as const,
  id: eventId(PEER, parseSeqNum(seq).unwrap()),
  peerId: PEER,
  seqNum: parseSeqNum(seq).unwrap(),
  hlc: [Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000 + seq), ZERO] as const,
  procedure: PROCEDURE,
  changes: [
    seq <= rows
      ? { kind: "insert" as const, table: NOTES, key: key(((seq - 1) % rows) + 1), row: row(seq) }
      : {
          kind: "update" as const,
          table: NOTES,
          key: key(((seq - 1) % rows) + 1),
          patch: row(seq),
        },
  ],
});

await runScale([
  path({
    name: "kernel · applyChange",
    growth: "constant",
    because:
      "Folding one change touches one row. Cost that tracks the number of rows already held means the fold is copying the table per event, which makes replaying a log quadratic in its own state — 20,000 events over 5,000 rows is a second of copying, and it gets worse for the life of the app.",
    sizes: [1_000, 4_000, 16_000],
    prepare: (rows) => {
      let state: State = emptyState();
      for (let seq = 1; seq <= rows; seq += 1) {
        const e = event(seq, rows);
        for (const change of e.changes)
          state = applyChange(state, change, stampOf(e), undefined, undefined);
      }
      const next = event(rows + 1, rows);
      return { state, change: next.changes[0]!, stamp: stampOf(next) };
    },
    run: ({ state, change, stamp }) => applyChange(state, change, stamp, undefined, undefined),
  }),

  path({
    name: "wire · encodeCbor (bytes)",
    growth: "linear",
    because:
      "A serializer walks its payload once. Anything worse than linear is the writer doing per-byte work with a per-call cost — an array of numbers grown one push at a time, or a spread that re-reads what it already wrote. It also caps how large a blob or snapshot can be encoded before the spread overflows the stack.",
    sizes: [16_384, 65_536, 262_144],
    /**
     * A quarter-megabyte payload, with room to spare over a writer that fills a preallocated
     * buffer — measured at roughly 30 µs for this size. The budget is here rather than a tighter
     * class because the curve is honest: the writer *is* linear, it simply pays a per-byte push
     * into a number array and a spread on top of it, which a shape check can never see.
     */
    budget: 200,
    prepare: (bytes) => new Uint8Array(bytes).fill(1),
    run: (payload) => encodeCbor(payload),
  }),

  path({
    name: "wire · sealPayload (bytes)",
    growth: "linear",
    because:
      "An AEAD is one pass over the plaintext. This path is the control: it is expected to hold, and a failure here is evidence the harness is measuring noise rather than that the cipher regressed.",
    sizes: [4_096, 16_384, 65_536],
    prepare: (bytes) => ({
      key: newContentKey(),
      plain: new Uint8Array(bytes).fill(3),
      aad: new Uint8Array(32),
    }),
    run: ({ key: k, plain, aad }) => sealPayload(k, plain, aad),
  }),

  path({
    name: "kernel · mergeCells into a wide row",
    growth: "constant",
    because:
      "Merging one cell reads that column and writes it back. Cost that tracks the row's other columns means the join is rebuilding the whole cell map per change, which is the same copy-per-write shape as the fold and shows up on tables with many columns rather than many rows.",
    sizes: [8, 32, 128],
    prepare: (columns) => {
      const cells = new Map<ColumnName, Cell>();
      const e = event(1, 1);
      const stamp = stampOf(e);
      for (let i = 0; i < columns; i += 1) cells.set(column(`c${i}`), { value: i, stamp });
      const record: RowRecord = { cells, writeStamp: stamp };
      const table = new Map<RowKey, RowRecord>([[key(1), record]]);
      const state: State = new Map([[NOTES, table]]);
      return {
        state,
        change: {
          kind: "update" as const,
          table: NOTES,
          key: key(1),
          patch: new Map([[column("c0"), 1]]),
        },
        stamp,
      };
    },
    run: ({ state, change, stamp }) => applyChange(state, change, stamp, undefined, undefined),
  }),
]);

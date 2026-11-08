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
  CellValue,
  ColumnName,
  Logical,
  Procedure,
  Row,
  RowKey,
  State,
  TableName,
} from "@syncmesh/kernel";

import { createMemoryEventStore } from "@syncmesh/engine";
import {
  applyChange,
  emptyState,
  mergeRecord,
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
    name: "kernel · mergeRecord (snapshot install, repair)",
    growth: "constant",
    because:
      "Installing a snapshot or healing a divergence merges one whole record per row through the same join as the fold. Cost that tracks the rows already installed means each row copies the table, so a 30,000-row join is quadratic before the first frame is drawn.",
    sizes: [1_000, 4_000, 16_000],
    prepare: (rows) => {
      let state: State = emptyState();
      for (let seq = 1; seq <= rows; seq += 1) {
        const e = event(seq, rows);
        for (const change of e.changes)
          state = applyChange(state, change, stampOf(e), undefined, undefined);
      }
      const next = event(rows + 1, rows);
      const record = applyChange(
        emptyState(),
        next.changes[0]!,
        stampOf(next),
        undefined,
        undefined,
      )
        .get(NOTES)!
        .get(next.changes[0]!.key)!;
      return { state, key: next.changes[0]!.key, record };
    },
    run: ({ state, key: k, record }) => mergeRecord(state, NOTES, k, record),
  }),

  path({
    name: "engine · memory store lastSeq",
    growth: "constant",
    because:
      "Every write asks the store for this author's last sequence number before it numbers the next event. Cost that tracks the log means the store walks every event it holds per write, which makes a session's writes quadratic in its own history.",
    sizes: [1_000, 4_000, 16_000],
    prepare: async (events) => {
      const store = createMemoryEventStore();
      const entries = Array.from({ length: events }, (_, i) => ({ event: event(i + 1, events) }));
      (await store.appendBatch(entries)).unwrap();
      return store;
    },
    run: (store) => void store.lastSeq(PEER, "synced"),
  }),

  path({
    name: "wire · encodeCbor (bytes)",
    growth: "linear",
    because:
      "A serializer walks its payload once. Anything worse than linear is the writer doing per-byte work with a per-call cost — an array of numbers grown one push at a time, or a spread that re-reads what it already wrote. It also caps how large a blob or snapshot can be encoded before the spread overflows the stack.",
    sizes: [16_384, 65_536, 262_144],
    /**
     * A quarter-megabyte payload. A writer that pushes each byte into a number array and spreads
     * it is still linear, so only a budget sees it: that writer took about 87 ms at this size.
     * The growable-buffer writer takes 30–60 µs on a laptop and about 250 µs on a shared CI
     * runner, where allocation and page faults dominate. The budget sits far above the second and
     * far below the first.
     */
    budget: 2_000,
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
    // built through the fold, as every row the engine holds is: a hand-made plain `Map` would be
    // copied on its first write — once per row loaded at boot, not once per change
    prepare: (columns) => {
      const stamp = stampOf(event(1, 1));
      const wide = new Map<ColumnName, CellValue>();
      for (let i = 0; i < columns; i += 1) wide.set(column(`c${i}`), i);
      const state = applyChange(
        emptyState(),
        { kind: "insert", table: NOTES, key: key(1), row: wide },
        stamp,
        undefined,
        undefined,
      );
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

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

import { createEngine, createMemoryEventStore } from "@syncmesh/engine";
import {
  applyChange,
  createHlcClock,
  emptyState,
  mergeRecord,
  eventStamp,
  eventId,
  parseSeqNum,
  parsePeerId,
} from "@syncmesh/kernel";
import { t, table } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores, schemaName } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { encodeCbor, encodeEventCore, newContentKey, sealPayload } from "@syncmesh/wire";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fanoutRoom } from "./fanout-room.js";
import { path, runScale } from "./harness.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- bench fixtures; naming is not what is measured */
const NOTES = "notes" as TableName;
const PROCEDURE = "notes.write" as Procedure;
const ZERO = 0 as Logical;
const column = (name: string) => name as ColumnName;
const key = (n: number) => `n${n}` as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** The table the events below write, as an app declares it: what a durable store projects into. */
const NOTES_TABLE = table("notes", {
  title: t.text().primaryKey(),
  done: t.boolean(),
  body: t.text(),
});

const PEER = parsePeerId("a".repeat(64)).unwrap();
/** The device that receives: never the author, so what it folds is somebody else's. */
const DEVICE = parsePeerId("b".repeat(64)).unwrap();

const row = (seq: number): Row =>
  new Map<ColumnName, CellValue>([
    [column("title"), `note ${seq}`],
    [column("done"), seq % 2 === 0],
    [column("body"), "x".repeat(120)],
  ]);

const event = (seq: number, rows: number, author = PEER) => ({
  v: 1 as const,
  id: eventId(author, parseSeqNum(seq).unwrap()),
  peerId: author,
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
          state = applyChange(state, change, eventStamp(e), undefined, undefined);
      }
      const next = event(rows + 1, rows);
      return { state, change: next.changes[0]!, stamp: eventStamp(next) };
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
          state = applyChange(state, change, eventStamp(e), undefined, undefined);
      }
      const next = event(rows + 1, rows);
      const record = applyChange(
        emptyState(),
        next.changes[0]!,
        eventStamp(next),
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
      const stamp = eventStamp(event(1, 1));
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
  path({
    name: "engine · receive one event (fold and log)",
    growth: "constant",
    because:
      "Receiving one event validates it, appends it to the log and folds its one change into the replica. Cost that tracks the rows already held means some step on the receive path — admission, the fold, the coverage — walks the replica per event, which makes every catch-up quadratic in the device's own state.",
    sizes: [1_000, 4_000, 16_000],
    /**
     * About 50 µs on a laptop at every size, the fold a small part of it and the rest the
     * engine's per-event admission and bookkeeping; the budget leaves a shared runner its 3–5×.
     */
    budget: 1_000,
    prepare: async (rows) => {
      const engine = createEngine({
        peerId: DEVICE,
        clock: createHlcClock({ now: () => Temporal.Now.instant() }),
        store: createMemoryEventStore(),
      });
      const held = Array.from({ length: rows }, (_, i) => ({ event: event(i + 1, rows) }));
      (await engine.receiveBatch(held)).unwrap();
      let next = rows;
      // built per call, so the clock includes one small event's construction: the same at every size
      return { engine, next: () => ({ event: event((next += 1), rows) }) };
    },
    run: async ({ engine, next }) => (await engine.receive(next())).unwrap(),
  }),

  path({
    name: "storage · receive one event into SQLite (log, state and tables)",
    growth: "constant",
    because:
      "Receiving one event into a durable store asks the log for its author's head, appends it, and writes the row to the state sidecar, the row-sync table and the app's table. Cost that tracks the events already held means a statement reads the author's run rather than the end of its key — the head read did, through a MAX over a UNION, until the ten-million ladder found it (gaps O17).",
    sizes: [1_000, 4_000, 16_000],
    /** About 150 µs on a laptop at every size: a transaction of a few statements. */
    budget: 5_000,
    prepare: async (rows) => {
      const dir = mkdtempSync(join(tmpdir(), "syncmesh-scale-"));
      const driver = bunSqliteDriver(join(dir, "receive.db"), schemaName([NOTES_TABLE]));
      const stores = (await openStores(driver, { tables: [NOTES_TABLE] })).unwrap();
      const engine = createEngine({
        peerId: DEVICE,
        clock: createHlcClock({ now: () => Temporal.Now.instant() }),
        store: stores.events,
        stateStore: stores.state,
        atomic: stores.atomic,
      });
      for (let at = 0; at < rows; at += 1_000) {
        const page = Array.from({ length: Math.min(1_000, rows - at) }, (_, i) => ({
          event: event(at + i + 1, rows),
        }));
        (await engine.receiveBatch(page)).unwrap();
      }
      let next = rows;
      return { engine, dir, driver, next: () => ({ event: event((next += 1), rows) }) };
    },
    run: async ({ engine, next }) => (await engine.receive(next())).unwrap(),
    release: async ({ driver, dir }) => {
      await driver.close?.();
      rmSync(dir, { recursive: true, force: true });
    },
  }),

  path({
    name: "wire · encodeEventCore (changes)",
    growth: "linear",
    because:
      "Every event a device writes is encoded once to be signed, stored and sent, and its size is its changes. Anything worse than linear in them is the encoder re-reading what it already wrote — and a bulk import of a few hundred rows is one event.",
    sizes: [16, 64, 256],
    /** About 250 µs on a laptop for 256 three-column rows; a quadratic writer is tens of ms. */
    budget: 5_000,
    prepare: (changes) => {
      const one = event(1, changes);
      const many = Array.from({ length: changes }, (_, i) => event(i + 1, changes).changes[0]!);
      return { ...one, changes: many };
    },
    run: (built) => encodeEventCore(built),
  }),

  path({
    name: "relay · fan-out one event (subscribers)",
    growth: "linear",
    because:
      "A relay sends each event once to every socket that is interested in it, so its cost grows with the room, and no faster: the work per subscriber is an interest check and an enqueue of bytes encoded once. Faster growth is per-subscriber work that scans the others — re-encoding the frame per socket, or walking every client to decide each one.",
    sizes: [64, 256, 1_024],
    /**
     * From the author's frame to the last subscriber's send. About 650 µs on a laptop at 64 and
     * 1.2 ms at 1,024: verifying the signature and appending to the log, once, are most of it, so
     * the curve is flat and the budget is the sharper claim. Work per subscriber that scans the
     * others is a million steps at 1,024 — tens of milliseconds, far past it.
     */
    budget: 10_000,
    prepare: (subscribers) =>
      fanoutRoom(subscribers, (author, seq) => event(seq, 1, author), 4_000),
    run: (room) => room.publish(),
    release: (room) => room.close(),
  }),
]);

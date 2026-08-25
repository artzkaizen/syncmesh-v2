import type { EventStore, StateStore, StoredEvent } from "@syncmesh/engine";
import type {
  CellValue,
  ColumnName,
  Logical,
  Row,
  RowKey,
  SyncEvent,
  TableName,
} from "@syncmesh/kernel";
import type { Procedure } from "@syncmesh/kernel";

import { openEngine } from "@syncmesh/engine";
import { createHlcClock, eventId, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { sqliteEventStore, sqliteStateStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { bench, group, run, summary } from "mitata";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- bench fixtures; naming rules are not what is measured */
const NOTES = "notes" as TableName;
const PROCEDURE = "notes.write" as Procedure;
const key = (n: number) => `n${n}` as RowKey;
const column = (name: string) => name as ColumnName;
const ZERO = 0 as Logical;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const PEER = parsePeerId("a".repeat(64)).unwrap();
const clock = () => createHlcClock({ now: () => Temporal.Now.instant() });
const dbPath = () => join(mkdtempSync(join(tmpdir(), "syncmesh-bench-")), "bench.db");

const row = (seq: number): Row =>
  new Map<ColumnName, CellValue>([
    [column("title"), `note ${seq}`],
    [column("done"), seq % 2 === 0],
    [column("body"), "x".repeat(120)],
  ]);

/** Event `seq`: an insert while `seq ≤ rows`, then updates cycling over the same rows. */
const event = (seq: number, rows: number): SyncEvent => {
  const seqNum = parseSeqNum(seq).unwrap();
  const k = key(((seq - 1) % rows) + 1);
  const change =
    seq <= rows
      ? { kind: "insert" as const, table: NOTES, key: k, row: row(seq) }
      : { kind: "update" as const, table: NOTES, key: k, patch: row(seq) };
  return {
    v: 1,
    id: eventId(PEER, seqNum),
    peerId: PEER,
    seqNum,
    hlc: [Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000 + seq), ZERO],
    procedure: PROCEDURE,
    changes: [change],
  };
};

const openLog = async (path = dbPath()) => (await sqliteEventStore(bunSqliteDriver(path))).unwrap();

const BATCH = 1_000;

group("append 1,000 events — bun:sqlite on disk", () => {
  summary(async () => {
    const perCall = await openLog();
    let nextA = 1;
    bench("append(), one call per event", async () => {
      for (let i = 0; i < BATCH; i += 1) await perCall.append({ event: event(nextA++, BATCH) });
    });

    const batched = await openLog();
    let nextB = 1;
    bench("appendBatch(), one transaction", async () => {
      const events: StoredEvent[] = [];
      for (let i = 0; i < BATCH; i += 1) events.push({ event: event(nextB++, BATCH) });
      await batched.appendBatch(events);
    });
  });
});

const EVENTS = 20_000;
const ROWS = 5_000;

const prepare = async (): Promise<{ store: EventStore; stateStore: StateStore }> => {
  const driver = bunSqliteDriver(dbPath());
  const store = (await sqliteEventStore(driver)).unwrap();
  for (let from = 1; from <= EVENTS; from += BATCH) {
    const events: StoredEvent[] = [];
    for (let seq = from; seq < from + BATCH; seq += 1) events.push({ event: event(seq, ROWS) });
    (await store.appendBatch(events)).unwrap();
  }
  const stateStore = (await sqliteStateStore(driver)).unwrap();
  (await openEngine({ peerId: PEER, clock: clock(), store, stateStore })).unwrap();
  return { store, stateStore };
};

const { store, stateStore } = await prepare();

group(`boot — ${EVENTS.toLocaleString()} events behind ${ROWS.toLocaleString()} live rows`, () => {
  summary(() => {
    bench("refold the whole log", async () =>
      (await openEngine({ peerId: PEER, clock: clock(), store })).unwrap());
    bench("open persisted state", async () =>
      (await openEngine({ peerId: PEER, clock: clock(), store, stateStore })).unwrap());
  });
});

await run();

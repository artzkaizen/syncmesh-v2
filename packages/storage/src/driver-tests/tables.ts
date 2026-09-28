import type { Coverage, RowWrite, SuiteCase } from "@syncmesh/engine";
import type { RowRecord, RowKey } from "@syncmesh/kernel";

import { equal } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { captureChanges } from "../capture.js";
import { openStores } from "../open-stores.js";
import { A, JOBS, event, sqlText, stamp, sqlOf } from "./fixtures.js";

const NONE: Coverage = { synced: new Map(), local: new Map() };
const ACME = parsePartitionKey("org:acme").unwrap();
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- suite fixtures; keys are opaque strings */
const J1 = "j1" as RowKey;
const J2 = "j2" as RowKey;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
const col = JOBS.columnNames;

/** A visible jobs record as the fold holds it: every cell stamped, written at `ms`. */
const job = (title: string, ms: number): RowRecord => ({
  cells: new Map([
    [col.id, { value: J1, stamp: stamp(ms) }],
    [col.title, { value: title, stamp: stamp(ms) }],
    [col.hours, { value: 1.5, stamp: stamp(ms) }],
    [col.rank, { value: 2, stamp: stamp(ms) }],
    [col.done, { value: true, stamp: stamp(ms) }],
    [col.dueAt, { value: 1_700_000_000_000, stamp: stamp(ms) }],
    [col.meta, { value: { tags: ["a"] }, stamp: stamp(ms) }],
    [col.photo, { value: Uint8Array.of(1, 2, 255), stamp: stamp(ms) }],
  ]),
  writeStamp: stamp(ms),
  partition: ACME,
});
const gone = (ms: number): RowRecord => ({ ...job("x", ms - 1), deleteStamp: stamp(ms) });
const write = (key: RowKey, record: RowRecord): RowWrite => ({ table: JOBS.name, key, record });

const open = async (driver: SqlDriver) => (await openStores(driver, { tables: [JOBS] })).unwrap();
const count = async (driver: SqlDriver, sql: string) =>
  Number((await driver.all(sql))[0]?.[0] ?? -1);

export const tablesCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "tables: a fold's visible record lands in its SQL table, values in the column's form, and is never captured",
    run: async () => {
      const driver = await openDriver("tables-upsert");
      const L = sqlText(driver);
      const { state } = await open(driver);
      (await state.commit([write(J1, job("one", 1))], NONE)).unwrap();
      const [row] = await driver.all(
        `SELECT id, title, hours, rank, done, "dueAt", meta, photo, _partition FROM jobs`,
      );
      equal(
        [...(row?.slice(0, 6).map(String) ?? []), L.jsonText(row?.[6] ?? null)],
        ["j1", "one", "1.5", "2", L.boolText(true), L.tsText(1_700_000_000_000), '{"tags":["a"]}'],
        "values",
      );
      equal(row?.[7] instanceof Uint8Array ? row[7] : undefined, Uint8Array.of(1, 2, 255), "bytes");
      equal(String(row?.[8]), "org:acme", "_partition");
      equal(
        await count(driver, `SELECT COUNT(*) FROM ${sqlOf(driver).changes}`),
        0,
        "not captured",
      );
      (await state.commit([write(J1, job("two", 2))], NONE)).unwrap();
      equal(String((await driver.all(`SELECT title FROM jobs`))[0]?.[0]), "two", "upsert by key");
      equal(await count(driver, `SELECT COUNT(*) FROM jobs`), 1, "still one row");
    },
  },
  {
    name: "tables: a tombstone deletes the row; a later visible record brings it back",
    run: async () => {
      const driver = await openDriver("tables-delete");
      const { state } = await open(driver);
      (await state.commit([write(J1, job("one", 1))], NONE)).unwrap();
      (await state.commit([write(J1, gone(2))], NONE)).unwrap();
      equal(await count(driver, `SELECT COUNT(*) FROM jobs`), 0, "deleted");
      (await state.commit([write(J1, job("back", 3))], NONE)).unwrap();
      equal(String((await driver.all(`SELECT title FROM jobs`))[0]?.[0]), "back", "restored");
    },
  },
  {
    name: "tables: stamps stay in the sidecar — loadAll returns the record; clear empties both",
    run: async () => {
      const driver = await openDriver("tables-sidecar");
      const { state } = await open(driver);
      (await state.commit([write(J1, job("one", 7))], NONE)).unwrap();
      const loaded = (await state.loadAll()).unwrap().get(JOBS.name)?.get(J1);
      equal(loaded?.writeStamp?.hlc[0].epochMilliseconds, 7, "the stamp came back");
      equal(String(loaded?.partition), "org:acme", "the partition came back");
      (await state.clear()).unwrap();
      equal(await count(driver, `SELECT COUNT(*) FROM jobs`), 0, "table cleared");
      equal((await state.isEmpty()).unwrap(), true, "sidecar cleared");
    },
  },
  {
    name: "tables: atomic — the event and its rows land together, or a failing body leaves neither",
    run: async () => {
      const driver = await openDriver("tables-atomic");
      const stores = (await openStores(driver, { tables: [JOBS] })).unwrap();
      await stores.atomic(async ({ events, state }) => {
        (await events.append({ event: event(A, 1, 100) })).unwrap();
        (await state.commit([write(J1, job("both", 1))], NONE)).unwrap();
      });
      equal((await stores.events.all()).unwrap().length, 1, "event committed");
      equal(String((await driver.all(`SELECT title FROM jobs`))[0]?.[0]), "both", "row committed");

      const failed = await stores
        .atomic(async ({ events, state }) => {
          (await events.append({ event: event(A, 2, 101) })).unwrap();
          (await state.commit([write(J1, job("half", 2))], NONE)).unwrap();
          throw new Error("policy said no");
        })
        .then(
          () => "resolved",
          () => "rolled back",
        );
      equal(failed, "rolled back", "the body's throw aborts");
      equal((await stores.events.all()).unwrap().length, 1, "no second event");
      equal(String((await driver.all(`SELECT title FROM jobs`))[0]?.[0]), "both", "row unchanged");
    },
  },
  {
    name: "tables: two writers, one order — a capture in flight and a fold commit take turns on the connection",
    run: async () => {
      const driver = await openDriver("tables-two-writers");
      const L = sqlText(driver);
      const { state } = await open(driver);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const capture = captureChanges(driver, [JOBS], async () => {
        await driver.run(
          `INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'app', 1, ${L.F})`,
        );
        await held; // the app's transaction stays open while a fold arrives
      });
      const fold = state.commit(
        [
          write(J2, {
            ...job("peer", 1),
            cells: new Map([...job("peer", 1).cells, [col.id, { value: J2, stamp: stamp(1) }]]),
          }),
        ],
        NONE,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
      const changes = (await capture).unwrap();
      (await fold).unwrap();
      equal(
        changes.map((c) => `${c.kind}:${String(c.key)}`),
        ["insert:j1"],
        "the app's write, and only it, was captured",
      );
      equal(await count(driver, `SELECT COUNT(*) FROM jobs`), 2, "both writers landed");
      equal(
        await count(driver, `SELECT COUNT(*) FROM ${sqlOf(driver).changes}`),
        0,
        "the fold was not captured",
      );
    },
  },
];

import type { SuiteCase } from "@syncmesh/engine";
import type { Change } from "@syncmesh/kernel";

import { equal } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";

import type { SqliteDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { captureChanges, installCapture } from "../capture.js";
import { COUNTERS as counters, JOBS as jobs, sqlText } from "./fixtures.js";

const open = async (driver: SqliteDriver) => {
  (await installCapture(driver, [jobs, counters])).unwrap();
  return driver;
};

const captured = (driver: SqliteDriver, fn: () => Promise<void>) =>
  captureChanges(driver, [jobs, counters], fn);

/** The change's cells as JSON text per column, so `equal` compares leaves — bytes stay bytes. */
const cellsOf = (change: Change): Readonly<Record<string, string | Uint8Array>> =>
  Object.fromEntries(
    [...(change.kind === "insert" ? change.row : change.kind === "update" ? change.patch : [])].map(
      ([column, value]) => [
        String(column),
        value instanceof Uint8Array ? value : JSON.stringify(value),
      ],
    ),
  );

const count = async (driver: SqliteDriver, sql: string) =>
  Number((await driver.all(sql))[0]?.[0] ?? -1);

export const captureCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "capture: an insert is the whole row, decoded by column kind — bytes, booleans, json, timestamps",
    run: async () => {
      const driver = await open(await openDriver("capture-insert"));
      const L = sqlText(driver);
      const photo = Uint8Array.of(1, 2, 255);
      const changes = (
        await captured(driver, () =>
          driver.run(
            `INSERT INTO jobs (id, title, hours, rank, done, "dueAt", meta, photo) VALUES (${[1, 2, 3, 4, 5, 6, 7, 8].map(L.p).join(", ")})`,
            [
              "j1",
              "panel B",
              1.5,
              2,
              L.bool(true),
              L.ts(1_700_000_000_000),
              JSON.stringify({ tags: ["a"] }),
              photo,
            ],
          ),
        )
      ).unwrap();
      equal(changes.length, 1, "one change");
      const change = changes[0];
      equal(change?.kind, "insert", "kind");
      equal(String(change?.key), "j1", "key");
      const row = change === undefined ? {} : cellsOf(change);
      equal(row["title"], '"panel B"', "text");
      equal(row["hours"], "1.5", "float");
      equal(row["rank"], "2", "integer");
      equal(row["done"], "true", "boolean from 1");
      equal(
        row["dueAt"],
        "1700000000000",
        "timestamp as epoch ms; a mixed-case column survives quoting",
      );
      equal(row["meta"], '{"tags":["a"]}', "json parsed");
      equal(row["photo"], photo, "blob via hex");
    },
  },
  {
    name: "capture: an update carries only the columns whose value changed; a no-op update is nothing",
    run: async () => {
      const driver = await open(await openDriver("capture-update"));
      const L = sqlText(driver);
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, ${L.F})`);
      const changes = (
        await captured(driver, async () => {
          await driver.run(
            `UPDATE jobs SET title = 'one!', rank = 1, done = ${L.T} WHERE id = 'j1'`,
          );
          await driver.run(`UPDATE jobs SET title = 'one!' WHERE id = 'j1'`);
        })
      ).unwrap();
      equal(changes.length, 1, "the no-op update produced nothing");
      equal(changes[0]?.kind, "update", "kind");
      const patch = changes[0] === undefined ? {} : cellsOf(changes[0]);
      equal(Object.keys(patch), ["title", "done"], "only changed columns");
      equal([patch["title"], patch["done"]], ['"one!"', "true"], "their values");
    },
  },
  {
    name: "capture: delete, integer keys as decimal text, and statement order across tables",
    run: async () => {
      const driver = await open(await openDriver("capture-order"));
      const L = sqlText(driver);
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, ${L.F})`);
      const changes = (
        await captured(driver, async () => {
          await driver.run(`INSERT INTO counters (id, n) VALUES (42, 0)`);
          await driver.run(`DELETE FROM jobs WHERE id = 'j1'`);
          await driver.run(`UPDATE counters SET n = 7 WHERE id = 42`);
        })
      ).unwrap();
      equal(
        changes.map((c) => `${c.kind}:${String(c.table)}:${String(c.key)}`),
        ["insert:counters:42", "delete:jobs:j1"],
        "first-touch order, one change per row; the counter's insert carries its final value",
      );
      equal(changes[0] === undefined ? undefined : cellsOf(changes[0])["n"], "7", "net insert");
    },
  },
];

/** The rules a transaction's changes obey beyond the per-statement ones: net effect per row, the partition stamp, rollback, the guard. */
export const captureRuleCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "capture: a row touched twice is one change — its net effect, since one event has one stamp",
    run: async () => {
      const driver = await open(await openDriver("capture-net"));
      const L = sqlText(driver);
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('kept', 'k', 1, ${L.F})`);
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('gone', 'g', 1, ${L.F})`);
      await driver.run(
        `INSERT INTO jobs (id, title, rank, done) VALUES ('reborn', 'r', 1, ${L.F})`,
      );
      const changes = (
        await captured(driver, async () => {
          await driver.run(
            `INSERT INTO jobs (id, title, rank, done) VALUES ('new', 'a', 1, ${L.F})`,
          );
          await driver.run(`UPDATE jobs SET title = 'b' WHERE id = 'new'`); // insert + update → insert with the final image
          await driver.run(`UPDATE jobs SET title = 'k2' WHERE id = 'kept'`);
          await driver.run(`UPDATE jobs SET rank = 2 WHERE id = 'kept'`); // update + update → one patch, both columns
          await driver.run(
            `INSERT INTO jobs (id, title, rank, done) VALUES ('blink', 'x', 1, ${L.F})`,
          );
          await driver.run(`DELETE FROM jobs WHERE id = 'blink'`); // insert + delete → nothing
          await driver.run(`UPDATE jobs SET title = 'g2' WHERE id = 'gone'`);
          await driver.run(`DELETE FROM jobs WHERE id = 'gone'`); // update + delete → delete
          await driver.run(`DELETE FROM jobs WHERE id = 'reborn'`);
          await driver.run(
            `INSERT INTO jobs (id, title, rank, done) VALUES ('reborn', 'r2', 1, ${L.F})`,
          ); // delete + insert → update
        })
      ).unwrap();
      equal(
        changes.map((c) => `${c.kind}:${String(c.key)}`),
        ["insert:new", "update:kept", "delete:gone", "update:reborn"],
        "one net change per row, in first-touch order",
      );
      const by = Object.fromEntries(changes.map((c) => [String(c.key), cellsOf(c)]));
      equal(by["new"]?.["title"], '"b"', "insert carries the final value");
      equal(Object.keys(by["kept"] ?? {}), ["title", "rank"], "both updated columns, once");
      equal(by["reborn"]?.["title"], '"r2"', "delete then insert is the columns that differ");
    },
  },
  {
    name: "capture: the write's partition is stamped onto inserted rows, uncaptured; updated rows keep theirs",
    run: async () => {
      const driver = await open(await openDriver("capture-partition"));
      const L = sqlText(driver);
      const acme = parsePartitionKey("org:acme").unwrap();
      const globex = parsePartitionKey("org:globex").unwrap();
      const inserted = (
        await captureChanges(
          driver,
          [jobs],
          () =>
            driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, ${L.F})`),
          { partition: acme },
        )
      ).unwrap();
      equal(
        inserted.map((c) => c.kind),
        ["insert"],
        "the stamping is not a second change",
      );
      equal(
        String((await driver.all(`SELECT _partition FROM jobs`))[0]?.[0]),
        "org:acme",
        "stamped",
      );
      const updated = (
        await captureChanges(
          driver,
          [jobs],
          () => driver.run(`UPDATE jobs SET title = 'two' WHERE id = 'j1'`),
          { partition: globex },
        )
      ).unwrap();
      equal(
        updated.map((c) => c.kind),
        ["update"],
        "an update is captured as itself",
      );
      equal(
        String((await driver.all(`SELECT _partition FROM jobs`))[0]?.[0]),
        "org:acme",
        "an update never re-homes a row",
      );
      equal(await count(driver, `SELECT COUNT(*) FROM _syncmesh_changes`), 0, "log empty");
    },
  },
  {
    name: "capture: a throw rolls everything back — no rows, no changes, nothing left in the log",
    run: async () => {
      const driver = await open(await openDriver("capture-rollback"));
      const L = sqlText(driver);
      const r = await captured(driver, async () => {
        await driver.run(
          `INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, ${L.F})`,
        );
        throw new Error("policy said no");
      });
      equal(r.isErr(), true, "the capture fails");
      equal(await count(driver, `SELECT COUNT(*) FROM jobs`), 0, "row rolled back");
      equal(await count(driver, `SELECT COUNT(*) FROM _syncmesh_changes`), 0, "log empty");
      equal(await count(driver, L.guard), 0, "guard disarmed");
    },
  },
  {
    name: "capture: writes outside a capture — the fold's own — are never logged",
    run: async () => {
      const driver = await open(await openDriver("capture-guard"));
      const L = sqlText(driver);
      await driver.run(
        `INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'from a peer', 1, ${L.F})`,
      );
      await driver.run(`UPDATE jobs SET title = 'merged' WHERE id = 'j1'`);
      equal(await count(driver, `SELECT COUNT(*) FROM _syncmesh_changes`), 0, "nothing logged");
      const changes = (
        await captured(driver, () => driver.run(`UPDATE jobs SET rank = 2 WHERE id = 'j1'`))
      ).unwrap();
      equal(changes.length, 1, "only the app's own write");
    },
  },
];

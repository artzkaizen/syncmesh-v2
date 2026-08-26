import type { SuiteCase } from "@syncmesh/engine";
import type { Change } from "@syncmesh/kernel";

import { equal } from "@syncmesh/engine";
import { t, table } from "@syncmesh/schema";

import type { SqliteDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { captureChanges, installCapture } from "../capture.js";

/** Every column kind once, so each encoding is exercised. */
const jobs = table("jobs", {
  id: t.text().primaryKey(),
  title: t.text(),
  hours: t.float().nullable(),
  rank: t.integer(),
  done: t.boolean(),
  due: t.timestamp().nullable(),
  meta: t.json().nullable(),
  photo: t.blob().nullable(),
});
const counters = table("counters", { id: t.integer().primaryKey(), n: t.integer() });

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
      const photo = Uint8Array.of(1, 2, 255);
      const changes = (
        await captured(driver, () =>
          driver.run(
            `INSERT INTO jobs (id, title, hours, rank, done, due, meta, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ["j1", "panel B", 1.5, 2, 1, 1_700_000_000_000, JSON.stringify({ tags: ["a"] }), photo],
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
      equal(row["due"], "1700000000000", "timestamp as epoch ms");
      equal(row["meta"], '{"tags":["a"]}', "json parsed");
      equal(row["photo"], photo, "blob via hex");
    },
  },
  {
    name: "capture: an update carries only the columns whose value changed; a no-op update is nothing",
    run: async () => {
      const driver = await open(await openDriver("capture-update"));
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, 0)`);
      const changes = (
        await captured(driver, async () => {
          await driver.run(`UPDATE jobs SET title = 'one!', rank = 1, done = 1 WHERE id = 'j1'`);
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
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, 0)`);
      const changes = (
        await captured(driver, async () => {
          await driver.run(`INSERT INTO counters (id, n) VALUES (42, 0)`);
          await driver.run(`DELETE FROM jobs WHERE id = 'j1'`);
          await driver.run(`UPDATE counters SET n = 7 WHERE id = 42`);
        })
      ).unwrap();
      equal(
        changes.map((c) => `${c.kind}:${String(c.table)}:${String(c.key)}`),
        ["insert:counters:42", "delete:jobs:j1", "update:counters:42"],
        "order and keys",
      );
    },
  },
  {
    name: "capture: a throw rolls everything back — no rows, no changes, nothing left in the log",
    run: async () => {
      const driver = await open(await openDriver("capture-rollback"));
      const r = await captured(driver, async () => {
        await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'one', 1, 0)`);
        throw new Error("policy said no");
      });
      equal(r.isErr(), true, "the capture fails");
      equal(await count(driver, `SELECT COUNT(*) FROM jobs`), 0, "row rolled back");
      equal(await count(driver, `SELECT COUNT(*) FROM _syncmesh_changes`), 0, "log empty");
      equal(await count(driver, `SELECT armed FROM _syncmesh_capture`), 0, "guard disarmed");
    },
  },
  {
    name: "capture: writes outside a capture — the fold's own — are never logged",
    run: async () => {
      const driver = await open(await openDriver("capture-guard"));
      await driver.run(
        `INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'from a peer', 1, 0)`,
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

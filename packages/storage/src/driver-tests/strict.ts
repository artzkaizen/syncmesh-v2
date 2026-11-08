import type { SuiteCase } from "@syncmesh/engine";

import { equal } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { captureChanges, installCapture } from "../capture.js";
import { folding, installGuard } from "../guard.js";
import { inTransaction } from "../sql.js";
import { COUNTERS as counters, JOBS as jobs, asFold, sqlText } from "./fixtures.js";

/**
 * Strict capture (gaps U5): a write to a synced table that no capture logs would change the row
 * and leave no event to carry it — the device diverging from every peer without a word — so the
 * guard trigger refuses it, and lets the fold's own writes by.
 */

const refused = async (fn: () => Promise<void>) =>
  (await Result.tryPromise({ try: fn, catch: (cause) => String(cause) })).match({
    ok: () => "applied",
    err: (message) => (message.includes("outside a captured write") ? "refused" : message),
  });

const rows = async (driver: SqlDriver) =>
  (await driver.all(`SELECT id, title FROM jobs ORDER BY id`)).map(([id, title]) =>
    [id, title].map(String).join("="),
  );

export const strictCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  ...rowCases(openDriver),
  ...postgresStrictCases(openDriver),
];

/** The row writes every dialect's guard refuses, and the writes it lets by. */
const rowCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "strict: an unarmed INSERT, UPDATE or DELETE on a synced table is refused, and changes nothing",
    run: async () => {
      const driver = await openDriver("strict-refuses");
      const L = sqlText(driver);
      (await installCapture(driver, [jobs, counters])).unwrap();
      await asFold(driver, () =>
        driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'kept', 1, ${L.F})`),
      );
      equal(
        await refused(() =>
          driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j2', 'raw', 1, ${L.F})`),
        ),
        "refused",
        "insert",
      );
      equal(
        await refused(() => driver.run(`UPDATE jobs SET title = 'raw' WHERE id = 'j1'`)),
        "refused",
        "update",
      );
      equal(await refused(() => driver.run(`DELETE FROM jobs`)), "refused", "delete");
      equal(
        await refused(() => driver.run(`INSERT INTO counters (id, n) VALUES (1, 1)`)),
        "refused",
        "every synced table",
      );
      // inside a transaction of the app's own, still unarmed
      equal(
        await refused(() =>
          inTransaction(driver, () => driver.run(`UPDATE jobs SET title = 'raw' WHERE id = 'j1'`)),
        ),
        "refused",
        "in a transaction",
      );
      equal(await rows(driver), ["j1=kept"], "the row is what the fold wrote");
    },
  },
  {
    name: "strict: a captured write and the fold's own both pass, and leave the guard at rest",
    run: async () => {
      const driver = await openDriver("strict-passes");
      const L = sqlText(driver);
      (await installCapture(driver, [jobs])).unwrap();
      const changes = (
        await captureChanges(driver, [jobs], () =>
          driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'app', 1, ${L.F})`),
        )
      ).unwrap();
      equal(changes.length, 1, "captured");
      await asFold(driver, () => driver.run(`UPDATE jobs SET title = 'peer' WHERE id = 'j1'`));
      equal(await count(driver, L.guard), 0, "at rest after both");
      equal(
        await refused(() => driver.run(`UPDATE jobs SET title = 'raw' WHERE id = 'j1'`)),
        "refused",
        "and an unarmed write after them still is",
      );
      equal(await rows(driver), ["j1=peer"], "rows");
    },
  },
  {
    name: "strict: a fold that throws leaves the guard at rest, not open",
    run: async () => {
      const driver = await openDriver("strict-fold-throws");
      const L = sqlText(driver);
      (await installCapture(driver, [jobs])).unwrap();
      // no transaction around it to roll the guard back: `folding` itself must put it at rest
      const failed = await Result.tryPromise({
        try: () =>
          folding(driver, async () => {
            await driver.run(
              `INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'x', 1, ${L.F})`,
            );
            throw new Error("the fold failed");
          }),
        catch: (cause) => cause,
      });
      equal(failed.isErr(), true, "the fold failed");
      equal(await count(driver, L.guard), 0, "at rest");
      equal(
        await refused(() =>
          driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j2', 'raw', 1, ${L.F})`),
        ),
        "refused",
        "an unarmed write after it",
      );
    },
  },
  {
    name: "strict: off lets an unarmed write through, and `except` leaves only the tables it names",
    run: async () => {
      const driver = await openDriver("strict-off");
      const L = sqlText(driver);
      (await installCapture(driver, [jobs, counters], { strict: false })).unwrap();
      equal(
        await refused(() =>
          driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'raw', 1, ${L.F})`),
        ),
        "applied",
        "off",
      );
      (await installGuard(driver, [jobs, counters], { except: ["counters"] })).unwrap();
      equal(
        await refused(() => driver.run(`INSERT INTO counters (id, n) VALUES (1, 1)`)),
        "applied",
        "an excepted table",
      );
      equal(
        await refused(() => driver.run(`UPDATE jobs SET title = 'raw2' WHERE id = 'j1'`)),
        "refused",
        "every other table",
      );
      (await installGuard(driver, [jobs, counters], false)).unwrap();
      equal(
        await refused(() => driver.run(`UPDATE jobs SET title = 'raw3' WHERE id = 'j1'`)),
        "applied",
        "dropped again",
      );
    },
  },
];

/** What only Postgres has to get around a row trigger: `TRUNCATE`, and the replication role. */
const postgresStrictCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "strict: a TRUNCATE is refused even inside a capture, which no row trigger would see (Postgres)",
    run: async () => {
      const driver = await openDriver("strict-truncate");
      if (driver.dialect !== "postgres") return;
      const L = sqlText(driver);
      (await installCapture(driver, [jobs])).unwrap();
      await asFold(driver, () =>
        driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'kept', 1, ${L.F})`),
      );
      equal(await refused(() => driver.run(`TRUNCATE jobs`)), "refused", "unarmed");
      const armed = await captureChanges(driver, [jobs], () => driver.run(`TRUNCATE jobs`));
      equal(armed.isErr(), true, "armed");
      equal(await rows(driver), ["j1=kept"], "the row is still there");
    },
  },
  {
    name: "strict: `session_replication_role = replica` does not skip the guard (Postgres)",
    run: async () => {
      const driver = await openDriver("strict-replica");
      if (driver.dialect !== "postgres" || driver.transaction === undefined) return;
      const L = sqlText(driver);
      (await installCapture(driver, [jobs])).unwrap();
      const bypass = await refused(() =>
        inTransaction(driver, async () => {
          await driver.run(`SET LOCAL session_replication_role = replica`);
          await driver.run(
            `INSERT INTO jobs (id, title, rank, done) VALUES ('j1', 'raw', 1, ${L.F})`,
          );
        }),
      );
      equal(bypass, "refused", "the guard fires ALWAYS");
      equal(await rows(driver), [], "nothing landed");
    },
  },
];

const count = async (driver: SqlDriver, sql: string) =>
  Number((await driver.all(sql))[0]?.[0] ?? -1);

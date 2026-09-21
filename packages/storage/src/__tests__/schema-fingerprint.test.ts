import { syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import type { SqlDriver, SqlRow, SqlValue } from "../driver.js";

import { openStores } from "../open-stores.js";
import { openPair } from "./pair.js";

/**
 * Opening a database that has not changed installs nothing.
 *
 * Every statement `installCapture` runs is `IF NOT EXISTS`, so running them again was correct and
 * wasteful in a way nothing would ever fail on — which is exactly the kind of cost that survives
 * for years. What is asserted here is the saving itself: the statements a second open runs, by
 * count, because "it is still correct" was never in doubt.
 */

const schema = syncSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    note: {
      columns: { id: t.text().primaryKey(), body: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

const wider = syncSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    note: {
      // one more column: a different shape, and the fingerprint has to notice
      columns: { id: t.text().primaryKey(), body: t.text(), title: t.text() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});

/** The same driver, counting the statements that reach it. */
const counting = (inner: SqlDriver) => {
  const ran: string[] = [];
  const driver: SqlDriver = {
    ...inner,
    run: (sql: string, params?: readonly SqlValue[]) => {
      ran.push(sql);
      return params === undefined ? inner.run(sql) : inner.run(sql, params);
    },
    all: (sql: string, params?: readonly SqlValue[]): Promise<readonly SqlRow[]> =>
      params === undefined ? inner.all(sql) : inner.all(sql, params),
  };
  return { driver, ran, since: () => ran.splice(0, ran.length).length };
};

describe("the app schema is installed once, not once per launch", () => {
  test("a second open of an unchanged database runs one statement instead of forty", async () => {
    const file = await openPair();
    const counted = counting(file);
    const tables = schema.entries.map((entry) => entry.table);

    (await openStores(counted.driver, { tables })).unwrap();
    const first = counted.since();
    // the tables, their triggers, the row-sync pair and the engine's own migration
    expect(first).toBeGreaterThan(10);

    (await openStores(counted.driver, { tables })).unwrap();
    // the fingerprint's own table, and nothing else: the read that decides is a `SELECT`
    expect(counted.since()).toBe(1);
  });

  test("a changed manifest is installed again, with no version for anyone to bump", async () => {
    const file = await openPair();
    const counted = counting(file);

    (await openStores(counted.driver, { tables: schema.entries.map((e) => e.table) })).unwrap();
    counted.since();

    (await openStores(counted.driver, { tables: wider.entries.map((e) => e.table) })).unwrap();
    // the column changed the table's DDL, so the text differs and everything is reinstalled
    expect(counted.since()).toBeGreaterThan(1);

    // and now *that* shape is the one on record
    (await openStores(counted.driver, { tables: wider.entries.map((e) => e.table) })).unwrap();
    expect(counted.since()).toBe(1);
  });
});

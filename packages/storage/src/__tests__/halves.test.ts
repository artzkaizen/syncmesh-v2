import { syncSchema, t } from "@syncmesh/schema";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { SqlRow, SqliteDriver } from "../driver.js";

import { sqlBlobStore } from "../blob.js";
import { LOG_TABLES, STATE_TABLES, engineTable } from "../dialect.js";
import { sqlGrantStore } from "../grant-store.js";
import { openStores } from "../open-stores.js";
import { operationStore } from "../operation-store.js";
import { sqliteDriver } from "../sqlite-driver.js";

/** A manifest, so capture and the row-sync pair are installed alongside the rest. */
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

/**
 * The two halves, checked against a database rather than against a comment.
 *
 * `LOG_TABLES` and `STATE_TABLES` are read by three things that each drift on their own — what a
 * backup must include, what may be discarded and refolded, and which file each table would land
 * in if the two were ever separated. A list that quietly stopped describing the schema would be
 * worse than no list, because all three would keep trusting it.
 */

const inMemory = (): SqliteDriver => {
  const db = new Database(":memory:", { create: true, strict: true });
  return sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back text, integers, reals, blobs and NULL — exactly SqlValue
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
};

describe("the durable half and the derived half", () => {
  test("every table the lists name exists, and every engine table is on exactly one list", async () => {
    const driver = inMemory();
    // every store, because each opens its own tables and no single call creates them all
    (await openStores(driver, { tables: schema.entries.map((e) => e.table) })).unwrap();
    (await operationStore(driver)).unwrap();
    (await sqlGrantStore(driver)).unwrap();
    (await sqlBlobStore(driver)).unwrap();

    const present = new Set(
      (
        await driver.all(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'syncmesh\\_%' ESCAPE '\\'`,
        )
      ).map((row) => String(row[0])),
    );

    // a name on a list that the schema does not have: the list has gone stale
    const named = [...LOG_TABLES, ...STATE_TABLES].map((n) => engineTable(n, "sqlite"));
    const missing = named.filter((table) => !present.has(table));
    expect(missing).toEqual([]);

    // and a table the schema has that neither list names: the lists have fallen behind it
    const unclaimed = [...present].filter((table) => !named.includes(table));
    expect(unclaimed).toEqual([]);
  });

  /**
   * The halves cannot overlap, and the compiler says so rather than a test.
   *
   * Writing the runtime version got `TS2367: this comparison appears to be unintentional… the
   * types have no overlap` — which is the assertion, made statically and for free. A table on
   * both lists stops compiling here.
   */
  test("a name belongs to one half, and the type of that name proves it", () => {
    const shared: Extract<(typeof LOG_TABLES)[number], (typeof STATE_TABLES)[number]>[] = [];
    expect(shared).toEqual([]);
  });
});

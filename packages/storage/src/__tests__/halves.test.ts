import { syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import { sqlBlobStore } from "../blob.js";
import { LOG_TABLES, STATE_TABLES } from "../dialect.js";
import { sqlGrantStore } from "../grant-store.js";
import { openStores } from "../open-stores.js";
import { operationStore } from "../operation-store.js";
import { openPair } from "./pair.js";

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

describe("the durable half and the derived half", () => {
  test("each half is in its own file, and neither list has drifted from the schema", async () => {
    const driver = await openPair();
    // every store, because each opens its own tables and no single call creates them all
    (await openStores(driver, { tables: schema.entries.map((e) => e.table) })).unwrap();
    (await operationStore(driver)).unwrap();
    (await sqlGrantStore(driver)).unwrap();
    (await sqlBlobStore(driver)).unwrap();

    const tablesIn = async (where: string) =>
      new Set(
        (
          await driver.all(
            `SELECT name FROM ${where}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
        ).map((row) => String(row[0])),
      );
    const inLog = await tablesIn("syncmesh");
    const inState = await tablesIn("main");

    // the durable half is in the attached file and nowhere else
    for (const name of LOG_TABLES) {
      expect({ [name]: inLog.has(name) }).toEqual({ [name]: true });
      expect({ [name]: inState.has(`syncmesh_${name}`) }).toEqual({ [name]: false });
    }
    // and the derived half is in `main`, beside the app's own tables
    for (const name of STATE_TABLES) {
      expect({ [name]: inState.has(`syncmesh_${name}`) }).toEqual({ [name]: true });
    }

    // nothing of ours in `main` that neither list claims
    const claimed = STATE_TABLES.map((name) => `syncmesh_${name}`);
    const strays = [...inState].filter(
      (table) => table.startsWith("syncmesh_") && !claimed.includes(table),
    );
    expect(strays).toEqual([]);
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

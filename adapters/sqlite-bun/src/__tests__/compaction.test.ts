import { sqliteEventStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";
import { A, B, event, seq } from "./fixtures.js";

const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

const filled = async (driver = bunSqliteDriver(":memory:")) => {
  const store = (await sqliteEventStore(driver)).unwrap();
  (
    await store.appendBatch([
      event(A, 1, 10),
      event(A, 2, 20),
      event(A, 3, 30),
      event(B, 1, 10),
      event(A, 1, 10, { local: true }),
    ])
  ).unwrap();
  return { driver, store };
};

describe("compaction over bun:sqlite", () => {
  test("compactBelow removes per-author, in scope, older than the cut; records the highest removed seq", async () => {
    const { store } = await filled();
    const floor = new Map([[A, seq(3)]]);
    expect((await store.compactBelow(floor, "synced", at(25))).unwrap()).toBe(2);
    const left = (await store.all()).unwrap().map((e) => e.id);
    expect(left).toEqual([
      event(A, 1, 10, { local: true }).id,
      event(B, 1, 10).id,
      event(A, 3, 30).id,
    ]);
    const floors = (await store.compactedBelow()).unwrap();
    expect(floors.synced.get(A)).toBe(seq(2));
    expect(floors.synced.has(B)).toBe(false);
    expect(floors.local.size).toBe(0);

    expect((await store.compactBelow(floor, "synced", at(100))).unwrap()).toBe(1);
    expect((await store.compactedBelow()).unwrap().synced.get(A)).toBe(seq(3));
    expect((await store.compactBelow(new Map([[A, seq(1)]]), "local", at(100))).unwrap()).toBe(1);
    expect((await store.compactedBelow()).unwrap().local.get(A)).toBe(seq(1));
  });

  test("lastSeq and maxHlc never regress, even with every event gone", async () => {
    const { store } = await filled();
    (
      await store.compactBelow(
        new Map([
          [A, seq(3)],
          [B, seq(1)],
        ]),
        "synced",
        at(100),
      )
    ).unwrap();
    (await store.compactBelow(new Map([[A, seq(1)]]), "local", at(100))).unwrap();
    expect((await store.all()).unwrap()).toHaveLength(0);
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(3));
    expect((await store.lastSeq(A, "local")).unwrap()).toBe(seq(1));
    expect((await store.lastSeq(B, "synced")).unwrap()).toBe(seq(1));
    const max = (await store.maxHlc()).unwrap();
    expect(max?.[0].epochMilliseconds).toBe(30);
  });

  test("the recorded floor survives a reopen and never lowers", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "syncmesh-")), "events.db");
    const { driver, store } = await filled(bunSqliteDriver(path));
    (await store.compactBelow(new Map([[A, seq(2)]]), "synced", at(100))).unwrap();
    await driver.close?.();

    const reopened = (await sqliteEventStore(bunSqliteDriver(path))).unwrap();
    expect((await reopened.compactedBelow()).unwrap().synced.get(A)).toBe(seq(2));
    expect((await reopened.compactBelow(new Map([[A, seq(1)]]), "synced", at(100))).unwrap()).toBe(
      0,
    );
    expect((await reopened.compactedBelow()).unwrap().synced.get(A)).toBe(seq(2));
  });

  test("a database at schema version 1 migrates to 2 with its events intact", async () => {
    const { driver, store } = await filled();
    await driver.run("DROP TABLE compaction");
    await driver.run("PRAGMA user_version = 1");
    const migrated = (await sqliteEventStore(driver)).unwrap();
    expect((await driver.all("PRAGMA user_version"))[0]?.[0]).toBe(2);
    expect((await migrated.compactedBelow()).unwrap().synced.size).toBe(0);
    expect((await store.all()).unwrap()).toHaveLength(5);
  });
});

import type { Coverage, StateStore } from "@syncmesh/engine";
import type { ColumnName, Logical, RowKey, RowRecord, Stamp, TableName } from "@syncmesh/kernel";
import type { SqliteDriver } from "@syncmesh/storage";

import { encodeRecord, sqliteEventStore, sqliteStateStore } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";
import { A, B, seq } from "./fixtures.js";

// SAFETY: test fixture; naming rules are not under test here
const NOTES = "notes" as TableName;
// SAFETY: as above
const N1 = "n1" as RowKey;
// SAFETY: as above
const BODY = "body" as ColumnName;

const stamp = (ms: number): Stamp => ({
  // SAFETY: test fixture; 0 is a valid Logical
  hlc: [Temporal.Instant.fromEpochMilliseconds(ms), 0 as Logical],
  peer: A,
});
const record = (body: string, ms: number): RowRecord => ({
  cells: new Map([[BODY, { value: body, stamp: stamp(ms) }]]),
  writeStamp: stamp(ms),
});
const coverage: Coverage = {
  synced: new Map([
    [A, seq(3)],
    [B, seq(1)],
  ]),
  local: new Map([[A, seq(2)]]),
};
const open = async (driver: SqliteDriver = bunSqliteDriver(":memory:")) =>
  (await sqliteStateStore(driver)).unwrap();
const bodyOf = async (store: StateStore) =>
  (await store.loadAll()).unwrap().get(NOTES)?.get(N1)?.cells.get(BODY)?.value;

describe("sqliteStateStore over bun:sqlite", () => {
  test("commit lands rows and coverage together; loadAll and loadCursors read them back", async () => {
    const store = await open();
    expect((await store.isEmpty()).unwrap()).toBe(true);
    (await store.commit([{ table: NOTES, key: N1, record: record("a", 1) }], coverage)).unwrap();
    expect((await store.isEmpty()).unwrap()).toBe(false);

    const loaded = (await store.loadAll()).unwrap().get(NOTES)?.get(N1);
    expect(loaded && encodeRecord(loaded)).toEqual(encodeRecord(record("a", 1)));
    expect((await store.loadCursors()).unwrap()).toEqual(coverage);
  });

  test("a later commit replaces the row and raises the cursors", async () => {
    const store = await open();
    (await store.commit([{ table: NOTES, key: N1, record: record("a", 1) }], coverage)).unwrap();
    const later: Coverage = { synced: new Map([[A, seq(4)]]), local: new Map() };
    (await store.commit([{ table: NOTES, key: N1, record: record("b", 2) }], later)).unwrap();
    expect(await bodyOf(store)).toBe("b");
    expect((await store.loadAll()).unwrap().get(NOTES)?.size).toBe(1);
    const cursors = (await store.loadCursors()).unwrap();
    expect(cursors.synced.get(A)).toBe(seq(4));
    expect(cursors.synced.get(B)).toBe(seq(1));
    expect(cursors.local.get(A)).toBe(seq(2));
  });

  test("durable: write, close, reopen the same file, read", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "syncmesh-")), "state.db");
    const first = bunSqliteDriver(path);
    (
      await (
        await open(first)
      ).commit([{ table: NOTES, key: N1, record: record("a", 1) }], coverage)
    ).unwrap();
    await first.close?.();
    expect(await bodyOf(await open(bunSqliteDriver(path)))).toBe("a");
  });

  test("a damaged row makes loadAll StateCorrupt; clear empties the cache", async () => {
    const driver = bunSqliteDriver(":memory:");
    const store = await open(driver);
    (await store.commit([{ table: NOTES, key: N1, record: record("a", 1) }], coverage)).unwrap();
    await driver.run("UPDATE state_rows SET record = X'00'");
    const loaded = await store.loadAll();
    expect(loaded.isErr() && loaded.error._tag).toBe("StateCorrupt");
    (await store.clear()).unwrap();
    expect((await store.isEmpty()).unwrap()).toBe(true);
  });

  test("a commit that fails halfway leaves nothing behind", async () => {
    const inner = bunSqliteDriver(":memory:");
    const failing: SqliteDriver = {
      ...inner,
      run: (sql, params) =>
        sql.includes("state_cursors") && sql.startsWith("INSERT")
          ? Promise.reject(new Error("disk full"))
          : inner.run(sql, params),
    };
    const store = await open(failing);
    const committed = await store.commit(
      [{ table: NOTES, key: N1, record: record("a", 1) }],
      coverage,
    );
    expect(committed.isErr() && committed.error._tag).toBe("StoreFailure");
    expect((await store.isEmpty()).unwrap()).toBe(true);
    expect((await store.loadAll()).unwrap().size).toBe(0);
  });

  test("shares one database with the event store", async () => {
    const driver = bunSqliteDriver(":memory:");
    const events = (await sqliteEventStore(driver)).unwrap();
    const state = await open(driver);
    expect((await events.maxHlc()).unwrap()).toBeUndefined();
    expect((await state.isEmpty()).unwrap()).toBe(true);
  });
});

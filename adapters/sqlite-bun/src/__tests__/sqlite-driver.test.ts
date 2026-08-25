import type { SqliteDriver } from "@syncmesh/storage";

import { compareHlc, parsePartitionKey, type SyncEvent } from "@syncmesh/kernel";
import { sqliteEventStore } from "@syncmesh/storage";
import { encodeEventCore } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunSqliteDriver } from "../index.js";
import { A, B, event, hlc, seq } from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();

const open = async (driver: SqliteDriver = bunSqliteDriver(":memory:")) =>
  (await sqliteEventStore(driver)).unwrap();
const cores = (events: readonly SyncEvent[]) => events.map(encodeEventCore);
const ids = (events: readonly SyncEvent[]) => events.map((e) => e.id);

describe("sqliteEventStore over bun:sqlite", () => {
  test("round-trip: core bytes survive, an absent partition stays absent, local survives", async () => {
    const store = await open();
    const e1 = event(A, 1, 100, { partition: ACME });
    const e2 = event(A, 2, 101);
    const e3 = event(A, 1, 102, { local: true });
    (await store.appendBatch([e1, e2, e3])).unwrap();

    const all = (await store.all()).unwrap();
    expect(cores(all)).toEqual(cores([e1, e2, e3]));
    expect(all[0]?.partition).toBe(ACME);
    expect(all[1]).not.toHaveProperty("partition");
    expect(all[2]?.local).toBe(true);
    expect(all[0]).not.toHaveProperty("local");
  });

  test("append is idempotent; has() answers for the synced scope", async () => {
    const store = await open();
    const e1 = event(A, 1, 100);
    (await store.append(e1)).unwrap();
    (await store.append(e1)).unwrap();
    (await store.append(event(A, 1, 100, { local: true }))).unwrap();
    expect((await store.all()).unwrap()).toHaveLength(2);
    expect((await store.has(e1.id)).unwrap()).toBe(true);
    expect((await store.has(event(B, 1, 100).id)).unwrap()).toBe(false);
  });

  test("allSince: the per-author floor runs in SQL, local never travels, author-then-sequence order", async () => {
    const store = await open();
    const [b2, a3, a1, b1, a2, aLocal] = [
      event(B, 2, 5),
      event(A, 3, 4),
      event(A, 1, 3),
      event(B, 1, 2),
      event(A, 2, 1),
      event(A, 1, 9, { local: true }),
    ];
    (await store.appendBatch([b2, a3, a1, b1, a2, aLocal])).unwrap();

    const above = (await store.allSince(new Map([[A, a2.seqNum]]))).unwrap();
    expect(ids(above)).toEqual(ids([a3, b1, b2]));
    const everything = (await store.allSince(new Map())).unwrap();
    expect(everything).toHaveLength(5);
    expect(ids(everything)).toEqual(ids([a1, a2, a3, b1, b2]));
  });

  test("lastSeq is per scope; maxHlc is the highest stamp, not the last written", async () => {
    const store = await open();
    (
      await store.appendBatch([
        event(A, 1, 300),
        event(A, 2, 200),
        event(A, 1, 250, { local: true }),
      ])
    ).unwrap();
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(2));
    expect((await store.lastSeq(A, "local")).unwrap()).toBe(seq(1));
    expect((await store.lastSeq(B, "synced")).unwrap()).toBeUndefined();
    const max = (await store.maxHlc()).unwrap();
    expect(max !== undefined && compareHlc(max, hlc(300))).toBe(0);
    expect((await open().then((s) => s.maxHlc())).unwrap()).toBeUndefined();
  });

  test("a driver without transactions is still correct", async () => {
    const full = bunSqliteDriver(":memory:");
    const plain: SqliteDriver = { run: full.run, all: full.all };
    const store = await open(plain);
    (await store.appendBatch([event(A, 1, 1), event(A, 2, 2)])).unwrap();
    expect((await store.lastSeq(A, "synced")).unwrap()).toBe(seq(2));
  });

  test("durable: write, close, reopen the same file, read", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "syncmesh-")), "events.db");
    const first = bunSqliteDriver(path);
    const store = await open(first);
    (await store.appendBatch([event(A, 1, 1), event(A, 2, 2)])).unwrap();
    await first.close?.();

    const reopened = await open(bunSqliteDriver(path));
    expect(ids((await reopened.all()).unwrap())).toEqual([event(A, 1, 1).id, event(A, 2, 2).id]);
  });

  test("corruption and driver failures are StoreFailure values, never throws", async () => {
    const driver = bunSqliteDriver(":memory:");
    const store = await open(driver);
    (await store.append(event(A, 1, 1))).unwrap();
    await driver.run("UPDATE events SET core = X'00'");
    const all = await store.all();
    expect(all.isErr() && all.error._tag).toBe("StoreFailure");

    await driver.run("DROP TABLE events");
    const last = await store.lastSeq(A, "synced");
    expect(last.isErr() && last.error._tag).toBe("StoreFailure");
    expect(
      (
        await sqliteEventStore({
          run: () => Promise.reject(new Error("no disk")),
          all: () => Promise.reject(new Error("no disk")),
        })
      ).isErr(),
    ).toBe(true);
  });
});

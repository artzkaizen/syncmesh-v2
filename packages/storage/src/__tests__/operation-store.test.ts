import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { SqlRow } from "../driver.js";

import { operationStore } from "../operation-store.js";
import { inTransaction } from "../sql.js";
import { sqliteDriver } from "../sqlite-driver.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const A = "a".repeat(64) as PeerId;
const B = "b".repeat(64) as PeerId;
const seq = (n: number) => n as SeqNum;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const open = async () => {
  const db = new Database(":memory:", { strict: true });
  const driver = sqliteDriver({
    exec: (sql) => db.run(sql),
    run: (sql, params) => void db.run(sql, [...params]),
    // SAFETY: SQLite hands back exactly SqlValue shapes
    all: (sql, params) => db.query(sql).values(...params) as readonly SqlRow[],
    close: () => db.close(),
  });
  return { driver, store: (await operationStore(driver)).unwrap() };
};

describe("operationStore", () => {
  test("a record survives, reads back by id and by event, and starts unsettled", async () => {
    const { store } = await open();
    (
      await store.record({ id: "op-1", peer: A, seq: seq(1), label: "notes.create", atMs: 5 })
    ).unwrap();

    const byId = (await store.get("op-1")).unwrap();
    expect(byId?.status).toBe("applied");
    expect(byId?.label).toBe("notes.create");
    expect((await store.byEvent(A, seq(1))).unwrap()?.id).toBe("op-1");
    expect((await store.unsettled()).unwrap().map((op) => op.id)).toEqual(["op-1"]);
  });

  test("an acknowledgement receipts everything it covers, idempotently", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.record({ id: "op-2", peer: A, seq: seq(2), label: "l", atMs: 2 })).unwrap();
    (await store.record({ id: "op-3", peer: A, seq: seq(3), label: "l", atMs: 3 })).unwrap();

    (await store.acknowledge(B, A, seq(2), 10)).unwrap();
    (await store.acknowledge(B, A, seq(2), 99)).unwrap(); // replay: same receipts, same rows

    expect((await store.receiptsOf(A, seq(1))).unwrap()).toEqual([{ holder: B, atMs: 10 }]);
    expect((await store.receiptsOf(A, seq(2))).unwrap()).toEqual([{ holder: B, atMs: 10 }]);
    expect((await store.unsettled()).unwrap().map((op) => op.id)).toEqual(["op-3"]);
  });

  test("a correction marks the displaced write and keeps the why", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.correct(A, seq(1), "srv-305", "below the category floor")).unwrap();

    const corrected = (await store.get("op-1")).unwrap();
    expect(corrected?.status).toBe("superseded");
    expect(corrected?.correction).toEqual({ by: "srv-305", reason: "below the category floor" });
  });

  test("a record inside a rolled-back transaction never existed", async () => {
    const { driver, store } = await open();
    const failed = await inTransaction(driver, async () => {
      (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
      throw new Error("the commit boundary: everything or nothing");
    }).then(
      () => "committed",
      () => "rolled back",
    );
    expect(failed).toBe("rolled back");
    expect((await store.get("op-1")).unwrap()).toBeUndefined();
  });
});

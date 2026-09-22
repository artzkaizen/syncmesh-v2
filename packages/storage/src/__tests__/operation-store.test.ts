import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import { operationStore } from "../operation-store.js";
import { inTransaction } from "../sql.js";
import { openPair } from "./pair.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const A = "a".repeat(64) as PeerId;
const B = "b".repeat(64) as PeerId;
const seq = (n: number) => n as SeqNum;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const open = async () => {
  const driver = await openPair();
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

  test("a claim is not a signature: a receipted write is settled and still sole-custody", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();

    (await store.acknowledge(B, A, seq(1), 10)).unwrap();

    // the weaker tier moved: somebody said in its cursors that it holds this
    expect((await store.unsettled()).unwrap()).toEqual([]);
    // the stronger one did not, and that is the whole point — a cursor is a peer's word
    expect((await store.soleCustody()).unwrap().map((op) => op.id)).toEqual(["op-1"]);
  });

  test("a vouch is, and it carries the store it was made out of", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.record({ id: "op-2", peer: A, seq: seq(2), label: "l", atMs: 2 })).unwrap();

    (await store.vouch(B, A, seq(1), "inc-1", 10)).unwrap();

    expect((await store.vouchesOf(A, seq(1))).unwrap()).toEqual([
      { holder: B, incarnation: "inc-1", atMs: 10 },
    ]);
    // only through seq 1: the signature covers what it says it covers
    expect((await store.soleCustody()).unwrap().map((op) => op.id)).toEqual(["op-2"]);
  });

  test("a holder that rebuilt its store stops counting for what it lost", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.record({ id: "op-2", peer: A, seq: seq(2), label: "l", atMs: 2 })).unwrap();
    (await store.vouch(B, A, seq(2), "inc-1", 10)).unwrap();
    expect((await store.soleCustody()).unwrap()).toEqual([]);

    // B comes back under a fresh lineage, holding only the first: the rest was on the disk it lost
    (await store.vouch(B, A, seq(1), "inc-2", 20)).unwrap();

    expect((await store.soleCustody()).unwrap().map((op) => op.id)).toEqual(["op-2"]);
    expect((await store.vouchesOf(A, seq(1))).unwrap()).toEqual([
      { holder: B, incarnation: "inc-2", atMs: 20 },
    ]);
    // and the vouch it made with the store that is gone is gone with it
    expect((await store.vouchesOf(A, seq(2))).unwrap()).toEqual([]);
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

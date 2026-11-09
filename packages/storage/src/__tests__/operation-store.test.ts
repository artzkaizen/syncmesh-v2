import type { PeerId, SeqNum } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import { operationStore } from "../operation-store.js";
import { inTransaction } from "../sql.js";
import { openPair } from "./pair.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const A = "a".repeat(64) as PeerId;
const B = "b".repeat(64) as PeerId;
const C = "c".repeat(64) as PeerId;
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

  test("a holder that proves a new lineage stops counting for the old one before it signs again", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.vouch(B, A, seq(1), "inc-1", 10)).unwrap();
    (await store.vouch(C, A, seq(1), "inc-9", 10)).unwrap();

    // B said hello from inc-2: what it signed out of inc-1 is gone, and nobody else's vouch is
    (await store.retireLineages(B, "inc-2")).unwrap();
    expect((await store.vouchesOf(A, seq(1))).unwrap()).toEqual([
      { holder: C, incarnation: "inc-9", atMs: 10 },
    ]);
    // the lineage it is in now keeps what it signed
    (await store.vouch(B, A, seq(1), "inc-2", 20)).unwrap();
    (await store.retireLineages(B, "inc-2")).unwrap();
    expect((await store.vouchesOf(A, seq(1))).unwrap().map((v) => v.holder)).toEqual([C, B]);
  });

  test("a holder that signs for less withdraws what it signed above it, and a stale one does not", async () => {
    const { store } = await open();
    for (const n of [1, 2, 3])
      (await store.record({ id: `op-${n}`, peer: A, seq: seq(n), label: "l", atMs: n })).unwrap();
    (await store.vouch(B, A, seq(3), "inc-1", 10)).unwrap();
    expect((await store.soleCustody()).unwrap()).toEqual([]);

    // B purged a narrowed partition (D45), same store: its run now stops at 1
    (await store.vouch(B, A, seq(1), "inc-1", 20)).unwrap();
    expect((await store.soleCustody()).unwrap().map((op) => op.id)).toEqual(["op-2", "op-3"]);

    // B signs 3 again, then a receipt it signed before that arrives late: it withdraws nothing
    (await store.vouch(B, A, seq(3), "inc-1", 40)).unwrap();
    (await store.vouch(B, A, seq(1), "inc-1", 30)).unwrap();
    expect((await store.soleCustody()).unwrap()).toEqual([]);
  });

  test("a stale receipt that arrives after a lower one does not put back what it withdrew", async () => {
    const { store } = await open();
    for (const n of [1, 2, 3])
      (await store.record({ id: `op-${n}`, peer: A, seq: seq(n), label: "l", atMs: n })).unwrap();
    (await store.vouch(B, A, seq(3), "inc-1", 10)).unwrap();
    (await store.vouch(B, A, seq(1), "inc-1", 20)).unwrap();

    // the receipt for 3 arrives again, over a second link or from another room instance
    (await store.vouch(B, A, seq(3), "inc-1", 10)).unwrap();
    expect((await store.soleCustody()).unwrap().map((op) => op.id)).toEqual(["op-2", "op-3"]);
    expect((await store.vouchesOf(A, seq(1))).unwrap()).toEqual([
      { holder: B, incarnation: "inc-1", atMs: 20 },
    ]);
  });

  test("a vouch whose insert fails leaves the holder's earlier claim whole", async () => {
    const driver = await openPair();
    let failing = false;
    // the same connection, with the vouch insert made to fail on demand
    const flaky = {
      ...driver,
      run: (sql: string, params?: Parameters<typeof driver.run>[1]) =>
        failing && sql.includes("INSERT") && sql.includes("vouches")
          ? Promise.reject(new Error("the disk filled between the delete and the insert"))
          : driver.run(sql, params),
    };
    const store = (await operationStore(flaky)).unwrap();
    for (const n of [1, 2, 3])
      (await store.record({ id: `op-${n}`, peer: A, seq: seq(n), label: "l", atMs: n })).unwrap();
    (await store.vouch(B, A, seq(3), "inc-1", 10)).unwrap();

    // a new lineage that signs for less: its deletes and its insert land together or not at all
    failing = true;
    expect((await store.vouch(B, A, seq(1), "inc-2", 20)).isErr()).toBe(true);
    failing = false;
    expect((await store.soleCustody()).unwrap()).toEqual([]);
    expect((await store.vouchesOf(A, seq(3))).unwrap()).toEqual([
      { holder: B, incarnation: "inc-1", atMs: 10 },
    ]);
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

describe("operationStore — refusals (D32)", () => {
  const STALE = { reason: "refused", verdict: "GrantStale" } as const;

  test("a refusal lands beside the write, by the refuser, and repeating it is one row", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();

    (await store.refuse(B, A, seq(1), STALE, 10)).unwrap();
    (await store.refuse(B, A, seq(1), STALE, 11)).unwrap();

    expect((await store.refusals(A, seq(1))).unwrap()).toEqual([
      { refuser: B, reason: "refused", verdict: "GrantStale", atMs: 11 },
    ]);
    const row = (await store.get("op-1")).unwrap();
    expect(row?.refusals).toEqual([{ by: B, reason: "refused", verdict: "GrantStale" }]);
    // an axis, never a state: the write is still applied, still unsettled, still sole custody
    expect(row?.status).toBe("applied");
    expect((await store.unsettled()).unwrap()[0]?.refusals).toEqual(row?.refusals);
    expect((await store.soleCustody()).unwrap().map((op) => op.id)).toEqual(["op-1"]);
  });

  test("two refusers read in the same order however often each repeats", async () => {
    // a repeat re-stamps its row, so an order by time would flip and fire every ref watching it
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.refuse(C, A, seq(1), STALE, 10)).unwrap();
    (await store.refuse(B, A, seq(1), STALE, 20)).unwrap();
    const before = (await store.get("op-1")).unwrap()?.refusals;
    (await store.refuse(C, A, seq(1), STALE, 30)).unwrap();
    expect((await store.get("op-1")).unwrap()?.refusals).toEqual(before);
    expect((await store.unsettled()).unwrap()[0]?.refusals).toEqual(before);
    expect(before?.map((refusal) => refusal.by)).toEqual([B, C]);
  });

  test("a later verdict from the same refuser replaces its earlier one", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.refuse(B, A, seq(1), STALE, 10)).unwrap();
    (await store.refuse(B, A, seq(1), { reason: "refused", verdict: "GrantRevoked" }, 12)).unwrap();
    expect((await store.byEvent(A, seq(1))).unwrap()?.refusals).toEqual([
      { by: B, reason: "refused", verdict: "GrantRevoked" },
    ]);
  });

  test("custody from the same holder covering the seq deletes the refusal; a lower one does not", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.record({ id: "op-2", peer: A, seq: seq(2), label: "l", atMs: 2 })).unwrap();
    (await store.refuse(B, A, seq(2), STALE, 10)).unwrap();

    (await store.vouch(B, A, seq(1), "inc-1", 20)).unwrap();
    expect((await store.refusals(A, seq(2))).unwrap()).toHaveLength(1);

    (await store.vouch(B, A, seq(2), "inc-1", 30)).unwrap();
    expect((await store.refusals(A, seq(2))).unwrap()).toEqual([]);
    expect((await store.get("op-2")).unwrap()?.refusals).toBeUndefined();
  });

  test("custody from another holder retires nothing: weigh by refuser, never by count", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.refuse(B, A, seq(1), STALE, 10)).unwrap();
    (await store.vouch(C, A, seq(1), "inc-1", 20)).unwrap();
    expect((await store.refusals(A, seq(1))).unwrap().map((r) => r.refuser)).toEqual([B]);
  });

  test("a refusal arriving after the refuser signed for the write is not recorded", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (await store.vouch(B, A, seq(1), "inc-1", 20)).unwrap();
    (await store.refuse(B, A, seq(1), STALE, 10)).unwrap();
    expect((await store.refusals(A, seq(1))).unwrap()).toEqual([]);
  });

  test("a refusal of a write this ledger has no record of is not recorded", async () => {
    const { store } = await open();
    (await store.refuse(B, A, seq(9), STALE, 10)).unwrap();
    expect((await store.refusals(A, seq(9))).unwrap()).toEqual([]);
  });

  test("an older-build bucket keeps its reason", async () => {
    const { store } = await open();
    (await store.record({ id: "op-1", peer: A, seq: seq(1), label: "l", atMs: 1 })).unwrap();
    (
      await store.refuse(B, A, seq(1), { reason: "unknown-table", verdict: "UnknownTable" }, 10)
    ).unwrap();
    expect((await store.get("op-1")).unwrap()?.refusals).toEqual([
      { by: B, reason: "unknown-table", verdict: "UnknownTable" },
    ]);
  });
});

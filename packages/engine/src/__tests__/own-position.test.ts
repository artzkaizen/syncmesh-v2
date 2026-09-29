import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { StoredEvent } from "../store.js";

import { ownPositionWarning } from "../own-position.js";
import { CREATE, NOTES, PEER_A, key, row, seq, setup } from "./fixtures.js";

/**
 * **A key that outlives its log** (RFC 0024 G7). An author numbers from its own log and every
 * peer drops an `(author, seq)` it already holds as a duplicate, so a device whose log is gone —
 * but whose key is not — would number its next writes over ones the room already has, and they
 * would vanish without a word. The engine takes on what a room says it holds of its own author,
 * and takes back the own events a peer hands it.
 */

type Engine = ReturnType<typeof setup>["engine"];

const writeNote = async (engine: Engine, id: string, body: string) =>
  (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(id), row({ body })))).unwrap();

/** As it arrives from a relay: an author's signature on it (the engine does not verify, links do). */
const signed = (entry: StoredEvent): StoredEvent => ({ ...entry, sig: new Uint8Array(64) });

describe("a room ahead of this log for its own author", () => {
  test("moves numbering past it, and says nothing when the log had written nothing", async () => {
    const { engine } = setup(PEER_A);
    const position = (await engine.adoptOwnPosition(seq(5))).unwrap();
    expect(position).toEqual({ kind: "resumed", room: seq(5) });
    expect(ownPositionWarning(position)).toBeUndefined();
    expect((await writeNote(engine, "n1", "one")).seqNum).toBe(seq(6));
    // told again, it is already known
    expect((await engine.adoptOwnPosition(seq(5))).unwrap()).toEqual({ kind: "known" });
  });

  test("says which of this log's own writes collided, and numbers past the room", async () => {
    const { engine } = setup(PEER_A);
    await writeNote(engine, "x1", "offline");
    const position = (await engine.adoptOwnPosition(seq(5))).unwrap();
    expect(position).toEqual({ kind: "collided", room: seq(5), held: seq(1) });
    expect(ownPositionWarning(position)).toContain("up to 5");
    expect((await writeNote(engine, "n2", "two")).seqNum).toBe(seq(6));
  });

  test("a room behind the log is the ordinary case: writes it has not had yet", async () => {
    const { engine } = setup(PEER_A);
    for (const id of ["n1", "n2", "n3"]) await writeNote(engine, id, id);
    expect((await engine.adoptOwnPosition(seq(1))).unwrap()).toEqual({ kind: "known" });
    expect((await writeNote(engine, "n4", "four")).seqNum).toBe(seq(4));
  });

  test("local writes keep their own run: the room's never counts them", async () => {
    const { engine } = setup(PEER_A);
    await engine.adoptOwnPosition(seq(5));
    const local = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, key("l1"), row({ body: "mine" })), {
        local: true,
      })
    ).unwrap();
    expect(local.seqNum).toBe(seq(1));
  });
});

describe("own events a peer hands back", () => {
  test("are taken back when the log lost them, and the next write numbers after them", async () => {
    const { engine: before, store } = setup(PEER_A);
    await writeNote(before, "n1", "one");
    await writeNote(before, "n2", "two");
    const history = (await store.all()).unwrap().map(signed);

    const { engine: reborn } = setup(PEER_A);
    const back = (await reborn.receiveBatch(history)).unwrap();
    expect(back.folded).toBe(2);
    expect(readRow(reborn.state(), NOTES, key("n2"))).toEqual(row({ body: "two" }));
    expect(Number(reborn.coverage().synced.get(PEER_A))).toBe(2);
    expect((await writeNote(reborn, "n3", "three")).seqNum).toBe(seq(3));
  });

  test("one with no signature cannot have come from a peer, and is skipped", async () => {
    const { engine: before, store } = setup(PEER_A);
    await writeNote(before, "n1", "one");
    const [unsigned] = (await store.all()).unwrap();
    const { engine: reborn } = setup(PEER_A);
    const report = (await reborn.receiveBatch(unsigned === undefined ? [] : [unsigned])).unwrap();
    expect(report.folded).toBe(0);
    expect(report.skipped).toBe(1);
  });

  test("one the log already holds is a duplicate, as before", async () => {
    const { engine, store } = setup(PEER_A);
    await writeNote(engine, "n1", "one");
    const again = (await store.all()).unwrap().map(signed);
    const report = (await engine.receiveBatch(again)).unwrap();
    expect(report.folded).toBe(0);
    expect(report.skipped).toBe(1);
  });
});

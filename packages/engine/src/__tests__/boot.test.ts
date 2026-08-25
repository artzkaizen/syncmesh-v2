import { compareHlc, readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { openEngine } from "../engine.js";
import { CREATE, N1, NOTES, PEER_A, column, fakeClock, key, row, seq, setup } from "./fixtures.js";

describe("openEngine — boot from the store", () => {
  test("folds the log and moves the clock past the highest stored stamp before numbering", async () => {
    const { store, engine } = setup(PEER_A, 500);
    const stored = (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))
    ).unwrap();

    const clock = fakeClock(100);
    const booted = (await openEngine({ peerId: PEER_A, clock, store })).unwrap();
    expect(readRow(booted.state(), NOTES, N1)?.get(column("body"))).toBe("a");

    const next = (
      await booted.mutate(CREATE, (tx) => tx.insert(NOTES, key("n2"), row({ body: "b" })))
    ).unwrap();
    expect(compareHlc(next.hlc, stored.hlc)).toBe(1);
    expect(next.seqNum).toBe(seq(2));
  });

  test("an empty store boots to an empty state and a fresh sequence", async () => {
    const { store } = setup(PEER_A);
    const booted = (await openEngine({ peerId: PEER_A, clock: fakeClock(1), store })).unwrap();
    expect(booted.state().size).toBe(0);
    const first = (
      await booted.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "a" })))
    ).unwrap();
    expect(first.seqNum).toBe(seq(1));
  });
});

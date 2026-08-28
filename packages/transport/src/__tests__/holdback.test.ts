import type { StoredEvent } from "@syncmesh/engine";
import type { CellValue, ColumnName, SyncEvent } from "@syncmesh/kernel";

import { tableDigests } from "@syncmesh/engine";
import { describe, expect, test } from "bun:test";

import { createHoldback } from "../holdback.js";
import { BODY, ID, NOTES, key, mintFor, peer, write, type Peer } from "./fixtures.js";

/** A device that already holds the author's grant, so validation refuses nothing but the forgery. */
const deviceKnowing = (n: number, author: Peer): Peer => {
  const device = peer(n, "acct_b");
  device.grants.register(mintFor(author.identity, "acct_a")).unwrap();
  return device;
};

/** The author's own event, rewritten into a row no build's schema here will ever accept. */
const forge = (event: SyncEvent): SyncEvent => ({
  ...event,
  changes: [
    {
      kind: "insert",
      table: NOTES,
      key: key("bad"),
      // a number in a text column: a refusal the ladder reaches on every device alike, and one
      // no later build of *this* schema reverses — the `refused` bucket, not `unknown-table`
      row: new Map<ColumnName, CellValue>([
        [ID, "bad"],
        [BODY, 7],
      ]),
    },
  ],
});

/** Four events from one author, the second of them permanently inadmissible. */
const runFrom = async (author: Peer) => {
  const events: SyncEvent[] = [];
  for (const n of [1, 2, 3, 4]) events.push((await write(author, `n${n}`, `b${n}`)).unwrap());
  // SAFETY: the loop above pushed four events
  const [e1, e2, e3, e4] = events as [SyncEvent, SyncEvent, SyncEvent, SyncEvent];
  return [e1, forge(e2), e3, e4].map((event): StoredEvent => ({ event }));
};

describe("the holdback's gap rule against a parked event", () => {
  test("a refusal no upgrade reverses does not stop the author's later events", async () => {
    const author = peer(40, "acct_a");
    const device = deviceKnowing(41, author);
    const run = await runFrom(author);

    // one event at a time and strictly in order — what a bridge or a relay session delivers
    const holdback = createHoldback(device.engine, device.identity.peerId, 8);
    for (const entry of run) {
      expect(holdback.put(entry)).toBe(false); // never overflows into a rejoin
      const ready = holdback.drain(entry.event.peerId);
      if (ready.length > 0) (await device.engine.receiveBatch(ready)).unwrap();
    }

    expect(device.engine.quarantine().map((p) => Number(p.entry.event.seqNum))).toEqual([2]);
    // seqs 3 and 4 landed even though the cursor is still pinned below the parked seq 2
    expect(Number(device.engine.coverage().synced.get(author.identity.peerId) ?? 0)).toBe(1);
    const above = (of: "ahead" | "holding") =>
      (device.engine[of]().get(author.identity.peerId) ?? []).map(Number);
    expect(above("holding")).toEqual([2, 3, 4]); // every sequence this device has the bytes for
    // and what travels is the folded half alone: peers go on offering the refusal, because
    // something outside the event — a grant, an un-revocation — is what reverses that verdict
    expect(above("ahead")).toEqual([3, 4]);
    expect(readBody(device, "n3")).toBe("b3");
    expect(readBody(device, "n4")).toBe("b4");
  });

  test("two devices fed that run in opposite orders reach the same digest", async () => {
    const author = peer(40, "acct_a");
    const run = await runFrom(author);
    const digests = [];
    for (const [n, order] of [
      [42, [0, 1, 2, 3]],
      [43, [3, 2, 1, 0]],
    ] as const) {
      const device = deviceKnowing(n, author);
      const holdback = createHoldback(device.engine, device.identity.peerId, 8);
      for (const i of order) {
        // SAFETY: every index in the orders above is within the four-entry run
        const entry = run[i]!;
        holdback.put(entry);
        const ready = holdback.drain(entry.event.peerId);
        if (ready.length > 0) (await device.engine.receiveBatch(ready)).unwrap();
      }
      digests.push([...tableDigests(device.engine.state())]);
    }
    expect(digests[1]).toEqual(digests[0]!);
  });
});

const readBody = (p: Peer, id: string) =>
  p.engine.state().get(NOTES)?.get(key(id))?.cells.get(BODY)?.value;

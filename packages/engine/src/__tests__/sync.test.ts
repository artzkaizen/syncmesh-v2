import { parseSeqNum, type SyncEvent } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import {
  coversCursors,
  generateSyncMessage,
  initialSyncState,
  receiveSyncMessage,
  type Cursors,
  type SyncDoc,
} from "../sync.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, row, seq, setup } from "./fixtures.js";

const docWith = async (n: number): Promise<{ doc: SyncDoc; events: SyncEvent[] }> => {
  const { engine } = setup(PEER_A);
  const events: SyncEvent[] = [];
  for (let i = 0; i < n; i++)
    events.push((await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ i })))).unwrap());
  const all = (await engine.eventsSince(new Map())).unwrap();
  const cursors = (await engine.cursors()).unwrap();
  return {
    doc: {
      cursors,
      eventsSince: (theirs) => all.filter((e) => (theirs.get(e.peerId) ?? 0) < e.seqNum),
    },
    events,
  };
};

describe("generateSyncMessage / receiveSyncMessage", () => {
  test("first message is our cursors; then only what they lack; then nothing", async () => {
    const { doc, events } = await docWith(3);
    const [s1, m1] = generateSyncMessage(initialSyncState, doc);
    expect(m1?.kind).toBe("cursors");
    expect(s1.inFlight).toBe(true);

    const theirs: Cursors = new Map([[PEER_A, seq(1)]]);
    const [s2] = receiveSyncMessage({ kind: "cursors", cursors: theirs });
    expect(s2.inFlight).toBe(false);

    const [s3, m3] = generateSyncMessage(s2, doc);
    expect(m3?.kind === "events" && m3.events.map((e) => Number(e.seqNum))).toEqual([2, 3]);
    expect(s3.inFlight).toBe(true);
    expect(s3.theirCursors?.get(PEER_A)).toBe(events[2]?.seqNum);

    const [s4] = receiveSyncMessage({ kind: "cursors", cursors: doc.cursors });
    expect(generateSyncMessage(s4, doc)[1]).toBeUndefined();
  });

  test("inFlight blocks a second message until a reply clears it", async () => {
    const { doc } = await docWith(1);
    const [s1, m1] = generateSyncMessage(initialSyncState, doc);
    expect(m1).toBeDefined();
    expect(generateSyncMessage(s1, doc)[1]).toBeUndefined();
    const [s2] = receiveSyncMessage({ kind: "cursors", cursors: new Map() });
    expect(generateSyncMessage(s2, doc)[1]?.kind).toBe("events");
  });

  test("receiving events returns them to fold and records the sender's cursors", async () => {
    const { doc, events } = await docWith(2);
    const [state, toFold] = receiveSyncMessage({
      kind: "events",
      events,
      cursors: doc.cursors,
    });
    expect(toFold).toBe(events);
    expect(state.theirCursors).toBe(doc.cursors);
  });
});

describe("coversCursors", () => {
  test("true iff every author in want is at or below have", () => {
    const have: Cursors = new Map([
      [PEER_A, seq(3)],
      [PEER_B, seq(1)],
    ]);
    expect(coversCursors(have, new Map([[PEER_A, seq(3)]]))).toBe(true);
    expect(coversCursors(have, new Map([[PEER_A, seq(4)]]))).toBe(false);
    expect(
      coversCursors(
        have,
        new Map([
          [PEER_B, seq(1)],
          [PEER_A, seq(1)],
        ]),
      ),
    ).toBe(true);
    expect(coversCursors(new Map(), new Map([[PEER_A, seq(1)]]))).toBe(false);
    expect(coversCursors(have, new Map())).toBe(true);
  });
});

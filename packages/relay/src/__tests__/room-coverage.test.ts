import { parseSeqNum } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { roomCoverage } from "../room-coverage.js";
import { entryOf, peer, write } from "./fixtures.js";

describe("the room's position at open", () => {
  test("a log compacted before this open keeps nothing past a gap: the run it holds is its cursors", async () => {
    const a = peer(40, "acct_a");
    const wires = [];
    for (const n of [1, 2, 3, 4, 5]) wires.push(await write(a, `n${n}`, "body"));
    const [, , ...kept] = wires.map(entryOf);
    const floor = new Map([[a.identity.peerId, parseSeqNum(2).unwrap()]]);
    const coverage = roomCoverage({ synced: floor, local: new Map() }, kept.slice(0, 2));
    // what lands after open closes onto the floor's run: nothing is kept waiting past a gap
    for (const entry of kept.slice(2)) coverage.note(entry.event);
    expect(coverage.current().synced.get(a.identity.peerId)).toBe(parseSeqNum(5).unwrap());
    expect(coverage.current().held).toBeUndefined();
  });
});

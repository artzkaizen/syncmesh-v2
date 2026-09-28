import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import type { EngineError } from "../errors.js";

import { openEngine } from "../boot.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { StrandedWrites } from "../stranded.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, fakeClock, row, seq, setup } from "./fixtures.js";

/**
 * **Rotating a device key over a log that is kept strands every write that had not left yet.**
 *
 * The log stores an event this device authored with no signature: nothing had signed it when it
 * was written, and the bridge signs on the way out. Take a new key and those entries are no
 * longer self-authored — so nobody can sign them, `relayEnvelope` refuses them forever, and they
 * sit below this device's own cursor where no peer will ever offer them back. They fold, they
 * are on the screen, and they reach nobody.
 *
 * It happened here: an app changed from a bundled device key to a per-install one while existing
 * databases kept running, and one install was left holding 86 events it could not send. Nothing
 * reported it. The only column that made it visible at all was a PN-counter, because a counter is
 * keyed by author and every last-writer-wins column reads the same whether the author's events
 * arrived or not.
 *
 * What is pinned here is the choice: **report, do not repair.** Re-signing under the new key
 * would re-author them — a new event id, a colliding sequence, and a second cell in every
 * per-author CRDT for a write that already folded, which is the counter bug doubled rather than
 * fixed. Dropping them would unfold state that is on the screen. Refusing to open would brick
 * exactly the databases this has already happened to. So boot names them, on a listener that
 * exists before the engine does, and `stranded()` answers the same question afterwards.
 */

const writeNote = async (engine: ReturnType<typeof setup>["engine"], body: string) =>
  (await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body })))).unwrap();

describe("a device that rotated its key over a kept log", () => {
  test("says so at boot, names the retired author, and keeps the state it folded", async () => {
    const store = createMemoryEventStore();
    const before = createEngine({ peerId: PEER_A, clock: fakeClock(100), store });
    for (const body of ["one", "two", "three"]) await writeNote(before, body);
    // nothing is stranded while the key that wrote them is still the key in hand
    expect((await before.stranded()).unwrap()).toEqual([]);

    const heard: EngineError[] = [];
    const after = (
      await openEngine({
        peerId: PEER_B,
        clock: fakeClock(200),
        store,
        onError: (error) => void heard.push(error),
      })
    ).unwrap();

    const stranded = heard.filter((e): e is StrandedWrites => e instanceof StrandedWrites);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.author).toBe(PEER_A);
    expect(stranded[0]?.count).toBe(3);
    expect(stranded[0]?.from).toBe(seq(1));
    expect(stranded[0]?.to).toBe(seq(3));
    expect(stranded[0]?.message).toContain("can never be sent");

    // the same answer on demand, for a screen that asks after boot rather than a listener
    expect((await after.stranded()).unwrap().map((s) => s.count)).toEqual([3]);
    // and nothing was repaired away: the rows those events folded to are still here
    expect(readRow(after.state(), NOTES, N1)).toEqual(row({ body: "three" }));
  });

  test("a device that did not rotate reports nothing, and boot stays quiet", async () => {
    const { store, engine } = setup(PEER_A);
    for (const body of ["one", "two"]) await writeNote(engine, body);

    const heard: EngineError[] = [];
    const again = (
      await openEngine({
        peerId: PEER_A,
        clock: fakeClock(200),
        store,
        onError: (error) => void heard.push(error),
      })
    ).unwrap();
    expect(heard).toEqual([]);
    expect((await again.stranded()).unwrap()).toEqual([]);
  });

  test("a local-only write is not stranded: it was never going anywhere", async () => {
    const store = createMemoryEventStore();
    const before = createEngine({ peerId: PEER_A, clock: fakeClock(100), store });
    (
      await before.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "mine" })), {
        local: true,
      })
    ).unwrap();

    const after = createEngine({ peerId: PEER_B, clock: fakeClock(200), store });
    expect((await after.stranded()).unwrap()).toEqual([]);
  });
});

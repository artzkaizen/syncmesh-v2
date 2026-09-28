import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createLink } from "../link.js";
import { CREATE, column, key, N1, NOTES, PEER_B, PEER_C, row, setup } from "./fixtures.js";

const N2 = key("n2");

describe("Link", () => {
  test("done-when: offline edits to title on A and body on B merge on both sides after reconnect", async () => {
    const a = setup();
    const b = setup(PEER_B);
    const link = createLink(a.engine, b.engine);

    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "t", body: "b" })));
    await link.flush();
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(row({ title: "t", body: "b" }));

    link.setOnline(false);
    await a.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ title: "A's title" })));
    await b.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "B's body" })));
    await link.flush();
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(row({ title: "t", body: "B's body" }));

    link.setOnline(true);
    (await link.catchUp()).unwrap();
    const merged = row({ title: "A's title", body: "B's body" });
    expect(readRow(a.engine.state(), NOTES, N1)).toEqual(merged);
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(merged);
  });

  test("a third device keeps receiving across repeated reunions (silence is an acknowledgement)", async () => {
    // three devices, each linked to the other two, going apart and back several times. The bug
    // this pins: a `catchUp` that ends with one side's message unanswered left that side's
    // `inFlight` set, and `generateSyncMessage` refuses to speak while one is outstanding — so
    // that direction went quiet permanently and the device simply stopped receiving. Nothing
    // errored, nothing diverged loudly, it just stopped, and only a third device showed it
    const a = setup();
    const b = setup(PEER_B);
    const c = setup(PEER_C);
    const links = [
      createLink(a.engine, b.engine),
      createLink(b.engine, c.engine),
      createLink(a.engine, c.engine),
    ];
    const reunite = async () => {
      for (const link of links) link.setOnline(true);
      for (let round = 0; round < 3; round += 1)
        for (const link of links) (await link.catchUp()).unwrap();
    };
    const bodyOn = (who: typeof a) => readRow(who.engine.state(), NOTES, N1)?.get(column("body"));

    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ body: "first" })));
    await reunite();

    for (const round of [1, 2, 3]) {
      for (const link of links) link.setOnline(false);
      await b.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: `round ${round}` })));
      await reunite();
      // `a` wrote nothing after the first round, so it has nothing to say — and having nothing to
      // say must not be what stops it listening
      expect(bodyOn(a)).toBe(`round ${round}`);
      expect(bodyOn(c)).toBe(`round ${round}`);
    }
  });

  test("catchUp is symmetric and idempotent: a second run moves nothing", async () => {
    const a = setup();
    const b = setup(PEER_B);
    const link = createLink(a.engine, b.engine);
    link.setOnline(false);
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ x: 1 })));
    await b.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N2, row({ y: 2 })));
    link.setOnline(true);
    (await link.catchUp()).unwrap();
    const before = [(await a.store.all()).unwrap().length, (await b.store.all()).unwrap().length];
    expect(before).toEqual([2, 2]);
    (await link.catchUp()).unwrap();
    expect([(await a.store.all()).unwrap().length, (await b.store.all()).unwrap().length]).toEqual([
      2, 2,
    ]);
    expect((await a.engine.cursors()).unwrap()).toEqual((await b.engine.cursors()).unwrap());
  });

  test("a settled link starts a fresh session when one side later writes offline", async () => {
    const a = setup();
    const b = setup(PEER_B);
    const link = createLink(a.engine, b.engine);

    (
      await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ title: "before" })))
    ).unwrap();
    await link.flush();
    (await link.catchUp()).unwrap();

    link.setOnline(false);
    (
      await b.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ body: "written offline" })))
    ).unwrap();
    link.setOnline(true);
    (await link.catchUp()).unwrap();

    const merged = row({ title: "before", body: "written offline" });
    expect(readRow(a.engine.state(), NOTES, N1)).toEqual(merged);
    expect(readRow(b.engine.state(), NOTES, N1)).toEqual(merged);
  });

  /**
   * **`catchUp` on a down link used to answer `Result.ok(undefined)`.** A success that did
   * nothing, and indistinguishable from the success that did everything — so a test asserting
   * convergence over a link somebody forgot to bring back up passed, and a caller looping until
   * `catchUp` succeeds span forever against a link that would never speak. Same class of lie as
   * a relay dropping an event out of a page and reporting the page count.
   */
  test("catchUp while offline says so, rather than succeeding at nothing", async () => {
    const a = setup();
    const b = setup(PEER_B);
    const link = createLink(a.engine, b.engine);
    link.setOnline(false);
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ x: 1 })));

    const refused = await link.catchUp();
    expect(refused.isErr()).toBe(true);
    expect(refused.isErr() && refused.error._tag).toBe("LinkOffline");
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();

    link.setOnline(true);
    link.close(); // close takes the link back offline, and the refusal survives it
    await a.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ x: 2 })));
    await link.flush();
    expect((await link.catchUp()).isErr()).toBe(true);
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();
  });

  test("a link says what it holds above its cursor, so a run past a hole is not re-offered", async () => {
    const a = setup();
    const b = setup(PEER_B);
    const c = setup(PEER_C);

    // c authors three events; b takes 1 and 3, so it stands at cursor 1 holding 3 above the hole
    const events = [];
    for (const n of [1, 2, 3])
      events.push(
        (
          await c.engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(`n${n}`), row({ x: n })))
        ).unwrap(),
      );
    const entries = events.map((event) => ({ event }));
    (await a.engine.receiveBatch(entries)).unwrap();
    (await b.engine.receiveBatch(entries.filter((_, i) => i !== 1))).unwrap();
    expect((b.engine.ahead().get(PEER_C) ?? []).map(Number)).toEqual([3]);

    const offered: number[] = [];
    const counting = {
      ...b.engine,
      receiveBatch: (entries: Parameters<typeof b.engine.receiveBatch>[0]) => {
        for (const { event } of entries) offered.push(Number(event.seqNum));
        return b.engine.receiveBatch(entries);
      },
    };
    (await createLink(a.engine, counting).catchUp()).unwrap();
    expect(offered).toEqual([2]); // the hole, and not the run above it
  });
});

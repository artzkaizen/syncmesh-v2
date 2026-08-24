import { readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createLink } from "../link.js";
import { CREATE, key, N1, NOTES, PEER_B, row, setup } from "./fixtures.js";

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

  test("catchUp while offline is a no-op; close stops live forwarding", async () => {
    const a = setup();
    const b = setup(PEER_B);
    const link = createLink(a.engine, b.engine);
    link.setOnline(false);
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ x: 1 })));
    (await link.catchUp()).unwrap();
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();
    link.setOnline(true);
    link.close();
    await a.engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ x: 2 })));
    await link.flush();
    expect(readRow(b.engine.state(), NOTES, N1)).toBeUndefined();
  });
});

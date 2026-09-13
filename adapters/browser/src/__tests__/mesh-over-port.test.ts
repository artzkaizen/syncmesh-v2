import { describe, expect, test } from "bun:test";

import type { FollowerMesh } from "../client.js";

import { MeshHostGone } from "../protocol.js";
import { ACME, book, device, meshOrigin, settled } from "./origin-mesh.js";

/**
 * Two tabs, one mesh, no browser.
 *
 * The whole arrangement is written against a `WirePort`, so the same host that will sit in a
 * dedicated worker answers a `MessageChannel` here and cannot tell the difference — which is how
 * `driverTests` already certifies the SQLite wire, and is why the part most likely to be wrong (a
 * write in tab A re-running a live query in tab B) is provable in `bun test`.
 */
const titles = (mesh: FollowerMesh) => mesh.on(ACME).unwrap().db.select().from(book);

describe("the mesh over a port", () => {
  test("a write in one tab re-runs a live query in another", async () => {
    const { host, tab, stop } = await meshOrigin();
    const a = tab("leader");
    const b = tab();

    const live = b.mesh.on(ACME).unwrap().live(titles(b.mesh));
    expect(await live.ready).toEqual([]);
    const seen: number[] = [];
    live.subscribe((rows) => seen.push(rows.length));

    await a.mesh.on(ACME).unwrap().db.insert(book).values({ id: "b1", title: "Dune" });
    await settled();

    expect(live.data()).toEqual([{ id: "b1", title: "Dune" }]);
    expect(seen).toEqual([1]);
    // the fold is one host subscription however many tabs asked for it, and so is `auth`
    expect(host.census().feeds).toBe(4);
    live.release();
    await stop();
  });

  test("a follower's write is the origin's event, in the one log", async () => {
    const { mesh, tab, stop } = await meshOrigin();
    const b = tab();
    await b.mesh.on(ACME).unwrap().db.insert(book).values({ id: "b2", title: "Emma" });

    const events = (await mesh.engine.eventsSince(new Map())).unwrap();
    expect(events.length).toBe(1);
    expect(events[0]?.event.peerId).toBe(device.peerId);
    expect(await mesh.query?.("select id from book")).toEqual([["b2"]]);
    await stop();
  });

  test("a write reports its receipt to the tab that made it, and to no other", async () => {
    const { tab, stop } = await meshOrigin();
    const a = tab();
    const b = tab();
    const mine: string[] = [];
    const theirs: string[] = [];
    a.mesh
      .on(ACME)
      .unwrap()
      .onCommit((r) => mine.push(String(r.eventId)));
    b.mesh
      .on(ACME)
      .unwrap()
      .onCommit((r) => theirs.push(String(r.eventId)));

    await a.mesh.on(ACME).unwrap().db.insert(book).values({ id: "b3", title: "Ada" });
    await settled();

    expect(mine.length).toBe(1);
    expect(theirs).toEqual([]);
    await stop();
  });

  test("a transaction in one tab excludes the other's statements for its whole span", async () => {
    const { mesh, tab, stop } = await meshOrigin();
    const a = tab();
    const b = tab();
    const handleA = a.mesh.on(ACME).unwrap();
    const handleB = b.mesh.on(ACME).unwrap();

    const both = await Promise.all([
      handleA.db.transaction(async (tx) => {
        await tx.insert(book).values({ id: "t1", title: "one" });
        await tx.insert(book).values({ id: "t2", title: "two" });
      }),
      handleB.db.insert(book).values({ id: "t3", title: "three" }),
    ]);

    expect(both.length).toBe(2);
    // two transactions, so two events — the pair never became one, and neither was lost
    const events = (await mesh.engine.eventsSince(new Map())).unwrap();
    expect(events.length).toBe(2);
    expect(
      await handleB.db
        .select()
        .from(book)
        .then((rows) => rows.length),
    ).toBe(3);
    await stop();
  });

  test("a tab that closes leaves no subscription and no handle behind", async () => {
    const { host, tab, stop } = await meshOrigin();
    const a = tab();
    const b = tab();
    const live = b.mesh.on(ACME).unwrap().live(titles(b.mesh));
    await live.ready;
    a.mesh.on(ACME).unwrap();
    // one topic per window for `auth` on top of the four this test's two tabs already hold: the
    // principal is pushed rather than asked, because a handler is handed it synchronously and a
    // port cannot answer that way. The *feed* is one for the origin however many windows subscribe
    expect(host.census()).toEqual({
      clients: 2,
      topics: 7,
      feeds: 4,
      handles: 0,
      inspecting: false,
    });

    await b.mesh.stop();
    await settled();
    expect(host.census().clients).toBe(1);
    // `sync`, `grant` and `auth`: the three every window holds for the life of its link
    expect(host.census().topics).toBe(3);
    expect(host.census().feeds).toBe(3);

    // the tab that stayed is unaffected, and the host is still answering
    await a.mesh.on(ACME).unwrap().db.insert(book).values({ id: "b4", title: "Still here" });
    expect(await a.mesh.query?.("select id from book")).toEqual([["b4"]]);

    await a.mesh.stop();
    await settled();
    expect(host.census()).toEqual({
      clients: 0,
      topics: 0,
      feeds: 0,
      handles: 0,
      inspecting: false,
    });
    await stop();
  });

  test("a host that goes away settles the calls that were out, rather than hanging", async () => {
    const { tab, stop } = await meshOrigin();
    const b = tab();
    const outstanding = b.mesh.flush();
    b.link.lost();

    const thrown = await outstanding.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(thrown).toBeInstanceOf(MeshHostGone);
    expect(b.mesh.running()).toBe(false);
    await stop();
  });

  test("the two synchronous questions answer once the round trip has landed", async () => {
    const { tab, stop } = await meshOrigin();
    const b = tab();
    // the pessimistic answer first: a component renders before a port can reply
    expect(b.mesh.can("book.insert", undefined, ACME)).toBe(false);
    let asked = 0;
    b.mesh.grants.onRegistered(() => (asked += 1));
    await settled();

    expect(asked).toBe(1);
    expect(b.mesh.can("book.insert", undefined, ACME)).toBe(true);
    await stop();
  });
});

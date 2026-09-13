import { meshApi, mutation, query } from "@syncmesh/orpc";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ORG, book, meshOrigin, settled } from "./origin-mesh.js";

/**
 * The acceptance test for the whole arrangement: **the app's own api, unchanged, in a tab that
 * holds no engine.**
 *
 * `meshApi` is not reimplemented here and is not configured for this — it reads a handful of
 * members off a mesh, `FollowerMesh` answers exactly those, and so the surface an app writes
 * against is one implementation whether the tab is the elected one or the fourth one. That is the
 * whole of what "one engine per origin" has to buy to be worth building.
 */
const books = {
  list: query.input(z.object({ orgId: z.string() })).handler(({ db }) => db.select().from(book)),
  create: mutation
    .input(z.object({ orgId: z.string(), id: z.string(), title: z.string().min(1) }))
    .handler(async ({ input, db }) => {
      await db.insert(book).values({ id: input.id, title: input.title });
      return { id: input.id };
    }),
};

const apiTab = async (origin: Awaited<ReturnType<typeof meshOrigin>>) => {
  const { mesh } = origin.tab();
  // awaited once, the way a window does it: the port cannot answer synchronously
  return { mesh, api: meshApi({ ...mesh, self: await mesh.selfId() }, { books }) };
};

describe("the app's api in a tab that holds no engine", () => {
  test("a write through one tab's api re-renders a live query in another's", async () => {
    const origin = await meshOrigin();
    const { stop } = origin;
    const a = await apiTab(origin);
    const b = await apiTab(origin);

    const live = b.api.books.list({ orgId: ORG }).live();
    expect(await live.ready).toEqual([]);
    const rendered: number[] = [];
    live.subscribe((rows) => rendered.push(rows.length));

    const written = await a.api.books.create({ orgId: ORG, id: "b1", title: "Dune" }).committed;
    expect(written.isOk()).toBe(true);
    expect(String(written.unwrap().eventId)).toMatch(/^[0-9a-f]{64}-\d+$/);
    expect(written.unwrap().data).toEqual({ id: "b1" });

    await settled();
    expect(live.data()).toEqual([{ id: "b1", title: "Dune" }]);
    expect(rendered).toEqual([1]);
    live.release();
    await stop();
  });

  test("a rehearsal runs on the leader's replica and rolls back, leaving no row and no event", async () => {
    const origin = await meshOrigin();
    const { stop } = origin;
    const a = await apiTab(origin);
    const allowed = await a.api.books.create
      .can({ orgId: ORG, id: "r1", title: "Rehearsed" })
      .run();

    expect(allowed.isOk()).toBe(true);
    expect(await a.api.books.list({ orgId: ORG }).run()).toEqual([]);
    await stop();
  });

  /**
   * The tick a detail panel actually produces: a button rehearses its delete while an effect
   * counts a view, in one render. Both open a host-side scope, and the host lets the tab that is
   * already holding the turn straight through — so without a queue on this side the second span
   * overwrites the first's, the first is never closed, and the origin's one handle is wedged for
   * every tab. Found in a browser, on the second write of the first screen.
   */
  test("a rehearsal and a write opened in one tick both settle, and the handle is free after", async () => {
    const origin = await meshOrigin();
    const { stop } = origin;
    const a = await apiTab(origin);
    const rehearsal = a.api.books.create.can({ orgId: ORG, id: "r2", title: "Rehearsed" }).run();
    const written = a.api.books.create({ orgId: ORG, id: "b3", title: "Persuasion" }).committed;

    expect((await rehearsal).isOk()).toBe(true);
    expect((await written).isOk()).toBe(true);
    // the handle is handed back rather than held by whoever got in first
    expect(await a.api.books.list({ orgId: ORG }).run()).toEqual([
      { id: "b3", title: "Persuasion" },
    ]);
    expect(origin.host.census().handles).toBe(0);
    await stop();
  });

  test("a write recorded under an id the caller already holds keeps that id", async () => {
    const origin = await meshOrigin();
    const { stop } = origin;
    const a = await apiTab(origin);
    const write = a.api.books.create({ orgId: ORG, id: "b2", title: "Emma" });

    expect(write.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await write.committed).isOk()).toBe(true);
    expect(await a.api.books.list({ orgId: ORG }).run()).toEqual([{ id: "b2", title: "Emma" }]);
    await stop();
  });
});

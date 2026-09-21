import { meshApi, mutation, query } from "@syncmesh/orpc";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { ORG, book, meshOrigin, settled } from "./origin-mesh.js";

/**
 * A read fired beside a rehearsal, in one tab, in one tick — the detail panel's own shape.
 *
 * A panel that rehearses `remove` to decide whether to draw the delete button while reading the
 * row it is about is two statements from one tab in the same tick, and the second must not be
 * answered out of the first's staged rows. It used to be: both arrived as bare `sql` messages, the
 * host saw the tab already inside a span and fed the read into the rehearsal's transaction, so the
 * read came back empty for a row sitting in the list beside it and the panel said "that issue is
 * not on this device" — then the rehearsal rolled its `DELETE` back and the row was there all
 * along. Nothing invalidated afterwards, so the empty answer stuck.
 *
 * The read waiting for the rehearsal rather than joining it is what a `Handle` does in process;
 * this is that rule kept across the port, and the token on each statement is what makes it
 * keepable — the host cannot tell the two apart by sender, because the sender is the same tab.
 */
const books = {
  get: query
    .input(z.object({ orgId: z.string(), id: z.string() }))
    .handler(({ input, db }) => db.select().from(book).where(eq(book.id, input.id))),
  create: mutation
    .input(z.object({ orgId: z.string(), id: z.string(), title: z.string().min(1) }))
    .handler(async ({ input, db }) => {
      await db.insert(book).values({ id: input.id, title: input.title });
      return { id: input.id };
    }),
  /** Held by a tab that neither finishes nor disconnects — a reload caught mid-statement. */
  removeSilently: mutation
    .input(z.object({ orgId: z.string(), id: z.string() }))
    .handler(async ({ input, db }) => {
      await db.delete(book).where(eq(book.id, input.id));
      silent.open();
      await silent.held;
      return { id: input.id };
    }),
  /** Rehearsed, then abandoned: the body never returns, so `leave` is never sent. */
  removeForever: mutation
    .input(z.object({ orgId: z.string(), id: z.string() }))
    .handler(async ({ input, db }) => {
      await db.delete(book).where(eq(book.id, input.id));
      orphaned.open();
      await orphaned.held;
      return { id: input.id };
    }),
  remove: mutation
    .input(z.object({ orgId: z.string(), id: z.string() }))
    .handler(async ({ input, db }) => {
      await db.delete(book).where(eq(book.id, input.id));
      staged.open();
      // the span stays open across the read, which is the whole interleaving: a rehearsal is not
      // instantaneous, and the panel's read is fired while the handler is still in its body
      await staged.held;
      return { id: input.id };
    }),
};

/** A second one, for the tab that goes quiet without ever saying so. */
const silent = (() => {
  let open!: () => void;
  const inside = new Promise<void>((resolve) => (open = resolve));
  return { open, inside, held: new Promise<void>(() => undefined) };
})();

/** A rehearsal that never sends `leave`, because the window it was running in is gone. */
const orphaned = (() => {
  let open!: () => void;
  const inside = new Promise<void>((resolve) => (open = resolve));
  return { open, inside, held: new Promise<void>(() => undefined) };
})();

/** Lets the test stand inside the rehearsal: staged, and not yet rolled back. */
const staged = (() => {
  let open!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => (open = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  return { open, inside, held, release };
})();

const apiTab = async (origin: Awaited<ReturnType<typeof meshOrigin>>) => {
  const { mesh } = origin.tab();
  return meshApi({ ...mesh, self: await mesh.selfId() }, { books });
};

describe("a statement is placed by the sink it came through", () => {
  test("a read fired with a delete rehearsal still sees the row", async () => {
    const origin = await meshOrigin();
    const api = await apiTab(origin);

    expect((await api.books.create({ orgId: ORG, id: "b1", title: "Dune" }).committed).isOk()).toBe(
      true,
    );
    await settled();

    // the panel mounting: the rehearsal goes first and is still inside its body when the read
    // is fired — the ordering the browser actually produces, and the one that used to answer empty
    const rehearsing = api.books.remove.can({ orgId: ORG, id: "b1" }).run();
    await staged.inside;

    const reading = api.books.get({ orgId: ORG, id: "b1" }).run();
    // long enough for the read to reach the host and be placed, whichever way it is placed
    await new Promise((resolve) => setTimeout(resolve, 20));
    staged.release();

    expect(await reading).toEqual([{ id: "b1", title: "Dune" }]);
    expect((await rehearsing).isOk()).toBe(true);

    // and the rehearsal rolled back: the row is still there for the next read
    expect(await api.books.get({ orgId: ORG, id: "b1" }).run()).toEqual([
      { id: "b1", title: "Dune" },
    ]);
    await origin.stop();
  });

  /**
   * The other half of the rule: waiting on a span is only safe if a span always settles.
   *
   * A window can be closed — or refreshed — with a rehearsal open and `leave` never sent, and the
   * statements now waiting for it would wait for ever if nothing rolled it back. `abandon` is what
   * does, and this is the test that says so, because the wait above is what makes it load-bearing.
   */
  test("a rehearsal orphaned by a closing window does not wedge the next tab", async () => {
    const origin = await meshOrigin();
    const window = origin.tab();
    const first = meshApi({ ...window.mesh, self: await window.mesh.selfId() }, { books });
    expect(
      (await first.books.create({ orgId: ORG, id: "b2", title: "Persuasion" }).committed).isOk(),
    ).toBe(true);
    await settled();

    void first.books.removeForever.can({ orgId: ORG, id: "b2" }).run();
    await orphaned.inside;
    window.close(); // the window goes away mid-span

    const next = await apiTab(origin);
    const answered = await Promise.race([
      next.books.get({ orgId: ORG, id: "b2" }).run(),
      new Promise((resolve) => setTimeout(() => resolve("wedged"), 2000)),
    ]);
    expect(answered).toEqual([{ id: "b2", title: "Persuasion" }]);
    await origin.stop();
  }, 10_000);

  /**
   * The same rule for the span that is not orphaned but simply never finishes.
   *
   * `abandon` needs a tab to have gone; this one has not. Its body is waiting on something that
   * is not coming, and everything else on the handle is waiting on *it* — which is the state a
   * refresh storm was leaving behind: one `enter`, no `leave`, and a database that answered
   * nothing ever again. A dry run's transaction was always going to roll back, so the host ends
   * it rather than believing in it for ever.
   */
  test("a rehearsal that never settles is ended, and the reads behind it go through", async () => {
    const origin = await meshOrigin({ spanLimit: 150 });
    const api = await apiTab(origin);
    expect(
      (await api.books.create({ orgId: ORG, id: "b3", title: "Villette" }).committed).isOk(),
    ).toBe(true);
    await settled();

    void api.books.removeForever.can({ orgId: ORG, id: "b3" }).run();
    await orphaned.inside;

    const answered = await Promise.race([
      api.books.get({ orgId: ORG, id: "b3" }).run(),
      new Promise((resolve) => setTimeout(() => resolve("wedged"), 3000)),
    ]);
    expect(answered).toEqual([{ id: "b3", title: "Villette" }]);
    await origin.stop();
  }, 10_000);

  /**
   * The turn, taken back on behalf of whoever is waiting for it.
   *
   * This is the one a refresh actually produces, and the one `abandon` cannot answer: the tab is
   * gone but the host has not been told — `bye` is best effort and a `MessagePort` reports no
   * death of its own — so from here it is simply a client that stopped talking mid-statement while
   * holding the origin's only handle. The next tab is a *different* client and would queue behind
   * it for ever. Silence long enough to be evidence, read only when somebody is waiting, is what
   * turns that into a pause.
   */
  test("a tab that goes quiet holding the turn does not wedge the next one", async () => {
    const origin = await meshOrigin({ spanLimit: 150 });
    const first = await apiTab(origin);
    expect(
      (await first.books.create({ orgId: ORG, id: "b4", title: "Emma" }).committed).isOk(),
    ).toBe(true);
    await settled();

    // the holder never settles and never disconnects: its window is simply not there any more
    void first.books.removeSilently.can({ orgId: ORG, id: "b4" }).run();
    await silent.inside;

    const next = await apiTab(origin);
    const answered = await Promise.race([
      next.books.get({ orgId: ORG, id: "b4" }).run(),
      new Promise((resolve) => setTimeout(() => resolve("wedged"), 3000)),
    ]);
    expect(answered).toEqual([{ id: "b4", title: "Emma" }]);
    await origin.stop();
  }, 10_000);
});

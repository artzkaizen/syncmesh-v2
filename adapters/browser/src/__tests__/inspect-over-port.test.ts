/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- the fixture stands in for an inspector, whose payloads this adapter deliberately never parses */

import { describe, expect, test } from "bun:test";

import type { MeshInspector } from "../inspect.js";

import { ACME, book, meshOrigin, settled } from "./origin-mesh.js";

/**
 * The device's own feeds, from a window that holds none of them.
 *
 * The adapter carries an inspector's vocabulary without learning a word of it, so what is tested
 * here is the *carriage*: a named read reaches the thread with the engine, its answer comes back,
 * the two server-initiated feeds are refcounted like `fold` is, and a host that was handed no
 * inspector refuses the lot. What the names mean is `@syncmesh/devtools`' business and is tested
 * there.
 */
const spy = () => {
  const reads: { readonly name: string; readonly args: readonly unknown[] }[] = [];
  const watchers = new Set<(moved: unknown) => void>();
  const forced = new Set<(held: unknown) => void>();
  const inspector: MeshInspector = {
    read: (name, args) => {
      reads.push({ name, args });
      return Promise.resolve({ answered: name });
    },
    watch: (listener) => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    onForced: (listener) => {
      forced.add(listener);
      return () => void forced.delete(listener);
    },
  };
  return {
    inspector,
    reads,
    watching: () => watchers.size,
    holding: () => forced.size,
    moved: (channels: readonly string[]) => {
      for (const listener of watchers) listener(channels);
    },
    held: (mediums: readonly { readonly name: string }[]) => {
      for (const listener of forced) listener(mediums);
    },
  };
};

describe("the inspector across the port", () => {
  test("a named read reaches the thread with the engine and its answer comes back", async () => {
    const spied = spy();
    const { tab, stop } = await meshOrigin({ inspector: spied.inspector });
    const a = tab();
    expect(await a.mesh.inspect.read("open")).toEqual({ answered: "open" });
    expect(await a.mesh.inspect.read("snapshot", [["links"]])).toEqual({ answered: "snapshot" });
    expect(spied.reads).toEqual([
      { name: "open", args: [] },
      { name: "snapshot", args: [["links"]] },
    ]);
    await stop();
  });

  test("a host with no inspector refuses every read, and says which", async () => {
    const { tab, stop } = await meshOrigin();
    const refused = await tab()
      .mesh.inspect.read("open")
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect((refused as { readonly _tag?: string })._tag).toBe("NoInspector");
    expect((refused as { readonly read?: string }).read).toBe("open");
    await stop();
  });

  test("both feeds are one host subscription however many tabs watch, and none after they go", async () => {
    const spied = spy();
    const { host, tab, stop } = await meshOrigin({ inspector: spied.inspector });
    const a = tab();
    const b = tab();
    const seen: unknown[] = [];
    const offA = a.mesh.inspect.watch((moved) => seen.push(moved));
    const offB = b.mesh.inspect.watch((moved) => seen.push(moved));
    b.mesh.inspect.onForced((held) => seen.push(held));
    await settled();

    expect(spied.watching()).toBe(1);
    expect(spied.holding()).toBe(1);
    expect(host.census().inspecting).toBe(true);

    spied.moved(["fold"]);
    spied.held([{ name: "ble" }]);
    await settled();
    expect(seen).toEqual([["fold"], ["fold"], [{ name: "ble" }]]);

    offA();
    offB();
    await settled();
    expect(spied.watching()).toBe(0);
    expect(host.census().inspecting).toBe(false);
    await stop();
  });

  test("a tab that closes leaves no topic, no feed and no handle behind", async () => {
    const spied = spy();
    const { host, tab, stop } = await meshOrigin({ inspector: spied.inspector });
    const a = tab();
    a.mesh.inspect.watch(() => undefined);
    a.mesh.inspect.onForced(() => undefined);
    a.mesh.operations.onChange(() => undefined);
    a.mesh.on(ACME).unwrap();
    await settled();
    // five: the three this tab asked for, plus `grant` and `auth`, which `connectMesh` holds for
    // the life of the link — the first invalidates a cached answer as well as notifying, and the
    // second *is* a cache, because a handler reads the principal synchronously
    expect(host.census().topics).toBe(5);

    a.close();
    await settled();
    expect(host.census()).toEqual({
      clients: 0,
      topics: 0,
      feeds: 0,
      handles: 0,
      inspecting: false,
    });
    expect(spied.watching()).toBe(0);
    expect(spied.holding()).toBe(0);
    await stop();
  });
});

describe("the write ledger across the port", () => {
  test("a window reads the record of the write it just made, and every window hears about it", async () => {
    const { tab, stop } = await meshOrigin();
    const a = tab();
    const b = tab();
    let told = 0;
    b.mesh.operations.onChange(() => (told += 1));
    await settled();

    const handle = a.mesh.on(ACME).unwrap();
    const id = crypto.randomUUID();
    await handle.under({ id }, () =>
      handle.db.insert(book).values({ id: "b9", title: "Middlemarch" }),
    );
    await settled();

    const record = await a.mesh.operations.get(id);
    expect(record.isOk()).toBe(true);
    expect(record.unwrap()?.id).toBe(id);
    expect(told).toBeGreaterThan(0);
    await stop();
  });

  test("the procedure's name crosses the port, because the capture is on the other side", async () => {
    const { tab, stop } = await meshOrigin();
    const a = tab();
    const handle = a.mesh.on(ACME).unwrap();
    const id = crypto.randomUUID();
    // this is the split the label exists for: procedures run in the *window* and capture runs on
    // the *host*, so by the time a statement reaches the thread that records it, all that is left
    // is `INSERT INTO book …`. Without the name on this message the ledger says `book.insert` for
    // everything a person ever did.
    await handle.under({ id, label: "books.shelve" }, () =>
      handle.db.insert(book).values({ id: "b11", title: "Shirley" }),
    );
    await settled();

    const record = (await a.mesh.operations.get(id)).unwrap();
    expect(record?.label).toBe("books.shelve");
    await stop();
  });

  test("a write with no procedure above it still gets the name its statements earn", async () => {
    const { tab, stop } = await meshOrigin();
    const a = tab();
    const handle = a.mesh.on(ACME).unwrap();
    const id = crypto.randomUUID();
    // a seed, a migration, an adapter's own statement: nothing named it, so the derived label is
    // the honest answer rather than a blank or an invented one
    await handle.under({ id }, () => handle.db.insert(book).values({ id: "b12", title: "Emma" }));
    await settled();

    expect((await a.mesh.operations.get(id)).unwrap()?.label).toBe("book.insert");
    await stop();
  });

  test("a window sees its own unsettled writes, which is the ledger and not the log", async () => {
    const { tab, stop } = await meshOrigin();
    const a = tab();
    const handle = a.mesh.on(ACME).unwrap();
    await handle.under({ id: crypto.randomUUID() }, () =>
      handle.db.insert(book).values({ id: "b10", title: "Villette" }),
    );
    await settled();
    const waiting = await a.mesh.operations.unsettled();
    expect(waiting.isOk()).toBe(true);
    expect(waiting.unwrap().length).toBe(1);
    await stop();
  });
});

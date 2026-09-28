import type { Live } from "@syncmesh/drizzle";

import { createCollection } from "@tanstack/db";
import { describe, expect, test } from "bun:test";

import { syncmeshCollection } from "../index.js";

interface Product {
  readonly id: string;
  readonly name: string;
}

/** A live query under the test's control: the seam the adapter is written against. */
const liveOf = (initial: readonly Product[]) => {
  const listeners = new Set<(rows: readonly Product[]) => void>();
  let rows = initial;
  let released = 0;
  const live: Live<Product> = {
    data: () => rows,
    snapshot: () => ({
      answered: true,
      data: rows,
      state: new Map(rows.map((row) => [row.id, row])),
      diff: { added: new Map(), removed: new Map(), changed: new Map() },
      status: "success",
      error: undefined,
    }),
    ready: Promise.resolve(initial),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    release: () => void (released += 1),
  };
  return {
    live,
    released: () => released,
    push: (next: readonly Product[]) => {
      rows = next;
      for (const listener of listeners) listener(next);
    },
  };
};

const query = (source: ReturnType<typeof liveOf>, settled = Promise.resolve()) => ({
  "~mesh": {
    key: JSON.stringify(["products.list", null]),
    live: () => source.live,
    settled: () => settled,
  },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("syncmeshCollection — the mesh as a TanStack source (book ch. 11)", () => {
  test("rows arrive, changes are a diff, and a row that left is deleted", async () => {
    const source = liveOf([{ id: "p1", name: "Desk lamp" }]);
    const products = createCollection(
      syncmeshCollection<Product>(query(source), { startSync: true }),
    );
    await settle();
    // TanStack annotates each row with its own `$` metadata; the app's fields are what matter
    const appFields = (rows: Iterable<Product>) =>
      [...rows].map((p) => ({ id: p.id, name: p.name }));
    expect(appFields(products.values())).toEqual([{ id: "p1", name: "Desk lamp" }]);

    source.push([
      { id: "p1", name: "Desk lamp" },
      { id: "p2", name: "Chair" },
    ]);
    await settle();
    expect([...products.values()].map((p) => p.id).sort()).toEqual(["p1", "p2"]);

    source.push([{ id: "p2", name: "Chair" }]);
    await settle();
    expect(appFields(products.values())).toEqual([{ id: "p2", name: "Chair" }]);
  });

  test("readiness waits on coverage, not on the local store answering", async () => {
    let openTheRelay: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      openTheRelay = resolve;
    });
    const source = liveOf([]);
    const products = createCollection(
      syncmeshCollection<Product>(query(source, settled), { startSync: true }),
    );
    await settle();
    // the local store answered instantly — with nothing. Drawing "no products" here is the lie
    expect(products.status).not.toBe("ready");

    openTheRelay();
    await settle();
    expect(products.status).toBe("ready");
  });

  test("the identity is the query's own key, and cleanup releases the live query", async () => {
    const source = liveOf([{ id: "p1", name: "Desk lamp" }]);
    const config = syncmeshCollection<Product>(query(source), { startSync: true });
    expect(config.getKey({ id: "p1", name: "Desk lamp" })).toBe("p1");

    const products = createCollection(config);
    await settle();
    await products.cleanup();
    expect(source.released()).toBe(1); // the subscription is not left behind
  });
});

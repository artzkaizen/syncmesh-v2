import type { CellValue, ColumnName } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AnyColumn, ColumnDef } from "../column.js";

import { columnFromDef, strategyOf, t } from "../column.js";
import { fromWireRow } from "../convert.js";
import { defineSchema } from "../manifest.js";
import { checkRow, table, type InsertRow, type WireRow } from "../table.js";

const posts = table("posts", {
  id: t.text().primaryKey(),
  title: t.text(),
  likes: t.counter(),
  labels: t.set(t.text()),
});

/** A def that came from outside the builder — what `fromDrizzle` and any JavaScript caller can hand in. */
const forge = (base: ColumnDef, patch: Partial<ColumnDef>): AnyColumn =>
  columnFromDef({ ...base, ...patch });

const cells = (values: WireRow): WireRow => values;

describe("t.counter() and t.set() — the kind is the strategy", () => {
  test("a schema gives them their strategy without anyone declaring one", () => {
    const schema = defineSchema({ tables: { posts: { columns: posts.columns } } });
    expect(schema.merge.get(posts.name)).toEqual(
      new Map([
        [posts.columnNames.likes, "counter"],
        [posts.columnNames.labels, "set"],
      ]),
    );
  });

  test("strategyOf reads it off the kind, and off onConflict for everything else", () => {
    expect(strategyOf(t.counter().def)).toBe("counter");
    expect(strategyOf(t.set(t.text()).def)).toBe("set");
    expect(strategyOf(t.integer().onConflict("max").def)).toBe("max");
    expect(strategyOf(t.text().def)).toBeUndefined();
  });

  test("onConflict on one is a definition error, past the builder's types", () => {
    for (const kind of ["counter", "set"] as const) {
      const base = kind === "counter" ? t.counter().def : t.set(t.text()).def;
      expect(() =>
        table("posts", { id: t.text().primaryKey(), c: forge(base, { onConflict: "max" }) }),
      ).toThrow("the kind is the strategy");
    }
  });

  test("and so are a nullable one, a schema on one, and one as the key", () => {
    const id = t.text().primaryKey();
    const counter = t.counter().def;
    expect(() => table("posts", { id, c: forge(counter, { nullable: true }) })).toThrow(
      "never null",
    );
    expect(() => table("posts", { id, c: forge(counter, { check: z.number() }) })).toThrow(
      "merge state",
    );
    expect(() => table("posts", { c: forge(counter, { primaryKey: true }) })).toThrow(
      "must be text, uuid or integer",
    );
  });

  test("a set of a set is refused where it is written, not where it is folded", () => {
    expect(() => t.set(t.set(t.text()))).toThrow("already a cell CRDT");
    expect(() => t.set(t.counter())).toThrow("already a cell CRDT");
  });
});

describe("what an insert may say about a lattice column", () => {
  test("the type does not ask for one — there is no value the app could put there", () => {
    const row = { id: "p1", title: "hi" } satisfies InsertRow<typeof posts>;
    void (() => {
      // @ts-expect-error `title` is an ordinary column and is still required
      const missing = { id: "p1" } satisfies InsertRow<typeof posts>;
      // @ts-expect-error a counter is not set by assigning a total
      const assigned = { id: "p1", title: "hi", likes: 7 } satisfies InsertRow<typeof posts>;
      void [missing, assigned];
    });
    expect(row.title).toBe("hi");
  });

  test("it may say nothing: an absent cell is the empty counter and the empty set", () => {
    expect(checkRow(posts, cells({ id: "p1", title: "hi" }), "insert").isOk()).toBe(true);
  });

  test("what it may not say is a value: the cell holds merge state, never a total", () => {
    const bad = checkRow(posts, cells({ id: "p1", title: "hi", likes: 7 }), "insert");
    expect(bad.isErr()).toBe(true);
    expect(bad.isErr() && bad.error.message).toContain("expected counter");
    expect(checkRow(posts, cells({ id: "p1", title: "hi", likes: {} }), "insert").isOk()).toBe(
      true,
    );
  });

  test("a set's live elements are checked against the column it was declared over", () => {
    const ok = { t1: ["urgent"], t2: [] };
    const wrong = { t1: ["urgent"], t2: [42] };
    expect(checkRow(posts, cells({ labels: ok }), "update").isOk()).toBe(true);
    const bad = checkRow(posts, cells({ labels: wrong }), "update");
    expect(bad.isErr()).toBe(true);
    expect(bad.isErr() && bad.error.message).toContain("expected text");
  });
});

describe("what the app reads back", () => {
  test("a counter reads as its total and a set as its live elements, in id order", () => {
    const row = fromWireRow(
      posts,
      new Map<ColumnName, CellValue>([
        [posts.columnNames.id, "p1"],
        [posts.columnNames.title, "hi"],
        [posts.columnNames.likes, { a: { dec: 1, inc: 5 }, b: { dec: 0, inc: 2 } }],
        [posts.columnNames.labels, { t2: ["urgent"], t1: ["draft"], t3: [] }],
      ]),
    );
    expect<number>(row.likes).toBe(6);
    expect<readonly string[]>(row.labels).toEqual(["draft", "urgent"]);
  });

  test("an absent cell reads as zero and empty, so an older peer's row is not a hole", () => {
    const row = fromWireRow(posts, new Map<ColumnName, CellValue>([[posts.columnNames.id, "p1"]]));
    expect<number>(row.likes).toBe(0);
    expect<readonly string[]>(row.labels).toEqual([]);
  });
});

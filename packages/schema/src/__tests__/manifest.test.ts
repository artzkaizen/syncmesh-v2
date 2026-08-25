import { describe, expect, test } from "bun:test";

import { t } from "../column.js";
import { defineSchema } from "../manifest.js";
import { table } from "../table.js";

const imported = table("views", {
  id: t.uuid().primaryKey(),
  count: t.integer().onConflict("max"),
  label: t.text(),
});

const schema = defineSchema({
  partitions: {
    org: { isolation: "database" },
    shelf: { parent: "org" },
  },
  roles: { org: ["owner", "admin", "member"] },
  tables: {
    books: {
      columns: { id: t.uuid().primaryKey(), title: t.text(), rating: t.float().onConflict("max") },
      partition: "shelf",
    },
    notes: { columns: { id: t.uuid().primaryKey(), body: t.text() }, partition: "user" },
    drafts: { columns: { id: t.uuid().primaryKey(), body: t.text() }, partition: "local" },
    views: { table: imported, partition: "org" },
  },
});

describe("defineSchema", () => {
  test("builds a table per entry, keyed and named the same, in declaration order", () => {
    expect(Object.keys(schema.tables)).toEqual(["books", "notes", "drafts", "views"]);
    expect(String(schema.tables.books.name)).toBe("books");
    expect(schema.tables.books.primaryKey).toBe("id");
    expect(schema.tables.views).toBe(imported);
    expect(schema.entries.map((e) => [String(e.table.name), e.partition])).toEqual([
      ["books", "shelf"],
      ["notes", "user"],
      ["drafts", "local"],
      ["views", "org"],
    ]);
  });

  test("merge spec: column onConflict rules, lww omitted", () => {
    const books = schema.merge.get(schema.tables.books.name);
    expect(books && [...books]).toEqual([[schema.tables.books.columnNames.rating, "max"]]);
    const views = schema.merge.get(imported.name);
    expect(views && [...views]).toEqual([[imported.columnNames.count, "max"]]);
    expect(schema.merge.has(schema.tables.notes.name)).toBe(false);
  });

  test("rolesFor inherits down the partition chain; user and local have none", () => {
    expect(schema.rolesFor("org")).toEqual(["owner", "admin", "member"]);
    expect(schema.rolesFor("shelf")).toEqual(["owner", "admin", "member"]);
    expect(schema.rolesFor("user")).toEqual([]);
    expect(schema.rolesFor("local")).toEqual([]);
  });

  test("reserved tables are installed outside the app namespace", () => {
    expect(schema.reserved.map((r) => String(r.name))).toEqual(["_policy", "_corrections"]);
    expect("_policy" in schema.tables).toBe(false);
  });

  test("definition mistakes throw at module load", () => {
    const id = t.uuid().primaryKey();
    expect(() => defineSchema({ partitions: { a: { parent: "nope" } }, tables: {} })).toThrow(
      "unknown parent",
    );
    expect(() =>
      defineSchema({ partitions: { user: { isolation: "database" } }, tables: {} }),
    ).toThrow("reserved");
    expect(() => defineSchema({ partitions: {}, roles: { x: ["a"] }, tables: {} })).toThrow(
      "unknown partition",
    );
    const stray = { columns: { id }, partition: "nope" } as const;
    // @ts-expect-error the type already refuses an unknown partition; the runtime guard is for generated manifests
    expect(() => defineSchema({ partitions: {}, tables: { b: stray } })).toThrow(
      "unknown partition",
    );
    expect(() =>
      defineSchema({ partitions: {}, tables: { other: { table: imported, partition: "user" } } }),
    ).toThrow("is named");
  });
});

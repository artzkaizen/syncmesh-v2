import type { PolicyNode } from "@syncmesh/policy";

import { describe, expect, test } from "bun:test";

import { t } from "../column.js";
import { defineSchema } from "../manifest.js";

const id = () => t.uuid().primaryKey();
const none = ({ deny }: { readonly deny: PolicyNode }) => ({ $default: deny });

const schema = defineSchema({
  partitions: { org: { shelf: {} } },
  roles: { org: ["owner", "admin", "member"] },
  tables: {
    catalog: { columns: { id: id(), code: t.text() } },
    books: {
      columns: { id: id(), title: t.text(), rating: t.float().onConflict("max") },
      partition: "shelf",
      allow: none,
    },
    members: { columns: { id: id(), name: t.text() }, partition: "org", allow: none },
    notes: { columns: { id: id(), body: t.text() }, partition: "user" },
    drafts: { columns: { id: id(), body: t.text() }, partition: "local" },
    patient: { columns: { id: id(), name: t.text() }, visibility: "authority" },
  },
});

describe("defineSchema", () => {
  test("builds one table per entry, named by its key, in declaration order", () => {
    expect(Object.keys(schema.tables)).toEqual([
      "catalog",
      "books",
      "members",
      "notes",
      "drafts",
      "patient",
    ]);
    expect(String(schema.tables.books.name)).toBe("books");
    expect(schema.tables.books.primaryKey).toBe("id");
  });

  test("entries carry the partition — global by omission — and the visibility tier", () => {
    expect(schema.entries.map((e) => [String(e.table.name), e.partition, e.visibility])).toEqual([
      ["catalog", "global", "partition"],
      ["books", "shelf", "partition"],
      ["members", "org", "partition"],
      ["notes", "user", "partition"],
      ["drafts", "local", "partition"],
      ["patient", "global", "authority"],
    ]);
  });

  test("kinds come from the tree, parents first, with parentOf and inherited roles", () => {
    expect(schema.kinds).toEqual(["org", "shelf"]);
    expect(schema.parentOf("shelf")).toBe("org");
    expect(schema.parentOf("org")).toBeUndefined();
    expect(schema.rolesFor("shelf")).toEqual(["owner", "admin", "member"]);
    expect(schema.rolesFor("user")).toEqual([]);
  });

  test("merge spec is assembled from column rules; lww omitted", () => {
    const books = schema.merge.get(schema.tables.books.name);
    expect(books && [...books]).toEqual([[schema.tables.books.columnNames.rating, "max"]]);
    expect(schema.merge.has(schema.tables.notes.name)).toBe(false);
  });

  test("reserved tables are installed outside the app namespace; no partitions key is fine", () => {
    expect(schema.reserved.map((r) => String(r.name))).toEqual([
      "_policy",
      "_corrections",
      "_revocations",
      "_links",
    ]);
    const minimal = defineSchema({
      tables: { notes: { columns: { id: id() }, partition: "user" } },
    });
    expect(minimal.kinds).toEqual([]);
  });

  test("definition mistakes throw at module load", () => {
    expect(() => defineSchema({ partitions: { user: {} }, tables: {} })).toThrow("reserved");
    expect(() => defineSchema({ partitions: { org: { org: {} } }, tables: {} })).toThrow(
      "declared twice",
    );
    expect(() => defineSchema({ partitions: {}, roles: { x: ["a"] }, tables: {} })).toThrow(
      "unknown partition kind",
    );
    // SAFETY: deliberately a partition the type refuses, to exercise the runtime guard for generated manifests
    const stray = { columns: { id: id() }, partition: "nope", allow: none } as never;
    expect(() => defineSchema({ partitions: {}, tables: { b: stray } })).toThrow(
      "unknown partition kind",
    );
    // SAFETY: deliberately missing allow, which the type requires, to exercise the runtime guard
    const noAllow = { columns: { id: id() }, partition: "org" } as never;
    expect(() => defineSchema({ partitions: { org: {} }, tables: { b: noAllow } })).toThrow(
      "needs an allow rule",
    );
  });

  test("a declared kind requires allow; reserved kinds and authority tables refuse it", () => {
    const cols = { id: id() };
    // compile-time only: the runtime guards would panic on the first one, which is their own test above
    const rejected = () => {
      defineSchema({
        partitions: { org: {} },
        tables: {
          // @ts-expect-error allow is required for a declared kind
          a: { columns: cols, partition: "org" },
          // @ts-expect-error a misspelt kind
          b: { columns: cols, partition: "orgs", allow: none },
        },
      });
      defineSchema({
        tables: {
          // @ts-expect-error a user table takes no allow
          a: { columns: cols, partition: "user", allow: none },
          // @ts-expect-error an authority table has no partition
          b: { columns: cols, visibility: "authority", partition: "user" },
        },
      });
    };
    expect(rejected).toBeInstanceOf(Function);
  });
});

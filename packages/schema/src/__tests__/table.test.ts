import type { Temporal } from "@syncmesh/temporal";

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { columnFromDef, t, type AnyColumn } from "../column.js";
import { parseColumnName, parseTableName, reservedTableName } from "../names.js";
import { checkRow, rowKeyText, table, type InsertRow, type Row } from "../table.js";

const books = table("books", {
  id: t.uuid().primaryKey(),
  title: t.text(),
  addedAt: t.timestamp(),
  note: t.text().nullable(),
  starred: t.boolean(),
  pages: t.integer().onConflict("max"),
  meta: t.json(z.object({ tags: z.array(z.string()) })).nullable(),
});

const ID = "123e4567-e89b-42d3-a456-426614174000";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => undefined;

describe("table()", () => {
  test("a primary key must be a keyable kind — blob, json, float, boolean and timestamp are refused", () => {
    for (const bad of [t.blob(), t.json(), t.float(), t.boolean(), t.timestamp()]) {
      expect(() => table("things", { id: bad.primaryKey(), n: t.integer() })).toThrow(
        "must be text, uuid or integer",
      );
    }
    expect(() => table("things", { id: t.uuid().primaryKey() })).not.toThrow();
    expect(() => table("things", { id: t.integer().primaryKey() })).not.toThrow();
  });

  test("a nullable primary key def is refused even past the builder's types", () => {
    // the builder makes this unwritable; a def can still arrive from outside it (fromDrizzle)
    const forge = (patch: Partial<AnyColumn["def"]>): AnyColumn =>
      columnFromDef({ ...t.text().primaryKey().def, ...patch });
    expect(() => table("things", { id: forge({ nullable: true }) })).toThrow("cannot be nullable");
  });

  test("returns name, columns, the primary key and validated column names", () => {
    expect(String(books.name)).toBe("books");
    expect(books.primaryKey).toBe("id");
    expect(Object.keys(books.columnNames)).toEqual([
      "id",
      "title",
      "addedAt",
      "note",
      "starred",
      "pages",
      "meta",
    ]);
  });

  test("zero or two primary keys throw at definition time", () => {
    expect(() => table("a", { x: t.text() })).toThrow("exactly one primaryKey");
    expect(() => table("a", { x: t.text().primaryKey(), y: t.text().primaryKey() })).toThrow(
      "found 2",
    );
  });

  test("invalid or reserved names throw at definition time", () => {
    expect(() => table("_policy", { id: t.text().primaryKey() })).toThrow("reserved");
    expect(() => table("Books", { id: t.text().primaryKey() })).toThrow("lowercase");
    expect(() => table("books", { "bad-name": t.text().primaryKey() })).toThrow("column names");
    expect(() => table("books", { Bad: t.text().primaryKey() })).toThrow("column names");
    expect(parseColumnName("addedAt").isOk()).toBe(true);
  });

  test("max/min on a non-numeric column is refused at definition time (the kernel would panic later)", () => {
    // @ts-expect-error the type already forbids it; this checks the runtime guard for fromDrizzle-style input
    expect(() => table("a", { id: t.text().primaryKey().onConflict("max") })).toThrow("numeric");
  });

  test("names: parsers accept lowercase identifiers; reserved names start with `_`", () => {
    expect(parseTableName("notes").isOk()).toBe(true);
    expect(parseTableName("_policy").isErr()).toBe(true);
    expect(reservedTableName("_policy").isOk()).toBe(true);
    expect(reservedTableName("policy").isErr()).toBe(true);
    for (const bad of ["", "1x", "Ab", "a-b", "a b"])
      expect(parseColumnName(bad).isErr()).toBe(true);
  });
});

describe("Row / InsertRow", () => {
  test("row type is inferred; only nullable columns are optional on insert", () => {
    assertType<
      Equal<
        Row<typeof books>,
        {
          readonly id: string;
          readonly title: string;
          readonly addedAt: Temporal.Instant;
          readonly note: string | null;
          readonly starred: boolean;
          readonly pages: number;
          readonly meta: { tags: string[] } | null;
        }
      >
    >();
    // SAFETY: type-level test; the Instant is never used at runtime
    const instant = {} as never;
    const minimal: InsertRow<typeof books> = {
      id: ID,
      title: "t",
      addedAt: instant,
      starred: false,
      pages: 1,
    };
    const full: InsertRow<typeof books> = { ...minimal, note: null, meta: { tags: [] } };
    // @ts-expect-error title is required
    const missing: InsertRow<typeof books> = { id: ID, addedAt: instant, starred: false, pages: 1 };
    expect([minimal, full, missing]).toHaveLength(3);
  });
});

describe("checkRow", () => {
  test("insert: every column checked; omitted nullable columns pass; omitted required fails", () => {
    expect(
      checkRow(
        books,
        { id: ID, title: "t", addedAt: 1, starred: false, pages: 3 },
        "insert",
      ).isOk(),
    ).toBe(true);
    const r = checkRow(books, { id: ID, addedAt: 1, starred: false, pages: 3 }, "insert");
    expect(r.isErr() && r.error._tag === "ColumnCheckFailed" && r.error.column).toBe("title");
  });

  test("update: only present columns are checked; wrong kinds and unknown columns are values", () => {
    expect(checkRow(books, { title: "x" }, "update").isOk()).toBe(true);
    const wrong = checkRow(books, { pages: 1.5 }, "update");
    expect(
      wrong.isErr() && wrong.error._tag === "ColumnCheckFailed" && wrong.error.cause._tag,
    ).toBe("KindMismatch");
    const unknown = checkRow(books, { nope: 1 }, "update");
    expect(unknown.isErr() && unknown.error._tag).toBe("UnknownColumn");
  });

  test("schema-checked json is validated inside a row", () => {
    expect(checkRow(books, { meta: { tags: ["a"] } }, "update").isOk()).toBe(true);
    expect(checkRow(books, { meta: { tags: [1] } }, "update").isErr()).toBe(true);
    expect(checkRow(books, { meta: null }, "update").isOk()).toBe(true);
  });
});

describe("rowKeyText", () => {
  const books = table("books", { id: t.text().primaryKey(), n: t.integer().nullable() });
  const nums = table("nums", { id: t.integer().primaryKey() });

  test("a string key is itself; an integer key is its decimal text", () => {
    expect(rowKeyText(books, { id: "b1" }).unwrap()).toBe("b1");
    expect(rowKeyText(nums, { id: 42 }).unwrap()).toBe("42");
  });

  test("absence, null, json and bytes are errors, never keys", () => {
    for (const bad of [undefined, null, { a: 1 }, [1], Uint8Array.of(1), true]) {
      // SAFETY: deliberately wrong key values under test
      const r = rowKeyText(books, { id: bad as never });
      expect(r.isErr() && r.error._tag).toBe("ColumnCheckFailed");
    }
  });
});

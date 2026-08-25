import type { Temporal } from "@syncmesh/temporal";

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  blob,
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";

import { fromDrizzle, type DrizzleWarning } from "../from-drizzle.js";
import { defineSchema } from "../manifest.js";
import { checkRow, type Row } from "../table.js";

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => undefined;

const books = pgTable("books", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  pages: integer("pages"),
  big: bigint("big", { mode: "number" }).notNull(),
  rating: real("rating"),
  score: doublePrecision("score"),
  starred: boolean("starred").notNull().default(false),
  meta: jsonb("meta"),
  code: varchar("code", { length: 8 }).unique(),
  addedAt: timestamp("added_at").defaultNow(),
});

describe("fromDrizzle — the pinned mapping", () => {
  test("maps every supported Postgres column to its frozen kind and modifiers", () => {
    const warnings: DrizzleWarning[] = [];
    const table = fromDrizzle(books, { onWarn: (w) => warnings.push(w) });
    expect(String(table.name)).toBe("books");
    expect(table.primaryKey).toBe("id");
    const kinds = Object.fromEntries(
      Object.entries(table.columns).map(([k, c]) => [
        k,
        `${c.def.kind}${c.def.nullable ? "?" : ""}${c.def.hasDefault ? "=" : ""}`,
      ]),
    );
    expect(kinds).toEqual({
      id: "uuid",
      title: "text",
      pages: "integer?",
      big: "integer",
      rating: "float?",
      score: "float?",
      starred: "boolean=",
      meta: "json?",
      code: "text?",
      addedAt: "timestamp?",
    });
    expect(table.columns.starred.def.defaultValue).toBe(false);
    expect(table.columns.addedAt.def.hasDefault).toBe(false);
    expect(warnings.map((w) => `${w.column}: ${w.message.split(";")[0]}`)).toEqual([
      "code: unique() cannot be enforced across offline devices",
      "addedAt: Drizzle hands back a Date",
      "addedAt: the default is computed by the database",
    ]);
  });

  test("maps SQLite columns, including blob and boolean-mode integers", () => {
    const t = sqliteTable("t", {
      id: sqliteText("id").primaryKey(),
      n: sqliteInteger("n", { mode: "number" }),
      b: sqliteInteger("b", { mode: "boolean" }).notNull(),
      raw: blob("raw", { mode: "buffer" }),
      j: sqliteText("j", { mode: "json" }),
    });
    const table = fromDrizzle(t);
    expect(
      Object.fromEntries(Object.entries(table.columns).map(([k, c]) => [k, c.def.kind])),
    ).toEqual({ id: "text", n: "integer", b: "boolean", raw: "blob", j: "json" });
  });

  test("row types come from Drizzle's inference, with Date overridden to Temporal.Instant", () => {
    const table = fromDrizzle(books);
    assertType<Equal<Row<typeof table>["id"], string>>();
    assertType<Equal<Row<typeof table>["pages"], number | null>>();
    assertType<Equal<Row<typeof table>["big"], number>>();
    assertType<Equal<Row<typeof table>["addedAt"], Temporal.Instant | null>>();
    expect(true).toBe(true);
  });
});

describe("fromDrizzle — refusals at module load", () => {
  test("serial, unbounded numeric, generated, custom types, and a missing single primary key", () => {
    expect(() => fromDrizzle(pgTable("a", { id: serial("id").primaryKey() }))).toThrow(
      "serial has no value to sync",
    );
    expect(() =>
      fromDrizzle(pgTable("b", { id: uuid("id").primaryKey(), n: numeric("n") })),
    ).toThrow("unbounded numeric");
    expect(() =>
      fromDrizzle(
        pgTable("c", { id: uuid("id").primaryKey(), g: integer("g").generatedAlwaysAsIdentity() }),
      ),
    ).toThrow("generated");
    const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
    expect(() =>
      fromDrizzle(pgTable("d", { id: uuid("id").primaryKey(), raw: bytea("raw") })),
    ).toThrow("not in the frozen mapping");
    expect(() => fromDrizzle(pgTable("e", { a: text("a"), b: text("b") }))).toThrow(
      "exactly one primary-key column",
    );
    // SAFETY: deliberately not a Drizzle table, to exercise the runtime guard
    const notATable = {} as never;
    expect(() => fromDrizzle(notATable)).toThrow("not a Drizzle table");
  });

  test("a SQL default is a database default: warned, and the column stays required", () => {
    const warnings: DrizzleWarning[] = [];
    const t = pgTable("f", {
      id: uuid("id").primaryKey(),
      n: integer("n")
        .notNull()
        .default(sql`1`),
    });
    const table = fromDrizzle(t, { onWarn: (w) => warnings.push(w) });
    expect(table.columns.n.def.hasDefault).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe("fromDrizzle — end to end", () => {
  test("an imported table goes into a manifest and admits a row the mesh would accept", () => {
    const schema = defineSchema({
      partitions: { org: { isolation: "database" } },
      tables: {
        books: { table: fromDrizzle(books, { onConflict: { rating: "max" } }), partition: "org" },
        plain: {
          table: pgTable("plain", { id: uuid("id").primaryKey(), n: integer("n") }),
          partition: "org",
        },
      },
    });
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(checkRow(schema.tables.books, { id, title: "t", big: 1 }, "insert").isOk()).toBe(true);
    expect(checkRow(schema.tables.books, { id, title: "t", big: 1.5 }, "insert").isErr()).toBe(
      true,
    );
    expect(schema.merge.get(schema.tables.books.name)?.size).toBe(1);
    expect(String(schema.tables.plain.name)).toBe("plain");
    assertType<Equal<Row<typeof schema.tables.plain>["n"], number | null>>();
  });

  test("onConflict is typed against the imported columns", () => {
    fromDrizzle(books, { onConflict: { pages: "min" } });
    // @ts-expect-error rating exists but max on text does not
    fromDrizzle(books, { onConflict: { title: "max" } });
    // @ts-expect-error not a column
    fromDrizzle(books, { onConflict: { norma: "min" } });
    // SAFETY: deliberately an unknown column, to exercise the runtime guard behind the type
    const unknownColumn = { nope: "max" } as never;
    expect(() => fromDrizzle(books, { onConflict: unknownColumn })).toThrow("does not have");
  });
});

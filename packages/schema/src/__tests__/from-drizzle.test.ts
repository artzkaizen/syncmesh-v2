import type { Temporal } from "@syncmesh/temporal";

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
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

import {
  drizzleTable,
  fromDrizzle,
  type ColumnsFromDrizzle,
  type DrizzleWarning,
} from "../from-drizzle.js";
import { syncSchema } from "../manifest.js";
import { global, ladder, partition } from "../partition.js";
import { checkRow, table, type Row } from "../table.js";

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

const workspace = partition("workspace", { roles: ladder("owner", "admin", "member", "guest") });
const embargo = partition("embargo", { sealed: true, roles: workspace.roles });
const ward = partition("ward", { roles: ladder("consultant", "nurse") });
const archive = partition("archive");

describe("fromDrizzle — the pinned mapping", () => {
  test("maps every supported Postgres column to its frozen kind and modifiers", () => {
    const warnings: DrizzleWarning[] = [];
    const columns = fromDrizzle(books, { onWarn: (w) => warnings.push(w) });
    expect(table("books", columns).primaryKey).toBe("id");
    const kinds = Object.fromEntries(
      Object.entries(columns).map(([k, c]) => [k, `${c.def.kind}${c.def.nullable ? "?" : ""}`]),
    );
    expect(kinds).toEqual({
      id: "uuid",
      title: "text",
      pages: "integer?",
      big: "integer",
      rating: "float?",
      score: "float?",
      starred: "boolean",
      meta: "json?",
      code: "text?",
      addedAt: "timestamp?",
    });
    expect(table("books", columns).primaryKey).toBe("id");
    expect(warnings.map((w) => `${w.column}: ${w.message.split(";")[0]}`)).toEqual([
      "starred: defaults do not sync: every peer must see the inserted value, so the column is required",
      "code: unique() cannot be enforced across offline devices",
      "addedAt: Drizzle hands back a Date",
      "addedAt: defaults do not sync: an omitted column reads as null, never the default",
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
    const columns = fromDrizzle(t);
    expect(Object.fromEntries(Object.entries(columns).map(([k, c]) => [k, c.def.kind]))).toEqual({
      id: "text",
      n: "integer",
      b: "boolean",
      raw: "blob",
      j: "json",
    });
  });

  test("Drizzle 1.0's own bytea is a blob; a mode-less SQLite blob() is JSON, as Drizzle now reads it", () => {
    const bytes = fromDrizzle(pgTable("bytes", { id: uuid("id").primaryKey(), raw: bytea("raw") }));
    expect(bytes.raw.def.kind).toBe("blob");
    // 1.0 flipped blob()'s default mode from buffer to json; the mapping follows Drizzle's value
    const t = sqliteTable("modeless", { id: sqliteText("id").primaryKey(), raw: blob("raw") });
    expect(fromDrizzle(t).raw.def.kind).toBe("json");
  });

  test("a SQLite key is typed exactly; pg-core 1.0 does not type its key, so any non-null column may be", () => {
    const notes = sqliteTable("notes", {
      id: sqliteText("id").primaryKey(),
      body: sqliteText("body").notNull(),
    });
    assertType<
      Equal<ReturnType<typeof table<ColumnsFromDrizzle<typeof notes>>>["primaryKey"], "id">
    >();
    assertType<
      Equal<
        ReturnType<typeof table<ColumnsFromDrizzle<typeof books>>>["primaryKey"],
        "id" | "title" | "big" | "starred"
      >
    >();
    expect(table("books", fromDrizzle(books)).primaryKey).toBe("id");
  });

  test("row types come from Drizzle's inference, with Date overridden to Temporal.Instant", () => {
    const imported = table("books", fromDrizzle(books));
    assertType<Equal<Row<typeof imported>["id"], string>>();
    assertType<Equal<Row<typeof imported>["pages"], number | null>>();
    assertType<Equal<Row<typeof imported>["big"], number>>();
    assertType<Equal<Row<typeof imported>["addedAt"], Temporal.Instant | null>>();
    expect(true).toBe(true);
  });
});

describe("fromDrizzle — refusals at module load", () => {
  test("serial, unbounded numeric, generated, custom types, arrays, and a missing single primary key", () => {
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
    const custom = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });
    expect(() =>
      fromDrizzle(pgTable("d", { id: uuid("id").primaryKey(), raw: custom("raw") })),
    ).toThrow("not in the frozen mapping");
    // 1.0 reports an int[] as an integer with dimensions; it must not import as one
    expect(() =>
      fromDrizzle(pgTable("g", { id: uuid("id").primaryKey(), tags: integer("tags").array() })),
    ).toThrow("array (PgInteger[]) is not in the frozen mapping");
    expect(() => fromDrizzle(pgTable("e", { a: text("a"), b: text("b") }))).toThrow(
      "exactly one primary-key column",
    );
    // SAFETY: deliberately not a Drizzle table, to exercise the runtime guard
    const notATable = {} as never;
    expect(() => fromDrizzle(notATable)).toThrow("not a Drizzle table");
  });

  test("any default — SQL or literal — is warned and never carried; the column stays required", () => {
    const warnings: DrizzleWarning[] = [];
    const t = pgTable("f", {
      id: uuid("id").primaryKey(),
      n: integer("n")
        .notNull()
        .default(sql`1`),
    });
    fromDrizzle(t, { onWarn: (w) => warnings.push(w) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("defaults do not sync");
  });
});

describe("fromDrizzle — end to end", () => {
  test("an imported table goes into a manifest and admits a row the mesh would accept", () => {
    const org = partition("org");
    const schema = syncSchema({
      tables: {
        books: {
          columns: fromDrizzle(books, { merge: { rating: "max" } }),
          partition: org,
          allow: ({ deny }) => ({ $default: deny }),
        },
        plain: {
          columns: fromDrizzle(pgTable("plain", { id: uuid("id").primaryKey(), n: integer("n") })),
          partition: org,
          allow: ({ deny }) => ({ $default: deny }),
        },
      },
    });
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      checkRow(schema.tables.books, { id, title: "t", big: 1, starred: false }, "insert").isOk(),
    ).toBe(true);
    expect(checkRow(schema.tables.books, { id, title: "t", big: 1.5 }, "insert").isErr()).toBe(
      true,
    );
    expect(schema.merge.get(schema.tables.books.name)?.size).toBe(1);
    expect(String(schema.tables.plain.name)).toBe("plain");
    expect(() => syncSchema({ tables: { other: { columns: fromDrizzle(books) } } })).toThrow(
      'come from the Drizzle table "books"',
    );
    assertType<Equal<Row<typeof schema.tables.plain>["n"], number | null>>();
  });

  test("merge is typed against the imported columns", () => {
    fromDrizzle(books, { merge: { pages: "min" } });
    // @ts-expect-error rating exists but max on text does not
    fromDrizzle(books, { merge: { title: "max" } });
    // @ts-expect-error not a column
    expect(() => fromDrizzle(books, { merge: { norma: "min" } })).toThrow("does not have");
    // SAFETY: deliberately an unknown column, to exercise the runtime guard behind the type
    const unknownColumn = { nope: "max" } as never;
    expect(() => fromDrizzle(books, { merge: unknownColumn })).toThrow("does not have");
  });
});

describe("drizzleTable — role() is typed against the referenced kind", () => {
  test("a role from the kind's own ladder compiles and builds the rule the spread form built", () => {
    const spread = syncSchema({
      tables: {
        books: {
          ...drizzleTable(books),
          partition: workspace,
          allow: ({ role }) => ({ read: role("admin"), $default: role("owner") }),
        },
      },
    });
    const called = syncSchema({
      tables: {
        books: drizzleTable(books, {
          partition: workspace,
          merge: { rating: "max" },
          allow: ({ role }) => ({ read: role("admin"), $default: role("owner") }),
        }),
      },
    });
    expect(called.entries[0]?.allow).toEqual({
      read: { kind: "role", role: "admin" },
      $default: { kind: "role", role: "owner" },
    });
    expect(called.entries[0]?.allow).toEqual(spread.entries[0]?.allow);
    expect(called.kinds).toEqual(["workspace"]);
    expect(called.merge.get(called.tables.books.name)?.size).toBe(1);
    expect(called.rolesFor("workspace")).toBe(workspace.roles);
  });

  test("a role the kind does not have is a compile error", () => {
    const other = drizzleTable(books, {
      partition: ward,
      // @ts-expect-error a role from a different kind
      allow: ({ deny, role }) => ({ $default: deny, read: role("guest") }),
    });
    const none = drizzleTable(books, {
      partition: archive,
      // @ts-expect-error a kind with no roles has no role() to call
      allow: ({ deny, role }) => ({ $default: deny, read: role("anything") }),
    });
    const typo = drizzleTable(books, {
      partition: workspace,
      // @ts-expect-error not a role in the manifest
      allow: ({ deny, role }) => ({ $default: deny, read: role("nope") }),
    });
    expect(other).toHaveProperty("partition", ward);
    expect(none).toHaveProperty("partition", archive);
    expect(typo).toHaveProperty("partition", workspace);
  });

  test("roles: other.roles shares the union, so embargo may name a workspace role", () => {
    const schema = syncSchema({
      tables: {
        books: drizzleTable(books, {
          partition: embargo,
          allow: ({ owner, role }) => ({ read: role("guest"), $default: owner("id") }),
        }),
      },
    });
    expect(schema.entries[0]?.allow?.read).toEqual({ kind: "role", role: "guest" });
    expect(schema.rolesFor("embargo")).toBe(workspace.roles);
    expect(schema.sealedKinds.has("embargo")).toBe(true);
  });

  test("a reserved kind takes no allow; a declared kind requires one", () => {
    const schema = syncSchema({ tables: { books: drizzleTable(books, { partition: global }) } });
    expect(schema.entries[0]?.partition).toBe("global");
    expect(schema.entries[0]?.allow).toBeUndefined();
    // @ts-expect-error a table in a declared kind needs an allow rule
    const bare = drizzleTable(books, { partition: workspace });
    expect(bare).toHaveProperty("columns");
    expect(() =>
      syncSchema({
        tables: {
          books: drizzleTable(books, {
            partition: global,
            allow: ({ deny }) => ({ $default: deny }),
          }),
        },
      }),
    ).toThrow("takes no allow rule");
  });
});

import type { PolicyNode } from "@syncmesh/policy";

import { describe, expect, test } from "bun:test";
import { bytea, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { blob, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { Columns } from "../table.js";

import { columnFromDef, t } from "../column.js";
import {
  DocColumnConstraint,
  DocColumnNotBinary,
  InvalidDerive,
  MergeKindMismatch,
  from,
  type DeriveBlock,
  type Derivation,
  type DocumentAdapter,
} from "../documents.js";
import { fromDrizzle } from "../from-drizzle.js";
import { defineSchema } from "../manifest.js";
import { table } from "../table.js";
import { assertType, type Equal } from "./fixtures.js";

/** The shape `@syncmesh/loro` exports; the schema reads only its id. */
interface FakeDoc {
  readonly text: string;
}
const loro: DocumentAdapter<FakeDoc> = { id: "loro@1" };

const notes = pgTable("notes", {
  id: uuid().primaryKey(),
  title: text().notNull().default(""),
  content: bytea(),
  wordCount: integer().notNull().default(0),
});

const deny = ({ deny: no }: { readonly deny: PolicyNode }) => ({ $default: no });
const oneTable = (columns: Columns, derive: DeriveBlock<Columns> = {}) =>
  defineSchema({ tables: { notes: { columns, derive } } });
// SAFETY: a merge value past the types, to exercise the runtime backstop behind them
const cast = <T>(value: T) => value as never;

describe("declaring a document column", () => {
  test("merge: adapter on a byte column sets doc, not a strategy — Postgres, SQLite and t.blob", () => {
    const pg = fromDrizzle(notes, { merge: { title: "lww", content: loro } });
    expect(pg.content.def.doc).toEqual({ adapter: "loro@1" });
    expect(pg.content.def.merge).toBeUndefined();
    expect(pg.content.def.kind).toBe("blob");
    const lite = sqliteTable("notes", {
      id: sqliteText().primaryKey(),
      content: blob({ mode: "buffer" }),
    });
    expect(fromDrizzle(lite, { merge: { content: loro } }).content.def.doc?.adapter).toBe("loro@1");
    expect(t.blob({ merge: loro }).def.doc).toEqual({ adapter: "loro@1" });
  });

  test("MergeFor admits an adapter on byte columns only", () => {
    t.blob({ merge: loro });
    t.blob({ merge: "lww" });
    fromDrizzle(notes, { merge: { content: loro } });
    // @ts-expect-error text is not bytes
    t.text({ merge: loro });
    // @ts-expect-error nor is json
    t.json({ merge: loro });
    // @ts-expect-error nor a number
    t.integer({ merge: loro });
    // @ts-expect-error a Drizzle text column
    expect(() => table("notes", fromDrizzle(notes, { merge: { title: loro } }))).toThrow();
    const modeless = sqliteTable("m", { id: sqliteText().primaryKey(), content: blob() });
    // @ts-expect-error Drizzle 1.0 reads a mode-less blob() as JSON
    expect(() => table("m", fromDrizzle(modeless, { merge: { content: loro } }))).toThrow();
    // @ts-expect-error max still needs a number
    t.blob({ merge: "max" });
  });

  test("the fold's merge map never names a document column", () => {
    const schema = oneTable(fromDrizzle(notes, { merge: { content: loro } }));
    expect(schema.merge.size).toBe(0);
  });
});

describe("the manifest's shareable half", () => {
  const schema = defineSchema({
    partitions: { workspace: {} },
    roles: { workspace: ["editor"] },
    tables: {
      notes: {
        columns: fromDrizzle(notes, { merge: { content: loro } }),
        partition: "workspace",
        derive: {
          title: from("content", (d: FakeDoc) => d.text.split("\n")[0] ?? ""),
          wordCount: from("content", (d: FakeDoc) => d.text.split(/\s+/).length),
        },
        allow: deny,
      },
      plain: { columns: { id: t.uuid().primaryKey(), body: t.text() } },
    },
  });

  test("carries { column, doc, derive } per document column, as plain data", () => {
    const entries = schema.docs.get(schema.tables.notes.name);
    const shared: unknown = JSON.parse(JSON.stringify(entries));
    expect(shared).toEqual([{ column: "content", doc: "loro@1", derive: ["title", "wordCount"] }]);
    expect(shared).toEqual(entries);
    expect(schema.docs.has(schema.tables.plain.name)).toBe(false);
  });

  test("the derive functions stay on the entry, beside the rules", () => {
    const derive = schema.entries[0]?.derive;
    expect(Object.keys(derive ?? {})).toEqual(["title", "wordCount"]);
    expect(derive?.title?.from).toBe("content");
    // SAFETY: the materialiser hands the adapter's own document to the function it declared for
    const run = derive?.title?.derive as ((doc: FakeDoc) => string) | undefined;
    expect(run?.({ text: "Q3 plan\nbody" })).toBe("Q3 plan");
    expect(schema.entries[1]?.derive).toBeUndefined();
  });

  test("from() keeps the source name and the value type", () => {
    const d = from("content", (doc: FakeDoc) => doc.text.length);
    assertType<Equal<typeof d, Derivation<"content", number>>>();
    expect(d.from).toBe("content");
  });
});

describe("construction refuses — RFC-0023 §4.1's error table", () => {
  test("DocColumnNotBinary: text, json, and SQLite blob() without a mode", () => {
    const pgText = pgTable("notes", { id: uuid().primaryKey(), content: text() });
    expect(() => table("notes", fromDrizzle(pgText, { merge: { content: cast(loro) } }))).toThrow(
      DocColumnNotBinary,
    );
    const pgJson = pgTable("notes", { id: uuid().primaryKey(), content: jsonb() });
    expect(() => table("notes", fromDrizzle(pgJson, { merge: { content: cast(loro) } }))).toThrow(
      'use bytea() / blob({ mode: "buffer" })',
    );
    const modeless = sqliteTable("notes", { id: sqliteText().primaryKey(), content: blob() });
    expect(() => table("notes", fromDrizzle(modeless, { merge: { content: cast(loro) } }))).toThrow(
      DocColumnNotBinary,
    );
    expect(() =>
      table("notes", { id: t.uuid().primaryKey(), content: t.text({ merge: cast(loro) }) }),
    ).toThrow("notes.content: a document column holds bytes, not text");
  });

  test("DocColumnConstraint: the primary key, a unique() column, a check()", () => {
    expect(() => table("notes", { id: t.blob({ merge: loro }).primaryKey() })).toThrow(
      DocColumnConstraint,
    );
    const unique = pgTable("notes", { id: uuid().primaryKey(), content: bytea().unique() });
    expect(() => table("notes", fromDrizzle(unique, { merge: { content: loro } }))).toThrow(
      "notes.content: a document column cannot be a unique()",
    );
    const checked = t.blob({ merge: loro }).check(z.instanceof(Uint8Array));
    expect(() => table("notes", { id: t.uuid().primaryKey(), content: checked })).toThrow(
      "cannot be a check()",
    );
  });

  test("MergeKindMismatch: max/min on a document column, an adapter on a non-document kind", () => {
    const both = columnFromDef({
      kind: "blob",
      nullable: true,
      primaryKey: false,
      unique: false,
      merge: "max",
      doc: { adapter: "loro@1" },
    });
    expect(() => table("notes", { id: t.uuid().primaryKey(), content: both })).toThrow(
      MergeKindMismatch,
    );
    expect(() =>
      table("notes", { id: t.uuid().primaryKey(), n: t.integer({ merge: cast(loro) }) }),
    ).toThrow("notes.n: a document adapter needs a byte column, not integer");
    expect(() =>
      table("notes", { id: t.uuid().primaryKey(), c: t.blob({ merge: cast({ id: "loro" }) }) }),
    ).toThrow("neither a rule nor a document adapter");
    // D25's backstop is the same error now
    expect(() =>
      table("notes", { id: t.uuid().primaryKey(), s: t.text({ merge: cast("max") }) }),
    ).toThrow(MergeKindMismatch);
  });

  const columns = fromDrizzle(notes, { merge: { content: loro } });
  const body = (d: FakeDoc) => d.text;

  test("InvalidDerive: a target that is the key, a document, missing, or merged by the app", () => {
    expect(() => oneTable(columns, { id: from("content", body) })).toThrow(
      "notes.id: derive cannot target the primary key",
    );
    expect(() => oneTable(columns, { content: from("content", body) })).toThrow(InvalidDerive);
    expect(() => oneTable(columns, { nope: from("content", body) })).toThrow(
      "names a column the table does not have",
    );
    const merged = fromDrizzle(notes, { merge: { content: loro, wordCount: "max" } });
    expect(() => oneTable(merged, { wordCount: from("content", body) })).toThrow(
      'targets a column the app writes under merge "max"',
    );
  });

  test("InvalidDerive: a source that is not a document column of the same table", () => {
    expect(() => oneTable(columns, { wordCount: from("title", body) })).toThrow(
      'reads "title", which is not a document column of notes',
    );
    expect(() => oneTable(columns, { wordCount: from("elsewhere", body) })).toThrow(InvalidDerive);
  });
});

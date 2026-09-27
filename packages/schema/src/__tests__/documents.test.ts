import { describe, expect, test } from "bun:test";
import { bytea, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { blob, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import type { Columns } from "../table.js";

import { columnFromDef, t } from "../column.js";
import {
  DocColumnConstraint,
  DocColumnNotBinary,
  MergeKindMismatch,
  type DocumentAdapter,
} from "../documents.js";
import { fromDrizzle } from "../from-drizzle.js";
import { defineSchema } from "../manifest.js";
import { table } from "../table.js";

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

const oneTable = (columns: Columns) => defineSchema({ tables: { notes: { columns } } });
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
});

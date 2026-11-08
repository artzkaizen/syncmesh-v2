import type { CellValue, ColumnName } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { bytea, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { createDerivers } from "../derive.js";
import { InvalidDerive, from, type DeriveBlock, type DocumentAdapter } from "../documents.js";
import { drizzleTable, type ColumnsFromDrizzle } from "../from-drizzle.js";
import { syncSchema } from "../manifest.js";
import { ladder, partition } from "../partition.js";
import { checkRow } from "../table.js";

/** The shape `@syncmesh/loro` hands a derive function; the schema reads only the adapter's id. */
interface FakeDoc {
  readonly title: string;
  readonly body: string;
}
const loro: DocumentAdapter<FakeDoc> = { id: "loro@1" };

const notes = pgTable("notes", {
  id: uuid().primaryKey(),
  title: text().notNull().default(""),
  wordCount: integer(),
  editedAt: timestamp(),
  content: bytea(),
});

type NotesDerive = DeriveBlock<ColumnsFromDrizzle<typeof notes>>;

const workspace = partition("workspace", { roles: ladder("editor") });
const schema = syncSchema({
  tables: {
    notes: drizzleTable(notes, {
      partition: workspace,
      merge: { content: loro },
      derive: {
        title: from("content", (d: FakeDoc) => d.title),
        wordCount: from("content", (d: FakeDoc) => d.body.split(" ").length),
        editedAt: from("content", () => Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000)),
      },
      allow: ({ role }) => ({ $default: role("editor") }),
    }),
  },
});
const table = schema.tables.notes;
const { title, wordCount, editedAt, content, id } = table.columnNames;

describe("drizzleTable(t, { merge, derive }) — RFC-0023 §4.1", () => {
  test("the manifest carries { column, doc, derive } and the table marks each derived column", () => {
    const entries: unknown = JSON.parse(JSON.stringify(schema.docs.get(table.name)));
    expect(entries).toEqual([
      { column: "content", doc: "loro@1", derive: ["title", "wordCount", "editedAt"] },
    ]);
    expect(table.columns.title.def.derived).toEqual({ from: "content" });
    expect(table.columns.id.def.derived).toBeUndefined();
    expect(schema.entries[0]?.derive?.title?.from).toBe("content");
  });

  test("an insert need not name a derived column, even one the table declares not null", () => {
    expect(checkRow(table, { id: "0b6f4f86-1d3c-4f5e-9a3b-2a5e2c1d0e9f" }, "insert").isOk()).toBe(
      true,
    );
  });

  const build = (derive: NotesDerive) =>
    syncSchema({
      tables: {
        notes: drizzleTable(notes, {
          partition: workspace,
          merge: { content: loro, wordCount: "max" },
          derive,
          allow: ({ role }) => ({ $default: role("editor") }),
        }),
      },
    });

  test("its mistakes are refused at construction, with the table's name", () => {
    expect(() => build({ id: from("content", () => "x") })).toThrow(InvalidDerive);
    expect(() => build({ wordCount: from("content", () => 1) })).toThrow(
      'notes.wordCount: derive targets a column the app writes under merge "max"',
    );
    expect(() => build({ title: from("title", () => "x") })).toThrow(
      'reads "title", which is not a document column of notes',
    );
  });

  test("derive keys are typed against the table's columns", () => {
    const block: NotesDerive = {
      title: from("content", () => "x"),
      // @ts-expect-error notes has no column `subtitle`
      subtitle: from("content", () => "x"),
    };
    expect(() => build(block)).toThrow(
      "notes.subtitle: derive names a column the table does not have",
    );
  });
});

describe("createDerivers — what a replica runs, and what a host checks", () => {
  const deriver = createDerivers(schema).get(table.name)?.get(content);

  test("computes every derived column in wire form", () => {
    const values = deriver?.compute({ title: "Q3", body: "one two three" } satisfies FakeDoc);
    expect(values?.unwrap()).toEqual(
      new Map<ColumnName, CellValue>([
        [title, "Q3"],
        [wordCount, 3],
        [editedAt, 1_700_000_000_000],
      ]),
    );
    expect(deriver?.columns).toEqual([title, wordCount, editedAt]);
  });

  test("a function that throws, or returns what its column cannot hold, is DeriveFailed", () => {
    const failing = syncSchema({
      tables: {
        notes: drizzleTable(notes, {
          partition: workspace,
          merge: { content: loro },
          derive: {
            title: from("content", (d: FakeDoc) => (d.title === "" ? undefined : d.title)),
            wordCount: from("content", (d: FakeDoc): number => {
              if (d.body === "") throw new Error("empty");
              return d.body.length;
            }),
          },
          allow: ({ role }) => ({ $default: role("editor") }),
        }),
      },
    });
    const run = createDerivers(failing).get(table.name)?.get(content);
    const thrown = run?.compute({ title: "t", body: "" });
    expect(thrown?.isErr() && thrown.error.message).toBe(
      "notes.wordCount: the derive function threw",
    );
    const missing = run?.compute({ title: "", body: "b" });
    expect(missing?.isErr() && missing.error._tag).toBe("DeriveFailed");
  });

  test("check takes values from elsewhere only for the derive list, and only of the column's kind", () => {
    const ok = new Map<ColumnName, CellValue>([[title, "from a device"]]);
    expect(deriver?.check(ok).unwrap()).toEqual(ok);
    const stray = deriver?.check(new Map<ColumnName, CellValue>([[id, "x"]]));
    expect(stray?.isErr() && stray.error.message).toBe("notes.id: not derived from content");
    const kind = deriver?.check(new Map<ColumnName, CellValue>([[wordCount, "many"]]));
    expect(kind?.isErr() && kind.error._tag).toBe("DeriveFailed");
  });

  test("a schema with no derive has no derivers", () => {
    const plain = syncSchema({
      tables: {
        notes: drizzleTable(notes, {
          partition: workspace,
          merge: { content: loro },
          allow: ({ role }) => ({ $default: role("editor") }),
        }),
      },
    });
    expect(createDerivers(plain).size).toBe(0);
  });
});

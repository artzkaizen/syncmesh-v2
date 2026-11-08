import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { t } from "../column.js";
import { syncSchema } from "../manifest.js";
import { flat, partition } from "../partition.js";
import { portableSchema } from "../portable.js";

const team = partition("team", { roles: flat("lead", "ops") });

const schema = syncSchema({
  dropped: ["memos"],
  tables: {
    shifts: {
      columns: {
        id: t.text().primaryKey(),
        hours: t.integer().check(z.number().int().min(0)),
        legacy: t.text().nullable().retired(),
        code: t.text().check(z.custom<string>(() => true)),
      },
      partition: team,
      allow: ({ role, any, owner }) => ({
        $default: role("lead"),
        replace: any(role("lead"), owner("id")),
      }),
    },
    settings: { columns: { id: t.text().primaryKey(), value: t.text() } },
  },
});

describe("the manifest as a port reads it (gap U3)", () => {
  const portable = portableSchema(schema);

  test("a table's rules travel as the data `allow` returned, replace included", () => {
    expect(portable.tables["shifts"]?.allow).toEqual({
      $default: { kind: "role", role: "lead" },
      replace: {
        kind: "any",
        of: [
          { kind: "role", role: "lead" },
          { kind: "owner", column: "id" },
        ],
      },
    });
    // a reserved kind's rule is what it is: no block to carry
    expect(portable.tables["settings"]?.allow).toBeUndefined();
    expect(portable.tables["settings"]?.partition).toBe("global");
  });

  test("a check travels as JSON Schema where it can say itself as one, and as a flag where not", () => {
    const columns = portable.tables["shifts"]?.columns;
    expect(columns?.["hours"]).toEqual({
      kind: "integer",
      nullable: false,
      primaryKey: false,
      unique: false,
      check: true,
      checkSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "integer",
        minimum: 0,
        maximum: 9007199254740991,
      },
    });
    // `z.custom` has no JSON Schema: the column says a check guards it, and a port knows it cannot run it
    expect(columns?.["code"]).toEqual({
      kind: "text",
      nullable: false,
      primaryKey: false,
      unique: false,
      check: true,
    });
  });

  test("a column says what shipped, and the roles say whether they are a ladder", () => {
    const columns = portable.tables["shifts"]?.columns;
    expect(columns?.["legacy"]?.retired).toBe(true);
    expect(portable.roles).toEqual({ team: { names: ["lead", "ops"], ordered: false } });
    expect(portable.dropped).toEqual(["memos"]);
  });

  test("the manifest's own tables travel too, so a port judges them by the same columns", () => {
    expect(Object.keys(portable.reserved)).toEqual([
      "_policy",
      "_corrections",
      "_revocations",
      "_links",
      "_cdc",
    ]);
    expect(portable.reserved["_policy"]?.columns["grace"]?.nullable).toBe(true);
    // JSON is the format: what is written reads back as itself
    expect(JSON.parse(JSON.stringify(portable))).toEqual(portable);
  });
});

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

  test("a check a port runs is never stricter than the function it says", () => {
    const DOT = "[^\\n\\r\u2028\u2029]";
    const SPACE = "\\t\\n\\v\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const loose = syncSchema({
      tables: {
        loose: {
          columns: {
            id: t.text().primaryKey(),
            folded: t.text().check(z.string().regex(/^ab$/i)),
            caught: t.text().check(z.string().min(5).catch("x")),
            preprocessed: t
              .text()
              .check(z.preprocess((v) => String(v).toLowerCase(), z.enum(["red"]))),
            coerced: t.text().check(z.coerce.number()),
            trimmed: t.text().check(z.string().trim().max(3)),
            long: t.text().check(z.string().min(3).max(9)),
            step: t.float().check(z.number().multipleOf(0.1)),
            nested: t.json(z.object({ tag: z.string().regex(/^x$/m), n: z.number().catch(0) })),
            dotted: t.text().check(z.string().regex(/^.{2}$/)),
            negated: t.text().check(z.string().regex(/^[^a]{2}$/)),
            bounded: t.text().check(z.string().regex(/^a\b/)),
            named: t.text().check(z.string().regex(/^(?<x>a)\k<x>$/)),
            unicode: t.text().check(z.string().regex(/^.{2}$/u)),
            run: t.text().check(z.string().regex(/^a[^b]*b$/)),
            looked: t.text().check(z.string().regex(/^(?!x)\D*\s*$/)),
            classed: t.text().check(z.string().regex(/^[\w\s]*$/)),
            unclassed: t.text().check(z.string().regex(/^[\S]*$/)),
            counted: t.text().check(z.string().regex(/^a{,2}$/)),
            templated: t.text().check(z.templateLiteral([z.string().length(2)])),
            keyed: t.json(z.looseRecord(z.string().regex(/^\w+$/), z.number())),
            spanned: t.text().check(z.string().regex(new RegExp("^[ -\uffff]{2}$"))),
            ranged: t.text().check(z.string().regex(new RegExp("^[\u4e00-\u9fff]{2}$"))),
          },
        },
      },
    });
    const schemaOf = (column: string) => {
      const { $schema: _, ...rest } =
        portableSchema(loose).tables["loose"]?.columns[column]?.checkSchema ?? {};
      return rest;
    };
    // the i flag says "AB" passes, and a pattern of `^ab$` would refuse it
    expect(schemaOf("folded")).toEqual({ type: "string" });
    // a catch, a preprocess and a coerce each take any value the function takes
    expect(schemaOf("caught")).toEqual({});
    expect(schemaOf("preprocessed")).toEqual({});
    expect(schemaOf("coerced")).toEqual({});
    // the length is measured after the trim: "  abc  " passes
    expect(schemaOf("trimmed")).toEqual({ type: "string" });
    // "😀😀" is four UTF-16 units and two code points
    expect(schemaOf("long")).toEqual({ type: "string", minLength: 2, maxLength: 9 });
    expect(schemaOf("step")).toEqual({ type: "number" });
    expect(schemaOf("nested")).toEqual({
      type: "object",
      properties: { tag: { type: "string" }, n: {} },
      required: ["tag"],
    });
    // without `u` a `.` and a negated class match half of "😀", so `^.{2}$` passes it
    expect(schemaOf("dotted")).toEqual({ type: "string" });
    expect(schemaOf("negated")).toEqual({ type: "string" });
    // a port's `\b` knows "é" is a letter; JavaScript's does not, and passes "aé"
    expect(schemaOf("bounded")).toEqual({ type: "string" });
    // a backreference is JavaScript's own: a port's engine cannot compile it
    expect(schemaOf("named")).toEqual({ type: "string" });
    // with `u`, and as a `*` run, a pattern takes the same strings in a port
    expect(schemaOf("unicode")).toEqual({ type: "string", pattern: `^${DOT}{2}$` });
    expect(schemaOf("run")).toEqual({ type: "string", pattern: "^a[^b]*b$" });
    // a port's `\D`, `\s` are Unicode's, and a lookahead skips the crate's translation:
    // "٣" passes JavaScript's `\D`, so each shorthand travels as the set JavaScript means
    expect(schemaOf("looked")).toEqual({ type: "string", pattern: `^(?!x)[^0-9]*[${SPACE}]*$` });
    expect(schemaOf("classed")).toEqual({ type: "string", pattern: `^[A-Za-z0-9_${SPACE}]*$` });
    // a negated shorthand cannot be spelled inside a class, and `{,2}` is JavaScript's literal
    expect(schemaOf("unclassed")).toEqual({ type: "string" });
    expect(schemaOf("counted")).toEqual({ type: "string" });
    // a template literal's own pattern and a loose record's key patterns are read alike
    expect(schemaOf("templated")).toEqual({ type: "string" });
    // without `u` a range over the surrogates takes either half of "😀" alone, so `^[ -\uffff]{2}$`
    // passes it; a code-point engine reads the range without them and would refuse it
    expect(schemaOf("spanned")).toEqual({ type: "string" });
    expect(schemaOf("ranged")).toEqual({ type: "string", pattern: "^[\u4e00-\u9fff]{2}$" });
    expect(schemaOf("keyed")).toEqual({
      type: "object",
      patternProperties: { "^[A-Za-z0-9_]+$": { type: "number" } },
    });
  });
});

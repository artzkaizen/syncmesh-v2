/**
 * A manifest as the data another runtime's validator reads (gap U3): every fact the shared ladder
 * judges an event by, with nothing a port would have to run JavaScript to know.
 */
import type { JsonObject, JsonValue } from "@syncmesh/kernel";
import type { AllowBlock, RoleSet } from "@syncmesh/policy";

import { jsonObject } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SchemaEntry } from "./manifest.js";
import type { Table } from "./table.js";

import { shippedColumn, type ShippedColumn, type ShippedTable } from "./shipped.js";
import { speaksJsonSchema, type StandardSchemaV1 } from "./standard-schema.js";

/**
 * One column as a port reads it: what shipped, and whether a `check()` schema guards it. The
 * schema is a function; where it can say itself as JSON Schema (the Standard JSON Schema
 * extension, which zod 4 carries) `checkSchema` holds that, draft 2020-12, and a port runs it.
 *
 * A port's check is never stricter than the function. What JSON Schema cannot say — a
 * `.refine()`, a transform — is not in it, so there a port's verdict is the weaker one unless the
 * port registers a check of its own. Where zod's own converter would say *more* than the function
 * accepts, the part that would refuse is left out: a `.catch()`, a `z.preprocess` or a
 * `z.coerce` accepts any value; a string that is trimmed, case-folded or otherwise rewritten
 * before its checks, or whose regex a port's engine would read otherwise (a flag, a `.` that
 * counts UTF-16 units, a `\b`, a lookbehind), keeps only its type; a `.min(n)`
 * length (UTF-16 units in JavaScript, code points in JSON Schema) becomes `ceil(n / 2)`; a
 * fractional `multipleOf` is dropped. A check from a vendor other than zod travels as the flag.
 */
export interface PortableColumn extends ShippedColumn {
  readonly check?: true;
  /** The check's input as JSON Schema (draft 2020-12); absent when it cannot say itself as one. */
  readonly checkSchema?: JsonObject;
}

/* oxlint-disable no-underscore-dangle -- zod names its internals `_zod`; read here structurally */
/** The part of a zod 4 schema node {@link loosen} reads. zod's internals, read structurally. */
interface ZodNode {
  readonly _zod: {
    readonly def: {
      readonly type: string;
      readonly coerce?: boolean;
      readonly in?: ZodNode;
      readonly checks?: readonly { readonly _zod: { readonly def: { readonly check: string } } }[];
    };
    readonly bag?: { readonly patterns?: ReadonlySet<RegExp> };
  };
}

/** What zod's `override` hook hands over for each node it converts. */
interface ZodOverride {
  readonly zodSchema: ZodNode;
  readonly jsonSchema: {
    minLength?: number;
    multipleOf?: number;
    [keyword: string]: JsonValue | undefined;
  };
}

/** Regex flags whose meaning a JSON Schema `pattern` cannot carry. */
const UNSAID_FLAGS = /[imsv]/;

/** Escapes a port's regex reads as JavaScript does, with or without `u`. */
const SAME_ESCAPES = new Set("dwstnrfvx^$\\.*+?()[]{}|/-");

/** Escapes that match one UTF-16 unit without `u`, half of a character outside the BMP. */
const UNIT_ESCAPES = new Set("DWS");

/** What may follow `(?` in a pattern a port runs as JavaScript does: a plain group, a lookahead. */
const SAME_GROUPS = new Set(":=!");

const isSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdfff;

/**
 * Whether a port's regex engine, which counts code points, accepts no less than `regex` does.
 *
 * Without `u` JavaScript matches `.`, a negated class and `\D`, `\W`, `\S` one UTF-16 unit at a
 * time, so `/^.{2}$/` passes "😀". Such an atom is kept only as a `*` run, which takes the same
 * strings either way. A pattern with a literal outside the BMP, a `\b`, a backreference, a
 * named group, a lookbehind, a `\p` or `\u` escape, a nested or empty class, or a flag a
 * pattern cannot carry is not one a port can be trusted to read alike, so it is left out.
 */
const portablePattern = ({ source, flags }: RegExp) => {
  if (UNSAID_FLAGS.test(flags)) return false;
  const units = !flags.includes("u");
  let inClass = false;
  let unitClass = false;
  // the atom just read can match half a surrogate pair: only `*` may follow it
  let unitAtom = false;
  for (let at = 0; at < source.length; at += 1) {
    const char = source.charAt(at);
    if (unitAtom) {
      if (char !== "*") return false;
      unitAtom = false;
      continue;
    }
    if (units && isSurrogate(source.charCodeAt(at))) return false;
    if (char === "\\") {
      at += 1;
      const escaped = source.charAt(at);
      if (units && UNIT_ESCAPES.has(escaped)) {
        if (inClass) unitClass = true;
        else unitAtom = true;
      } else if (!SAME_ESCAPES.has(escaped) && !UNIT_ESCAPES.has(escaped)) return false;
    } else if (inClass) {
      if (char === "[" || (/[&~-]/.test(char) && source.charAt(at + 1) === char)) return false;
      if (char === "]") {
        inClass = false;
        unitAtom = unitClass;
      }
    } else if (char === "[") {
      inClass = true;
      unitClass = units && source.charAt(at + 1) === "^";
      if (source.charAt(at + 1) === "^") at += 1;
      if (source.charAt(at + 1) === "]") return false;
    } else if (char === "(" && source.charAt(at + 1) === "?") {
      if (!SAME_GROUPS.has(source.charAt(at + 2))) return false;
    } else if (char === ".") {
      unitAtom = units;
    }
  }
  return !unitAtom && !inClass;
};

/** Whether a node accepts values its JSON Schema would refuse: it rewrites or replaces its input. */
const acceptsAnything = ({ type, coerce, in: input }: ZodNode["_zod"]["def"]) =>
  type === "catch" || coerce === true || (type === "pipe" && input?._zod.def.type === "transform");

const clear = (json: ZodOverride["jsonSchema"], keep: readonly string[] = []) => {
  for (const key of Object.keys(json)) if (!keep.includes(key)) delete json[key];
};

/** Leaves out of one converted node whatever would make it stricter than the zod node it says. */
const loosen = ({ zodSchema, jsonSchema }: ZodOverride) => {
  const { def, bag } = zodSchema._zod;
  if (acceptsAnything(def)) return clear(jsonSchema);
  const rewrites = def.checks?.some((check) => check._zod.def.check === "overwrite") === true;
  const unportable = [...(bag?.patterns ?? [])].some((regex) => !portablePattern(regex));
  if (rewrites || unportable) return clear(jsonSchema, ["type"]);
  const { minLength, multipleOf } = jsonSchema;
  if (def.type === "string" && minLength !== undefined && minLength > 1) {
    jsonSchema.minLength = Math.ceil(minLength / 2);
  }
  if (multipleOf !== undefined && !Number.isInteger(multipleOf)) delete jsonSchema.multipleOf;
};
/* oxlint-enable no-underscore-dangle */

/** The JSON Schema a check says it accepts, or `undefined` when it cannot say. */
const checkSchemaOf = (check: StandardSchemaV1): JsonObject | undefined => {
  const standard = check["~standard"];
  // only zod's converter lets `loosen` see each node, so only zod's schema can be kept no stricter
  if (standard.vendor !== "zod" || !speaksJsonSchema(standard)) return undefined;
  // a converter throws on what JSON Schema cannot express (`z.custom`, a transform's output)
  const converted = Result.try(() =>
    standard.jsonSchema.input({
      target: "draft-2020-12",
      libraryOptions: { override: loosen },
    }),
  );
  if (converted.isErr()) return undefined;
  // a round trip through JSON keeps only what the format can carry: the manifest is JSON
  const json = Result.try(
    // SAFETY: `JSON.parse` answers `any`, and JSON text parses to exactly a JsonValue
    () => JSON.parse(JSON.stringify(converted.value)) as JsonValue,
  );
  return json.isOk() ? jsonObject(json.value) : undefined;
};

/** One table as a port reads it: its shape, and its rules as the data `allow` returned. */
export interface PortableTable extends Omit<ShippedTable, "columns" | "dropped"> {
  readonly columns: Readonly<Record<string, PortableColumn>>;
  /** Absent for a table in a reserved kind (`global`, `user`, `local`) and an authority table. */
  readonly allow?: AllowBlock;
}

/**
 * A manifest as plain data: what the Rust validator reads to reach the TypeScript's verdict on
 * every event. `v` is this format's own version, not the app's.
 *
 * Not carried, because no validator rung reads them: `fields` (read rules, honoured where an
 * authority serves rows), `derive` functions (each replica computes the value; the validator
 * needs only which column a derived one reads, which `columns` keeps), presence topics and
 * sealed kinds.
 */
export interface PortableSchema {
  readonly v: 1;
  readonly schemaVersion: number;
  readonly tables: Readonly<Record<string, PortableTable>>;
  /** The manifest's own tables (`_policy`, `_revocations`, …), by name. */
  readonly reserved: Readonly<Record<string, Pick<PortableTable, "columns">>>;
  /** Every declared kind's roles; a kind not named here has none. */
  readonly roles: Readonly<Record<string, RoleSet>>;
  readonly dropped: readonly string[];
}

/** What {@link portableSchema} reads from a schema, so any `Schema<C, PC>` fits. */
export interface PortingSchema {
  readonly entries: readonly Pick<
    SchemaEntry,
    "table" | "partition" | "visibility" | "sync" | "retired" | "allow"
  >[];
  readonly reserved: readonly Table[];
  readonly kinds: readonly string[];
  readonly rolesFor: (kind: string) => RoleSet;
  readonly schemaVersion?: number;
  readonly dropped: ReadonlySet<string>;
}

const portableCheck = (check: StandardSchemaV1 | undefined) => {
  if (check === undefined) return {};
  const checkSchema = checkSchemaOf(check);
  return checkSchema === undefined
    ? { check: true as const }
    : { check: true as const, checkSchema };
};

const portableColumns = (table: Table): Readonly<Record<string, PortableColumn>> =>
  Object.fromEntries(
    Object.entries(table.columns).map(([name, column]) => [
      name,
      {
        ...shippedColumn(column.def),
        ...portableCheck(column.def.check),
      },
    ]),
  );

/**
 * The schema as the data a port's validator runs on. Write it beside the app, or hand it to the
 * Rust device at open; regenerate it whenever the manifest changes.
 *
 * @example
 * await Bun.write("schema.portable.json", `${JSON.stringify(portableSchema(schema), null, 2)}\n`);
 */
export function portableSchema(schema: PortingSchema): PortableSchema {
  const tables = Object.fromEntries(
    schema.entries.map((entry): [string, PortableTable] => [
      entry.table.name,
      {
        partition: entry.partition,
        visibility: entry.visibility,
        ...(entry.sync !== undefined && { sync: entry.sync }),
        ...(entry.retired === true && { retired: true as const }),
        columns: portableColumns(entry.table),
        ...(entry.allow !== undefined && { allow: entry.allow }),
      },
    ]),
  );
  return {
    v: 1,
    schemaVersion: schema.schemaVersion ?? 1,
    tables,
    reserved: Object.fromEntries(
      schema.reserved.map((table) => [table.name, { columns: portableColumns(table) }]),
    ),
    roles: Object.fromEntries(schema.kinds.map((kind) => [kind, schema.rolesFor(kind)])),
    dropped: [...schema.dropped],
  };
}

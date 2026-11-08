/**
 * The last manifest an app shipped, as a file it commits beside its schema (D31): what
 * `checkEvolution` compares the next manifest against.
 */
import type { JsonObject, JsonValue } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { ColumnDef, ColumnKind } from "./column.js";
import type { SchemaEntry } from "./manifest.js";

/**
 * One column as it shipped: the facts about it an older build judges a write by. A `check()`
 * schema is a function and is not recorded, so tightening one is the one change this cannot see.
 */
export interface ShippedColumn {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly merge?: string;
  /** The document adapter's id (`name@major`), on a document column. */
  readonly doc?: string;
  /** The document column a derived column is computed from. */
  readonly derived?: string;
  readonly retired?: true;
}

/** One table as it shipped. */
export interface ShippedTable {
  readonly partition: string;
  readonly visibility: "partition" | "authority";
  readonly sync?: "window";
  readonly retired?: true;
  readonly columns: Readonly<Record<string, ShippedColumn>>;
  /**
   * Columns this table has removed, kept for good so no later build declares the name again.
   * Only {@link checkEvolution} writes it, from the file before; a schema does not know it.
   */
  readonly dropped?: readonly string[];
}

/**
 * The last manifest an app shipped, as plain data (D31): the file it commits beside its schema
 * and checks the next one against. `v` is this file's own format, not the app's version.
 */
export interface ShippedSchema {
  readonly v: 1;
  /** What the manifest declared; `1` for one that declared none, which is what peers read. */
  readonly schemaVersion: number;
  readonly tables: Readonly<Record<string, ShippedTable>>;
  /** Tables the app has dropped, in the order the manifest names them. */
  readonly dropped: readonly string[];
}

/** What {@link shippedSchema} reads from a schema, so any `Schema<C, PC>` fits. */
export interface EvolvingSchema {
  readonly entries: readonly Pick<
    SchemaEntry,
    "table" | "partition" | "visibility" | "sync" | "retired"
  >[];
  readonly schemaVersion?: number;
  readonly dropped: ReadonlySet<string>;
}

const shippedColumn = (def: ColumnDef): ShippedColumn => ({
  kind: def.kind,
  nullable: def.nullable,
  primaryKey: def.primaryKey,
  unique: def.unique,
  // `lww` is the default spelled out, not a different column
  ...(def.merge !== undefined && def.merge !== "lww" && { merge: def.merge }),
  ...(def.doc !== undefined && { doc: def.doc.adapter }),
  ...(def.derived !== undefined && { derived: def.derived.from }),
  ...(def.retired === true && { retired: true as const }),
});

/**
 * A schema as the data {@link checkEvolution} compares: the file to commit when the app first
 * ships. After that, commit what `checkEvolution` returns, which also keeps the names of the
 * columns removed since; this function cannot know them.
 *
 * @example
 * await Bun.write("schema.shipped.json", formatShippedSchema(shippedSchema(schema)));
 */
export function shippedSchema(schema: EvolvingSchema): ShippedSchema {
  const tables = Object.fromEntries(
    schema.entries.map((entry): [string, ShippedTable] => [
      entry.table.name,
      {
        partition: entry.partition,
        visibility: entry.visibility,
        ...(entry.sync !== undefined && { sync: entry.sync }),
        ...(entry.retired === true && { retired: true as const }),
        columns: Object.fromEntries(
          Object.entries(entry.table.columns).map(([name, column]) => [
            name,
            shippedColumn(column.def),
          ]),
        ),
      },
    ]),
  );
  return { v: 1, schemaVersion: schema.schemaVersion ?? 1, tables, dropped: [...schema.dropped] };
}

/** The file's text: two-space JSON with a trailing newline, keys in the order the schema has them. */
export const formatShippedSchema = (shipped: ShippedSchema): string =>
  `${JSON.stringify(shipped, null, 2)}\n`;

/** The committed file did not parse as a {@link ShippedSchema}. */
export class ShippedSchemaUnreadable extends TaggedError("ShippedSchemaUnreadable")<{
  message: string;
  cause?: unknown;
}> {}

/* oxlint-disable anti-slop/no-runtime-typeof -- the committed file is outside input: its runtime type is the fact being checked */
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boolean = (value: JsonValue | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** Text, absent, or `false` for a field that is there and is not text. */
const optionalText = (value: JsonValue | undefined): string | undefined | false =>
  value === undefined || typeof value === "string" ? value : false;

const COLUMN_KINDS = new Map<JsonValue | undefined, ColumnKind>(
  (["text", "integer", "float", "boolean", "timestamp", "json", "blob", "uuid"] as const).map(
    (kind) => [kind, kind],
  ),
);

const VISIBILITIES = new Map<JsonValue | undefined, ShippedTable["visibility"]>([
  ["partition", "partition"],
  ["authority", "authority"],
]);

/** `true` for `true`, absent for absent, `false` for anything else: how a flag is written. */
const flag = (value: JsonValue | undefined): true | undefined | false =>
  value === undefined || value === true ? value : false;

/** The optional parts of a column, or `undefined` when one of them is not what it should be. */
function columnExtras(value: JsonObject): Partial<ShippedColumn> | undefined {
  const [merge, doc, derived] = [value["merge"], value["doc"], value["derived"]].map(optionalText);
  const retired = flag(value["retired"]);
  if (merge === false || doc === false || derived === false || retired === false) return undefined;
  return {
    ...(merge !== undefined && { merge }),
    ...(doc !== undefined && { doc }),
    ...(derived !== undefined && { derived }),
    ...(retired === true && { retired }),
  };
}

function readColumn(value: JsonValue): ShippedColumn | undefined {
  if (!isObject(value)) return undefined;
  const kind = COLUMN_KINDS.get(value["kind"]);
  const nullable = boolean(value["nullable"]);
  const primaryKey = boolean(value["primaryKey"]);
  const unique = boolean(value["unique"]);
  const extras = columnExtras(value);
  if (kind === undefined || nullable === undefined || primaryKey === undefined) return undefined;
  if (unique === undefined || extras === undefined) return undefined;
  return { kind, nullable, primaryKey, unique, ...extras };
}

/** Every value of an object read by `read`, or `undefined` when one does not read. */
function readEach<T>(
  value: JsonValue | undefined,
  read: (each: JsonValue) => T | undefined,
): Readonly<Record<string, T>> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, T> = {};
  for (const [name, each] of Object.entries(value)) {
    const item = read(each);
    if (item === undefined) return undefined;
    out[name] = item;
  }
  return out;
}

/** A list of names, absent for absent, or `undefined` when it is there and is not one. */
function names(value: JsonValue | undefined): readonly string[] | undefined | false {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return false;
  const each = value.filter((name): name is string => typeof name === "string");
  return each.length === value.length ? each : false;
}

function readTable(value: JsonValue): ShippedTable | undefined {
  if (!isObject(value)) return undefined;
  const { partition, sync } = value;
  const dropped = names(value["dropped"]);
  const visibility = VISIBILITIES.get(value["visibility"]);
  const retired = flag(value["retired"]);
  const columns = readEach(value["columns"], readColumn);
  if (typeof partition !== "string" || visibility === undefined || columns === undefined)
    return undefined;
  if ((sync !== undefined && sync !== "window") || retired === false || dropped === false)
    return undefined;
  return {
    partition,
    visibility,
    ...(sync !== undefined && { sync }),
    ...(retired === true && { retired }),
    columns,
    ...(dropped !== undefined && { dropped }),
  };
}

function readShipped(value: JsonValue): ShippedSchema | undefined {
  if (!isObject(value) || value["v"] !== 1) return undefined;
  const { schemaVersion } = value;
  const tables = readEach(value["tables"], readTable);
  const dropped = names(value["dropped"]);
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion)) return undefined;
  if (schemaVersion < 1 || tables === undefined || dropped === undefined || dropped === false)
    return undefined;
  return { v: 1, schemaVersion, tables, dropped };
}

/* oxlint-enable anti-slop/no-runtime-typeof */

/** Reads the committed file back; anything that is not a {@link ShippedSchema} is a value, not a throw. */
export function parseShippedSchema(text: string): Result<ShippedSchema, ShippedSchemaUnreadable> {
  return Result.try({
    // SAFETY: `JSON.parse` answers `any`, and JSON text parses to exactly a JsonValue
    try: () => JSON.parse(text) as JsonValue,
    catch: (cause) => new ShippedSchemaUnreadable({ message: "not JSON", cause }),
  }).andThen((value) => {
    const shipped = readShipped(value);
    return shipped === undefined
      ? Result.err(new ShippedSchemaUnreadable({ message: "not a shipped schema (format v1)" }))
      : Result.ok(shipped);
  });
}

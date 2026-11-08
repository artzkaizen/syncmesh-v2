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
 * What JSON Schema cannot say — a `.refine()`, a transform — is not in it, so there a port's
 * verdict is the weaker one unless the port registers a check of its own.
 */
export interface PortableColumn extends ShippedColumn {
  readonly check?: true;
  /** The check's input as JSON Schema (draft 2020-12); absent when it cannot say itself as one. */
  readonly checkSchema?: JsonObject;
}

/** The JSON Schema a check says it accepts, or `undefined` when it cannot say. */
const checkSchemaOf = (check: StandardSchemaV1): JsonObject | undefined => {
  const standard = check["~standard"];
  if (!speaksJsonSchema(standard)) return undefined;
  // a converter throws on what JSON Schema cannot express (`z.custom`, a transform's output)
  const converted = Result.try(() => standard.jsonSchema.input({ target: "draft-2020-12" }));
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

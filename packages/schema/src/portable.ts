/**
 * A manifest as the data another runtime's validator reads (gap U3): every fact the shared ladder
 * judges an event by, with nothing a port would have to run JavaScript to know.
 */
import type { AllowBlock, RoleSet } from "@syncmesh/policy";

import type { SchemaEntry } from "./manifest.js";
import type { Table } from "./table.js";

import { shippedColumn, type ShippedColumn, type ShippedTable } from "./shipped.js";

/**
 * One column as a port reads it: what shipped, and whether a `check()` schema guards it. The
 * schema is a function, so a port cannot run it; the flag says where its verdict is the weaker one.
 */
export interface PortableColumn extends ShippedColumn {
  readonly check?: true;
}

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

const portableColumns = (table: Table): Readonly<Record<string, PortableColumn>> =>
  Object.fromEntries(
    Object.entries(table.columns).map(([name, column]) => [
      name,
      {
        ...shippedColumn(column.def),
        ...(column.def.check !== undefined && { check: true as const }),
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

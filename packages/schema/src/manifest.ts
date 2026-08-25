import type { ColumnName, MergeSpec, StrategyName, TableName } from "@syncmesh/kernel";

import { panic } from "@syncmesh/result";

import {
  fromDrizzle,
  isDrizzleTable,
  type ColumnsFromDrizzle,
  type DrizzleTableLike,
} from "./from-drizzle.js";
import { reservedTables } from "./reserved.js";
import { table, type Columns, type PrimaryKey, type Table } from "./table.js";

export type PartitionDef = { readonly isolation: "database" } | { readonly parent: string };

export type Partitions = Readonly<Record<string, PartitionDef>>;

/** Where a table's rows live: one of the manifest's partitions, the account-private `user` scope, or `local` (never on the wire). */
export type PartitionKind<P extends Partitions> = (keyof P & string) | "user" | "local";

export type Roles<P extends Partitions> = { readonly [K in keyof P]?: readonly string[] };

export type TableEntry<P extends Partitions> =
  | { readonly columns: Columns; readonly partition: PartitionKind<P>; readonly table?: undefined }
  | {
      readonly table: Table | DrizzleTableLike;
      readonly partition: PartitionKind<P>;
      readonly columns?: undefined;
    };

export interface Manifest<
  P extends Partitions,
  R extends Roles<P>,
  T extends Readonly<Record<string, TableEntry<P>>>,
> {
  readonly partitions: P;
  readonly roles?: R;
  readonly tables: T;
}

export interface SchemaEntry<P extends Partitions = Partitions> {
  readonly table: Table;
  readonly partition: PartitionKind<P>;
}

export type TablesOf<T extends Readonly<Record<string, TableEntry<Partitions>>>> = {
  readonly [K in keyof T]: T[K] extends { readonly table: infer Given }
    ? Given extends Table
      ? Given
      : Given extends DrizzleTableLike
        ? Table<ColumnsFromDrizzle<Given>, PrimaryKey<ColumnsFromDrizzle<Given>>>
        : never
    : T[K] extends { readonly columns: infer C extends Columns }
      ? Table<C, PrimaryKey<C>>
      : never;
};

export interface Schema<
  P extends Partitions,
  R extends Roles<P>,
  T extends Readonly<Record<string, TableEntry<P>>>,
> {
  readonly partitions: P;
  readonly roles: R;
  readonly tables: TablesOf<T>;
  readonly entries: readonly SchemaEntry<P>[];
  /** Installed by the manifest, outside the app namespace. */
  readonly reserved: readonly Table[];
  readonly merge: MergeSpec;
  /** Roles that apply in a partition, inherited from its parent when it declares none. */
  readonly rolesFor: (partition: PartitionKind<P>) => readonly string[];
}

/** One manifest for the data model: partitions, roles, and tables with their partition (D06-A). Conflict rules live on columns. Definition mistakes throw. */
export function defineSchema<
  const P extends Partitions,
  const R extends Roles<P>,
  const T extends Readonly<Record<string, TableEntry<P>>>,
>(manifest: Manifest<P, R, T>): Schema<P, R, T> {
  // SAFETY: an absent roles map means no roles anywhere, which every R admits
  const roles = manifest.roles ?? ({} as R);
  const { partitions, tables } = manifest;
  checkPartitions(partitions, roles);
  const built: Record<string, Table> = {};
  const entries: SchemaEntry<P>[] = [];
  const merge = new Map<TableName, Map<ColumnName, StrategyName>>();
  for (const [name, entry] of Object.entries(tables)) {
    if (
      entry.partition !== "user" &&
      entry.partition !== "local" &&
      !(entry.partition in partitions)
    ) {
      panic(`${name}: unknown partition "${entry.partition}"`);
    }
    const tbl = resolve(name, entry);
    if (String(tbl.name) !== name) panic(`${name}: imported table is named "${String(tbl.name)}"`);
    built[name] = tbl;
    entries.push({ table: tbl, partition: entry.partition });
    const rules = mergeRulesFor(name, tbl);
    if (rules.size > 0) merge.set(tbl.name, rules);
  }
  return {
    partitions,
    roles,
    // SAFETY: built has exactly the keys of T, each the table its entry describes
    tables: built as Schema<P, R, T>["tables"],
    entries,
    reserved: reservedTables,
    merge,
    rolesFor: (partition) => rolesFor(partitions, roles, partition),
  };
}

const resolve = (name: string, entry: TableEntry<Partitions>): Table => {
  if (entry.table === undefined) return table(name, entry.columns);
  return isDrizzleTable(entry.table) ? fromDrizzle(entry.table) : entry.table;
};

function checkPartitions(partitions: Partitions, roles: Roles<Partitions>): void {
  for (const [name, def] of Object.entries(partitions)) {
    if (name === "user" || name === "local") panic(`partition "${name}" is reserved`);
    if ("parent" in def && !(def.parent in partitions))
      panic(`partition ${name}: unknown parent "${def.parent}"`);
  }
  for (const name of Object.keys(roles))
    if (!(name in partitions)) panic(`roles: unknown partition "${name}"`);
}

function mergeRulesFor(name: string, tbl: Table): Map<ColumnName, StrategyName> {
  const rules = new Map<ColumnName, StrategyName>();
  for (const [key, column] of Object.entries(tbl.columns)) {
    const strategy = column.def.onConflict;
    if (strategy !== undefined && strategy !== "lww")
      rules.set(tbl.columnNames[key] ?? panic(`${name}.${key}: unnamed column`), strategy);
  }
  return rules;
}

function rolesFor(
  partitions: Partitions,
  roles: Roles<Partitions>,
  partition: string,
): readonly string[] {
  let current: string | undefined = partition;
  while (current !== undefined) {
    const declared = roles[current];
    if (declared !== undefined) return declared;
    const def: PartitionDef | undefined = partitions[current];
    current = def !== undefined && "parent" in def ? def.parent : undefined;
  }
  return [];
}

import type { ColumnName, MergeSpec, StrategyName, TableName } from "@syncmesh/kernel";
import type { AllowBlock } from "@syncmesh/policy";

import { panic } from "@syncmesh/result";

import type { AllowFn } from "./bind.js";

import { combinators } from "./bind.js";
import { sourceName } from "./from-drizzle.js";
import { reservedTables } from "./reserved.js";
import { table, type Columns, type PrimaryKey, type Table } from "./table.js";

/** Kinds as a tree: a key is a kind, nesting is nesting, a leaf is `{}`. Top-level kinds get their own store per instance. */
export interface PartitionTree {
  readonly [kind: string]: PartitionTree;
}

type Keys<P> = string extends keyof P ? never : keyof P & string;
type Level2<P> = { [A in Keys<P>]: Keys<P[A]> }[Keys<P>];
type Level3<P> = { [A in Keys<P>]: { [B in Keys<P[A]>]: Keys<P[A][B]> }[Keys<P[A]>] }[Keys<P>];
type Level4<P> = {
  [A in Keys<P>]: {
    [B in Keys<P[A]>]: { [C in Keys<P[A][B]>]: Keys<P[A][B][C]> }[Keys<P[A][B]>];
  }[Keys<P[A]>];
}[Keys<P>];
/** Every kind in the tree, to four levels deep. */
type Kinds<P> = Keys<P> | Level2<P> | Level3<P> | Level4<P>;

export type ReservedKind = "global" | "user" | "local";

/** A declared kind, or one of the three every app has: `global` (server-written, everyone reads), `user` (the account's devices), `local` (this device). */
export type PartitionKind<P extends PartitionTree> = Kinds<P> | ReservedKind;

export type Roles<P extends PartitionTree> = {
  readonly [K in Kinds<P>]?: readonly string[];
};

/** Every role named anywhere in the manifest's ladders. */
export type RoleNames<R extends Roles<PartitionTree>> = R[keyof R] extends
  | readonly (infer X)[]
  | undefined
  ? X & string
  : never;

/** Every table is written the same way: its columns, where its rows live, and who may do what. */
export type TableEntry<
  P extends PartitionTree,
  R extends Roles<P> = Roles<P>,
  C extends Columns = Columns,
> =
  | {
      readonly columns: C;
      /** A declared kind needs `allow`; omitted means `global`. */
      readonly partition: Kinds<P>;
      readonly allow: AllowFn<C, RoleNames<R>>;
      readonly visibility?: undefined;
    }
  | {
      readonly columns: Columns;
      readonly partition?: ReservedKind;
      readonly allow?: undefined;
      readonly visibility?: undefined;
    }
  | {
      readonly columns: C;
      /** The relay decides which rows reach which device, from the app's own data (RFC-0020). */
      readonly visibility: "authority";
      readonly partition?: undefined;
      readonly allow?: undefined;
    };

export type ColumnsMap = Readonly<Record<string, Columns>>;

/** `C` — each table's columns — is inferred first, so every entry's `allow` is typed to its own table. */
export interface Manifest<P extends PartitionTree, R extends Roles<P>, C extends ColumnsMap> {
  readonly partitions?: P;
  readonly roles?: R;
  readonly tables: { readonly [K in keyof C]: TableEntry<P, R, C[K]> };
}

export interface SchemaEntry<P extends PartitionTree = PartitionTree> {
  readonly table: Table;
  readonly partition: PartitionKind<P>;
  readonly visibility: "partition" | "authority";
  /** The rules, as data — what the `_policy` row will carry. Absent for user, local and global tables. */
  readonly allow?: AllowBlock;
}

export type TablesOf<C extends ColumnsMap> = {
  readonly [K in keyof C]: Table<C[K], PrimaryKey<C[K]>>;
};

export interface Schema<P extends PartitionTree, R extends Roles<P>, C extends ColumnsMap> {
  readonly partitions: P;
  readonly roles: R;
  readonly tables: TablesOf<C>;
  readonly entries: readonly SchemaEntry<P>[];
  readonly reserved: readonly Table[];
  readonly merge: MergeSpec;
  /** Every declared kind, parents before children. */
  readonly kinds: readonly Kinds<P>[];
  readonly parentOf: (kind: Kinds<P>) => Kinds<P> | undefined;
  /** Roles that apply in a kind, inherited from its parent when it declares none. */
  readonly rolesFor: (kind: PartitionKind<P>) => readonly string[];
}

const RESERVED = new Set<string>(["global", "user", "local"]);

/** One manifest for the data model (D06-A). Definition mistakes throw at module load. */
export function defineSchema<
  const P extends PartitionTree,
  const R extends Roles<P>,
  const C extends ColumnsMap,
>(manifest: Manifest<P, R, C>): Schema<P, R, C> {
  // SAFETY: an absent tree declares no kinds, which every P admits; an absent roles map declares none, which every R admits
  const partitions = manifest.partitions ?? ({} as P);
  // SAFETY: as above
  const roles = manifest.roles ?? ({} as R);
  const parents = flatten(partitions);
  for (const name of Object.keys(roles))
    if (!parents.has(name)) panic(`roles: unknown partition kind "${name}"`);

  const built: Record<string, Table> = {};
  const entries: SchemaEntry<P>[] = [];
  const merge = new Map<TableName, Map<ColumnName, StrategyName>>();
  const tables: Readonly<Record<string, TableEntry<P, R, Columns>>> = manifest.tables;
  for (const [name, entry] of Object.entries(tables)) {
    const source = sourceName(entry.columns);
    if (source !== undefined && source !== name)
      panic(`${name}: imported columns come from the Drizzle table "${source}"`);
    const tbl = table(name, entry.columns);
    const partition = partitionOf<P, R>(name, entry, parents);
    built[name] = tbl;
    const base: SchemaEntry<P> = {
      table: tbl,
      partition,
      visibility: entry.visibility ?? "partition",
    };
    entries.push(entry.allow === undefined ? base : { ...base, allow: entry.allow(combinators()) });
    const rules = mergeRulesFor(name, tbl);
    if (rules.size > 0) merge.set(tbl.name, rules);
  }
  const kinds = [...parents.keys()];
  return {
    partitions,
    roles,
    // SAFETY: built has exactly the keys of T, each the table its entry describes
    tables: built as Schema<P, R, C>["tables"],
    entries,
    reserved: reservedTables,
    merge,
    // SAFETY: kinds are the keys of the tree, which is what Kinds<P> names
    kinds: kinds as Kinds<P>[],
    // SAFETY: as above
    parentOf: (kind) => parents.get(kind) as Kinds<P> | undefined,
    rolesFor: (kind) => rolesFor(parents, roles, kind),
  };
}

function partitionOf<P extends PartitionTree, R extends Roles<P>>(
  name: string,
  entry: TableEntry<P, R, Columns>,
  parents: ReadonlyMap<string, string | undefined>,
): PartitionKind<P> {
  if (entry.visibility === "authority") return "global";
  const partition = entry.partition ?? "global";
  const declared = parents.has(partition);
  if (!declared && !RESERVED.has(partition))
    panic(`${name}: unknown partition kind "${partition}"`);
  if (declared && entry.allow === undefined)
    panic(`${name}: a table in a declared partition kind needs an allow rule`);
  return partition;
}

/** Kind → parent kind, in tree order; reserved and duplicate names throw. */
function flatten(
  tree: PartitionTree,
  parent?: string,
  into = new Map<string, string | undefined>(),
): Map<string, string | undefined> {
  for (const [kind, children] of Object.entries(tree)) {
    if (RESERVED.has(kind)) panic(`partition kind "${kind}" is reserved`);
    if (into.has(kind)) panic(`partition kind "${kind}" is declared twice`);
    into.set(kind, parent);
    flatten(children, kind, into);
  }
  return into;
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
  parents: ReadonlyMap<string, string | undefined>,
  roles: Readonly<Record<string, readonly string[] | undefined>>,
  kind: string,
): readonly string[] {
  let current: string | undefined = kind;
  while (current !== undefined) {
    const declared = roles[current];
    if (declared !== undefined) return declared;
    current = parents.get(current);
  }
  return [];
}

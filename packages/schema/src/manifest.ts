import type { ColumnName, MergeSpec, StrategyName, TableName } from "@syncmesh/kernel";
import type { AllowBlock, RoleSet } from "@syncmesh/policy";

import { NO_ROLES } from "@syncmesh/policy";
import { panic } from "@syncmesh/result";

import type { AllowFn } from "./bind.js";

import { combinators } from "./bind.js";
import { strategyOf } from "./column.js";
import { sourceName } from "./from-drizzle.js";
import {
  RESERVED,
  global,
  isPartition,
  type Partition,
  type ReservedPartition,
} from "./partition.js";
import {
  presenceTopics,
  type PresenceBlock,
  type PresenceMap,
  type PresenceTopic,
} from "./presence.js";
import { reservedTables } from "./reserved.js";
import { table, type Columns, type PrimaryKey, type Table } from "./table.js";

/** Every table is written the same way: its columns, where its rows live, and who may do what. */
export type TableEntry<C extends Columns = Columns> =
  | {
      readonly columns: C;
      /**
       * Where this table's rows live: the {@link Partition} value that declares the kind. A
       * declared kind needs `allow`; omitted, the table is `global`.
       *
       * `role()` here takes any name; only `drizzleTable` can narrow it to the kind's own
       * ladder, because it is a function and can infer the kind where a mapped type cannot.
       */
      readonly partition: Partition;
      readonly allow: AllowFn<C, string>;
      readonly visibility?: undefined;
    }
  | {
      readonly columns: Columns;
      /** One of the three every app has; what the kind is *is* its rule, so no `allow`. */
      readonly partition?: ReservedPartition;
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
export interface Manifest<C extends ColumnsMap, PC extends PresenceMap = Record<string, never>> {
  readonly tables: { readonly [K in keyof C]: TableEntry<C[K]> };
  /** The ephemeral tier (D16): topics that never touch the log, the snapshot or a cursor. */
  readonly presence?: PresenceBlock<PC>;
}

export interface SchemaEntry {
  readonly table: Table;
  /** The name of the kind the table's rows live in; one of the reserved three or a declared one. */
  readonly partition: string;
  readonly visibility: "partition" | "authority";
  /** The rules, as data — what the `_policy` row will carry. Absent for user, local and global tables. */
  readonly allow?: AllowBlock;
}

export type TablesOf<C extends ColumnsMap> = {
  readonly [K in keyof C]: Table<C[K], PrimaryKey<C[K]>>;
};

export interface Schema<C extends ColumnsMap, PC extends PresenceMap = Record<string, never>> {
  readonly tables: TablesOf<C>;
  /** Declared presence topics, in declaration order; empty when the manifest declares none. */
  readonly presence: readonly PresenceTopic[];
  /** The value shape a topic declares, for the hooks that infer from it. */
  readonly presenceOf: PC;
  readonly entries: readonly SchemaEntry[];
  readonly reserved: readonly Table[];
  readonly merge: MergeSpec;
  /** Every declared kind, in the order the tables and topics first reference them; never a reserved one. */
  readonly kinds: readonly string[];
  /** The kinds whose content is sealed; empty for a manifest that declares none. */
  readonly sealedKinds: ReadonlySet<string>;
  /** The roles that apply in a kind and whether they are ordered; {@link NO_ROLES} for a reserved or unknown one. */
  readonly rolesFor: (kind: string) => RoleSet;
}

/**
 * Every table a manifest declares, for the calls that take a list rather than a manifest:
 * `openStores`, `schemaNameFor`, the Drizzle bridge. Not `tablesOf`, which `@syncmesh/drizzle`
 * already has for a different question — which tables a *query* reads.
 *
 * Reads `entries` rather than `tables`, because `entries` is the one that already has the mesh's
 * own reserved tables folded in — a store opened from `tables` would be missing them and find out
 * at the first write.
 */
export const syncedTables = (schema: {
  readonly entries: readonly Pick<SchemaEntry, "table">[];
}): readonly Table[] => schema.entries.map((entry) => entry.table);

/** One manifest for the data model (D06-A). Definition mistakes throw at module load. */
export function syncSchema<
  const C extends ColumnsMap,
  const PC extends PresenceMap = Record<string, never>,
>(manifest: Manifest<C, PC>): Schema<C, PC> {
  const built: Record<string, Table> = {};
  const entries: SchemaEntry[] = [];
  const merge = new Map<TableName, Map<ColumnName, StrategyName>>();
  const tables: Readonly<Record<string, TableEntry>> = manifest.tables;
  /**
   * The kinds, collected from what references them (§2.1).
   *
   * Derived rather than listed, because a kind nothing stores in and nothing announces on holds
   * nothing — there is no manifest entry for it to be missing from. What object keys got for
   * free and this has to check for is a **duplicate name**: two `partition("ward")` values in
   * two modules can collide.
   */
  const declared = new Map<string, Partition>();
  const declare = (value: Partition): string => {
    // the three reserved kinds are not declarations — they exist in every manifest, so listing
    // them among the app's own kinds would put `global` in the set a devtool enumerates
    if (RESERVED.has(value.name)) return value.name;
    const held = declared.get(value.name);
    if (held === undefined) declared.set(value.name, value);
    else if (held !== value) panic(`partition kind "${value.name}" is declared twice`);
    return value.name;
  };
  for (const [name, entry] of Object.entries(tables)) {
    const source = sourceName(entry.columns);
    if (source !== undefined && source !== name)
      panic(`${name}: imported columns come from the Drizzle table "${source}"`);
    const tbl = table(name, entry.columns);
    const partition = partitionOf(name, entry, declare);
    built[name] = tbl;
    const base: SchemaEntry = {
      table: tbl,
      partition,
      visibility: entry.visibility ?? "partition",
    };
    entries.push(entry.allow === undefined ? base : { ...base, allow: entry.allow(combinators()) });
    const rules = mergeRulesFor(name, tbl);
    if (rules.size > 0) merge.set(tbl.name, rules);
  }
  const presence = presenceTopics<PC>(manifest.presence, declare);
  return {
    // SAFETY: built has exactly the keys of T, each the table its entry describes
    tables: built as Schema<C, PC>["tables"],
    presence,
    // SAFETY: the shapes are exactly the `of` maps the manifest declared, keyed as it keyed them
    presenceOf: Object.fromEntries(presence.map((t) => [t.name, t.columns])) as PC,
    entries,
    reserved: reservedTables,
    merge,
    kinds: [...declared.keys()],
    sealedKinds: new Set([...declared.values()].filter((p) => p.sealed).map((p) => p.name)),
    rolesFor: (kind) => declared.get(kind)?.roles ?? NO_ROLES,
  };
}

/** The kind a table's rows live in, with the two `allow` guards the types cannot express for a value. */
function partitionOf(
  name: string,
  entry: TableEntry,
  declare: (value: Partition) => string,
): string {
  if (entry.visibility === "authority") return "global";
  const value = entry.partition ?? global;
  // a manifest built where the types did not reach — generated, or spread from `any`
  if (!isPartition(value)) panic(`${name}: unknown partition kind "${String(value)}"`);
  // a reserved kind's rule *is* what it is (server-written, one account, one device), so an
  // `allow` block on one would be a second rule with nothing to say
  if (RESERVED.has(value.name) && entry.allow !== undefined)
    panic(`${name}: a table in the reserved kind "${value.name}" takes no allow rule`);
  if (!RESERVED.has(value.name) && entry.allow === undefined)
    panic(`${name}: a table in a declared partition kind needs an allow rule`);
  return declare(value);
}

/** The strategies the fold needs: `lww` is the default and is left out, so an empty map means no rules. */
function mergeRulesFor(name: string, tbl: Table): Map<ColumnName, StrategyName> {
  const rules = new Map<ColumnName, StrategyName>();
  for (const [key, column] of Object.entries(tbl.columns)) {
    const strategy = strategyOf(column.def);
    if (strategy !== undefined && strategy !== "lww")
      rules.set(tbl.columnNames[key] ?? panic(`${name}.${key}: unnamed column`), strategy);
  }
  return rules;
}

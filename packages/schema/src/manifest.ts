import type { ColumnName, MergeSpec, StrategyName, TableName } from "@syncmesh/kernel";
import type { AllowBlock, RoleSet } from "@syncmesh/policy";

import { NO_ROLES } from "@syncmesh/policy";
import { panic } from "@syncmesh/result";

import type { AllowFn } from "./bind.js";

import { combinators } from "./bind.js";
import { strategyOf } from "./column.js";
import { sourceName } from "./from-drizzle.js";
import { RESERVED, isPartition, type Partition } from "./partition.js";
import {
  presenceTopics,
  type PresenceBlock,
  type PresenceMap,
  type PresenceTopic,
} from "./presence.js";
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
export type Kinds<P> = Keys<P> | Level2<P> | Level3<P> | Level4<P>;

export type ReservedKind = "global" | "user" | "local";

/** A declared kind, or one of the three every app has: `global` (server-written, everyone reads), `user` (the account's devices), `local` (this device). */
export type PartitionKind<P extends PartitionTree> = Kinds<P> | ReservedKind;

/** The tree form's role block: a bare array per kind, read as a {@link ladder} (senior first). */
export type Roles<P extends PartitionTree> = {
  readonly [K in Kinds<P>]?: readonly string[];
};

/**
 * The names `role()` accepts: the manifest's own ladders where it has them, else any string.
 *
 * A manifest declaring kinds as values carries no `roles:` block, so `RoleNames` is `never` and
 * `role()` would take no argument at all. Narrowing those to the referenced kind's own ladder is
 * the win the value form is *for*, and it needs the entry's partition type at the entry — which
 * a mapped type cannot give. It arrives with `drizzleTable`, which is a function and can infer.
 */
export type RoleNamesOr<R extends Roles<PartitionTree>> = [RoleNames<R>] extends [never]
  ? string
  : RoleNames<R>;

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
      /**
       * Where this table's rows live: the {@link Partition} value that declares the kind, or —
       * for a manifest still using the tree form — its name.
       *
       * A declared kind needs `allow`; omitted means `global`. A second arm for the value form
       * was tried and withdrawn: two arms whose `allow` differ only in their role-name parameter
       * defeat contextual typing, and every `allow: ({ role }) => …` in the repo went `any`.
       */
      readonly partition: Kinds<P> | Partition;
      readonly allow: AllowFn<C, RoleNamesOr<R>>;
      readonly visibility?: undefined;
    }
  | {
      readonly columns: Columns;
      readonly partition?: ReservedKind | Partition;
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
export interface Manifest<
  P extends PartitionTree,
  R extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
> {
  readonly partitions?: P;
  readonly roles?: R;
  readonly tables: { readonly [K in keyof C]: TableEntry<P, R, C[K]> };
  /** The ephemeral tier (D16): topics that never touch the log, the snapshot or a cursor. */
  readonly presence?: PresenceBlock<P, PC>;
  /**
   * Kinds whose content is end-to-end encrypted (book ch. 14). Every carrier — another device,
   * a relay, the server's custody role — holds the envelope and cannot read a value in it.
   *
   * A list of kinds rather than a flag inside the tree, because the tree is a tree of kinds and
   * a boolean in it would be a node that is not one. Naming them here is also the only place
   * where the whole set is visible at once, which is what a person deciding what a server may
   * judge actually wants to read.
   *
   * **The trade is stated, not hidden**: sealing buys operator-proof custody and costs
   * server-side judgment. Folding into Postgres, watchdogs and corrections are structurally
   * unavailable for a sealed kind, because a judge has to read.
   */
  readonly sealed?: readonly PartitionKind<P>[];
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

export interface Schema<
  P extends PartitionTree,
  R extends Roles<P>,
  C extends ColumnsMap,
  PC extends PresenceMap = Record<string, never>,
> {
  readonly partitions: P;
  readonly roles: R;
  readonly tables: TablesOf<C>;
  /** Declared presence topics, in declaration order; empty when the manifest declares none. */
  readonly presence: readonly PresenceTopic[];
  /** The value shape a topic declares, for the hooks that infer from it. */
  readonly presenceOf: PC;
  readonly entries: readonly SchemaEntry<P>[];
  readonly reserved: readonly Table[];
  readonly merge: MergeSpec;
  /** Every declared kind — the tree's, then the ones table entries reference as values. */
  readonly kinds: readonly string[];
  /** The kinds whose content is sealed; empty for a manifest that declares none. */
  readonly sealedKinds: ReadonlySet<string>;
  readonly parentOf: (kind: string) => Kinds<P> | undefined;
  /** The roles that apply in a kind and whether they are ordered — inherited from its parent under the tree form when it declares none. */
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

/** The sealed kinds, checked against the tree: a typo here is a partition nobody encrypts. */
const sealedIn = (
  declared: readonly string[] | undefined,
  parents: ReadonlyMap<string, string | undefined>,
): ReadonlySet<string> => {
  for (const kind of declared ?? [])
    if (!parents.has(kind) && !RESERVED.has(kind))
      panic(`sealed: unknown partition kind "${kind}"`);
  return new Set<string>(declared ?? []);
};

/** One manifest for the data model (D06-A). Definition mistakes throw at module load. */
export function syncSchema<
  const P extends PartitionTree,
  const R extends Roles<P>,
  const C extends ColumnsMap,
  const PC extends PresenceMap = Record<string, never>,
>(manifest: Manifest<P, R, C, PC>): Schema<P, R, C, PC> {
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
  /**
   * Kinds declared as values, collected from what references them (§2.1).
   *
   * Derived rather than listed, because a kind nothing stores in and nothing announces on holds
   * nothing — there is no manifest entry for it to be missing from. What the tree form got for
   * free and this has to check for is a **duplicate name**: object keys could not collide, two
   * `partition("ward")` values in two modules can.
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
    if (isPartition(entry.partition)) declare(entry.partition);
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
  const presence = presenceTopics<P, PC>(manifest.presence, parents, declare);
  for (const name of declared.keys())
    if (parents.has(name)) panic(`partition kind "${name}" is declared twice`);
  const kinds = [...parents.keys(), ...declared.keys()];
  const sealedKinds = new Set<string>([
    ...sealedIn(manifest.sealed, parents),
    ...[...declared.values()].filter((p) => p.sealed).map((p) => p.name),
  ]);
  return {
    partitions,
    roles,
    // SAFETY: built has exactly the keys of T, each the table its entry describes
    tables: built as Schema<P, R, C, PC>["tables"],
    presence,
    // SAFETY: the shapes are exactly the `of` maps the manifest declared, keyed as it keyed them
    presenceOf: Object.fromEntries(presence.map((t) => [t.name, t.columns])) as PC,
    entries,
    reserved: reservedTables,
    merge,
    kinds,
    sealedKinds,
    // SAFETY: as above
    parentOf: (kind) => parents.get(kind) as Kinds<P> | undefined,
    rolesFor: (kind) => declared.get(String(kind))?.roles ?? rolesFor(parents, roles, kind),
  };
}

function partitionOf<P extends PartitionTree, R extends Roles<P>>(
  name: string,
  entry: TableEntry<P, R, Columns>,
  parents: ReadonlyMap<string, string | undefined>,
): PartitionKind<P> {
  if (entry.visibility === "authority") return "global";
  if (isPartition(entry.partition)) {
    // a reserved kind's rule *is* what it is (server-written, one account, one device), so an
    // `allow` block on one would be a second rule with nothing to say
    if (RESERVED.has(entry.partition.name) && entry.allow !== undefined)
      panic(`${name}: a table in the reserved kind "${entry.partition.name}" takes no allow rule`);
    if (!RESERVED.has(entry.partition.name) && entry.allow === undefined)
      panic(`${name}: a table in a declared partition kind needs an allow rule`);
    // SAFETY: the name came off a Partition this manifest declares, which is what PartitionKind names
    return entry.partition.name as PartitionKind<P>;
  }
  const partition = entry.partition ?? "global";
  const known = parents.has(partition);
  if (!known && !RESERVED.has(partition)) panic(`${name}: unknown partition kind "${partition}"`);
  if (known && entry.allow === undefined)
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

/** The tree form's roles for a kind: its own array or the nearest ancestor's, each a ladder because the tree form has no other shape. */
function rolesFor(
  parents: ReadonlyMap<string, string | undefined>,
  roles: Readonly<Record<string, readonly string[] | undefined>>,
  kind: string,
): RoleSet {
  let current: string | undefined = kind;
  while (current !== undefined) {
    const declared = roles[current];
    if (declared !== undefined) return { names: declared, ordered: true };
    current = parents.get(current);
  }
  return NO_ROLES;
}

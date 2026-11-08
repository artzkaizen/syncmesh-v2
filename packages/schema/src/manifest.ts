import type {
  ColumnName,
  MergeSpec,
  SchemaVersion,
  StrategyName,
  TableName,
} from "@syncmesh/kernel";
import type { AllowBlock, PolicyNode, RoleSet } from "@syncmesh/policy";

import { parseSchemaVersion } from "@syncmesh/kernel";
import { NO_ROLES } from "@syncmesh/policy";
import { panic } from "@syncmesh/result";

import type { AllowFn, FieldsFn } from "./bind.js";
import type { DeriveBlock, DocColumnEntry } from "./documents.js";

import { combinators } from "./bind.js";
import { columnFromDef, columnStrategy } from "./column.js";
import { docColumnEntries } from "./documents.js";
import { sourceName } from "./from-drizzle.js";
import { parseTableName } from "./names.js";
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
      /** Field-level read rules, honoured where an authority serves rows (E06, D40). */
      readonly fields?: FieldsFn<C, string>;
      readonly visibility?: undefined;
      readonly derive?: DeriveBlock<C>;
      /**
       * `"window"`: the server keeps this table and serves pages of it; devices never replicate it.
       * Read it through a `query` procedure, and every device shows the page that procedure returns
       * (D43). Absent, the table replicates.
       */
      readonly sync?: "window";
      /**
       * `true`: the table is retired (D31) — still declared, read and folded from peers, refused
       * for this device's own writes. The step before it moves to {@link Manifest.dropped}.
       */
      readonly retired?: true;
    }
  | {
      readonly columns: Columns;
      /** One of the three every app has; what the kind is *is* its rule, so no `allow`. */
      readonly partition?: ReservedPartition;
      readonly allow?: undefined;
      readonly visibility?: undefined;
      readonly derive?: DeriveBlock<Columns>;
      /**
       * `"window"`: the server keeps this table and serves pages of it; devices never replicate it.
       * Read it through a `query` procedure, and every device shows the page that procedure returns
       * (D43). Absent, the table replicates.
       */
      readonly sync?: "window";
      /**
       * `true`: the table is retired (D31) — still declared, read and folded from peers, refused
       * for this device's own writes. The step before it moves to {@link Manifest.dropped}.
       */
      readonly retired?: true;
    }
  | {
      readonly columns: C;
      /** The relay decides which rows reach which device, from the app's own data (RFC-0020). */
      readonly visibility: "authority";
      readonly partition?: undefined;
      readonly allow?: undefined;
      readonly derive?: DeriveBlock<C>;
      readonly sync?: undefined;
      /**
       * `true`: the table is retired (D31) — still declared, read and folded from peers, refused
       * for this device's own writes. The step before it moves to {@link Manifest.dropped}.
       */
      readonly retired?: true;
    };

export type ColumnsMap = Readonly<Record<string, Columns>>;

/** `C` — each table's columns — is inferred first, so every entry's `allow` is typed to its own table. */
export interface Manifest<C extends ColumnsMap, PC extends PresenceMap = Record<string, never>> {
  readonly tables: { readonly [K in keyof C]: TableEntry<C[K]> };
  /** The ephemeral tier (D16): topics that never touch the log, the snapshot or a cursor. */
  readonly presence?: PresenceBlock<PC>;
  /**
   * Which shape of the data model this is (D31): a positive integer, raised whenever the shape
   * changes. Stamped on every event this build writes and sent on the cursors frame, so a fleet
   * can read which builds are still writing; absent, nothing is stamped and peers read `1`.
   * `checkEvolution` refuses a lower one, and an unchanged one over a changed shape.
   */
  readonly schemaVersion?: number;
  /**
   * The tables this app declared once and has since dropped (D31's contract step). Kept so a
   * write to one from an older build parks under its own bucket, `dropped-table`, and never in
   * `unknown-table` beside a newer build's tables. A name here can never be declared again.
   */
  readonly dropped?: readonly string[];
}

export interface SchemaEntry {
  readonly table: Table;
  /** The name of the kind the table's rows live in; one of the reserved three or a declared one. */
  readonly partition: string;
  readonly visibility: "partition" | "authority";
  /** The rules, as data — what the `_policy` row will carry. Absent for user, local and global tables. */
  readonly allow?: AllowBlock;
  /** Per column, who may read its value where an authority serves rows; absent when none is restricted. */
  readonly fields?: Readonly<Record<string, PolicyNode>>;
  /** The derive functions, keyed by target column; absent when the table declares none. */
  readonly derive?: DeriveBlock<Columns>;
  /** `"window"` for a table the server serves pages of instead of replicating; absent, it replicates. */
  readonly sync?: "window";
  /** Present on a retired table (D31): read and folded from peers, refused for local writes. */
  readonly retired?: true;
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
  /** Document columns per table, in column order; a table without one is absent. */
  readonly docs: ReadonlyMap<TableName, readonly DocColumnEntry[]>;
  /** Every declared kind, in the order the tables and topics first reference them; never a reserved one. */
  readonly kinds: readonly string[];
  /** The kinds whose content is sealed; empty for a manifest that declares none. */
  readonly sealedKinds: ReadonlySet<string>;
  /** The roles that apply in a kind and whether they are ordered; {@link NO_ROLES} for a reserved or unknown one. */
  readonly rolesFor: (kind: string) => RoleSet;
  /** What {@link Manifest.schemaVersion} declared; absent when it declared none. */
  readonly schemaVersion?: SchemaVersion;
  /** {@link Manifest.dropped}; empty for a manifest that dropped nothing. */
  readonly dropped: ReadonlySet<string>;
}

/**
 * Every table a manifest declares, for the calls that take a list rather than a manifest:
 * `openStores`, `schemaName`, the Drizzle bridge. Not `queryTables`, which `@syncmesh/drizzle`
 * already has for a different question — which tables a *query* reads.
 *
 * Reads `entries` rather than `tables`, because `entries` is the one that already has the mesh's
 * own reserved tables folded in — a store opened from `tables` would be missing them and find out
 * at the first write.
 */
export const syncedTables = (schema: {
  readonly entries: readonly Pick<SchemaEntry, "table">[];
}): readonly Table[] => schema.entries.map((entry) => entry.table);

/**
 * The tables only the authority writes and only the relay's gate admits (D24) — what a relay's
 * `admission.tables` names.
 *
 * @example
 * startRelay(port, { admission: { tables: authorityTables(schema), entitle } })
 */
export const authorityTables = (schema: {
  readonly entries: readonly Pick<SchemaEntry, "table" | "visibility">[];
}): readonly TableName[] =>
  schema.entries
    .filter((entry) => entry.visibility === "authority")
    .map((entry) => entry.table.name);

/**
 * The names of the tables marked `sync: "window"`: kept by the server and read a page at a time,
 * never replicated (D43).
 */
export const servedTables = (schema: {
  readonly entries: readonly Pick<SchemaEntry, "table" | "sync">[];
}): ReadonlySet<string> =>
  new Set(
    schema.entries.filter((entry) => entry.sync === "window").map((entry) => entry.table.name),
  );

/** One manifest for the data model (D06-A). Definition mistakes throw at module load. */
export function syncSchema<
  const C extends ColumnsMap,
  const PC extends PresenceMap = Record<string, never>,
>(manifest: Manifest<C, PC>): Schema<C, PC> {
  const built: Record<string, Table> = {};
  const entries: SchemaEntry[] = [];
  const merge = new Map<TableName, Map<ColumnName, StrategyName>>();
  const docs = new Map<TableName, readonly DocColumnEntry[]>();
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
    const written = table(name, entry.columns);
    const documents = docColumnEntries(name, written, entry.derive ?? {});
    const tbl =
      entry.derive === undefined
        ? written
        : table(name, derivedColumns(entry.columns, entry.derive));
    const partition = declarePartition(name, entry, declare);
    built[name] = tbl;
    entries.push(schemaEntry(name, tbl, partition, entry));
    const rules = mergeRules(name, tbl);
    if (rules.size > 0) merge.set(tbl.name, rules);
    if (documents.length > 0) docs.set(tbl.name, documents);
  }
  const presence = presenceTopics<PC>(manifest.presence, declare);
  const dropped = droppedTables(manifest.dropped ?? [], tables);
  const version = declaredVersion(manifest.schemaVersion);
  return {
    ...(version !== undefined && { schemaVersion: version }),
    dropped,
    // SAFETY: built has exactly the keys of T, each the table its entry describes
    tables: built as Schema<C, PC>["tables"],
    presence,
    // SAFETY: the shapes are exactly the `of` maps the manifest declared, keyed as it keyed them
    presenceOf: Object.fromEntries(presence.map((t) => [t.name, t.columns])) as PC,
    entries,
    reserved: reservedTables,
    merge,
    docs,
    kinds: [...declared.keys()],
    sealedKinds: new Set([...declared.values()].filter((p) => p.sealed).map((p) => p.name)),
    rolesFor: (kind) => declared.get(kind)?.roles ?? NO_ROLES,
  };
}

/** One table's entry as the schema hands it out: its rules as data, and each optional part it declares. */
function schemaEntry(name: string, tbl: Table, partition: string, entry: TableEntry): SchemaEntry {
  const base: SchemaEntry = { table: tbl, partition, visibility: entry.visibility ?? "partition" };
  const ruled = entry.allow === undefined ? base : { ...base, allow: entry.allow(combinators()) };
  const fields = entry.allow === undefined ? undefined : fieldRules(name, tbl, entry.fields);
  const fielded = fields === undefined ? ruled : { ...ruled, fields };
  const derived = entry.derive === undefined ? fielded : { ...fielded, derive: entry.derive };
  const served = entry.sync === undefined ? derived : { ...derived, sync: entry.sync };
  return entry.retired === true ? { ...served, retired: true } : served;
}

/** The manifest's `schemaVersion`, checked: a definition mistake throws at module load. */
function declaredVersion(version: number | undefined): SchemaVersion | undefined {
  if (version === undefined) return undefined;
  const parsed = parseSchemaVersion(version);
  if (parsed.isErr()) panic(`schemaVersion: ${version} is not a positive integer`);
  return parsed.value;
}

/**
 * The dropped names, checked the way the types cannot: each a table name, none declared again —
 * a write from an older build would otherwise fold into a different table under the old name.
 */
function droppedTables(
  names: readonly string[],
  tables: Readonly<Record<string, TableEntry>>,
): ReadonlySet<string> {
  for (const name of names) {
    if (parseTableName(name).isErr()) panic(`dropped: "${name}" is not a table name`);
    if (Object.hasOwn(tables, name))
      panic(`dropped: "${name}" is declared too; a dropped table name is never reused`);
  }
  return new Set(names);
}

/**
 * A table's field rules as data, checked the way the types cannot for a value: every rule names a
 * column the table has, and none names the primary key — a row whose identity reads as `null` is
 * not a row anything can address, update or delete.
 */
function fieldRules(
  name: string,
  tbl: Table,
  fields: FieldsFn<Columns, string> | undefined,
): Readonly<Record<string, PolicyNode>> | undefined {
  if (fields === undefined) return undefined;
  const rules = Object.entries(fields(combinators())).filter(
    (pair): pair is [string, PolicyNode] => pair[1] !== undefined,
  );
  if (rules.length === 0) return undefined;
  for (const [column] of rules) {
    if (!Object.hasOwn(tbl.columns, column))
      panic(`${name}.fields: there is no column "${column}"`);
    if (tbl.primaryKey === column)
      panic(`${name}.fields: "${column}" is the primary key, which every reader must see`);
  }
  return Object.fromEntries(rules);
}

/** The kind a table's rows live in, with the two `allow` guards the types cannot express for a value. */
function declarePartition(
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
function mergeRules(name: string, tbl: Table): Map<ColumnName, StrategyName> {
  const rules = new Map<ColumnName, StrategyName>();
  for (const [key, column] of Object.entries(tbl.columns)) {
    const strategy = columnStrategy(column.def);
    if (strategy !== undefined && strategy !== "lww")
      rules.set(tbl.columnNames[key] ?? panic(`${name}.${key}: unnamed column`), strategy);
  }
  return rules;
}

/**
 * The columns with every derive target marked by the document column it reads, so the projection,
 * capture and the validator tell a derived column apart from the table alone. Runs after
 * {@link docColumnEntries} has refused what a materialiser could not honour.
 */
function derivedColumns(columns: Columns, derive: DeriveBlock<Columns>): Columns {
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => {
      const derivation = derive[key];
      return [
        key,
        derivation === undefined
          ? column
          : columnFromDef({ ...column.def, derived: { from: derivation.from } }),
      ];
    }),
  );
}

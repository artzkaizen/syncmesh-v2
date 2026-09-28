import type { StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

import type { AppValue } from "./convert.js";
import type {
  DrizzleEntry,
  DrizzleTableInKind,
  DrizzleTableOptions,
  DrizzleTableReserved,
} from "./drizzle-options.js";
import type { Columns } from "./table.js";

import {
  columnFromDef,
  type Column,
  type ColumnDef,
  type ColumnKind,
  type MergeFor,
  type Value,
} from "./column.js";

/** The parts of a Drizzle column syncmesh reads, declared structurally so drizzle-orm is not a dependency. */
export interface DrizzleColumnLike {
  readonly _: {
    readonly data: unknown;
    readonly notNull: boolean;
    readonly isPrimaryKey: boolean;
  };
}

export interface DrizzleTableLike {
  readonly _: {
    readonly name: string;
    readonly columns: Readonly<Record<string, DrizzleColumnLike>>;
  };
}

interface DrizzleColumnInfo {
  readonly name: string;
  readonly dataType: string;
  readonly columnType: string;
  readonly notNull: boolean;
  readonly primary: boolean;
  readonly hasDefault: boolean;
  readonly isUnique: boolean;
  readonly generated?: object;
  readonly generatedIdentity?: object;
}

/** Drizzle keeps a table's runtime metadata under these symbols; reading them keeps drizzle-orm out of our runtime. */
interface DrizzleRuntime {
  readonly [NAME]: string;
  readonly [COLUMNS]: Readonly<Record<string, DrizzleColumnInfo>>;
}
// SAFETY: a unique symbol type can only be declared, so the registry symbol is asserted onto it; the value is the registered symbol either way
const NAME: unique symbol = Symbol.for("drizzle:Name") as never;
// SAFETY: as above
const COLUMNS: unique symbol = Symbol.for("drizzle:Columns") as never;

export interface DrizzleWarning {
  readonly column: string;
  readonly message: string;
}

export type ColumnsFromDrizzle<D extends DrizzleTableLike> = {
  readonly [K in keyof D["_"]["columns"] & string]: Column<
    DrizzleValue<D["_"]["columns"][K]>,
    D["_"]["columns"][K]["_"]["isPrimaryKey"] extends true
      ? false
      : D["_"]["columns"][K]["_"]["notNull"] extends true
        ? false
        : true,
    D["_"]["columns"][K]["_"]["isPrimaryKey"]
  >;
};

type DrizzleValue<C extends DrizzleColumnLike> = C["_"]["data"] extends Date
  ? Temporal.Instant
  : C["_"]["data"];

export interface FromDrizzleOptions<D extends DrizzleTableLike> {
  /** Merge rules for an imported table, typed against its columns like `t.integer({ merge })` is. */
  readonly merge?: {
    readonly [K in keyof ColumnsFromDrizzle<D>]?: MergeFor<
      NonNullable<Value<ColumnsFromDrizzle<D>[K]>>
    >;
  };
  readonly onWarn?: (warning: DrizzleWarning) => void;
}

/**
 * The frozen mapping: Drizzle `dataType` as the base, `columnType` only where the base is ambiguous.
 * It determines wire bytes, so changing an entry invalidates every existing log.
 */
const INTEGER_TYPES = new Set([
  "PgInteger",
  "PgSmallInt",
  "PgBigInt53",
  "SQLiteInteger",
  "MySqlInt",
  "MySqlBigInt53",
]);
const FLOAT_TYPES = new Set([
  "PgReal",
  "PgDoublePrecision",
  "SQLiteReal",
  "MySqlReal",
  "MySqlDouble",
  "MySqlFloat",
]);
const REFUSED = {
  PgSerial:
    "serial has no value to sync: two offline devices cannot both be given the next number. Use t.uuid()",
  PgBigSerial53: "bigserial has no value to sync. Use t.uuid()",
  PgSmallSerial: "smallserial has no value to sync. Use t.uuid()",
  PgNumeric: "unbounded numeric has no exact JavaScript representation; use integer, real, or text",
  MySqlDecimal: "decimal has no exact JavaScript representation; use integer, real, or text",
} satisfies Readonly<Record<string, string>>;

const isRefused = (columnType: string): columnType is keyof typeof REFUSED => columnType in REFUSED;

function kindFor(info: DrizzleColumnInfo): ColumnKind {
  if (isRefused(info.columnType)) panic(`${info.name}: ${REFUSED[info.columnType]}`);
  if (info.generated !== undefined || info.generatedIdentity !== undefined)
    panic(`${info.name}: generated columns have no value to sync`);
  switch (info.dataType) {
    case "string":
      return info.columnType === "PgUUID" ? "uuid" : "text";
    case "number":
      if (INTEGER_TYPES.has(info.columnType)) return "integer";
      if (FLOAT_TYPES.has(info.columnType)) return "float";
      return panic(`${info.name}: number column ${info.columnType} is not in the frozen mapping`);
    case "boolean":
      return "boolean";
    case "date":
      return "timestamp";
    case "json":
      return "json";
    case "buffer":
      return "blob";
    default:
      return panic(
        `${info.name}: ${info.dataType} (${info.columnType}) is not in the frozen mapping`,
      );
  }
}

function defFor(
  info: DrizzleColumnInfo,
  strategy: string | undefined,
  warn: (message: string) => void,
): ColumnDef {
  const kind = kindFor(info);
  const def: ColumnDef = {
    kind,
    nullable: !info.primary && !info.notNull,
    primaryKey: info.primary,
    unique: info.isUnique,
  };
  if (info.isUnique)
    warn("unique() cannot be enforced across offline devices; two of them can both insert it");
  if (kind === "timestamp")
    warn("Drizzle hands back a Date; syncmesh carries epoch ms and hands back a Temporal.Instant");
  if (info.hasDefault)
    warn(
      def.nullable
        ? "defaults do not sync: an omitted column reads as null, never the default"
        : "defaults do not sync: every peer must see the inserted value, so the column is required",
    );
  // SAFETY: strategy came from FromDrizzleOptions.merge, typed per column as MergeFor<Value>
  return strategy === undefined ? def : { ...def, merge: strategy as StrategyName };
}

// SAFETY: a unique symbol type can only be declared, so the registry symbol is asserted onto it
const SOURCE: unique symbol = Symbol.for("syncmesh:drizzleSource") as never;

/** The Drizzle table a set of columns was imported from, if any; the manifest refuses a mismatched key. */
export function sourceName(columns: Columns): string | undefined {
  // SAFETY: SOURCE is set only by fromDrizzle, always to the table's name
  return (columns as Columns & { readonly [SOURCE]?: string })[SOURCE];
}

/** One definition: a Drizzle table's columns with the frozen type mapping. Refusals throw; the rest warns. */
export function fromDrizzle<const D extends DrizzleTableLike>(
  drizzle: D,
  options: FromDrizzleOptions<D> = {},
): ColumnsFromDrizzle<D> {
  const runtime = readRuntime(drizzle);
  const rules: Readonly<Record<string, string | undefined>> = options.merge ?? {};
  const mapped: Record<string, Column<AppValue, boolean, boolean>> = {};
  for (const [key, info] of Object.entries(runtime[COLUMNS])) {
    const def = defFor(info, rules[key], (message) => options.onWarn?.({ column: key, message }));
    mapped[key] = columnFromDef(def);
  }
  for (const key of Object.keys(rules))
    if (!(key in mapped))
      panic(`${runtime[NAME]}.${key}: merge names a column the table does not have`);
  const primary = Object.values(runtime[COLUMNS]).filter((c) => c.primary);
  if (primary.length !== 1)
    panic(
      `${runtime[NAME]}: syncmesh needs exactly one primary-key column; found ${primary.length} (composite keys are not supported)`,
    );
  Object.defineProperty(mapped, SOURCE, { value: runtime[NAME], enumerable: false });
  // SAFETY: mapped has one entry per Drizzle column, built by the frozen mapping that ColumnsFromDrizzle mirrors
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening -- the runtime record is shaped by the same mapping the type describes; TypeScript cannot relate them
  return mapped as Columns as ColumnsFromDrizzle<D>;
}

const isDrizzleTable = (value: DrizzleTableLike): boolean =>
  Object.getOwnPropertySymbols(value).includes(NAME);

function readRuntime(drizzle: DrizzleTableLike): DrizzleRuntime {
  if (!isDrizzleTable(drizzle)) panic("fromDrizzle: not a Drizzle table");
  // SAFETY: the drizzle:Name symbol is present, which only a Drizzle table carries; drizzle:Columns comes with it
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening -- reading a foreign object's symbol-keyed runtime fields; there is no parser to run
  return drizzle as unknown as DrizzleRuntime;
}

/**
 * A Drizzle table's manifest entry: the derived columns, where its rows live, and who may do what.
 *
 * ```ts
 * products: drizzleTable(products, {
 *   partition: shop,
 *   merge: { stock: "counter" },
 *   allow: ({ role }) => ({ read: role("viewer"), $default: role("editor") }),
 * }),
 * ```
 *
 * **The wrapper names its ORM, so there is no second declaration to drift from it**, and it is a
 * function, so it can infer what a manifest's mapped type cannot: the kind `partition` names.
 * `role()` is typed against that kind's own ladder — `role("viewer")` on a table whose kind has no
 * `viewer` does not compile — where the spread form (`{ ...drizzleTable(products), partition,
 * allow }`) checks it against every ladder the manifest declares, or any string under the value
 * form. A reserved kind (`global`, `user`, `local`) takes no `allow`; a declared kind requires one.
 *
 * Called with the derivation options alone it returns `{ columns }`, for an entry that overrides a
 * derived column by name before spreading it in.
 */
export function drizzleTable<const D extends DrizzleTableLike>(
  drizzle: D,
  options: DrizzleTableReserved<D>,
): DrizzleEntry<D> & Pick<DrizzleTableReserved<D>, "partition">;
export function drizzleTable<const D extends DrizzleTableLike, N extends string, R extends string>(
  drizzle: D,
  options: DrizzleTableInKind<D, N, R>,
): DrizzleEntry<D> & Pick<DrizzleTableInKind<D, N, R>, "partition" | "allow">;
// the derivation-only form stays last: it is all-optional, so a literal that also names `merge` or
// `onWarn` survives the first overload pass, and `allow` would be typed by it — as `any` — before
// the kind form is tried
export function drizzleTable<const D extends DrizzleTableLike>(
  drizzle: D,
  options?: FromDrizzleOptions<D>,
): DrizzleEntry<D>;
export function drizzleTable<const D extends DrizzleTableLike>(
  drizzle: D,
  options: DrizzleTableOptions<D> = {},
) {
  const { partition, allow, ...derive } = options;
  const columns = fromDrizzle(drizzle, derive);
  if (partition === undefined) return { columns };
  return allow === undefined ? { columns, partition } : { columns, partition, allow };
}

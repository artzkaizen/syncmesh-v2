import type { CellValue, StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

import type { Columns } from "./table.js";

import {
  columnFromDef,
  type Column,
  type ColumnDef,
  type ColumnKind,
  type StrategyFor,
  type Value,
} from "./column.js";

/** The parts of a Drizzle column syncmesh reads, declared structurally so drizzle-orm is not a dependency. */
export interface DrizzleColumnLike {
  readonly _: {
    readonly data: unknown;
    readonly notNull: boolean;
    readonly hasDefault: boolean;
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
  readonly default?: CellValue | SqlChunk;
  readonly defaultFn?: () => CellValue;
  readonly generated?: object;
  readonly generatedIdentity?: object;
}

interface SqlChunk {
  readonly queryChunks: readonly unknown[];
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
    D["_"]["columns"][K]["_"]["hasDefault"],
    D["_"]["columns"][K]["_"]["isPrimaryKey"]
  >;
};

type DrizzleValue<C extends DrizzleColumnLike> = C["_"]["data"] extends Date
  ? Temporal.Instant
  : C["_"]["data"];

export interface FromDrizzleOptions<D extends DrizzleTableLike> {
  /** Conflict rules for an imported table, typed against its columns like `.onConflict()` is. */
  readonly onConflict?: {
    readonly [K in keyof ColumnsFromDrizzle<D>]?: StrategyFor<
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

/* oxlint-disable anti-slop/no-runtime-typeof -- a Drizzle default is either a JSON value or an SQL chunk object; its runtime type is the fact being checked */
const isSql = (value: CellValue | SqlChunk | undefined): value is SqlChunk =>
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Uint8Array) &&
  !Array.isArray(value) &&
  "queryChunks" in value;
/* oxlint-enable anti-slop/no-runtime-typeof */

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
    hasDefault: false,
  };
  if (info.isUnique)
    warn("unique() cannot be enforced across offline devices; two of them can both insert it");
  if (kind === "timestamp")
    warn("Drizzle hands back a Date; syncmesh carries epoch ms and hands back a Temporal.Instant");
  const withDefault = defaultFor(info, def, warn);
  // SAFETY: strategy came from FromDrizzleOptions.onConflict, typed per column as StrategyFor<Value>
  return strategy === undefined
    ? withDefault
    : { ...withDefault, onConflict: strategy as StrategyName };
}

function defaultFor(
  info: DrizzleColumnInfo,
  def: ColumnDef,
  warn: (message: string) => void,
): ColumnDef {
  if (!info.hasDefault) return def;
  if (info.defaultFn !== undefined || isSql(info.default)) {
    warn("the default is computed by the database; nothing to carry, so the column stays required");
    return def;
  }
  return info.default === undefined
    ? def
    : { ...def, hasDefault: true, defaultValue: info.default };
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
  const rules: Readonly<Record<string, string | undefined>> = options.onConflict ?? {};
  const mapped: Record<string, Column<unknown, boolean, boolean, boolean>> = {};
  for (const [key, info] of Object.entries(runtime[COLUMNS])) {
    const def = defFor(info, rules[key], (message) => options.onWarn?.({ column: key, message }));
    mapped[key] = columnFromDef(def);
  }
  for (const key of Object.keys(rules))
    if (!(key in mapped))
      panic(`${runtime[NAME]}.${key}: onConflict names a column the table does not have`);
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

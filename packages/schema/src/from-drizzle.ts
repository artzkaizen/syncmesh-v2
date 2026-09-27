import type { StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

import type { AppValue } from "./convert.js";
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
  /** Array depth; Drizzle 1.0 keeps the element's type in `dataType` and marks an array here. */
  readonly dimensions?: number;
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

/**
 * Whether a Drizzle table names its key in its types. SQLite and MySQL columns still carry
 * `isPrimaryKey: true`; pg-core 1.0 types every built column `isPrimaryKey: false`, so a
 * Postgres table's key is known only at runtime.
 */
type KeyTyped<D extends DrizzleTableLike> =
  true extends D["_"]["columns"][keyof D["_"]["columns"]]["_"]["isPrimaryKey"] ? true : false;

/**
 * A column's key flag. Where the table does not type its key, every non-null column is a
 * candidate (`boolean`), so the table's `primaryKey` types as their union rather than `never`;
 * `fromDrizzle` still finds the one real key at runtime and refuses anything else.
 */
type KeyFlag<D extends DrizzleTableLike, C extends DrizzleColumnLike> =
  KeyTyped<D> extends true
    ? C["_"]["isPrimaryKey"]
    : C["_"]["notNull"] extends true
      ? boolean
      : false;

export type ColumnsFromDrizzle<D extends DrizzleTableLike> = {
  readonly [K in keyof D["_"]["columns"] & string]: Column<
    DrizzleValue<D["_"]["columns"][K]>,
    D["_"]["columns"][K]["_"]["isPrimaryKey"] extends true
      ? false
      : D["_"]["columns"][K]["_"]["notNull"] extends true
        ? false
        : true,
    KeyFlag<D, D["_"]["columns"][K]>
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
 *
 * The bases are the names Drizzle 0.45 used (`number`, `date`, `json`, `buffer`, …). Drizzle 1.0
 * spells `dataType` as `"<type> <constraint>"` — `"number int32"`, `"object date"`, `"string uuid"`
 * — and {@link frozenBase} reads the old base back out of it, so no entry moved in the upgrade.
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

/**
 * The 0.45 base of a Drizzle 1.0 `dataType`. The type word is the base, except `object`, which 0.45
 * named by what the object held: a date, a buffer, or JSON — the geometric objects were JSON then.
 * Anything else stays as written and falls through to the refusal.
 */
function frozenBase(dataType: string): string {
  const [type = dataType, constraint] = dataType.split(" ");
  if (type !== "object") return type;
  switch (constraint) {
    case "date":
    case "buffer":
    case "json":
      return constraint;
    case "point":
    case "line":
    case "geometry":
      return "json";
    default:
      return dataType;
  }
}

function kindFor(info: DrizzleColumnInfo): ColumnKind {
  if (isRefused(info.columnType)) panic(`${info.name}: ${REFUSED[info.columnType]}`);
  if (info.generated !== undefined || info.generatedIdentity !== undefined)
    panic(`${info.name}: generated columns have no value to sync`);
  if ((info.dimensions ?? 0) > 0)
    panic(`${info.name}: array (${info.columnType}[]) is not in the frozen mapping`);
  switch (frozenBase(info.dataType)) {
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

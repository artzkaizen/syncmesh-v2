import type { CellValue, JsonValue, StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import type { Output, StandardSchemaV1 } from "./standard-schema.js";

import { toWireValue, type AppValue } from "./convert.js";

export type ColumnKind =
  | "text"
  | "integer"
  | "float"
  | "boolean"
  | "timestamp"
  | "json"
  | "blob"
  | "uuid";

/** Which conflict strategies a column of value type `T` may declare: only numbers have a meaningful max/min. */
export type StrategyFor<T> = [T] extends [number] ? StrategyName : "lww";

export interface ColumnDef {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  /** Wire form: a timestamp default is epoch ms. */
  readonly defaultValue?: CellValue;
  readonly check?: StandardSchemaV1;
  readonly onConflict?: StrategyName;
}

/** A column: `def` is plain data, the methods return new columns. `T` is the app-facing value type. */
export interface Column<
  T,
  Nullable extends boolean = false,
  HasDefault extends boolean = false,
  PrimaryKey extends boolean = false,
> {
  readonly def: ColumnDef;
  /** Gone once `primaryKey()` was called: a key column is required on every row. */
  readonly nullable: PrimaryKey extends true ? never : () => Column<T, true, HasDefault, false>;
  /** Gone once `nullable()` or `default()` was called: a key is required and unique per row. */
  readonly primaryKey: Nullable extends true
    ? never
    : HasDefault extends true
      ? never
      : () => Column<T, false, false, true>;
  readonly unique: () => Column<T, Nullable, HasDefault, PrimaryKey>;
  /** Gone once `primaryKey()` was called: a shared default would collide every row. */
  readonly default: PrimaryKey extends true
    ? never
    : (value: T) => Column<T, Nullable, true, false>;
  readonly check: <S extends StandardSchemaV1>(
    schema: S,
  ) => Column<Output<S> & T, Nullable, HasDefault, PrimaryKey>;
  readonly onConflict: (strategy: StrategyFor<T>) => Column<T, Nullable, HasDefault, PrimaryKey>;
  /** Phantom: carries `T` for inference; never set. */
  readonly __value?: T;
  readonly __nullable?: Nullable;
  readonly __hasDefault?: HasDefault;
  readonly __primaryKey?: PrimaryKey;
}

/** What validation needs from a column: its data, whatever its value type. */
export interface AnyColumn {
  readonly def: ColumnDef;
}

/** The app-facing value type of a column, `null` included when nullable. */
export type Value<C> =
  C extends Column<infer T, infer N, boolean, boolean> ? (N extends true ? T | null : T) : never;

/** Wraps a definition as a column; how `fromDrizzle` builds columns from data. */
export function columnFromDef<T, N extends boolean, D extends boolean, P extends boolean>(
  def: ColumnDef,
): Column<T, N, D, P> {
  const next = <T2, N2 extends boolean, D2 extends boolean, P2 extends boolean>(
    patch: Partial<ColumnDef>,
  ) => columnFromDef<T2, N2, D2, P2>({ ...def, ...patch });
  const column = {
    def,
    nullable: () => next<T, true, D, false>({ nullable: true }),
    primaryKey: () => next<T, false, false, true>({ primaryKey: true }),
    unique: () => next<T, N, D, P>({ unique: true }),
    default: (value: T) =>
      // SAFETY: T is the column's declared app-facing value type, which is always an AppValue
      next<T, N, true, false>({ hasDefault: true, defaultValue: toWireValue(value as AppValue) }),
    check: <S extends StandardSchemaV1>(schema: S) =>
      next<Output<S> & T, N, D, P>({ check: schema }),
    onConflict: (strategy: StrategyFor<T>) => next<T, N, D, P>({ onConflict: strategy }),
  };
  // SAFETY: the runtime column always carries every method; the Column type erases the ones whose
  // combination is meaningless (nullable/default on a key, primaryKey on a nullable or defaulted
  // column), and table() panics on those combinations when a def arrives from outside the builder
  return column as Column<T, N, D, P>;
}

const base = (kind: ColumnKind): ColumnDef => ({
  kind,
  nullable: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
});

interface JsonColumn {
  <T extends JsonValue = JsonValue>(): Column<T, false, false, false>;
  <S extends StandardSchemaV1>(schema: S): Column<Output<S>, false, false, false>;
}

const json: JsonColumn = (schema?: StandardSchemaV1) => {
  // SAFETY: the two call signatures fix the value type; the runtime column is identical either way
  return columnFromDef<JsonValue, false, false, false>(
    schema === undefined ? base("json") : { ...base("json"), check: schema },
  ) as never;
};

export const t = {
  text: () => columnFromDef<string, false, false, false>(base("text")),
  integer: () => columnFromDef<number, false, false, false>(base("integer")),
  float: () => columnFromDef<number, false, false, false>(base("float")),
  boolean: () => columnFromDef<boolean, false, false, false>(base("boolean")),
  /** Epoch milliseconds on the wire; a `Temporal.Instant` to the app. */
  timestamp: () => columnFromDef<Temporal.Instant, false, false, false>(base("timestamp")),
  blob: () => columnFromDef<Uint8Array, false, false, false>(base("blob")),
  /** Canonical lowercase 8-4-4-4-12 only; never normalised, because rows are keyed by the string. */
  uuid: () => columnFromDef<string, false, false, false>(base("uuid")),
  /** With a schema the type is inferred and the value checked; without one anything JSON is accepted and `T` is a phantom. */
  json,
};

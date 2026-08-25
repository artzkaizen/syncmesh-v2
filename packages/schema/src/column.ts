import type { JsonValue, StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import type { AppValue } from "./convert.js";
import type { Output, StandardSchemaV1 } from "./standard-schema.js";

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
  readonly check?: StandardSchemaV1;
  readonly onConflict?: StrategyName;
}

/** A column: `def` is plain data, the methods return new columns. `T` is the app-facing value type. */
export interface Column<T, Nullable extends boolean = false, PrimaryKey extends boolean = false> {
  readonly def: ColumnDef;
  /** Gone once `primaryKey()` was called: a key column is required on every row. */
  readonly nullable: PrimaryKey extends true ? never : () => Column<T, true, false>;
  /** Gone once `nullable()` was called: a key is required and unique per row. */
  readonly primaryKey: Nullable extends true ? never : () => Column<T, false, true>;
  readonly unique: () => Column<T, Nullable, PrimaryKey>;
  readonly check: <S extends StandardSchemaV1>(
    schema: S,
  ) => Column<Output<S> & T, Nullable, PrimaryKey>;
  readonly onConflict: (strategy: StrategyFor<T>) => Column<T, Nullable, PrimaryKey>;
  /** Phantom: carries `T` for inference; never set. */
  readonly __value?: T;
  readonly __nullable?: Nullable;
  readonly __primaryKey?: PrimaryKey;
}

/** What validation needs from a column: its data, whatever its value type. */
export interface AnyColumn {
  readonly def: ColumnDef;
}

/** The app-facing value type of a column, `null` included when nullable. */
export type Value<C> =
  C extends Column<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never;

/** Wraps a definition as a column; how `fromDrizzle` builds columns from data. */
export function columnFromDef<T extends AppValue, N extends boolean, P extends boolean>(
  def: ColumnDef,
): Column<T, N, P> {
  const next = <T2 extends AppValue, N2 extends boolean, P2 extends boolean>(
    patch: Partial<ColumnDef>,
  ) => columnFromDef<T2, N2, P2>({ ...def, ...patch });
  const column = {
    def,
    nullable: () => next<T, true, false>({ nullable: true }),
    primaryKey: () => next<T, false, true>({ primaryKey: true }),
    unique: () => next<T, N, P>({ unique: true }),
    check: <S extends StandardSchemaV1>(schema: S) => next<Output<S> & T, N, P>({ check: schema }),
    onConflict: (strategy: StrategyFor<T>) => next<T, N, P>({ onConflict: strategy }),
  };
  // SAFETY: the runtime column always carries every method; the Column type erases the ones whose
  // combination is meaningless (nullable on a key, primaryKey on a nullable column), and table()
  // panics on those combinations when a def arrives from outside the builder
  return column as Column<T, N, P>;
}

const base = (kind: ColumnKind): ColumnDef => ({
  kind,
  nullable: false,
  primaryKey: false,
  unique: false,
});

interface JsonColumn {
  <T extends JsonValue = JsonValue>(): Column<T, false, false>;
  <S extends StandardSchemaV1>(schema: S): Column<Output<S>, false, false>;
}

const json: JsonColumn = (schema?: StandardSchemaV1) => {
  // SAFETY: the two call signatures fix the value type; the runtime column is identical either way
  return columnFromDef<JsonValue, false, false>(
    schema === undefined ? base("json") : { ...base("json"), check: schema },
  ) as never;
};

export const t = {
  text: () => columnFromDef<string, false, false>(base("text")),
  integer: () => columnFromDef<number, false, false>(base("integer")),
  float: () => columnFromDef<number, false, false>(base("float")),
  boolean: () => columnFromDef<boolean, false, false>(base("boolean")),
  /** Epoch milliseconds on the wire; a `Temporal.Instant` to the app. */
  timestamp: () => columnFromDef<Temporal.Instant, false, false>(base("timestamp")),
  blob: () => columnFromDef<Uint8Array, false, false>(base("blob")),
  /** Canonical lowercase 8-4-4-4-12 only; never normalised, because rows are keyed by the string. */
  uuid: () => columnFromDef<string, false, false>(base("uuid")),
  /** With a schema the type is inferred and the value checked; without one anything JSON is accepted and `T` is a phantom. */
  json,
};

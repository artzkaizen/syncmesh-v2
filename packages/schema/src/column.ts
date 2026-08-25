import type { CellValue, JsonValue, StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

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
  readonly nullable: () => Column<T, true, HasDefault, PrimaryKey>;
  readonly primaryKey: () => Column<T, Nullable, HasDefault, true>;
  readonly unique: () => Column<T, Nullable, HasDefault, PrimaryKey>;
  readonly default: (value: T) => Column<T, Nullable, true, PrimaryKey>;
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
  return {
    def,
    nullable: () => next<T, true, D, P>({ nullable: true }),
    primaryKey: () => next<T, N, D, true>({ primaryKey: true }),
    unique: () => next<T, N, D, P>({ unique: true }),
    default: (value) =>
      next<T, N, true, P>({ hasDefault: true, defaultValue: toWire(def.kind, value) }),
    check: (schema) => next<Output<typeof schema> & T, N, D, P>({ check: schema }),
    onConflict: (strategy) => next<T, N, D, P>({ onConflict: strategy }),
  };
}

const base = (kind: ColumnKind): ColumnDef => ({
  kind,
  nullable: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
});

const toWire = <T>(kind: ColumnKind, value: T): CellValue => {
  // SAFETY: T is the column's declared value type; only timestamp's wire form (epoch ms) differs from it
  return kind === "timestamp"
    ? (value as Temporal.Instant).epochMilliseconds
    : (value as CellValue);
};

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

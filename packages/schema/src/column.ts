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

/**
 * How a column merges when two devices wrote it while apart (D25) — declared on the column
 * itself, so the options a developer has appear at the moment they define it rather than in a
 * constructor they would have to already know about.
 *
 * Only numbers get `max` and `min`: those pick by value, and a meaningful larger-of-two needs an
 * order the app agrees with. Everything else takes the newest write.
 */
export type MergeFor<T> = [T] extends [number] ? StrategyName : "lww";

/** What the fold merges the column by; absent is {@link StrategyName}'s own default. */
export const strategyOf = (def: ColumnDef): StrategyName | undefined => def.merge;

/** What every `t.*` builder takes: how the column merges, and nothing else. */
export interface ColumnOptions<T> {
  readonly merge?: MergeFor<T>;
}

export interface ColumnDef {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly check?: StandardSchemaV1;
  readonly merge?: StrategyName;
}

/** A column: `def` is plain data, the methods return new columns. `T` is the app-facing value type. */
export interface Column<T, Nullable extends boolean = false, PrimaryKey extends boolean = false> {
  readonly def: ColumnDef;
  /** Gone once `primaryKey()` was called. */
  readonly nullable: PrimaryKey extends true ? never : () => Column<T, true, false>;
  /** Gone once `nullable()` was called: a key is required and unique per row. */
  readonly primaryKey: Nullable extends true ? never : () => Column<T, false, true>;
  readonly unique: () => Column<T, Nullable, PrimaryKey>;
  readonly check: <S extends StandardSchemaV1>(
    schema: S,
  ) => Column<Output<S> & T, Nullable, PrimaryKey>;
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
  };
  // SAFETY: the runtime column always carries every method; the Column type erases the ones whose
  // combination is meaningless (nullable on a key, primaryKey on a nullable column, any of
  // nullable/primaryKey/check on a lattice column), and table() panics on those combinations when
  // a def arrives from outside the builder
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

/** Applies the options every builder shares; absent `merge` leaves the default in place. */
const withOptions = <T>(def: ColumnDef, options?: ColumnOptions<T>): ColumnDef =>
  options?.merge === undefined ? def : { ...def, merge: options.merge };

/**
 * The column types, and the one option that changes how any of them merges.
 *
 * A number is a number: there is no separate constructor for a number that sums, because the
 * question "what happens when two devices write this at once" is a property of the column and not
 * a different kind of column. Ask it where the column is declared, and the answers are visible.
 */
export const t = {
  text: (options?: ColumnOptions<string>) =>
    columnFromDef<string, false, false>(withOptions(base("text"), options)),
  integer: (options?: ColumnOptions<number>) =>
    columnFromDef<number, false, false>(withOptions(base("integer"), options)),
  float: (options?: ColumnOptions<number>) =>
    columnFromDef<number, false, false>(withOptions(base("float"), options)),
  boolean: (options?: ColumnOptions<boolean>) =>
    columnFromDef<boolean, false, false>(withOptions(base("boolean"), options)),
  /** Epoch milliseconds on the wire; a `Temporal.Instant` to the app. */
  timestamp: (options?: ColumnOptions<Temporal.Instant>) =>
    columnFromDef<Temporal.Instant, false, false>(withOptions(base("timestamp"), options)),
  blob: (options?: ColumnOptions<Uint8Array>) =>
    columnFromDef<Uint8Array, false, false>(withOptions(base("blob"), options)),
  /** Canonical lowercase 8-4-4-4-12 only; never normalised, because rows are keyed by the string. */
  uuid: (options?: ColumnOptions<string>) =>
    columnFromDef<string, false, false>(withOptions(base("uuid"), options)),
  /** With a schema the type is inferred and the value checked; without one anything JSON is accepted and `T` is a phantom. */
  json,
};

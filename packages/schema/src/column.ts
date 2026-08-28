import type { Brand, DeclaredStrategyName, JsonValue, StrategyName } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import { panic } from "@syncmesh/result";

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
  | "uuid"
  | "counter"
  | "set";

/** The kinds whose merge happens inside the cell, which is also the name of the strategy they merge by. */
export type CellKind = "counter" | "set";

/**
 * Whether the column's kind *is* its merge strategy. A `counter` or `set` column carries the
 * strategy by being one, so `onConflict` on it is a definition error rather than a second opinion.
 */
export const isCellKind = (kind: ColumnKind): kind is CellKind =>
  kind === "counter" || kind === "set";

/**
 * What the fold merges the column by: its kind when the kind is a lattice, otherwise whatever
 * `onConflict` declared. The one place the two sources are reconciled, so a schema and the
 * `MergeSpec` built from it can never name different strategies for a column.
 */
export const strategyOf = (def: ColumnDef): StrategyName | undefined =>
  isCellKind(def.kind) ? def.kind : def.onConflict;

/**
 * What a `counter` column reads as: Σ of every peer's increments, less every peer's decrements.
 * A plain `number` is not assignable to it, and that is the point — a counter moves by an
 * `increment` change, never by assigning a total, which two devices would then overwrite for each
 * other.
 */
export type CounterValue = Brand<number, "CounterValue">;

/**
 * What a `set` column reads as: its live elements, each once, in id order. Not assignable from a
 * plain array for the same reason a counter is not assignable from a number — a set moves by `add`
 * and `remove`, which is what lets an add survive a concurrent removal.
 */
export type SetOf<T extends JsonValue> = Brand<readonly T[], "SetValue">;

/** Either lattice value, as the marker the column builder tests `T` against. */
export type LatticeValue = Brand<unknown, "CounterValue" | "SetValue">;

/**
 * Whether `T` is a lattice value. The brackets keep it one question about `T` itself rather than a
 * question distributed over the members of a union: a distributing form answers `boolean` for a
 * union that mixes a lattice value with anything else, which is neither `true` nor `false` and
 * matches neither branch of {@link StrategyFor}.
 *
 * It is **not** what keeps `max` and `min` away from `t.json()` — that is `StrategyFor`'s own
 * `[T] extends [number]`, and `t.json()`'s value type answers `false` here under either form.
 */
export type IsLattice<T> = [T] extends [LatticeValue] ? true : false;

/**
 * Which conflict strategies a column of value type `T` may declare: only numbers have a meaningful
 * max/min, and a lattice column declares none at all — `counter` and `set` merge inside the cell
 * and replace the value with lattice state, so a column gets them from its kind and never
 * from `onConflict`.
 */
export type StrategyFor<T> =
  IsLattice<T> extends true ? never : [T] extends [number] ? DeclaredStrategyName : "lww";

export interface ColumnDef {
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly check?: StandardSchemaV1;
  readonly onConflict?: DeclaredStrategyName;
  /** A `set` column's element definition: what each live element is checked against. */
  readonly element?: ColumnDef;
}

/** A column: `def` is plain data, the methods return new columns. `T` is the app-facing value type. */
export interface Column<T, Nullable extends boolean = false, PrimaryKey extends boolean = false> {
  readonly def: ColumnDef;
  /** Gone once `primaryKey()` was called, and on a lattice column, whose zero is empty rather than null. */
  readonly nullable: PrimaryKey extends true
    ? never
    : IsLattice<T> extends true
      ? never
      : () => Column<T, true, false>;
  /** Gone once `nullable()` was called: a key is required and unique per row. */
  readonly primaryKey: Nullable extends true
    ? never
    : IsLattice<T> extends true
      ? never
      : () => Column<T, false, true>;
  readonly unique: () => Column<T, Nullable, PrimaryKey>;
  /** Gone on a lattice column: the cell holds merge state, so a schema over it would check the wrong value. */
  readonly check: IsLattice<T> extends true
    ? never
    : <S extends StandardSchemaV1>(schema: S) => Column<Output<S> & T, Nullable, PrimaryKey>;
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
  /**
   * A PN-counter: every peer's own totals in the cell, Σ inc − Σ dec to the app. Two devices
   * that increment while apart both keep their increment.
   */
  counter: () => columnFromDef<CounterValue, false, false>(base("counter")),
  /**
   * An OR-Set of `element`'s values: an add that crossed a remove survives, because the
   * remove names the ids it had seen and never the value.
   */
  set: <T extends JsonValue>(element: Column<T, false, false>) => {
    if (isCellKind(element.def.kind))
      panic(
        `set(): a ${element.def.kind} column cannot be a set element — it is already a cell CRDT`,
      );
    return columnFromDef<SetOf<T>, false, false>({ ...base("set"), element: element.def });
  },
};

import type { Row, Table } from "@syncmesh/schema";
import type { AppValue } from "@syncmesh/schema";

import { Temporal } from "@syncmesh/temporal";
import { bytesToHex } from "@syncmesh/wire";

/** Row filter: a partial row matched structurally (shareable), or a predicate (never shared). */
export type Where<T extends Table> = Partial<Row<T>> | ((row: Row<T>) => boolean);

export type Direction = "asc" | "desc";

export type OrderBy<T extends Table> = readonly (readonly [
  keyof T["columns"] & string,
  Direction,
])[];

export interface QuerySpec<T extends Table> {
  readonly where?: Where<T>;
  readonly orderBy?: OrderBy<T>;
}

const valueOf = <T extends Table>(row: Row<T>, column: string): AppValue | undefined => {
  // SAFETY: Row<T> is an object whose values are the columns' app values
  return (row as Readonly<Record<string, AppValue | undefined>>)[column];
};

const rank = (value: AppValue | undefined): number =>
  value === null || value === undefined ? 0 : 1;

/* oxlint-disable anti-slop/no-runtime-typeof -- a comparator dispatches on the runtime type of the values it orders, like the serializer in wire's row codec */
/** One value as ordering text: bytes by hex, instants by time, everything else by JSON. */
const orderable = (value: NonNullable<AppValue>): number | string => {
  if (value instanceof Temporal.Instant) return value.epochMilliseconds;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value === true || value === false) return Number(value);
  return typeof value === "number" ? value : JSON.stringify(value);
};

/** Total order on app values: null first, then by value; bytes by hex, instants by time. */
export function compareValues(a: AppValue | undefined, b: AppValue | undefined): number {
  const byNull = rank(a) - rank(b);
  if (byNull !== 0 || a === null || a === undefined || b === null || b === undefined) return byNull;
  const left = orderable(a);
  const right = orderable(b);
  if (typeof left === "number" && typeof right === "number")
    return left === right ? 0 : left < right ? -1 : 1;
  const x = String(left);
  const y = String(right);
  return x === y ? 0 : x < y ? -1 : 1;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The spec's order, then the row key, so equal rows still have one stable position. */
export function compareRows<T extends Table>(
  orderBy: OrderBy<T> | undefined,
  a: { readonly key: string; readonly row: Row<T> },
  b: { readonly key: string; readonly row: Row<T> },
): number {
  for (const [column, direction] of orderBy ?? []) {
    const by = compareValues(valueOf(a.row, column), valueOf(b.row, column));
    if (by !== 0) return direction === "desc" ? -by : by;
  }
  return a.key === b.key ? 0 : a.key < b.key ? -1 : 1;
}

export function matches<T extends Table>(where: Where<T> | undefined, row: Row<T>): boolean {
  if (where === undefined) return true;
  if (where instanceof Function) return where(row);
  for (const [column, expected] of Object.entries(where)) {
    // SAFETY: a partial row's values are the columns' app values
    if (compareValues(valueOf(row, column), expected as AppValue) !== 0) return false;
  }
  return true;
}

/** A structural key for sharing; `undefined` when the spec cannot be shared (a predicate filter). */
export function specKey<T extends Table>(table: T, spec: QuerySpec<T>): string | undefined {
  if (spec.where instanceof Function) return undefined;
  return JSON.stringify([
    String(table.name),
    spec.where === undefined
      ? null
      : Object.entries(spec.where)
          .map(
            ([c, v]) =>
              [c, v instanceof Temporal.Instant ? `t:${v.epochMilliseconds}` : v] as const,
          )
          .sort(([x], [y]) => (x < y ? -1 : 1)),
    spec.orderBy ?? null,
  ]);
}

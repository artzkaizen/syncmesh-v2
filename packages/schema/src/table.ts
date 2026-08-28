import type { CellValue, ColumnName, TableName } from "@syncmesh/kernel";

import { isCellStrategy } from "@syncmesh/kernel";
import { Result, TaggedError, panic } from "@syncmesh/result";

import type { AnyColumn, ColumnDef, IsLattice, Value } from "./column.js";

import { KindMismatch, checkValue, scalarText, type ColumnError } from "./check.js";
import { isCellKind } from "./column.js";
import { parseColumnName, parseTableName } from "./names.js";

export type Columns = Readonly<Record<string, AnyColumn>>;

export interface Table<
  C extends Columns = Columns,
  PK extends keyof C & string = keyof C & string,
> {
  readonly name: TableName;
  readonly columns: C;
  readonly primaryKey: PK;
  /** `ColumnName` for every key of `columns`, validated once at definition time. */
  readonly columnNames: Readonly<Record<keyof C & string, ColumnName>>;
}

type IsPrimaryKey<Col> = Col extends { readonly __primaryKey?: infer P }
  ? unknown extends P
    ? boolean
    : P
  : never;
/** A column whose value merges inside the cell: it has no assignable form, so it is never inserted. */
type IsLatticeColumn<Col> = Col extends { readonly __value?: infer V }
  ? IsLattice<NonNullable<V>>
  : false;

/** Omittable on an insert: a nullable column reads as `null`, a lattice column as its empty state. */
type IsOptionalOnInsert<Col> = Col extends { readonly __nullable?: infer N }
  ? N extends true
    ? true
    : IsLatticeColumn<Col>
  : never;

export type PrimaryKey<C extends Columns> = {
  [K in keyof C & string]: IsPrimaryKey<C[K]> extends false ? never : K;
}[keyof C & string];

/** A full row as the app sees it. */
export type Row<T extends Table> = {
  readonly [K in keyof T["columns"]]: Value<T["columns"][K]>;
};

/** What `insert` requires: a nullable column may be omitted and reads as `null`, a lattice column as empty. */
export type InsertRow<T extends Table> = {
  readonly [
    K in keyof T["columns"] as IsOptionalOnInsert<T["columns"][K]> extends true ? never : K
  ]: Value<T["columns"][K]>;
} & {
  readonly [
    K in keyof T["columns"] as IsOptionalOnInsert<T["columns"][K]> extends true ? K : never
  ]?: Value<T["columns"][K]>;
};

/** Zero or two primary keys, a reserved name, or an invalid identifier — thrown at module load. */
export class InvalidTableDefinition extends Error {
  override readonly name = "InvalidTableDefinition";
}

/** The row key comes from this column: it must be keyable, present on every insert, and unique per row. */
function checkPrimaryKey(table: string, key: string, def: ColumnDef | undefined): void {
  if (def?.kind !== "text" && def?.kind !== "uuid" && def?.kind !== "integer") {
    panic(`${table}.${key}: a primary key must be text, uuid or integer, not ${String(def?.kind)}`);
  }
  if (def.nullable) panic(`${table}.${key}: a primary key cannot be nullable`);
}

/**
 * Where a column's merge strategy may come from, checked at runtime as well as in the types:
 * `fromDrizzle` and any JavaScript caller reach `onConflict` through a cast.
 *
 * A lattice column's kind **is** its strategy, so `onConflict` on one is a second opinion about a
 * settled question and a definition error. Its cell holds merge state rather than a value, which
 * is also why it is never null and why an app schema over it would be checking the wrong thing.
 * Naming a cell strategy on an ordinary column is the mirror error: it would read every plain
 * value that column ever held as the empty lattice and store `{}` in its place, on every peer.
 */
function checkStrategy(name: string, key: string, def: ColumnDef): void {
  if (isCellKind(def.kind)) {
    if (def.onConflict !== undefined)
      panic(
        `${name}.${key}: onConflict is not a ${def.kind} column's to declare — the kind is the strategy (E26)`,
      );
    if (def.nullable)
      panic(`${name}.${key}: a ${def.kind} column is never null; its zero is empty`);
    if (def.check !== undefined)
      panic(`${name}.${key}: check() on a ${def.kind} column would run against its merge state`);
    return;
  }
  if (def.onConflict === undefined || def.onConflict === "lww") return;
  if (isCellStrategy(def.onConflict)) {
    panic(
      `${name}.${key}: onConflict("${def.onConflict}") is not a column's to declare — that strategy comes from the column's kind (E26)`,
    );
  }
  if (def.kind !== "integer" && def.kind !== "float") {
    panic(`${name}.${key}: onConflict("${def.onConflict}") needs a numeric column`);
  }
}

export function table<const C extends Columns>(name: string, columns: C): Table<C, PrimaryKey<C>> {
  const parsedName = parseTableName(name);
  if (parsedName.isErr()) panic(`${name}: ${parsedName.error.message}`);
  const tableName = parsedName.value;
  const columnNames: Record<string, ColumnName> = {};
  for (const key of Object.keys(columns)) {
    const parsedColumn = parseColumnName(key);
    if (parsedColumn.isErr()) panic(`${name}.${key}: ${parsedColumn.error.message}`);
    columnNames[key] = parsedColumn.value;
  }
  const primaryKeys = Object.entries(columns)
    .filter(([, c]) => c.def.primaryKey)
    .map(([k]) => k);
  if (primaryKeys.length !== 1)
    panic(`${name}: expected exactly one primaryKey column, found ${primaryKeys.length}`);
  for (const [key, c] of Object.entries(columns)) checkStrategy(name, key, c.def);
  // SAFETY: exactly one primary key was found above and it is a key of C
  const primaryKey = primaryKeys[0] as PrimaryKey<C>;
  checkPrimaryKey(name, String(primaryKey), columns[primaryKey]?.def);
  // SAFETY: columnNames was built from Object.keys(columns), so its keys are exactly keyof C
  const names = columnNames as Table<C>["columnNames"];
  return { name: tableName, columns, primaryKey, columnNames: names };
}

export class UnknownColumn extends TaggedError("UnknownColumn")<{
  column: string;
  message: string;
}> {}

export class ColumnCheckFailed extends TaggedError("ColumnCheckFailed")<{
  column: string;
  cause: ColumnError;
  message: string;
}> {}

export type RowError = UnknownColumn | ColumnCheckFailed;

export type WireRow = Readonly<Record<string, CellValue | undefined>>;

/**
 * The row key an insert writes under: the primary-key cell's text. `checkValue` proves the cell
 * matches its keyable kind, so json, bytes, null and absence are all errors here, never keys.
 */
export function rowKeyText(t: Table, row: WireRow): Result<string, RowError> {
  const column = t.columns[t.primaryKey];
  if (column === undefined) {
    return Result.err(
      new UnknownColumn({
        column: t.primaryKey,
        message: `${String(t.name)} was not built by table()`,
      }),
    );
  }
  const value = row[t.primaryKey];
  return checkValue(column, value)
    .mapError(
      (cause) =>
        new ColumnCheckFailed({
          column: t.primaryKey,
          cause,
          message: `${t.primaryKey}: ${cause.message}`,
        }),
    )
    .andThen(() => {
      const text = scalarText(value);
      return text === undefined
        ? Result.err(
            new ColumnCheckFailed({
              column: t.primaryKey,
              cause: new KindMismatch({ expected: column.def.kind, message: "not a scalar key" }),
              message: `${t.primaryKey}: a key must be scalar`,
            }),
          )
        : Result.ok(text);
    });
}

/**
 * Validates wire-form values against the table. `insert` checks every column (an omitted
 * nullable or lattice column is fine); `update` checks only the columns present.
 */
export function checkRow(
  t: Table,
  row: WireRow,
  mode: "insert" | "update",
): Result<void, RowError> {
  for (const key of Object.keys(row)) {
    if (!(key in t.columns))
      return Result.err(
        new UnknownColumn({ column: key, message: `${String(t.name)} has no column ${key}` }),
      );
  }
  const keys = mode === "insert" ? Object.keys(t.columns) : Object.keys(row);
  for (const key of keys) {
    const column = t.columns[key];
    if (column === undefined) continue;
    const value = row[key];
    // omitted on an insert: a nullable column means `null`, a lattice column means its empty state,
    // and an absent lattice cell reads as that empty state on every peer alike
    if (
      mode === "insert" &&
      value === undefined &&
      (column.def.nullable || isCellKind(column.def.kind))
    )
      continue;
    const r = checkValue(column, value);
    if (r.isErr())
      return Result.err(
        new ColumnCheckFailed({
          column: key,
          cause: r.error,
          message: `${key}: ${r.error.message}`,
        }),
      );
  }
  return Result.ok(undefined);
}

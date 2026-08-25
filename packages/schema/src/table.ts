import type { CellValue, ColumnName, TableName } from "@syncmesh/kernel";

import { Result, TaggedError, panic } from "@syncmesh/result";

import type { AnyColumn, Value } from "./column.js";

import { checkValue, type ColumnError } from "./check.js";
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
type IsOptionalOnInsert<Col> = Col extends {
  readonly __nullable?: infer N;
  readonly __hasDefault?: infer D;
}
  ? N extends true
    ? true
    : D extends true
      ? true
      : false
  : never;

export type PrimaryKey<C extends Columns> = {
  [K in keyof C & string]: IsPrimaryKey<C[K]> extends false ? never : K;
}[keyof C & string];

/** A full row as the app sees it. */
export type Row<T extends Table> = {
  readonly [K in keyof T["columns"]]: Value<T["columns"][K]>;
};

/** What `insert` requires: nullable and defaulted columns may be omitted. */
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
  for (const [key, c] of Object.entries(columns)) {
    if (
      c.def.onConflict !== undefined &&
      c.def.onConflict !== "lww" &&
      c.def.kind !== "integer" &&
      c.def.kind !== "float"
    ) {
      panic(`${name}.${key}: onConflict("${c.def.onConflict}") needs a numeric column`);
    }
  }
  // SAFETY: exactly one primary key was found above and it is a key of C
  const primaryKey = primaryKeys[0] as PrimaryKey<C>;
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
 * Validates wire-form values against the table. `insert` checks every column (an omitted
 * defaulted or nullable column is fine); `update` checks only the columns present.
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
    if (mode === "insert" && value === undefined && (column.def.hasDefault || column.def.nullable))
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

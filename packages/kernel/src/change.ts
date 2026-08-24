import type { Brand } from "./primitives.js";
import type { CellValue, ColumnName } from "./record.js";

export type TableName = Brand<string, "TableName">;
export type RowKey = Brand<string, "RowKey">;

export type Row = ReadonlyMap<ColumnName, CellValue>;

export type Change =
  | { readonly kind: "insert"; readonly table: TableName; readonly key: RowKey; readonly row: Row }
  | {
      readonly kind: "update";
      readonly table: TableName;
      readonly key: RowKey;
      readonly patch: Row;
    }
  | { readonly kind: "delete"; readonly table: TableName; readonly key: RowKey };

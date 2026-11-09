import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind } from "@syncmesh/schema";

import type { SqlValue } from "./driver.js";

/*
 * How a column kind is spelled and bound in SQLite: the type a mesh-created column gets, and the
 * value a cell is bound as. The Postgres half is `dialect-postgres-cells.ts`.
 */

export const sqlType = (kind: ColumnKind): string => {
  switch (kind) {
    case "integer":
    case "timestamp":
    case "boolean":
      return "INTEGER";
    case "float":
      return "REAL";
    case "blob":
      return "BLOB";
    default:
      return "TEXT";
  }
};

export const sqliteCell = (kind: ColumnKind, cell: CellValue): SqlValue => {
  if (cell === null) return null;
  if (cell instanceof Uint8Array) return cell;
  switch (kind) {
    case "boolean":
      return cell === true ? 1 : 0;
    case "json":
      return JSON.stringify(cell);
    case "integer":
    case "float":
    case "timestamp":
      return Number(cell);
    default:
      // SAFETY: a text or uuid cell passed the column's kind check when it was written, so it is a string
      return cell as string;
  }
};

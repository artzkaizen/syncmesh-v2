import type { CellValue } from "@syncmesh/kernel";
import type { ColumnKind } from "@syncmesh/schema";

import type { SqlValue } from "./driver.js";

/*
 * How a column kind is spelled and bound in Postgres: the type a mesh-created column gets, and
 * the value a cell is bound as.
 */

/** What a Drizzle `pg-core` column of the kind would be, so a mesh-created table reads like the app's own. */
export const sqlType = (kind: ColumnKind): string => {
  switch (kind) {
    case "integer":
      return "BIGINT";
    case "float":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "timestamp":
      return "TIMESTAMPTZ";
    case "json":
      return "JSONB";
    case "blob":
      return "BYTEA";
    default:
      return "TEXT";
  }
};

/** A cell as the value the Postgres driver binds for a column of `kind`. */
export const postgresCell = (kind: ColumnKind, cell: CellValue): SqlValue => {
  if (cell === null) return null;
  if (cell instanceof Uint8Array) return cell;
  switch (kind) {
    case "boolean":
      return cell === true;
    case "json":
      return JSON.stringify(cell);
    case "timestamp":
      return new Date(Number(cell));
    case "integer":
    case "float":
      return Number(cell);
    default:
      // SAFETY: a text or uuid cell passed the column's kind check when it was written, so it is a string
      return cell as string;
  }
};

import type { CellValue, ColumnName, Row } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { ReadRefused } from "@syncmesh/window";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- a served row is whatever the handler selected; each value is checked here before it becomes a cell */

const isCell = (value: unknown): value is CellValue =>
  value === null ||
  value instanceof Uint8Array ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "object" && value.constructor === Object) ||
  Array.isArray(value);

/** One returned row as wire cells, keyed by the field names the handler selected. */
export const toRow = (record: Record<string, unknown>): Result<Row, ReadRefused> => {
  const cells = new Map<ColumnName, CellValue>();
  for (const [field, value] of Object.entries(record)) {
    const cell = value instanceof Uint8Array ? Uint8Array.from(value) : value;
    if (!isCell(cell))
      return Result.err(
        new ReadRefused({ message: `${field} holds a ${typeof value}, which no cell can carry` }),
      );
    // SAFETY: a selected field's name is the column name the client rebuilds the row under
    cells.set(field as ColumnName, cell);
  }
  return Result.ok(cells);
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

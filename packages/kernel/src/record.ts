import type { Brand } from "./primitives.js";

import { compareStamp, type Stamp } from "./stamp.js";

export type ColumnName = Brand<string, "ColumnName">;

export type CellValue = string | number | boolean | null;

export interface Cell {
  readonly value: CellValue;
  readonly stamp: Stamp;
}

export interface RowRecord {
  readonly cells: ReadonlyMap<ColumnName, Cell>;
  readonly writeStamp?: Stamp;
  readonly deleteStamp?: Stamp;
}

/** Whether the row is live: written, and never deleted or written after its latest delete. See RFC-0014 §1. */
export function isVisible(record: RowRecord): boolean {
  if (record.writeStamp === undefined) return false;
  return (
    record.deleteStamp === undefined || compareStamp(record.writeStamp, record.deleteStamp) > 0
  );
}

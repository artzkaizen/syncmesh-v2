import type { Brand } from "./primitives.js";

import { compareStamp, type Stamp } from "./stamp.js";

/** A column identifier within a table. */
export type ColumnName = Brand<string, "ColumnName">;

/** A value a cell can hold. JSON scalars for now; E26 adds richer kinds. */
export type CellValue = string | number | boolean | null;

/** One column's value and the stamp of the write that set it. */
export interface Cell {
  readonly value: CellValue;
  readonly stamp: Stamp;
}

/** A row as the kernel holds it: per-cell stamps for field-level merge, row-level stamps for existence. */
export interface RowRecord {
  readonly cells: ReadonlyMap<ColumnName, Cell>;
  /** Stamp of the latest insert or update. */
  readonly writeStamp: Stamp;
  /** Stamp of the latest delete; absent if the row was never deleted. */
  readonly deleteStamp?: Stamp;
}

/** Whether the row is live: never deleted, or written after its latest delete. See RFC-0014 §1. */
export function isVisible(record: RowRecord): boolean {
  return (
    record.deleteStamp === undefined || compareStamp(record.writeStamp, record.deleteStamp) > 0
  );
}

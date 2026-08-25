import type { PartitionKey } from "./partition.js";
import type { Brand } from "./primitives.js";

import { compareStamp, type Stamp } from "./stamp.js";

export type ColumnName = Brand<string, "ColumnName">;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** What a cell can hold: JSON, or raw bytes for `blob` columns. */
export type CellValue = JsonValue | Uint8Array;

export interface Cell {
  readonly value: CellValue;
  readonly stamp: Stamp;
}

export interface RowRecord {
  readonly cells: ReadonlyMap<ColumnName, Cell>;
  readonly writeStamp?: Stamp;
  readonly deleteStamp?: Stamp;
  /** The instance the row belongs to, fixed by the first write that reached it; absent for global, user and local tables. */
  readonly partition?: PartitionKey;
}

/** Whether the row is live: written, and never deleted or written after its latest delete. See RFC-0014 §1. */
export function isVisible(record: RowRecord): boolean {
  if (record.writeStamp === undefined) return false;
  return (
    record.deleteStamp === undefined || compareStamp(record.writeStamp, record.deleteStamp) > 0
  );
}

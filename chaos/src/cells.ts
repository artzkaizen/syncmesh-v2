import type { CellValue, ColumnName, Row, RowKey, TableName } from "@syncmesh/kernel";

/**
 * Names the engine takes, from the strings a schedule deals in.
 *
 * The brands exist so a column name cannot be confused with a value at a call site that means
 * one and was handed the other. A harness builds both from its own literals, so the check has
 * nothing left to catch here — this is where it is spent, once, rather than at every write.
 */

export const column = (name: string): ColumnName =>
  // SAFETY: the only names passed here are the four `schema.ts` declares; nothing outside this package reaches it
  name as ColumnName;

export const table = (name: string): TableName =>
  // SAFETY: the only table passed here is the one this package defines
  name as TableName;

export const key = (id: string): RowKey =>
  // SAFETY: keys are `n0`, `n1`, … built by the schedule from its own row numbers
  id as RowKey;

export const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [column(name), value]));

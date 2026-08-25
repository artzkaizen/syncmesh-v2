import type { CellValue, ColumnName, Row as WireCells } from "@syncmesh/kernel";

import { Temporal } from "@syncmesh/temporal";

import type { ColumnKind } from "./column.js";
import type { Row, Table } from "./table.js";

/** The app-facing value of one column; only `timestamp` differs from its wire form. */
export type AppValue = CellValue | Temporal.Instant;

export const toWireValue = (value: AppValue): CellValue =>
  value instanceof Temporal.Instant ? value.epochMilliseconds : value;

export const fromWireValue = (kind: ColumnKind, value: CellValue): AppValue =>
  kind === "timestamp" && !(value instanceof Uint8Array) && value !== null
    ? Temporal.Instant.fromEpochMilliseconds(Number(value))
    : value;

/** App values → wire cells for the columns present; `undefined` values are left out. */
export function toWireRow<T extends Table>(table: T, row: Partial<Row<T>>): WireCells {
  const cells = new Map<ColumnName, CellValue>();
  // SAFETY: Row<T> is an object keyed by the table's column names whose values are AppValues
  const given = row as Readonly<Record<string, AppValue | undefined>>;
  for (const name of Object.keys(table.columns)) {
    const value = given[name];
    const key = table.columnNames[name];
    if (value === undefined || key === undefined) continue;
    cells.set(key, toWireValue(value));
  }
  return cells;
}

/**
 * Wire cells → the app's row. A column the cells lack reads as its default, or `null` when nullable,
 * so an insert that omitted it and a row that never had it look the same.
 */
export function fromWireRow<T extends Table>(table: T, cells: WireCells): Row<T> {
  const row: Record<string, AppValue> = {};
  for (const [name, column] of Object.entries(table.columns)) {
    const key = table.columnNames[name];
    const cell = key === undefined ? undefined : cells.get(key);
    const value = cell ?? column.def.defaultValue ?? null;
    row[name] = fromWireValue(column.def.kind, value);
  }
  // SAFETY: every column of the table was set from its own cell, default or null — the shape Row<T> declares
  return row as Row<T>;
}

/** The wire row an insert writes: the given cells plus the defaults of the columns it omitted. */
export function withDefaults<T extends Table>(table: T, cells: WireCells): WireCells {
  const full = new Map(cells);
  for (const [name, column] of Object.entries(table.columns)) {
    const key = table.columnNames[name];
    if (key === undefined || full.has(key)) continue;
    if (column.def.hasDefault && column.def.defaultValue !== undefined)
      full.set(key, column.def.defaultValue);
    else if (column.def.nullable) full.set(key, null);
  }
  return full;
}

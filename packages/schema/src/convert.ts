import type { CellValue, ColumnName, Row as WireCells } from "@syncmesh/kernel";

import { counterValue, setValue } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import type { ColumnKind } from "./column.js";
import type { Row, Table } from "./table.js";

/** The app-facing value of one column: `timestamp`, `counter` and `set` differ from their wire form. */
export type AppValue = CellValue | Temporal.Instant;

export const toWireValue = (value: AppValue): CellValue =>
  value instanceof Temporal.Instant ? value.epochMilliseconds : value;

/**
 * The stored cell as the app reads it. A `counter` and a `set` are the two whose stored form is
 * merge state rather than a value — the app is shown the total and the live elements, which is
 * also why neither is assignable: there is no way back from what it read to what the cell holds.
 */
export const fromWireValue = (kind: ColumnKind, value: CellValue): AppValue => {
  if (kind === "counter") return counterValue(value);
  if (kind === "set") return setValue(value);
  return kind === "timestamp" && !(value instanceof Uint8Array) && value !== null
    ? Temporal.Instant.fromEpochMilliseconds(Number(value))
    : value;
};

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
 * Wire cells → the app's row. A column the cells lack reads as `null`: absence always means the
 * same thing, so an insert that omitted a nullable column and a row that never had it look the same.
 */
export function fromWireRow<T extends Table>(table: T, cells: WireCells): Row<T> {
  const row: Record<string, AppValue> = {};
  for (const [name, column] of Object.entries(table.columns)) {
    const key = table.columnNames[name];
    const cell = key === undefined ? undefined : cells.get(key);
    row[name] = fromWireValue(column.def.kind, cell ?? null);
  }
  // SAFETY: every column of the table was set from its own cell or null — the shape Row<T> declares
  return row as Row<T>;
}

/** Wire cells → a partial app row: only the columns present, nothing filled in. */
export function fromWirePatch<T extends Table>(table: T, cells: WireCells): Partial<Row<T>> {
  const row: Record<string, AppValue> = {};
  for (const [name, column] of Object.entries(table.columns)) {
    const key = table.columnNames[name];
    if (key === undefined || !cells.has(key)) continue;
    row[name] = fromWireValue(column.def.kind, cells.get(key) ?? null);
  }
  // SAFETY: every entry was set from its own column's cell — a subset of the shape Row<T> declares
  return row as Partial<Row<T>>;
}

/** The wire row an insert writes: the given cells plus explicit `null`s for omitted nullable columns. */
export function withNulls<T extends Table>(table: T, cells: WireCells): WireCells {
  const full = new Map(cells);
  for (const [name, column] of Object.entries(table.columns)) {
    const key = table.columnNames[name];
    if (key === undefined || full.has(key)) continue;
    if (column.def.nullable) full.set(key, null);
  }
  return full;
}

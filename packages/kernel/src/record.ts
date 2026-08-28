import type { PartitionKey } from "./partition.js";
import type { Brand } from "./primitives.js";

import { compareStamp, type Stamp } from "./stamp.js";

export type ColumnName = Brand<string, "ColumnName">;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

/** What a cell can hold: JSON, or raw bytes for `blob` columns. */
export type CellValue = JsonValue | Uint8Array;

/**
 * Narrows a JSON value to an array. `Array.isArray` alone cannot: its guard names the mutable
 * `any[]`, so a `readonly JsonValue[]` survives it in the union and every reader below has to
 * hand-wave the difference away with an assertion.
 */
export const isJsonArray = (value: CellValue | undefined): value is readonly JsonValue[] =>
  Array.isArray(value);

/* oxlint-disable anti-slop/no-runtime-typeof -- reading a foreign cell is an I/O boundary: its runtime shape is the fact being checked */
/**
 * The value as a JSON object, or `undefined` for anything else. The CRDT cells read every foreign
 * value through this one door: a truncated write, a wrong column kind or an outright lie becomes
 * the empty state on **every** peer alike, rather than throwing on one device and folding on another.
 */
export const jsonObject = (value: CellValue | undefined): JsonObject | undefined =>
  value !== null &&
  value !== undefined &&
  typeof value === "object" &&
  !isJsonArray(value) &&
  !(value instanceof Uint8Array)
    ? value
    : undefined;
/* oxlint-enable anti-slop/no-runtime-typeof */

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

/**
 * A JSON value as text with every object's keys sorted. Elements are compared by this and not by
 * `JSON.stringify`, whose output follows insertion order: the same element built by a local write
 * on one device and decoded from CBOR on another would otherwise compare unequal.
 */
export function canonicalJson(value: JsonValue): string {
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON's own shape is the contract: a value is a scalar or a container, and there is no earlier boundary to have parsed it at */
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
  return `{${fields.join(",")}}`;
}

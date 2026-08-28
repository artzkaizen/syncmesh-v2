import type { CellValue, ColumnName, JsonValue, Row } from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

import { isBoolean, isNumber, isString } from "./cbor-guards.js";

export class MalformedRow extends TaggedError("MalformedRow")<{ message: string }> {}

const malformed = (message: string) => Result.err(new MalformedRow({ message }));

/** A row as a CBOR map of column name to cell; the form event cores and persisted state share. */
export const rowToCbor = (row: Row): CborValue =>
  new Map<CborKey, CborValue>([...row].map(([c, v]) => [c, cellToCbor(v)]));

/* oxlint-disable anti-slop/no-runtime-typeof -- a serializer dispatches on the runtime type of what it encodes */
export const cellToCbor = (v: CellValue): CborValue => {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(cellToCbor);
  return new Map<CborKey, CborValue>(Object.entries(v).map(([k, x]) => [k, cellToCbor(x)]));
};
/* oxlint-enable anti-slop/no-runtime-typeof */

export function rowFromCbor(value: CborValue | undefined): Result<Row, MalformedRow> {
  if (!(value instanceof Map)) return malformed("row is not a map");
  const row = new Map<ColumnName, CellValue>();
  for (const [column, cell] of value) {
    if (!isString(column)) return malformed("column name is not text");
    const decoded = cellFromCbor(cell);
    if (decoded.isErr()) return decoded;
    // SAFETY: column naming rules are owned by the schema; the codec only requires text
    row.set(column as ColumnName, decoded.value);
  }
  return Result.ok(row);
}

/** Bytes are accepted only at the top of a cell; nested, they are refused. */
export function cellFromCbor(value: CborValue): Result<CellValue, MalformedRow> {
  if (value === null || isString(value) || isBoolean(value) || isNumber(value))
    return Result.ok(value);
  if (value instanceof Uint8Array) return Result.ok(value);
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const decoded = jsonFromCbor(item);
      if (decoded.isErr()) return decoded;
      items.push(decoded.value);
    }
    return Result.ok(items);
  }
  if (!(value instanceof Map)) return malformed("unsupported cell value");
  const object: Record<string, JsonValue> = {};
  for (const [k, v] of value) {
    if (!isString(k)) return malformed("json object keys must be text");
    const decoded = jsonFromCbor(v);
    if (decoded.isErr()) return decoded;
    object[k] = decoded.value;
  }
  return Result.ok(object);
}

function jsonFromCbor(value: CborValue): Result<JsonValue, MalformedRow> {
  if (value instanceof Uint8Array) return malformed("bytes are only allowed at the top of a cell");
  // SAFETY: bytes were excluded above and nested bytes are refused recursively, so what remains is JSON
  return cellFromCbor(value).map((v) => v as JsonValue);
}

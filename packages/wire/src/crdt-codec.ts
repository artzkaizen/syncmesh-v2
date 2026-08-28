import type {
  CellChange,
  ColumnName,
  CounterEntry,
  JsonValue,
  RowKey,
  SetAdd,
  SetTag,
  TableName,
} from "@syncmesh/kernel";

import { Result, TaggedError } from "@syncmesh/result";

import type { CborKey, CborValue } from "./cbor.js";

import { isSafeNonNegative, isString } from "./cbor-guards.js";
import { CHANGE } from "./event-codec.js";
import { cellFromCbor, cellToCbor } from "./row-codec.js";

export class MalformedCellChange extends TaggedError("MalformedCellChange")<{
  message: string;
}> {}

/**
 * The change kinds that merge inside a cell, continuing the row-level 0–2 (RFC-0002, E26). A peer
 * that does not know a kind refuses the event carrying it; that is why each kind is its own number
 * rather than a flag inside an `update`, which an old peer would fold as a plain value.
 */
export const CELL_KIND = { increment: 3, add: 4, remove: 5 } as const;

const malformed = (message: string) => Result.err(new MalformedCellChange({ message }));

const columns = <T>(
  source: ReadonlyMap<ColumnName, T>,
  payload: (value: T) => CborValue,
): CborValue => new Map<CborKey, CborValue>([...source].map(([c, v]) => [c, payload(v)]));

/** `increment` → `[inc, dec]`, `add` → `[id, element]`, `remove` → the ids, sorted so the bytes are canonical. */
const dataToCbor = (change: CellChange): CborValue => {
  if (change.kind === "increment") return columns(change.counts, (e) => [e.inc, e.dec]);
  if (change.kind === "add") return columns(change.adds, (a) => [a.tag, cellToCbor(a.value)]);
  return columns(change.drops, (drops) => [...drops].sort());
};

/** One cell-change in the same `{kind, table, key, data}` envelope every row-level change uses. */
export const encodeCellChange = (change: CellChange): CborValue =>
  new Map<CborKey, CborValue>([
    [CHANGE.kind, CELL_KIND[change.kind]],
    [CHANGE.table, change.table],
    [CHANGE.key, change.key],
    [CHANGE.data, dataToCbor(change)],
  ]);

function perColumn<T>(
  data: ReadonlyMap<CborKey, CborValue>,
  read: (value: CborValue) => Result<T, MalformedCellChange>,
): Result<ReadonlyMap<ColumnName, T>, MalformedCellChange> {
  const decoded = new Map<ColumnName, T>();
  for (const [column, payload] of data) {
    if (!isString(column)) return malformed("column name is not text");
    const value = read(payload);
    if (value.isErr()) return value;
    decoded.set(asColumn(column), value.value);
  }
  return Result.ok(decoded);
}

/** Both halves are lifetime totals, so a negative or fractional one is not a counter at all. */
const readEntry = (value: CborValue): Result<CounterEntry, MalformedCellChange> => {
  if (!Array.isArray(value) || value.length !== 2)
    return malformed("a counter total is not a pair");
  const [inc, dec] = value;
  if (!isSafeNonNegative(inc) || !isSafeNonNegative(dec))
    return malformed("counter totals are not non-negative integers");
  return Result.ok({ dec, inc });
};

const readAdd = (value: CborValue): Result<SetAdd, MalformedCellChange> => {
  if (!Array.isArray(value) || value.length !== 2) return malformed("an add is not [id, element]");
  const [tag, element] = value;
  if (!isString(tag) || tag.length === 0) return malformed("an add carries no id");
  if (element === undefined || element instanceof Uint8Array)
    return malformed("a set element must be JSON");
  return cellFromCbor(element)
    .mapError((e) => new MalformedCellChange({ message: e.message }))
    .map((decoded) => {
      // SAFETY: top-level bytes were refused above and cellFromCbor refuses nested ones, so what
      // came back is JSON
      return { tag: asTag(tag), value: decoded as JsonValue };
    });
};

const readDrops = (value: CborValue): Result<readonly SetTag[], MalformedCellChange> => {
  if (!Array.isArray(value)) return malformed("a remove is not a list of ids");
  const drops: SetTag[] = [];
  for (const tag of value) {
    if (!isString(tag) || tag.length === 0) return malformed("a removed id is not text");
    drops.push(asTag(tag));
  }
  return Result.ok(drops);
};

/**
 * Decodes one cell-change; refuses anything it cannot read whole. Never throws, and never guesses:
 * a payload it does not understand is an error rather than an empty column, because an empty
 * column would look like a legitimate state and spread.
 */
export function decodeCellChange(value: CborValue): Result<CellChange, MalformedCellChange> {
  if (!(value instanceof Map)) return malformed("change is not a map");
  const kind = value.get(CHANGE.kind);
  const table = value.get(CHANGE.table);
  const key = value.get(CHANGE.key);
  const data = value.get(CHANGE.data);
  if (!isString(table) || !isString(key)) return malformed("change table/key are not text");
  if (!(data instanceof Map)) return malformed("change data is not a map of columns");
  const at = { key: asKey(key), table: asTable(table) };
  if (kind === CELL_KIND.increment)
    return perColumn(data, readEntry).map((counts) => ({ ...at, counts, kind: "increment" }));
  if (kind === CELL_KIND.add)
    return perColumn(data, readAdd).map((adds) => ({ ...at, adds, kind: "add" }));
  if (kind === CELL_KIND.remove)
    return perColumn(data, readDrops).map((drops) => ({ ...at, drops, kind: "remove" }));
  return malformed("unknown cell change kind");
}

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- each brand below is applied right after the check that establishes it; naming rules for these identifiers are owned by the schema (E05) */
const asTable = (s: string) => s as TableName;
const asKey = (s: string) => s as RowKey;
const asColumn = (s: string) => s as ColumnName;
const asTag = (s: string) => s as SetTag;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

import type { Packing, RowKey, RowRecord, State, TableName, TableState } from "@syncmesh/kernel";

import { createPackedMap, isPackedMap } from "@syncmesh/kernel";
import { panic } from "@syncmesh/result";
import { packRecord, unpackRecord } from "@syncmesh/wire";

/**
 * Rows per table the engine keeps as objects: the latest written or read. Every other row is held
 * as its packed bytes and decoded when it is asked for (gaps O1, O17).
 */
export const WARM_ROWS = 10_000;

/**
 * A packed row that will not decode is a corrupt cache, and there is no honest value to return:
 * reading it as absent would let the next write merge onto nothing.
 */
const unpackRow = (bytes: Uint8Array): RowRecord => {
  const decoded = unpackRecord(bytes);
  if (decoded.isOk()) return decoded.value;
  return panic(
    `the state cache holds a record that will not decode: ${decoded.error.message} — clear it and rejoin from a peer`,
    decoded.error,
  );
};

const ROWS = {
  pack: packRecord,
  unpack: unpackRow,
  isPacked: (slot): slot is Uint8Array => slot instanceof Uint8Array,
  warm: WARM_ROWS,
} satisfies Packing<RowRecord, Uint8Array>;

/**
 * A table whose rows past {@link WARM_ROWS} are held packed (`packRecord`). `rows` may hold
 * records a fold made, or bytes in either record encoding: a store's, read back at boot.
 *
 * @example
 * const table = packedTable(new Map([[key, encodeRecord(record)]]));
 * table.get(key); // the record, decoded
 */
export const packedTable = (rows: ReadonlyMap<RowKey, RowRecord | Uint8Array>): TableState =>
  createPackedMap(rows, ROWS);

/** `state` with every table packed; `state` itself when every table already is. */
export function packState(state: State): State {
  let packed: Map<TableName, TableState> | undefined;
  for (const [name, table] of state)
    if (!isPackedMap(table)) (packed ??= new Map(state)).set(name, packedTable(table));
  return packed ?? state;
}

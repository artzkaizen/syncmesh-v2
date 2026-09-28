import type { RowKey, RowRecord, TableState } from "@syncmesh/kernel";

import { panic } from "@syncmesh/result";
import { decodeRecord } from "@syncmesh/wire";

/**
 * A table's rows as the bytes they were stored as, decoded one at a time on the way out.
 *
 * The state cache exists to answer merge, not reads. A read goes to the app's own tables over SQL
 * (D20); what the in-memory state holds is the per-cell stamps a fold needs to decide which of two
 * writes wins — and a fold asks for exactly the rows its events name, one `(table, key)` at a
 * time. Decoding the whole cache to open a database therefore pays, up front and on the thread
 * that draws, for rows nothing is going to ask about: a replica of a few hundred issues carries
 * thousands of cells, each of which costs a `Temporal.Instant` and a peer id to rebuild.
 *
 * So the bytes are kept and the decode is deferred to the first `get` of each key. What a caller
 * sees is an ordinary `ReadonlyMap`: `size`, `has` and `keys` are answered from the bytes without
 * decoding anything, and iteration decodes as it goes.
 *
 * **Iterating is not free, and one caller does it on purpose.** `withRecord` copies a table with
 * `new Map(table)` before writing a row, which decodes that table in full. That is the intended
 * shape rather than a leak: the first write to a table pays for that table, once, away from boot,
 * and a table this session never writes is never decoded at all.
 */
export function lazyTable(bytes: ReadonlyMap<RowKey, Uint8Array>): TableState {
  const decoded = new Map<RowKey, RowRecord>();

  const get = (key: RowKey): RowRecord | undefined => {
    const already = decoded.get(key);
    if (already !== undefined) return already;
    const stored = bytes.get(key);
    if (stored === undefined) return undefined;
    const record = decodeRecord(stored);
    /**
     * A record that will not decode is a corrupt cache, and there is no honest value to return.
     *
     * Eager loading could report this as `StateCorrupt` and let boot clear the cache and rebuild
     * from the log; deferring the decode moves the discovery to whenever the row is first touched,
     * which is the one thing laziness genuinely costs here. Returning `undefined` would be worse
     * than a crash: the fold would read the row as absent and merge the next write onto nothing,
     * turning a damaged byte range into silently wrong data.
     */
    if (record.isErr())
      return panic(
        `the state cache holds a record that will not decode (${String(key)}): ${record.error.message} — clear it and rejoin from a peer`,
        record.error,
      );
    decoded.set(key, record.value);
    return record.value;
  };

  const entries = function* (): MapIterator<[RowKey, RowRecord]> {
    for (const key of bytes.keys()) {
      const record = get(key);
      if (record !== undefined) yield [key, record];
    }
  };

  const values = function* (): MapIterator<RowRecord> {
    for (const [, record] of entries()) yield record;
  };

  return {
    get,
    entries,
    values,
    has: (key) => bytes.has(key),
    keys: () => bytes.keys(),
    /* oxlint-disable-next-line anti-slop/no-unknown-parameters -- `Map.forEach`'s own signature: `thisArg` is whatever the caller binds, and narrowing it would stop this being a `ReadonlyMap` */
    forEach(run, thisArg?: unknown) {
      for (const [key, record] of entries()) run.call(thisArg, record, key, this);
    },
    [Symbol.iterator]: entries,
    get size() {
      return bytes.size;
    },
  };
}

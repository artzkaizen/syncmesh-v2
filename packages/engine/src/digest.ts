import type { RowKey, RowRecord, State, TableName } from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { encodeRecord } from "@syncmesh/wire";

import type { FoldBatch } from "./engine.js";

/**
 * Divergence, detected cheaply and healed by the ordinary merge (RFC-0014). A digest is a **sum**
 * mod 2^64 of each row's hash, never an XOR: XOR self-cancels, so a row present twice — the exact
 * shape a replication bug produces — would digest identical to its absence.
 *
 * The sum is order-free, which is the point: two peers that folded the same events in different
 * orders agree, and an absent table digests as an empty one, because both are the empty sum.
 */

const MOD = 1n << 64n;

/** A row's contribution: the first 8 bytes of the hash of its canonical record encoding. */
export function rowDigest(record: RowRecord): bigint {
  const hash = sha256(encodeRecord(record));
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(hash[i] ?? 0);
  return value;
}

const sum = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const value of values) total = (total + value) % MOD;
  return total;
};

/** One table's digest, and the digest of every table, as the fingerprints a peer compares. */
export type TableDigests = ReadonlyMap<TableName, bigint>;

/** Per table, the sum of its rows' digests. A table with no rows is absent, not zero-valued. */
export function tableDigests(state: State): TableDigests {
  const digests = new Map<TableName, bigint>();
  for (const [table, rows] of state) {
    if (rows.size === 0) continue; // an empty table and an absent one are the same fact
    digests.set(table, sum([...rows.values()].map(rowDigest)));
  }
  return digests;
}

/** Every row's digest in one table, keyed — what narrows a divergent table to divergent rows. */
export function rowDigests(state: State, table: TableName): ReadonlyMap<RowKey, bigint> {
  const rows = state.get(table);
  if (rows === undefined) return new Map();
  return new Map([...rows].map(([key, record]) => [key, rowDigest(record)]));
}

/** The tables whose digests differ — including one present on only one side. */
export function divergentTables(ours: TableDigests, theirs: TableDigests): readonly TableName[] {
  const names = new Set([...ours.keys(), ...theirs.keys()]);
  return [...names].filter((name) => ours.get(name) !== theirs.get(name)).sort();
}

/** The keys in one table whose digests differ — what `rowRecords` is then asked for. */
export function divergentRows(
  ours: ReadonlyMap<RowKey, bigint>,
  theirs: ReadonlyMap<RowKey, bigint>,
): readonly RowKey[] {
  const keys = new Set([...ours.keys(), ...theirs.keys()]);
  return [...keys].filter((key) => ours.get(key) !== theirs.get(key)).sort();
}

/** One row and what it is, as the two sides of a repair hand it over. */
export interface RepairRow {
  readonly key: RowKey;
  readonly record: RowRecord;
}

/**
 * What an engine offers for divergence (RFC-0014): fingerprints out, records in. Two peers that
 * folded the same events agree whatever order the events arrived in; a table only one of them
 * has shows as a difference, and an empty table is the same fact as an absent one.
 */
export interface RepairApi {
  /** A fingerprint per table — the sum of its rows' digests. */
  readonly digest: () => TableDigests;
  /** Every row's digest in one table: what narrows a divergent table to the rows that differ. */
  readonly rowDigests: (table: TableName) => ReadonlyMap<RowKey, bigint>;
  /** The records behind those keys, to hand the other side. */
  readonly rowRecords: (table: TableName, keys: readonly RowKey[]) => readonly RepairRow[];
  /**
   * Heals divergence by merging the other side's records — the ordinary field-level merge, so it
   * is commutative and safe to run in both directions. Adopts **no** cursors: a repaired row says
   * what it is, never that this peer has seen the events behind it.
   */
  readonly repairRows: (table: TableName, records: readonly RepairRow[]) => Promise<void>;
}

export interface RepairDeps {
  readonly stateOf: () => State;
  readonly mergeInto: (table: TableName, key: RowKey, record: RowRecord) => void;
  readonly persist: (batch: FoldBatch) => Promise<void>;
  readonly notify: (batch: FoldBatch) => void;
}

/**
 * The engine's divergence surface: fingerprints out, records in. Repair is the ordinary
 * field-level merge, which makes it commutative — both sides can run it, in either order, and
 * land on the same rows — and it adopts no cursors, because a repaired row says what it *is*,
 * never that this peer has seen the events behind it.
 */
export function createRepairPath(deps: RepairDeps): RepairApi {
  const { stateOf, mergeInto, persist, notify } = deps;
  return {
    digest: (): TableDigests => tableDigests(stateOf()),
    rowDigests: (table: TableName): ReadonlyMap<RowKey, bigint> => rowDigests(stateOf(), table),
    rowRecords: (table: TableName, keys: readonly RowKey[]): readonly RepairRow[] => {
      const rows = stateOf().get(table);
      return keys.flatMap((key) => {
        const record = rows?.get(key);
        return record === undefined ? [] : [{ key, record }];
      });
    },
    repairRows: async (table: TableName, records: readonly RepairRow[]): Promise<void> => {
      if (records.length === 0) return; // nothing to heal is not an event
      for (const { key, record } of records) mergeInto(table, key, record);
      const batch: FoldBatch = {
        source: "repair",
        eventCount: records.length,
        writeTables: new Set([table]),
        writeKeys: new Map([[table, new Set(records.map((r) => r.key))]]),
      };
      await persist(batch);
      notify(batch);
    },
  };
}

import type { KeyedRecord, PartitionKey, RowKey, State, TableName } from "@syncmesh/kernel";

import { mergeRecord } from "@syncmesh/kernel";

import type { FoldBatch } from "./engine.js";
import type { Interest } from "./interest.js";
import type { Coverage } from "./sync.js";

import { interestText, rowsIn } from "./interest.js";

/**
 * State instead of history (RFC-0019). A device joining a room with 300k events does not want
 * 300k events; it wants the rows those events settle to, and the right to say it has them.
 *
 * A snapshot is exactly that pair: the records, and the coverage they represent. The coverage is
 * the dangerous half — adopting it is what stops the device asking for those events again, so it
 * is adopted **only** once every row has been installed. A snapshot that is incomplete for its
 * scope and adopted anyway loses the missing rows forever.
 */
export interface Snapshot {
  /** Every row in scope, tombstones included — a delete is a fact the joiner needs as much as a value. */
  readonly rows: readonly SnapshotRow[];
  /** What the sender had folded when it took this; the joiner adopts it only after installing. */
  readonly coverage: Coverage;
  /** The slice these rows are complete for; `undefined` means the sender's whole state. */
  readonly scope?: Interest;
}

/** One addressed row of a snapshot — the kernel's {@link KeyedRecord}, under the name this uses. */
export type SnapshotRow = KeyedRecord;

/** What `installSnapshot` did, for a caller that wants to say so. */
export interface Installed {
  readonly rows: number;
  /** The batch the fold notified with — one for the whole snapshot, however many rows it held. */
  readonly batch: FoldBatch;
}

export interface SnapshotOptions {
  /** Only the rows this names; the snapshot then claims completeness for that slice alone. */
  readonly interest?: Interest;
}

/**
 * The rows a peer holds, as one transferable value.
 *
 * ```ts
 * const snap = snapshotOf(engine.state(), engine.coverage(), { interest: { partitions: [board] } })
 * ```
 */
export function snapshotOf(
  state: State,
  coverage: Coverage,
  options: SnapshotOptions = {},
): Snapshot {
  const { interest } = options;
  const rows: SnapshotRow[] = [];
  for (const [table, records] of state) {
    for (const [key, record] of records) {
      // tombstones travel: without them a joiner would resurrect every row anyone deleted
      if (rowsIn(record, interest)) rows.push({ table, key, record });
    }
  }
  return interest === undefined ? { rows, coverage } : { rows, coverage, scope: interest };
}

/** What a snapshot install needs of the engine it lands in. */
export interface InstallDeps {
  readonly getState: () => State;
  readonly setState: (next: State) => void;
  readonly adopt: (coverage: Coverage) => void;
  readonly persist: (batch: FoldBatch) => Promise<void>;
  readonly notify: (batch: FoldBatch) => void;
  readonly merge?: Parameters<typeof mergeRecord>[4];
}

/**
 * Merges a snapshot's rows and, only then, adopts the coverage they stand for. Every row goes
 * through the ordinary field-level merge, which is what makes an install safe to repeat, safe to
 * interleave with live events, and unable to resurrect a tombstone: a delete stamp already newer
 * than the snapshot's write simply wins, as it would from any other source.
 *
 * One fold batch for the whole snapshot, so a joining device renders once rather than per row.
 */
export async function installSnapshot(deps: InstallDeps, snapshot: Snapshot): Promise<Installed> {
  const { getState, setState, adopt, persist, notify, merge } = deps;
  let state = getState();
  const writeKeys = new Map<TableName, Set<RowKey>>();
  for (const { table, key, record } of snapshot.rows) {
    state = mergeRecord(state, table, key, record, merge);
    const keys = writeKeys.get(table) ?? new Set<RowKey>();
    keys.add(key);
    writeKeys.set(table, keys);
  }
  setState(state);
  const batch: FoldBatch = {
    source: "snapshot",
    eventCount: snapshot.rows.length,
    writeTables: new Set(writeKeys.keys()),
    writeKeys,
  };
  await persist(batch);
  // the coverage is adopted last and only here: until the rows are durable, claiming to hold
  // the events behind them would turn a failed install into permanent, silent loss.
  // A scoped snapshot's coverage is adopted *as scoped* (D23): the rows are complete for that
  // slice and for no more, and a number that does not say so reads as the stronger claim
  adopt(
    snapshot.scope === undefined
      ? snapshot.coverage
      : { ...snapshot.coverage, scope: interestText(snapshot.scope) },
  );
  if (snapshot.rows.length > 0) notify(batch);
  return { rows: snapshot.rows.length, batch };
}

/** The instances a snapshot's rows actually came from — what a receiver checks its own pin against. */
export const partitionsIn = (snapshot: Snapshot): readonly PartitionKey[] => {
  const seen = new Set<PartitionKey>();
  for (const { record } of snapshot.rows)
    if (record.partition !== undefined) seen.add(record.partition);
  return [...seen];
};

/** What an engine offers for joining by state rather than by history (RFC-0019). */
export interface SnapshotApi {
  readonly snapshot: (options?: SnapshotOptions) => Snapshot;
  readonly installSnapshot: (snapshot: Snapshot) => Promise<Installed>;
}

/** Both halves against one engine's state, so `createEngine` states the wiring once. */
export function createSnapshotPath(
  deps: InstallDeps & { readonly coverageOf: () => Coverage },
): SnapshotApi {
  return {
    snapshot: (options) => snapshotOf(deps.getState(), deps.coverageOf(), options),
    installSnapshot: (snap) => installSnapshot(deps, snap),
  };
}

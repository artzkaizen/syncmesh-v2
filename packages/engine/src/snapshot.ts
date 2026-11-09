import type {
  DocColumns,
  Hlc,
  KeyedRecord,
  LineageCellRefused,
  MergeSpec,
  PartitionKey,
  RowKey,
  RowRecord,
  Stamp,
  State,
  TableName,
} from "@syncmesh/kernel";

import {
  codePointOrder,
  compareStamp,
  isVisible,
  keyedRecords,
  mergeRecord,
  parseLineageCells,
  readLineageCell,
} from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { FoldBatch } from "./engine.js";
import type { Interest, InterestWindow } from "./interest.js";
import type { Coverage } from "./sync.js";
import type { Validator } from "./validate.js";

import { interestText, rowsIn, wholeWindow } from "./interest.js";
import { lineageMoves } from "./lineage-moves.js";

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
  /**
   * Only the rows this names; the snapshot then claims completeness for that slice alone. A
   * `window` keeps the newest rows of the slice and every tombstone in it ({@link windowRows}).
   */
  readonly interest?: Interest;
  /**
   * Tables whose rows never leave this device — the schema's `local` kind
   * (`Validator.localTable`). Their rows are left out of the snapshot, as their events are left
   * out of every sync (gaps U36). Absent, every table travels.
   */
  readonly localTable?: (table: TableName) => boolean;
}

/**
 * The rows a peer holds, as one transferable value.
 *
 * ```ts
 * const snap = stateSnapshot(engine.state(), engine.coverage(), { interest: { partitions: [board] } })
 * ```
 */
export function stateSnapshot(
  state: State,
  coverage: Coverage,
  options: SnapshotOptions = {},
): Snapshot {
  const { interest, localTable } = options;
  // tombstones travel: without them a joiner would resurrect every row anyone deleted; a local
  // table's rows never do, whatever the interest, because nothing but this device may hold them
  const sliced = [...keyedRecords(state)].filter(
    ({ table, record }) => localTable?.(table) !== true && rowsIn(record, interest),
  );
  const window = wholeWindow(interest?.window);
  const rows = window === undefined ? sliced : windowRows(sliced, window);
  // the floor and the held run are this device's own account of its log, never part of what it
  // claims to a joiner
  const { floor: _ownFloor, held: _ownHeld, ...claimed } = coverage;
  return interest === undefined
    ? { rows, coverage: claimed }
    : { rows, coverage: claimed, scope: interest };
}

/**
 * The rows a window keeps (RFC-0019 §3): the `newest` live rows by each row's newest stamp, ties
 * broken by table and then key in code-point order, and every tombstone whatever its age — a
 * device that already holds a row outside the window must still learn it died. The rows keep the
 * order they came in. Both runtimes keep the same rows (`conformance/interest-vectors.json`).
 *
 * @example
 * windowRows(rows, { newest: 2 }); // the two most recently written live rows, and every delete
 */
export function windowRows(
  rows: readonly SnapshotRow[],
  window: InterestWindow,
): readonly SnapshotRow[] {
  const ranked = rows
    .filter(({ record }) => isVisible(record))
    .map((row) => ({ row, stamp: newestStamp(row.record) }))
    .sort(byRecency);
  const kept = new Set(ranked.slice(0, window.newest).map(({ row }) => row));
  return rows.filter((row) => kept.has(row) || !isVisible(row.record));
}

interface Ranked {
  readonly row: SnapshotRow;
  readonly stamp: Stamp | undefined;
}

/** Newest first; then table, then key, so two rows one event wrote have one order everywhere. */
const byRecency = (a: Ranked, b: Ranked): number => {
  if (a.stamp !== undefined && b.stamp !== undefined) {
    const order = compareStamp(b.stamp, a.stamp);
    if (order !== 0) return order;
  } else if (a.stamp !== b.stamp) return a.stamp === undefined ? 1 : -1;
  return codePointOrder(a.row.table, b.row.table) || codePointOrder(a.row.key, b.row.key);
};

/** The latest stamp anywhere in a record: its write, its delete, or any cell's. */
const newestStamp = (record: RowRecord): Stamp | undefined => {
  let newest = record.deleteStamp;
  const candidates = [record.writeStamp, ...[...record.cells.values()].map((cell) => cell.stamp)];
  for (const stamp of candidates)
    if (stamp !== undefined && (newest === undefined || compareStamp(stamp, newest) > 0))
      newest = stamp;
  return newest;
};

/** What a snapshot install needs of the engine it lands in. */
export interface InstallDeps {
  readonly getState: () => State;
  readonly setState: (next: State) => void;
  readonly adopt: (coverage: Coverage) => void;
  readonly persist: (batch: FoldBatch) => Promise<void>;
  /** Commits the coverage just adopted, rows already durable, so neither waits for the next fold. */
  readonly persistCoverage: () => Promise<void>;
  readonly notify: (batch: FoldBatch) => void;
  readonly merge?: MergeSpec | undefined;
  /** The mesh's doc columns: their cells are checked before anything joins, and their moves relabelled. */
  readonly docs?: DocColumns | undefined;
  /** The engine's clock, told every stamp a row brings in ({@link rowStamps}). */
  readonly receive?: (hlc: Hlc) => void;
}

/**
 * Merges a snapshot's rows and, only then, adopts the coverage they stand for. Every row goes
 * through the ordinary field-level merge, which is what makes an install safe to repeat, safe to
 * interleave with live events, and unable to resurrect a tombstone: a delete stamp already newer
 * than the snapshot's write simply wins, as it would from any other source.
 *
 * A page holding a lineage cell of a rule this build does not run is refused whole, before any
 * row joins: nothing is installed and no coverage is adopted, so the history behind it still
 * arrives as events (RFC-0023 §16.1). A document whose winning lineage the rows move has its doc
 * log relabelled in the same persist step.
 *
 * One fold batch for the whole snapshot, so a joining device renders once rather than per row.
 */
export async function installSnapshot(
  deps: InstallDeps,
  snapshot: Snapshot,
): Promise<Result<Installed, LineageCellRefused>> {
  const { getState, setState, adopt, persist, persistCoverage, notify, merge, docs, receive } =
    deps;
  const checked = docs === undefined ? undefined : parseLineageCells(snapshot.rows, docs);
  if (checked?.isErr() === true) return Result.err(checked.error);
  const before = getState();
  let state = before;
  const writeKeys = new Map<TableName, Set<RowKey>>();
  for (const row of snapshot.rows) {
    const { table, key, record } = row;
    if (receive !== undefined) for (const hlc of rowStamps(row, docs)) receive(hlc);
    state = mergeRecord(state, table, key, record, merge);
    const keys = writeKeys.get(table) ?? new Set<RowKey>();
    keys.add(key);
    writeKeys.set(table, keys);
  }
  setState(state);
  const moves = docs === undefined ? [] : lineageMoves(before, state, snapshot.rows, docs);
  const batch: FoldBatch = {
    source: "snapshot",
    eventCount: snapshot.rows.length,
    writeTables: new Set(writeKeys.keys()),
    writeKeys,
    ...(moves.length > 0 && { lineageMoves: moves }),
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
  await persistCoverage();
  if (snapshot.rows.length > 0) notify(batch);
  return Result.ok({ rows: snapshot.rows.length, batch });
}

/** The instances a snapshot's rows actually came from — what a receiver checks its own pin against. */
export const partitionsIn = (snapshot: Snapshot): readonly PartitionKey[] => {
  const seen = new Set<PartitionKey>();
  for (const { record } of snapshot.rows)
    if (record.partition !== undefined) seen.add(record.partition);
  return [...seen];
};

/**
 * Every clock reading a row carries: its write and delete stamps, each cell's stamp, and, in a doc
 * column's lineage cell, each genesis's stamp and the anchor's. What an engine's clock receives
 * from a row that joins outside an event, so a genesis it writes next is stamped after every one
 * it adopted (gaps U21).
 */
export function* rowStamps(row: KeyedRecord, docs: DocColumns | undefined): Iterable<Hlc> {
  const { record } = row;
  if (record.writeStamp !== undefined) yield record.writeStamp.hlc;
  if (record.deleteStamp !== undefined) yield record.deleteStamp.hlc;
  for (const cell of record.cells.values()) yield cell.stamp.hlc;
  for (const column of docs?.get(row.table)?.keys() ?? []) {
    const cell = readLineageCell(record.cells.get(column)?.value);
    for (const genesis of cell.geneses) yield genesis.stamp.hlc;
    if (cell.settled !== undefined) yield cell.settled.stamp.hlc;
  }
}

/** What an engine offers for joining by state rather than by history (RFC-0019). */
export interface SnapshotApi {
  readonly snapshot: (options?: SnapshotOptions) => Snapshot;
  readonly installSnapshot: (snapshot: Snapshot) => Promise<Result<Installed, LineageCellRefused>>;
}

/** Both halves against one engine's state, so `createEngine` states the wiring once. */
export function createSnapshotPath(
  /** The engine's doc columns, and its validator, whose `localTable` names the `local` kind. */
  settings: { readonly docs?: DocColumns | undefined; readonly validate?: Validator | undefined },
  deps: Omit<InstallDeps, "docs"> & { readonly coverageOf: () => Coverage },
): SnapshotApi {
  const installing = { ...deps, docs: settings.docs };
  const localTable = settings.validate?.localTable;
  return {
    snapshot: (options) =>
      stateSnapshot(
        deps.getState(),
        deps.coverageOf(),
        localTable === undefined ? options : { localTable, ...options },
      ),
    installSnapshot: (snap) => installSnapshot(installing, snap),
  };
}

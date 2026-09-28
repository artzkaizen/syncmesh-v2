import type { Coverage, EventHeader } from "@syncmesh/engine";
import type { Hlc, PartitionKey, PeerId, SeqNum } from "@syncmesh/kernel";

import { StateCorrupt, StoreFailure } from "@syncmesh/engine";
import { eventId, hlcOf, parsePartitionKey, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlRow, SqlValue, SqlDriver } from "./driver.js";

export const failure = (message: string) => (cause: unknown) =>
  new StoreFailure({ message, cause });

/** Runs `fn`, turning anything it throws into a `StoreFailure`. */
export const attempt = <T>(message: string, fn: () => Promise<T>) =>
  Result.tryPromise({ try: fn, catch: failure(message) });

const queues = new WeakMap<SqlDriver, Promise<unknown>>();

/**
 * Runs `fn` in this driver's turn: later callers wait for earlier ones, in call order, whatever
 * the earlier one settled as. A connection does one thing at a time, and this is the one queue
 * that says so — every transaction on this driver takes a turn in it, so a bare statement that
 * takes one cannot land inside somebody else's open transaction.
 *
 * A body must not take a second turn on the same driver: it would wait for itself.
 */
export const onConnection = <T>(driver: SqlDriver, fn: () => Promise<T>): Promise<T> => {
  const turn = (queues.get(driver) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    driver,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
};

/**
 * Runs `fn` in one transaction where the driver offers one, and in the driver's turn
 * ({@link onConnection}): the app's captured transaction and the fold's commit share a
 * connection, and SQLite cannot open a transaction inside another.
 */
export const inTransaction = <T>(driver: SqlDriver, fn: () => Promise<T>): Promise<T> => {
  if (driver.transaction === undefined) return fn();
  const { transaction } = driver;
  return onConnection(driver, () => transaction(fn));
};

/** A `MAX(seq)`-style cell: NULL is absent, anything else must be a sequence number. */
export const seqOf = (value: SqlValue | undefined): Result<SeqNum | undefined, StoreFailure> =>
  value === null || value === undefined
    ? Result.ok(undefined)
    : parseSeqNum(Number(value)).mapError(failure("stored sequence number is invalid"));

/** A `(peer, local, seq)` row of a cursor table; damage is `StateCorrupt`. */
export function decodeCursor(
  row: SqlRow,
): Result<readonly [PeerId, boolean, SeqNum], StateCorrupt | StoreFailure> {
  const [peer, local, seq] = row;
  return Result.gen(function* () {
    const peerId = yield* parsePeerId(String(peer)).mapError(
      (e) => new StateCorrupt({ message: e.message }),
    );
    const seqNum = yield* seqOf(seq);
    if (seqNum === undefined)
      return Result.err(new StateCorrupt({ message: "cursor without a sequence number" }));
    return Result.ok([peerId, local === 1, seqNum] as const);
  });
}

/** Folds `(peer, local, seq)` rows into a Coverage. */
export function coverageOf(rows: readonly SqlRow[]): Result<Coverage, StateCorrupt | StoreFailure> {
  return Result.gen(function* () {
    const synced = new Map<PeerId, SeqNum>();
    const local = new Map<PeerId, SeqNum>();
    for (const row of rows) {
      const [peer, isLocal, seq] = yield* decodeCursor(row);
      (isLocal ? local : synced).set(peer, seq);
    }
    return Result.ok({ synced, local });
  });
}

/**
 * The interest text the scope table holds, or `undefined` when it holds none (D23). Absent is a
 * device that never adopted a filtered catch-up, and its cursors keep their plain meaning.
 */
export const scopeOf = (rows: readonly SqlRow[]): string | undefined => {
  const value = rows[0]?.[0];
  return !value ? undefined : String(value);
};

/** A stored `partition` cell, which is NULL for a global table and a key everywhere else. */
const partitionOf = (
  value: SqlValue | undefined,
): Result<PartitionKey | undefined, StoreFailure> =>
  value === null || value === undefined
    ? Result.ok(undefined)
    : parsePartitionKey(String(value)).mapError(failure("stored partition key is invalid"));

/**
 * A `(peer, seq, local, hlc_ms, hlc_logical, partition, bytes)` row of the stamp-ordered read.
 *
 * The `tables` a header can carry are absent here and always will be: naming them means reading
 * the core back, which is the one thing the statement declines to select. A reader that must
 * have them has asked the wrong question of a database and should ask the event's author.
 */
export function headerRow(row: SqlRow): Result<EventHeader, StoreFailure> {
  return Result.gen(function* () {
    const peer = yield* parsePeerId(String(row[0])).mapError(failure("stored author is invalid"));
    const seq = yield* seqOf(row[1]);
    const hlc = yield* hlcRow(row.slice(3, 5));
    if (seq === undefined || hlc === undefined)
      return Result.err(new StoreFailure({ message: "stored event has no sequence or stamp" }));
    const local = Number(row[2]) === 1;
    const partition = yield* partitionOf(row[5]);
    return Result.ok({
      id: eventId(peer, seq, local),
      peer,
      seq,
      hlc,
      partition,
      local,
      bytes: Number(row[6]),
      tables: undefined,
    } satisfies EventHeader);
  });
}

/** A `(hlc_ms, hlc_logical)` row, or absent when the query matched nothing. */
export const hlcRow = (row: SqlRow | undefined): Result<Hlc | undefined, StoreFailure> => {
  if (row === undefined) return Result.ok(undefined);
  const [ms, logical] = row;
  if (ms === null || ms === undefined) return Result.ok(undefined);
  const a = Number(ms);
  const b = Number(logical);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0)
    return Result.err(new StoreFailure({ message: "stored stamp is not a pair of integers" }));
  return Result.ok(hlcOf(a, b));
};

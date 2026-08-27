import type { Coverage } from "@syncmesh/engine";
import type { Hlc, PeerId, SeqNum } from "@syncmesh/kernel";

import { StateCorrupt, StoreFailure } from "@syncmesh/engine";
import { hlcOf, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlRow, SqlValue, SqlDriver } from "./driver.js";

export const failure = (message: string) => (cause: unknown) =>
  new StoreFailure({ message, cause });

/** Runs `fn`, turning anything it throws into a `StoreFailure`. */
export const attempt = <T>(message: string, fn: () => Promise<T>) =>
  Result.tryPromise({ try: fn, catch: failure(message) });

const queues = new WeakMap<SqlDriver, Promise<unknown>>();

/**
 * Runs `fn` in one transaction where the driver offers one, and one at a time per driver: the
 * app's captured transaction and the fold's commit share a connection, and SQLite cannot open a
 * transaction inside another. Later callers wait for earlier ones, in call order. A body must
 * not open a second transaction on the same driver — it would wait for itself.
 */
export const inTransaction = <T>(driver: SqlDriver, fn: () => Promise<T>): Promise<T> => {
  if (driver.transaction === undefined) return fn();
  const { transaction } = driver;
  const turn = (queues.get(driver) ?? Promise.resolve()).then(
    () => transaction(fn),
    () => transaction(fn),
  );
  queues.set(
    driver,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
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

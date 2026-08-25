import type { Coverage } from "@syncmesh/engine";
import type { Hlc, Logical, PeerId, SeqNum } from "@syncmesh/kernel";

import { StateCorrupt, StoreFailure } from "@syncmesh/engine";
import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";

import type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";

export const failure = (message: string) => (cause: unknown) =>
  new StoreFailure({ message, cause });

/** Runs `fn`, turning anything it throws into a `StoreFailure`. */
export const attempt = <T>(message: string, fn: () => Promise<T>) =>
  Result.tryPromise({ try: fn, catch: failure(message) });

/** Runs `fn` in one transaction where the driver offers one. */
export const inTransaction = <T>(driver: SqliteDriver, fn: () => Promise<T>) =>
  driver.transaction === undefined ? fn() : driver.transaction(fn);

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

/** A stamp from its two stored integers. */
export function hlcOf(ms: number, logical: number): Hlc {
  // SAFETY: both come from columns (or CBOR ints) that were written from an Hlc; Logical is a non-negative integer
  return [Temporal.Instant.fromEpochMilliseconds(ms), logical as Logical];
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

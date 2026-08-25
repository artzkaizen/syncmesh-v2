import type { SeqNum } from "@syncmesh/kernel";

import { StoreFailure } from "@syncmesh/engine";
import { parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { SqlValue, SqliteDriver } from "./driver.js";

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

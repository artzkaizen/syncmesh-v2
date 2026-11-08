import type { readColumns } from "@syncmesh/drizzle";
import type { PrincipalStatement } from "@syncmesh/storage";
import type { SQL, Table } from "drizzle-orm";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { ReadFailed, ReadRefused } from "@syncmesh/window";
import { sql } from "drizzle-orm";
import { z } from "zod";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- this module is where a driver's error is read for its SQLSTATE: whatever a driver throws arrives as `unknown`, and its `code` is checked before it is trusted; a transaction hands back what a Drizzle statement answers, which the caller parses */

/** The parts of a Postgres Drizzle a served read uses: a transaction, and SQL in it. */
export interface ServedDb {
  readonly execute: (query: SQL) => PromiseLike<unknown>;
  readonly transaction: <T>(
    body: (tx: ServedTx) => Promise<T>,
    config?: { readonly isolationLevel: "repeatable read" },
  ) => Promise<T>;
}

/** A served read's transaction: SQL, a rollback, and the select chain a handler builds on. */
export interface ServedTx {
  readonly execute: (query: SQL) => PromiseLike<unknown>;
  readonly rollback: () => never;
  readonly select: (fields?: NonNullable<ReturnType<typeof readColumns>>) => {
    from: (t: Table) => { where: (w: unknown) => { as: (n: string) => unknown } };
  };
}

/** Several reads in one transaction read one snapshot. */
export const SNAPSHOT = { isolationLevel: "repeatable read" } as const;

export const refused = (message: string) => new ReadRefused({ message });

/**
 * SQLSTATE classes that say the read itself is wrong, so asking again gives the same answer:
 * `42` (a name it may not use, or that does not exist), `22` (a value it cannot take), `0A`
 * (something Postgres does not do) and `25` (a write inside a read-only transaction).
 */
const REFUSING = new Set(["42", "22", "0A", "25"]);

/**
 * The two of those a deploy in progress also gives, while the code is ahead of the migration:
 * `42501` (the role may not read the table yet) and `42P01` (the table does not exist yet).
 */
const DEPLOYING = new Set(["42501", "42P01"]);

/** The driver's own error under Drizzle's wrapper, and its SQLSTATE: what Postgres said, not the query it said it about. */
const driverError = (cause: unknown) => {
  for (let at = cause; at instanceof Error; at = at.cause) {
    const code: unknown = "code" in at ? at.code : undefined;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
      return { state: code, message: at.message };
  }
  return undefined;
};

/**
 * How one socket's reads that threw are answered: a refusal when asking again cannot help, and a
 * failure when it may. A role or table that is not there yet is a deploy for `grace`, then the
 * read's own fault; `settled` forgets a read that has since been answered.
 */
export const failures = (grace: Temporal.Duration) => {
  /** When each read was first told its role or table is not there, while it still is not. */
  const missing = new Map<string, Temporal.Instant>();

  const deploying = (key: string, message: string): ReadRefused | ReadFailed => {
    const now = Temporal.Now.instant();
    const since = missing.get(key) ?? now;
    missing.set(key, since);
    return Temporal.Duration.compare(now.since(since), grace) < 0
      ? new ReadFailed({ message })
      : refused(message);
  };

  const classify = (key: string, cause: unknown): ReadRefused | ReadFailed => {
    if (cause instanceof ReadRefused || cause instanceof ReadFailed) return cause;
    const driver = driverError(cause);
    // no SQLSTATE: the connection, not the read
    if (driver === undefined)
      return new ReadFailed({
        message: cause instanceof Error ? cause.message : "the read failed",
      });
    if (DEPLOYING.has(driver.state)) return deploying(key, driver.message);
    return REFUSING.has(driver.state.slice(0, 2))
      ? refused(driver.message)
      : new ReadFailed({ message: driver.message });
  };

  return { classify, settled: (key: string) => void missing.delete(key) };
};

/** `SELECT set_config('…', $1, TRUE)` as a Drizzle statement, each `$n` bound to its param. */
export const drizzleStatement = ({ sql: text, params }: PrincipalStatement): SQL =>
  sql.join(
    text
      .split(/\$(\d+)/)
      .map((part, i) => (i % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1] ?? null}`)),
  );

/** What `servedReadSettings` answers: the backend the transaction runs on, and when it began. */
const Entered = z.tuple([z.object({ pid: z.number(), began: z.string() })], z.unknown());

/**
 * Cancels the transaction `entered` names once `reads` have had `timeout` each and one more:
 * a fragment can turn its own `statement_timeout` off, and this it cannot reach. Sent from
 * another connection of `db`'s pool, and only while that backend is still in this transaction.
 * Answers the stop, which settles once a cancel it sent has.
 */
export const watchdog = (
  db: ServedDb,
  timeout: Temporal.Duration,
  entered: unknown,
  reads: number,
) => {
  const named = Entered.safeParse(entered);
  if (!named.success) return () => Promise.resolve();
  const [{ pid, began }] = named.data;
  let sent: Promise<unknown> = Promise.resolve();
  const timer = setTimeout(
    () => {
      // a cancel that cannot be sent leaves the read to its statement_timeout, as before
      sent = Result.tryPromise({
        try: async () =>
          db.execute(
            sql`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ${pid} AND (EXTRACT(EPOCH FROM xact_start) * 1000000)::bigint = ${began}::bigint`,
          ),
        catch: (cause) => cause,
      });
    },
    timeout.total("milliseconds") * (reads + 1),
  );
  return () => {
    clearTimeout(timer);
    return sent;
  };
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

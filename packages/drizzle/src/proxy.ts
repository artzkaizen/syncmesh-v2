import type { Change, PartitionKey } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { SqlDriver, SqlValue, SqlWriteError, TxReceipt, Write } from "@syncmesh/storage";

import { inTransaction } from "@syncmesh/storage";

/**
 * What a Drizzle proxy callback does over a mesh: `begin`/`commit`/`rollback` from Drizzle's own
 * `db.transaction()` open and settle one capture, a write statement on its own is its own
 * capture, and everything else runs as it is. Shared by the SQLite and Postgres faces; the
 * dialect decides only how values bind and how rows come back.
 */

export interface ProxyResult {
  readonly rows: unknown[][];
}

export interface ProxyDeps {
  readonly driver: SqlDriver;
  readonly writer: Write;
  readonly partition?: PartitionKey;
  /**
   * Runs inside every transaction before the app's statements — the Postgres face sets the
   * caller's principal here (RLS reads it), so it dies with the transaction. A bare read gets a
   * transaction of its own to hold it.
   */
  readonly prelude?: () => Promise<void>;
}

const isWrite = (statement: string): boolean => /^\s*(insert|update|delete)\b/i.test(statement);

/** The label an event carries when nobody named it: what the transaction turned out to do. */
export const derivedLabel = (changes: readonly Change[]): string =>
  changes.length === 0
    ? "sql.write"
    : [...new Set(changes.map((c) => `${String(c.table)}.${c.kind}`))].join("+");

/** Carries Drizzle's `rollback` out through the capture without it becoming an app error. */
class TxRollback extends Error {}

/** Drizzle hands values as it mapped them; SQLite has no boolean, Postgres has. */
const bind = (params: readonly unknown[], dialect: SqlDriver["dialect"]): readonly SqlValue[] =>
  params.map((p) => {
    if (p === undefined || p === null) return null;
    if (p === true) return dialect === "postgres" ? true : 1;
    if (p === false) return dialect === "postgres" ? false : 0;
    // SAFETY: Drizzle maps every other column value to a SQL scalar (string, number, bigint), a Date or bytes before the driver sees it
    return p as SqlValue;
  });

/** Drizzle's `run` (SQLite) executes for effect; every other method wants rows back. */
export type ProxyMethod = "run" | "all" | "values" | "get" | "execute";

export function createProxy(deps: ProxyDeps) {
  const { driver, writer, partition, prelude } = deps;
  const writeOptions = partition === undefined ? {} : { partition };

  /** Drizzle's own `db.transaction()` drives this: `begin` opens a capture, `commit` settles it. */
  interface OpenTx {
    readonly done: () => void;
    readonly fail: (cause: unknown) => void;
    readonly settled: Promise<Result<TxReceipt, SqlWriteError>>;
  }
  let openTx: OpenTx | undefined;
  let txTail: Promise<unknown> = Promise.resolve();

  const begin = async (): Promise<void> => {
    await txTail; // one app transaction at a time on this handle
    let began!: () => void;
    let done!: () => void;
    let fail!: (cause: unknown) => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve, reject) => {
      done = resolve;
      fail = reject;
    });
    const settled = writer(
      derivedLabel,
      () => {
        began(); // the capture transaction is now open; statements may flow
        return gate;
      },
      writeOptions,
    );
    txTail = settled.then(
      () => undefined,
      () => undefined,
    );
    openTx = { done, fail, settled };
    await started;
    await prelude?.(); // the capture transaction is open: the settings land inside it
  };

  const commit = async (): Promise<void> => {
    const tx = openTx;
    if (tx === undefined) return;
    openTx = undefined;
    tx.done();
    const written = await tx.settled;
    // a read-only transaction is fine — it just is not an event
    if (written.isErr() && written.error._tag !== "EmptyMutation") throw written.error;
  };

  const rollback = async (): Promise<void> => {
    const tx = openTx;
    if (tx === undefined) return;
    openTx = undefined;
    tx.fail(new TxRollback());
    await tx.settled; // the capture rolled back; Drizzle rethrows the app's own error
  };

  const execute = async (
    statement: string,
    params: readonly SqlValue[],
    method: ProxyMethod,
  ): Promise<ProxyResult> => {
    if (method === "run") {
      await driver.run(statement, params);
      return { rows: [] };
    }
    const rows = await driver.all(statement, params);
    return { rows: method === "get" ? [[...(rows[0] ?? [])]] : rows.map((r) => [...r]) };
  };

  const callback = async (
    statement: string,
    params: readonly unknown[],
    method: ProxyMethod,
  ): Promise<ProxyResult> => {
    const control = statement.trim().toLowerCase();
    if (control.startsWith("begin")) return begin().then(() => ({ rows: [] }));
    if (control === "commit") return commit().then(() => ({ rows: [] }));
    if (control === "rollback") return rollback().then(() => ({ rows: [] }));
    const bound = bind(params, driver.dialect);
    if (openTx !== undefined) return execute(statement, bound, method);
    if (!isWrite(statement)) {
      if (prelude === undefined) return execute(statement, bound, method);
      // a bare read gets a transaction to hold the settings; the per-driver queue orders it
      return inTransaction(driver, async () => {
        await prelude();
        return execute(statement, bound, method);
      });
    }
    // a statement on its own is its own transaction, hence its own event
    let result: ProxyResult = { rows: [] };
    const written = await writer(
      derivedLabel,
      async () => {
        await prelude?.();
        result = await execute(statement, bound, method);
      },
      writeOptions,
    );
    // a statement that changed nothing is not an event, and not an error either
    if (written.isErr() && written.error._tag !== "EmptyMutation") throw written.error;
    return result;
  };

  return { callback };
}

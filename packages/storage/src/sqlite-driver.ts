import type { SqlRow, SqlValue, SqliteDriver } from "./driver.js";

/**
 * What a binding receives once {@link bindSqlite} has run: SQLite's own storage classes, with no
 * boolean and no `Date` left in them.
 */
export type BoundSqlValue = string | number | bigint | Uint8Array | null;

/**
 * SQLite has no boolean and no date type; both bind as the integers the SQLite dialect writes and
 * reads back. Exported for a binding whose calls are async and so cannot be a {@link SqliteBinding}.
 */
export const bindSqlite = (params: readonly SqlValue[]): readonly BoundSqlValue[] =>
  params.map((p) => (p === true ? 1 : p === false ? 0 : p instanceof Date ? p.getTime() : p));

/**
 * The four calls a synchronous SQLite binding exposes. Parameter conversion, transaction control
 * and the promises the port returns all live in {@link sqliteDriver}, so a platform writes only
 * the lines on which its binding actually differs.
 */
export interface SqliteBinding {
  /** A statement taking no parameters and returning no rows: pragmas, and transaction control. */
  readonly exec: (sql: string) => void;
  /** Executes a statement for its effect. */
  readonly run: (sql: string, params: readonly BoundSqlValue[]) => void;
  /** Every row of a query, as positional values in `SELECT` order. */
  readonly all: (sql: string, params: readonly BoundSqlValue[]) => readonly SqlRow[];
  readonly close: () => void;
}

/**
 * The same four calls, one await later: a binding whose database is not on this thread, or whose
 * API is asynchronous to begin with. {@link bindSqlite} is exported for exactly this case.
 *
 * A binding is free to be async *and* to be one connection — `@syncmesh/sqlite-wasm`'s worker host
 * is both — and the transaction rule below is what makes that safe to say: statements issued
 * between `BEGIN IMMEDIATE` and `COMMIT` must reach the same connection, in order.
 */
export interface AsyncSqliteBinding {
  /** A statement taking no parameters and returning no rows: pragmas, and transaction control. */
  readonly exec: (sql: string) => Promise<void>;
  /** Executes a statement for its effect. */
  readonly run: (sql: string, params: readonly BoundSqlValue[]) => Promise<void>;
  /** Every row of a query, as positional values in `SELECT` order. */
  readonly all: (sql: string, params: readonly BoundSqlValue[]) => Promise<readonly SqlRow[]>;
  readonly close: () => Promise<void>;
}

/**
 * `BEGIN IMMEDIATE` rather than `BEGIN`: a deferred transaction takes its write lock at the first
 * write, and failing to take it there aborts work already done.
 *
 * Declared once for both bindings because the statements and their order are the contract, and
 * the only difference between a synchronous binding and an asynchronous one is where the awaits
 * fall. Neither version serialises: a second `transaction` entered while this one is between its
 * `BEGIN` and its `COMMIT` interleaves on the same connection, which SQLite answers with
 * `cannot start a transaction within a transaction`. One writer per driver, as every store here
 * already assumes.
 */
const transactionOver =
  (exec: (sql: string) => void | Promise<void>) =>
  async <T>(fn: () => Promise<T>): Promise<T> => {
    await exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      await exec("COMMIT");
      return result;
    } catch (cause) {
      await exec("ROLLBACK");
      throw cause;
    }
  };

/**
 * A {@link SqliteDriver} over a binding, so `node:sqlite`, `bun:sqlite`, `expo-sqlite` and anything
 * else differ only in how they are called. A binding that ships with a runtime has an adapter
 * package; one your app installs is this call in your own code, certified by `driverTests` from
 * `@syncmesh/storage/driver-tests` — the example is `expo-sqlite`, in full.
 *
 * An asynchronous binding is {@link asyncSqliteDriver}, and is not a lesser case: the port's own
 * calls return promises, so a database reached over a `MessagePort` is a driver like any other.
 *
 * @example
 * const db = openDatabaseSync("app.db");
 * db.execSync("PRAGMA journal_mode = WAL");
 * const driver = sqliteDriver({
 *   exec: (sql) => db.execSync(sql),
 *   run: (sql, params) => void db.runSync(sql, [...params]),
 *   all: (sql, params) => db.getAllSync(sql, [...params]).map(Object.values),
 *   close: () => db.closeSync(),
 * });
 */
export function sqliteDriver(binding: SqliteBinding): SqliteDriver {
  return {
    dialect: "sqlite",
    run: (sql, params = []) => {
      binding.run(sql, bindSqlite(params));
      return Promise.resolve();
    },
    all: (sql, params = []) => Promise.resolve(binding.all(sql, bindSqlite(params))),
    transaction: transactionOver(binding.exec),
    close: () => {
      binding.close();
      return Promise.resolve();
    },
  };
}

/**
 * A {@link SqliteDriver} over an {@link AsyncSqliteBinding} — the same driver as
 * {@link sqliteDriver}, for a binding that answers with promises.
 *
 * The port was always async; what this adds is the parameter conversion and the transaction
 * statements, so a binding still writes only the lines on which it genuinely differs.
 *
 * @example
 * const driver = asyncSqliteDriver({
 *   exec: (sql) => call({ kind: "exec", sql }),
 *   run: (sql, params) => call({ kind: "run", sql, params }),
 *   all: (sql, params) => call({ kind: "all", sql, params }),
 *   close: () => call({ kind: "close" }),
 * });
 */
export function asyncSqliteDriver(binding: AsyncSqliteBinding): SqliteDriver {
  return {
    dialect: "sqlite",
    run: (sql, params = []) => binding.run(sql, bindSqlite(params)),
    all: (sql, params = []) => binding.all(sql, bindSqlite(params)),
    transaction: transactionOver(binding.exec),
    close: binding.close,
  };
}

import type { BoundSqlValue, SqlRow, SqliteDriver } from "@syncmesh/storage";

import { panic } from "@syncmesh/result";
import { sqliteDriver } from "@syncmesh/storage";

/**
 * What `expo-sqlite` binds, which is one type short of what this library stores.
 *
 * Its `SQLiteBindValue` is `string | number | null | boolean | Uint8Array` — no `bigint`, though
 * SQLite's own integers are 64-bit and the engine binds sequence numbers and clock readings as
 * `bigint` on every other platform. {@link bindable} is where the difference is dealt with, in
 * the open rather than behind an assertion.
 */
export type ExpoBindValue = string | number | boolean | Uint8Array | null;

/**
 * A parameter in the shape the binding takes, refusing the one case that would lose information.
 *
 * A `bigint` inside the double-precision safe range is the same integer as a `number` and binds
 * to the same SQLite INTEGER, so converting is exact. Above it, it is not: `Number` would round,
 * SQLite would store the rounded value, and a sequence number or a clock reading would come back
 * subtly wrong — the kind of corruption that surfaces months later as two devices disagreeing
 * about an order. There is nothing sensible to do with such a value here, so it panics rather
 * than quietly becoming a different number.
 */
const bindable = (params: readonly BoundSqlValue[]): ExpoBindValue[] =>
  params.map((value) => {
    /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- this *is* the I/O boundary the rule
       asks for: a `BoundSqlValue` is a union of primitives on its way into a native binding, and
       which arm it is decides whether the binding can take it at all. There is no domain type
       above this to parse into; the parse is the branch. */
    if (typeof value !== "bigint") return value;
    if (value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER) return Number(value);
    return panic(`expo-sqlite cannot bind ${String(value)}: it is past the safe integer range`);
  });

/**
 * The four calls this adapter needs from `expo-sqlite`, named as a subset rather than imported as
 * a type.
 *
 * The same reason `@syncmesh/browser`'s `WirePort` is a subset of `Worker`: the adapter is then a
 * fact about a binding rather than about a version of Expo, and a fake one in a test certifies the
 * same sequence a phone runs. The real `SQLiteDatabase` satisfies it structurally; nothing has to
 * be asserted.
 */
export interface ExpoDatabase {
  readonly execSync: (source: string) => void;
  readonly runSync: (source: string, params: ExpoBindValue[]) => void;
  /** Prepared, so the result can be asked for as raw values rather than as named ones. */
  readonly prepareSync: (source: string) => ExpoStatement;
  readonly closeSync: () => void;
}

/** The prepared statement, as the two calls this adapter makes of it. */
export interface ExpoStatement {
  readonly executeForRawResultSync: (params: ExpoBindValue[]) => {
    readonly getAllSync: () => readonly SqlRow[];
  };
  readonly finalizeSync: () => void;
}

/**
 * A row as the store contract wants it: the selected values, in `SELECT` order.
 *
 * **Taken from the statement rather than reconstructed from an object**, and that distinction is
 * the whole of this adapter's correctness. `expo-sqlite`'s ordinary `getAllSync` answers with one
 * object per row keyed by column name, and turning that back into positions with `Object.values`
 * looks right until a statement selects two columns of the same name — which Drizzle does the
 * moment a query reads from a subquery or a join. The object keeps one of them, the array comes
 * back short, and every value after the collision lands in the wrong field: rows arrive with a
 * status but no id, a `views` count but no title, and a list keyed on `id` sees `null`.
 *
 * `executeForRawResultSync` is the same query answered as the values themselves, in the order the
 * statement declared, duplicates and all. There is nothing to reconstruct.
 */

/** The driver over an already-open database, so a caller that opened its own keeps it. */
/**
 * Every query is prepared, read and finalized.
 *
 * A statement left unfinalized holds a SQLite object open for as long as the JS one is reachable,
 * and a device that runs a live query on every fold would accumulate them by the thousand — so the
 * `finally` is not tidiness, it is the difference between a list that scrolls and an app that is
 * eventually killed for memory.
 */
/**
 * Called per statement with the SQL, the milliseconds the JS thread spent inside it, and how many
 * rows it handed back (zero for a write).
 *
 * Every call this adapter makes is a `*Sync` call, so the duration reported here is time the
 * thread could not draw, handle a touch or start an animation — not time spent waiting on a
 * database somewhere else.
 */
export type SqlTrace = (sql: string, ms: number, rows: number) => void;

let watching: SqlTrace | undefined;

/**
 * Reports every statement to `to`, or stops reporting when given `undefined`.
 *
 * Off by default and process-wide, because the cost being measured belongs to the one JS thread
 * rather than to any one connection.
 */
export const traceStatements = (to: SqlTrace | undefined): void => void (watching = to);

const timed = <T>(sql: string, run: () => T, counted?: (answer: T) => number): T => {
  const watcher = watching;
  if (watcher === undefined) return run();
  const began = Date.now();
  let answer: T | undefined;
  try {
    answer = run();
    return answer;
  } finally {
    watcher(sql, Date.now() - began, answer === undefined ? 0 : (counted?.(answer) ?? 0));
  }
};

const rowsOf = (db: ExpoDatabase, sql: string, params: ExpoBindValue[]): readonly SqlRow[] => {
  const statement = db.prepareSync(sql);
  try {
    return statement.executeForRawResultSync(params).getAllSync();
  } finally {
    statement.finalizeSync();
  }
};

export const expoSqliteDriverOver = (db: ExpoDatabase): SqliteDriver =>
  sqliteDriver({
    exec: (sql) => timed(sql, () => db.execSync(sql)),
    run: (sql, params) => timed(sql, () => db.runSync(sql, bindable(params))),
    all: (sql, params) =>
      timed(
        sql,
        () => rowsOf(db, sql, bindable(params)),
        (answer) => answer.length,
      ),
    close: () => db.closeSync(),
  });

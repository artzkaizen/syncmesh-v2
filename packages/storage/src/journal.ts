import { StoreFailure } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { decodeCbor, encodeCbor, isNumber, isString, type CborValue } from "@syncmesh/wire";

import type { SqlDriver, SqlValue } from "./driver.js";

import { ATTACHED_LOG, logPlacement, logTable } from "./namespace.js";
import { attempt, rootConnection } from "./sql.js";
import { bindSqlite } from "./sqlite-driver.js";

/**
 * The log half of the last transaction that wrote both files, kept in `main` (RFC-0022).
 *
 * SQLite commits a transaction over a WAL `main` and an attached log one file at a time, `main`
 * first: a `kill -9` between the two leaves the state, the app's rows and the cursor committed and
 * the log without the event they stand for. So every transaction that writes both copies its log
 * statements into this one-row table, in `main` and in the same transaction, with a number the
 * log also records. At the next open, a number the log has not reached is replayed into the log
 * ({@link recoverJournal}); the other direction — the log committed and `main` not — is the log
 * ahead of the state, which boot already replays.
 */
const JOURNAL = "syncmesh_journal";
/** The key in the log's `meta` table holding the number of the last journaled transaction. */
const MARK = "journal";

/** The journal's table, a rung of the derived half's ladder on a connection with an attached log. */
export const JOURNAL_DDL = `CREATE TABLE IF NOT EXISTS ${JOURNAL} (
  id INTEGER PRIMARY KEY CHECK (id = 0),
  n INTEGER NOT NULL,
  statements BLOB NOT NULL
)`;
const READ_JOURNAL = `SELECT n, statements FROM ${JOURNAL} WHERE id = 0`;
const WRITE_JOURNAL = `INSERT OR REPLACE INTO ${JOURNAL} (id, n, statements) VALUES (0, ?, ?)`;
const READ_MARK = `SELECT value FROM ${logTable("meta")} WHERE key = '${MARK}'`;
const WRITE_MARK = `INSERT OR REPLACE INTO ${logTable("meta")} (key, value) VALUES ('${MARK}', ?)`;

/** One statement as it reached the connection. */
type Statement = readonly [sql: string, params: readonly SqlValue[]];

/** Which file a statement writes, or `undefined` for a read or transaction control. */
type Target = "log" | "main" | undefined;

const LOG_WRITE = new RegExp(
  String.raw`^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+${ATTACHED_LOG}\.`,
  "i",
);
const LOG_WRITE_ANYWHERE = new RegExp(LOG_WRITE.source.replace("^\\s*", "\\b"), "i");
const WRITE_VERB_ANYWHERE = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const READ = /^\s*(?:SELECT|VALUES|EXPLAIN|SAVEPOINT|RELEASE|ROLLBACK|BEGIN|COMMIT|END)\b/i;
const PRAGMA_READ = /^\s*PRAGMA\b[^=]*$/i;
const NAMES_LOG = new RegExp(String.raw`\b${ATTACHED_LOG}\.`, "i");

/**
 * The file `sql` writes. A log statement names its table `syncmesh.<name>` (RFC-0022), so a write
 * whose target is spelled that way is the log's and any other write is `main`'s; DDL and pragma
 * writes go by whether they name the log at all.
 */
export const statementTarget = (sql: string): Target => {
  if (READ.test(sql) || PRAGMA_READ.test(sql)) return undefined;
  if (LOG_WRITE.test(sql)) return "log";
  if (/^\s*WITH\b/i.test(sql)) {
    if (LOG_WRITE_ANYWHERE.test(sql)) return "log";
    return WRITE_VERB_ANYWHERE.test(sql) ? "main" : undefined;
  }
  if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return "main";
  return NAMES_LOG.test(sql) ? "log" : "main";
};

/* oxlint-disable anti-slop/no-runtime-typeof -- a serializer dispatches on the runtime type of what it encodes */
/** A bound parameter as CBOR: a bigint, which CBOR here has no type for, travels as `[digits]`. */
const paramCbor = (value: SqlValue): CborValue => {
  const [bound] = bindSqlite([value]);
  if (typeof bound === "bigint") return [bound.toString()];
  return bound ?? null;
};
/* oxlint-enable anti-slop/no-runtime-typeof */

const paramFromCbor = (value: CborValue): Result<SqlValue, StoreFailure> => {
  if (Array.isArray(value)) {
    const [digits] = value;
    return isString(digits)
      ? Result.try({
          try: () => BigInt(digits),
          catch: (cause) => new StoreFailure({ message: "journal bigint is not digits", cause }),
        })
      : Result.err(new StoreFailure({ message: "journal parameter is not a bigint" }));
  }
  if (value === null || isString(value) || isNumber(value) || value instanceof Uint8Array)
    return Result.ok(value);
  return Result.err(new StoreFailure({ message: "journal parameter is not a SQL value" }));
};

const encodeStatements = (statements: readonly Statement[]): Uint8Array =>
  encodeCbor(statements.map(([sql, params]) => [sql, params.map(paramCbor)]));

/** The statements a journal row holds, in the order they ran. */
export function decodeStatements(bytes: Uint8Array): Result<readonly Statement[], StoreFailure> {
  return Result.gen(function* () {
    const value = yield* decodeCbor(bytes).mapError(
      (cause) => new StoreFailure({ message: "the journal does not decode", cause }),
    );
    if (!Array.isArray(value))
      return Result.err(new StoreFailure({ message: "the journal is not a list" }));
    const statements: Statement[] = [];
    for (const item of value) {
      const [sql, params] = Array.isArray(item) ? item : [];
      if (!isString(sql) || !Array.isArray(params))
        return Result.err(new StoreFailure({ message: "a journal entry is not a statement" }));
      const bound: SqlValue[] = [];
      for (const param of params) bound.push(yield* paramFromCbor(param));
      statements.push([sql, bound]);
    }
    return Result.ok(statements);
  });
}

/** Whether this connection's log is a second file whose commit can land apart from `main`'s. */
export const journaled = (driver: Pick<SqlDriver, "dialect" | "log">): boolean =>
  driver.dialect !== "postgres" && logPlacement(driver) === "attached";

const numberCell = (value: SqlValue | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

/**
 * Replays the log half of a transaction whose `main` half committed and whose log half did not,
 * and answers how many statements it replayed (0 when the two files agree). Runs before anything
 * reads either file, and after both ladders have climbed: until it has, the state can name events
 * the log does not hold.
 *
 * The log is exactly as it was before that transaction — SQLite rolled its half back — so the same
 * statements, in the same order, write what they wrote then.
 */
export function recoverJournal(driver: SqlDriver): Promise<Result<number, StoreFailure>> {
  if (!journaled(driver)) return Promise.resolve(Result.ok(0));
  return Result.gen(async function* () {
    const [row, mark] = yield* Result.await(
      attempt("could not read the write journal", async () => {
        const [held] = await driver.all(READ_JOURNAL);
        const [marked] = await driver.all(READ_MARK);
        return [held, numberCell(marked?.[0])] as const;
      }),
    );
    if (row === undefined || numberCell(row[0]) <= mark) return Result.ok(0);
    const bytes = row[1];
    if (!(bytes instanceof Uint8Array))
      return Result.err(new StoreFailure({ message: "the journal's statements are not bytes" }));
    const statements = yield* decodeStatements(bytes);
    yield* Result.await(
      attempt("could not replay the write journal into the log", () => {
        const replay = async () => {
          for (const [sql, params] of statements) await driver.run(sql, params);
        };
        return driver.transaction === undefined ? replay() : driver.transaction(replay);
      }),
    );
    console.warn(
      `[syncmesh] the last write committed its rows but not its log entry before the process stopped; replayed ${statements.length} statements into the log`,
    );
    return Result.ok(statements.length);
  });
}

/** What {@link journalingDriver} keeps for the transaction it is in. */
interface Open {
  readonly statements: Statement[];
  main: boolean;
}

/**
 * `driver`, with every transaction that writes both files journaled into `main` before it commits
 * (see {@link recoverJournal}). Statements outside a transaction, and transactions that write one
 * file, run as they are. Shares `driver`'s turn ({@link onConnection}).
 *
 * @param last The number the log or the journal last recorded; the next transaction takes the one
 * after it.
 */
export function journalingDriver(driver: SqlDriver, last: number): SqlDriver {
  const { transaction } = driver;
  if (!journaled(driver) || transaction === undefined) return driver;
  let n = last;
  let open: Open | undefined;
  const note = (sql: string, params: readonly SqlValue[]) => {
    if (open === undefined) return;
    const target = statementTarget(sql);
    if (target === "log") open.statements.push([sql, params]);
    else if (target === "main") open.main = true;
  };
  const tapped: SqlDriver = {
    ...driver,
    run: (sql, params = []) => {
      note(sql, params);
      return driver.run(sql, params);
    },
    all: (sql, params = []) => {
      note(sql, params);
      return driver.all(sql, params);
    },
    transaction: (fn) =>
      transaction(async () => {
        const mine: Open = { statements: [], main: false };
        open = mine;
        try {
          const result = await fn();
          if (mine.main && mine.statements.length > 0) {
            n += 1;
            const marked = String(n);
            mine.statements.push([WRITE_MARK, [marked]]);
            await driver.run(WRITE_MARK, [marked]);
            await driver.run(WRITE_JOURNAL, [n, encodeStatements(mine.statements)]);
          }
          return result;
        } finally {
          open = undefined;
        }
      }),
  };
  rootConnection(tapped, driver);
  return tapped;
}

/** The number the next journaled transaction counts on from: the higher of the log's and the journal's. */
export function journalPosition(driver: SqlDriver): Promise<Result<number, StoreFailure>> {
  if (!journaled(driver)) return Promise.resolve(Result.ok(0));
  return attempt("could not read the write journal", async () => {
    const [held] = await driver.all(READ_JOURNAL);
    const [marked] = await driver.all(READ_MARK);
    return Math.max(numberCell(held?.[0]), numberCell(marked?.[0]));
  });
}

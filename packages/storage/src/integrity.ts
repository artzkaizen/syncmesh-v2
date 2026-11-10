import { StoreFailure } from "@syncmesh/engine";
import { Result, TaggedError } from "@syncmesh/result";

import type { SqlDriver } from "./driver.js";

import { ATTACHED_LOG, LOG_TABLES, logTable, logPlacement } from "./dialect.js";
import { attempt } from "./sql.js";

/**
 * This database gives the store no integrity check it can run: a runtime whose authorizer refuses
 * `PRAGMA quick_check`, a Postgres without the `amcheck` extension, or a role there that may not
 * execute its functions. A Durable Object is not one: workerd allows `quick_check`.
 *
 * A fact about the database, not damage: the log may be perfectly sound, and nothing here can say.
 */
export class NoIntegrityCheck extends TaggedError("NoIntegrityCheck")<{
  message: string;
  /** The runtime's own refusal, where it gave one. */
  cause?: unknown;
}> {}

const damaged = (detail: string) =>
  new StoreFailure({ message: `the log failed its integrity check: ${detail}` });

/** SQLite's `quick_check` answer: one row `ok`, or one row per problem, headed by the database's name. */
const verdict = (rows: readonly (readonly unknown[])[]): Result<void, StoreFailure> => {
  const found = rows.map((row) => String(row[0])).filter((line) => !line.startsWith("***"));
  if (found.length === 1 && found[0] === "ok") return Result.ok(undefined);
  const shown = found.slice(0, 3).join("; ");
  return Result.err(damaged(`${shown}${found.length > 3 ? ` (${found.length} problems)` : ""}`));
};

/** `PRAGMA quick_check` over the attached log file. */
const quickCheck = (driver: SqlDriver): Promise<Result<void, StoreFailure>> =>
  Result.gen(async function* () {
    const rows = yield* Result.await(
      attempt("the log failed its integrity check", () =>
        driver.all(`PRAGMA ${ATTACHED_LOG}.quick_check`),
      ),
    );
    return verdict(rows);
  });

/**
 * How a runtime says it will not run a statement: SQLite's authorizer, which is workerd's answer
 * to most `PRAGMA`s, and the plain words another runtime's own gate would use. Anything else a
 * check throws is the check failing: workerd reports a torn page it reads as an assertion
 * (`false == true`), not as `SQLITE_CORRUPT`, so damage cannot be matched by name. Not
 * "unsupported": SQLite says "unsupported file format" of a garbled header, which is damage.
 */
const REFUSED = /not authorized|SQLITE_AUTH|not allowed|not permitted|not supported/i;

/**
 * `PRAGMA quick_check(<table>)` over each log table of a log that shares its database with the
 * state (`log: "inline"`): a Durable Object, which allows this one `PRAGMA`, and a Rivet actor.
 * A runtime that refuses the `PRAGMA` (workerd's authorizer, or another runtime's gate in its own
 * words) answers {@link NoIntegrityCheck}; any other failure is the database failing the check.
 */
const inlineQuickCheck = (
  driver: SqlDriver,
): Promise<Result<void, StoreFailure | NoIntegrityCheck>> =>
  Result.gen(async function* () {
    const names = LOG_TABLES.map((name) => logTable(name, "inline"));
    const present = yield* Result.await(
      Result.tryPromise({
        try: () =>
          driver.all(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => "?").join(", ")})`,
            names,
          ),
        catch: refusedOr(
          "this runtime refuses reading sqlite_master",
          "the log failed its integrity check",
        ),
      }),
    );
    const held = new Set(present.map(([name]) => name));
    for (const table of names.filter((name) => held.has(name))) {
      const rows = yield* Result.await(
        Result.tryPromise({
          try: () => driver.all(`PRAGMA quick_check(${table})`),
          catch: refusedOr(
            "this runtime refuses PRAGMA quick_check",
            `the log failed its integrity check on ${table}`,
          ),
        }),
      );
      yield* verdict(rows);
    }
    return Result.ok(undefined);
  });

/**
 * A failed statement of the inline check: {@link NoIntegrityCheck} when the runtime refused it
 * ({@link REFUSED}), saying `refusal`; otherwise the database failing the check, saying `damage`.
 */
const refusedOr =
  (refusal: string, damage: string) =>
  (cause: unknown): StoreFailure | NoIntegrityCheck =>
    cause instanceof Error && REFUSED.test(cause.message)
      ? new NoIntegrityCheck({
          message: `${refusal}, so the log's pages cannot be checked from here`,
          cause,
        })
      : new StoreFailure({ message: damage, cause });

/** The `verify_heapam` overload `verify_heapam($1::regclass)` resolves to, its defaults filled. */
const VERIFY_HEAPAM = "verify_heapam(regclass,boolean,boolean,text,bigint,bigint)";
/** The `bt_index_check` overload the heap-lookup check calls. */
const BT_INDEX_CHECK = "bt_index_check(regclass,boolean)";

/**
 * `amcheck` over the log's tables: `verify_heapam` on each, `bt_index_check` with every heap tuple
 * looked up on each of their b-tree indexes. Only where the extension is installed and this role
 * may execute both: creating it and granting it are the operator's calls, not side effects of a
 * read.
 */
const amcheck = (driver: SqlDriver): Promise<Result<void, StoreFailure | NoIntegrityCheck>> =>
  Result.gen(async function* () {
    const installed = yield* Result.await(
      attempt("could not read the installed extensions", () =>
        driver.all(`SELECT 1 FROM pg_extension WHERE extname = 'amcheck'`),
      ),
    );
    if (installed.length === 0)
      return Result.err(
        new NoIntegrityCheck({
          message:
            "this Postgres has no amcheck extension: `CREATE EXTENSION amcheck` to let the store verify its log",
        }),
      );
    // `amcheck`'s functions are revoked from PUBLIC: a role that cannot run them learns nothing
    // about the log, which is not the same as the log failing them. The check names the overloads
    // the calls below resolve to, by the same search path: a grant on another one does not count
    const [allowed] = yield* Result.await(
      attempt("could not read this role's privileges on amcheck", () =>
        driver.all(
          `SELECT COALESCE(has_function_privilege(to_regprocedure($1), 'EXECUTE'), false)
            AND COALESCE(has_function_privilege(to_regprocedure($2), 'EXECUTE'), false)`,
          [VERIFY_HEAPAM, BT_INDEX_CHECK],
        ),
      ),
    );
    if (allowed?.[0] !== true)
      return Result.err(
        new NoIntegrityCheck({
          message: `this role may not run amcheck's ${VERIFY_HEAPAM} and ${BT_INDEX_CHECK}: \`GRANT EXECUTE\` on them to let the store verify its log`,
        }),
      );
    for (const name of LOG_TABLES) {
      const table = logTable(name);
      const [present] = yield* Result.await(
        attempt("could not look up a log table", () =>
          driver.all(`SELECT to_regclass($1) IS NOT NULL`, [table]),
        ),
      );
      if (present?.[0] !== true) continue;
      const problems = yield* Result.await(
        attempt(`the log failed its integrity check on ${table}`, () =>
          driver.all(`SELECT blkno, offnum, msg FROM verify_heapam($1::regclass)`, [table]),
        ),
      );
      const [first] = problems;
      if (first !== undefined) {
        const [block, problem] = [Number(first[0]), String(first[2])];
        return Result.err(damaged(`${table} block ${block}: ${problem} (${problems.length})`));
      }
      yield* Result.await(
        attempt(`the log failed its integrity check on an index of ${table}`, () =>
          driver.all(
            `SELECT bt_index_check(i.indexrelid, true) FROM pg_index i
              JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am a ON a.oid = c.relam
              WHERE i.indrelid = $1::regclass AND a.amname = 'btree'`,
            [table],
          ),
        ),
      );
    }
    return Result.ok(undefined);
  });

/**
 * Checks the log's pages for damage a read cannot see (D39): `PRAGMA quick_check` on a device's
 * SQLite log and on each log table of an inline one (a Durable Object), `amcheck` on Postgres.
 * O(log size), so it runs on demand — `mesh.inspect.verify()` — and at boot after an unclean
 * shutdown, never on an ordinary launch.
 *
 * Damage is a `StoreFailure` naming what the database reported; a database that offers no check
 * answers {@link NoIntegrityCheck}.
 *
 * @example
 * const verified = await verifyLog(stores.driver);
 * if (verified.isErr() && verified.error._tag === "StoreFailure") console.error(verified.error.message);
 */
export function verifyLog(
  driver: SqlDriver,
): Promise<Result<void, StoreFailure | NoIntegrityCheck>> {
  if (driver.dialect === "postgres") return amcheck(driver);
  if (logPlacement(driver) === "inline") return inlineQuickCheck(driver);
  return quickCheck(driver);
}

/** The `meta` key that says how the last session over this log ended. */
const SESSION = "session";

/** Whether this connection's log is a file a session can leave half-written: a device's SQLite. */
const sessioned = (driver: SqlDriver): boolean =>
  driver.dialect !== "postgres" && logPlacement(driver) === "attached";

/**
 * Starts a session over the log: when the last one did not end in {@link closeSession} and the
 * log holds anything, runs {@link verifyLog} once first and refuses a damaged log as a value; then
 * marks the session open, so a crash before the next clean close is seen at the next start.
 *
 * Only on a device's SQLite. A Postgres log is shared by every process that opens it and is
 * recovered by its own server. An inline log shares its database with the state and has no
 * unclean session of its own to see; {@link verifyLog} still checks it on demand.
 */
export function openSession(driver: SqlDriver): Promise<Result<void, StoreFailure>> {
  if (!sessioned(driver)) return Promise.resolve(Result.ok(undefined));
  const meta = logTable("meta");
  return Result.gen(async function* () {
    const [ended, held] = yield* Result.await(
      attempt("could not read how the last session ended", async () => {
        const [row] = await driver.all(`SELECT value FROM ${meta} WHERE key = ?`, [SESSION]);
        const any = await driver.all(`SELECT 1 FROM ${logTable("events")} LIMIT 1`);
        return [row?.[0], any.length > 0] as const;
      }),
    );
    if (ended !== "closed" && held) {
      const verified = await quickCheck(driver);
      if (verified.isErr())
        return Result.err(
          new StoreFailure({
            message: `the last session ended without a clean close, and ${verified.error.message}`,
            cause: verified.error,
          }),
        );
    }
    yield* Result.await(reopenSession(driver));
    return Result.ok(undefined);
  });
}

/** Marks the session over the log closed cleanly, so the next {@link openSession} skips the check. */
export function closeSession(driver: SqlDriver): Promise<Result<void, StoreFailure>> {
  if (!sessioned(driver)) return Promise.resolve(Result.ok(undefined));
  return attempt("could not mark the session closed", () =>
    driver.run(`INSERT OR REPLACE INTO ${logTable("meta")} (key, value) VALUES (?, 'closed')`, [
      SESSION,
    ]),
  );
}

/**
 * Marks the session over the log open again, without the check {@link openSession} runs: the
 * session was {@link closeSession}d by this same process, which has not crashed since (D39).
 */
export function reopenSession(driver: SqlDriver): Promise<Result<void, StoreFailure>> {
  if (!sessioned(driver)) return Promise.resolve(Result.ok(undefined));
  return attempt("could not mark the session open", () =>
    driver.run(`INSERT OR REPLACE INTO ${logTable("meta")} (key, value) VALUES (?, 'open')`, [
      SESSION,
    ]),
  );
}

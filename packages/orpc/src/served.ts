import type { Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { SchemaEntry } from "@syncmesh/schema";
import type { Page, PageSource, ReadRequest, WindowRow, ReadFailed } from "@syncmesh/window";

import {
  driverValues,
  keyOfRows,
  limitOfRows,
  readColumns,
  readOnly,
  revocable,
  readFrom,
  readPredicate,
  scopeReads,
  tableIdentity,
  queryTables,
} from "@syncmesh/drizzle";
import { Result } from "@syncmesh/result";
import { SERVED_READ_TIMEOUT, servedReadSettings, servedView } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { MAX_ROWS, ReadRefused, readKey } from "@syncmesh/window";
import { Table, TransactionRollbackError, getTableName, is, sql } from "drizzle-orm";

import type { QueryContext, QueryDef, Router } from "./procedures.js";
import type { ServedDb, ServedTx } from "./served-pass.js";

import { isDef } from "./procedures.js";
import { isPostgresJs, servedClient } from "./served-client.js";
import { SNAPSHOT, drizzleStatement, failures, refused, watchdog } from "./served-pass.js";
import { toRow } from "./served-row.js";
import { validate } from "./validate.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this module is the boundary where a Drizzle row (whatever the handler selected) becomes wire cells, where a table is swapped for a Drizzle subquery that goes straight back to Drizzle, as `scopeReads` does, and where a driver's error is read for its SQLSTATE; every row value is checked before it is trusted */

/** What the server needs to serve the reads of one principal's socket. */
export interface ServedReadsOptions {
  /** The app's procedures; a window names one of its `query` leaves by path. */
  readonly router: Router;
  /** The manifest: which tables are `sync: "window"`, and their read rules. */
  readonly schema: Pick<ValidatorSchema, "rolesFor"> & {
    readonly entries: readonly (ValidatorSchema["entries"][number] & Pick<SchemaEntry, "sync">)[];
  };
  /**
   * A postgres.js Drizzle (`drizzle-orm/postgres-js`; any other throws) over the Postgres that
   * holds the served tables, **logged in as a login of its own**: one `servedReadDdl` granted the read role to (`grantTo`), and that holds nothing
   * else. Not the app's own connection: a read can always switch back to the role it logged in
   * as, so whatever that login may read, a served read may too. A login the DDL did not grant
   * the role is refused at the first read.
   */
  readonly db: object;
  /** Who holds the socket, as your auth established it: the read rules are evaluated for them. */
  readonly principal: Principal;
  /** The server's own peer id, which a handler is handed as `self`. */
  readonly self: PeerId;
  /** Committed changes to the database, as the tables each commit touched (`commitFeed`). */
  readonly onCommit: PageSource["onCommit"];
  /** Whether that feed is up (`resumableCommitFeed`); without it the feed is taken never to stop. */
  readonly onFeed?: PageSource["onFeed"];
  /**
   * The Postgres role every read runs as, which `servedReadDdl` creates: it may `SELECT` the
   * `sync: "window"` tables and nothing else, and each table's read rule is its row-level policy.
   * Each read is a read-only transaction running as this role, so what a handler reads is
   * bounded by Postgres as well as by the scoping here, `sql` fragments included.
   *
   * A server without one serves nothing: every read is refused.
   */
  readonly readRole: string;
  /**
   * The most rows one read may ask for. A handler whose query has no `.limit()`, or a larger one,
   * is refused before it runs.
   * @default 1000
   */
  readonly maxRows?: number;
  /**
   * How long one statement of a served read may run before Postgres cancels it. A cancelled read
   * failed, and is read again. A `sql` fragment can change the setting for the statements after
   * its own, so this bounds the reads as written, not a hostile fragment.
   * @default 5 seconds
   */
  readonly timeout?: Temporal.Duration;
  /**
   * How long a read is retried when Postgres says the role may not read a table, or that the
   * table does not exist. A deploy whose migration has not run yet looks like that for a while.
   * Past this the read is refused.
   * @default 1 minute
   */
  readonly grace?: Temporal.Duration;
}

/** The {@link ServedReadsOptions.grace} a server takes when none is given. */
export const GRACE = Temporal.Duration.from({ minutes: 1 });

/** A request matched to its procedure, its input parsed: a read ready to run. */
interface Planned {
  readonly key: string;
  readonly path: string;
  readonly def: QueryDef<never, unknown>;
  readonly input: never;
}

type Answer = Result<Page, ReadRefused | ReadFailed>;

/** The leaf `path` names, if it is a query: a window serves reads and nothing else. */
const queryAt = (router: Router, path: string): QueryDef<never, unknown> | undefined => {
  let node: Router[string] | undefined = router;
  // own keys only: `constructor` or `__proto__` names something every object has, and no procedure
  for (const step of path.split("."))
    node = node !== undefined && !isDef(node) && Object.hasOwn(node, step) ? node[step] : undefined;
  return node !== undefined && isDef(node) && node.kind === "query" ? node : undefined;
};

/** The request's procedure and parsed input, or why it is no read. */
const planRead = (router: Router, request: ReadRequest): Result<Planned, ReadRefused> => {
  const { path, input } = request;
  const def = queryAt(router, path);
  if (def === undefined) return Result.err(refused(`no read ${path}`));
  return validate<never>(def.schema, input)
    .mapError((error) => refused(error.message))
    .map((parsed) => ({ key: readKey(request), path, def, input: parsed }));
};

/** The table as `principal` may read it: the read rule compiled in, or a refusal. */
const canRead = (
  schema: ServedReadsOptions["schema"],
  principal: Principal,
  tx: ServedTx,
  table: Table,
): unknown => {
  const name = tableIdentity(table);
  const entry = schema.entries.find((e) => e.table.name === name);
  if (entry?.sync !== "window")
    throw refused(`${name} is not served: only a sync: "window" table is read on the server`);
  if (entry.allow === undefined) throw refused(`${name} has no read rule, so no one may read it`);
  const scope = { schema, dialect: "postgres", actor: principal } as const;
  // a column the reader's rule refuses reads NULL: its value never leaves the server
  const columns = readColumns(name, table, scope);
  const selecting = columns === undefined ? tx.select() : tx.select(columns);
  // a table with a ruled column is read from its view, which reads NULL where the rule
  // refuses: the role may not read that column of the table itself, `sql` fragments included
  const view = servedView(entry);
  // named as the query calls it, so an alias's columns still resolve
  return selecting
    .from(view === undefined ? table : readFrom(table, view))
    .where(readPredicate(name, scope))
    .as(getTableName(table));
};

/**
 * The app's `query` procedures, served a page at a time from Postgres to one principal's socket
 * (D43). A window names a procedure and its input; this runs that procedure's handler on the
 * server, exactly as it would run on a device, and returns its rows.
 *
 * **Permission is the read rule, applied twice** (E13). Every table the handler selects from is
 * replaced by the table as this principal may read it, as on a device, so the handler's own
 * filter only ever narrows; a table that is not `sync: "window"`, or has no rule, is refused.
 * Beneath that, the read runs as {@link ServedReadsOptions.readRole}, so a table named inside a
 * raw `sql` fragment is filtered or denied by Postgres itself, never read whole.
 *
 * Each read is a transaction that is rolled back: it switches to the role, records the
 * principal where the role's policies read it, and turns read-only, all before the handler
 * builds its query. Reads asked together share one transaction and one snapshot.
 *
 * A read the database refuses for what it asks (a table the role may not read, a value it cannot
 * take), or whose handler throws, is {@link ReadRefused}; one that did not run this time (a
 * timeout, a lost connection) is {@link ReadFailed}, and the window keeps its rows and reads
 * again. A role or table that is not there yet is a failure for {@link ServedReadsOptions.grace},
 * then a refusal.
 *
 * A served read selects one table's rows with its primary key, as a live query does, at most
 * {@link ServedReadsOptions.maxRows} of them; the key is how a page names its rows to the client.
 *
 * @example
 * // migration, as the tables' owner
 * for (const s of servedReadDdl(schema, { role: "syncmesh_reader", grantTo: "syncmesh_reads" })) await pg.unsafe(s);
 * // server: reads over a connection of their own
 * const reads = drizzle({ client: postgres(process.env.READS_URL) });
 * serveWindows(socket, {
 *   source: servedReads({ router, schema, db: reads, principal, self, onCommit: feed.onCommit, readRole: "syncmesh_reader" }),
 * });
 */
export function servedReads(options: ServedReadsOptions): PageSource {
  const {
    router,
    schema,
    principal,
    self,
    onCommit,
    onFeed,
    readRole,
    maxRows = MAX_ROWS,
    timeout = SERVED_READ_TIMEOUT,
    grace = GRACE,
  } = options;
  // the watchdog and the statement gate are postgres.js's: a read they cannot hold is not served
  if (!isPostgresJs(options))
    throw new TypeError(
      "servedReads needs a postgres.js Drizzle (drizzle-orm/postgres-js): a served read's statements are checked and cancelled through postgres.js",
    );
  // SAFETY: `db` is a Postgres Drizzle, which has `transaction`; its transaction has `execute`,
  // `rollback` and the select chain every dialect has, and the subquery goes straight back into
  // the handler's own chain
  const db = options.db as ServedDb;
  const settings = servedReadSettings(readRole, principal, timeout);
  const { classify: classifyFailure, settled } = failures(grace);

  /** The handler's query, built inside `tx`, or why it will not be run. */
  const build = (tx: ServedTx, { path, def, input }: Planned) => {
    const scoped = readOnly(
      scopeReads(tx, (table: never) =>
        is(table, Table) ? canRead(schema, principal, tx, table) : table,
      ),
    );
    /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the handler is written against the app's Drizzle; a Postgres Drizzle has the same read verbs, and the handler only chains them */
    const context = { input, db: scoped, principal, self } as unknown as QueryContext<never>;
    return Result.try({
      // boxed: a select is thenable, and a Result holds it as the builder it is
      try: () => ({ query: def.run(context) }),
      // a handler that throws throws again: it is the read's own fault, not the database's
      catch: (cause) =>
        cause instanceof ReadRefused
          ? cause
          : refused(
              `${path} threw building its query: ${cause instanceof Error ? cause.message : "no reason given"}`,
            ),
    }).andThen(({ query }) => {
      const keyOf = keyOfRows(query);
      if (keyOf === undefined)
        return Result.err(
          refused(
            `${path} must select one table's rows with its primary key to be served a page at a time`,
          ),
        );
      const limit = limitOfRows(query);
      if (limit === undefined || limit > maxRows)
        return Result.err(
          refused(`${path} must .limit() its rows to at most ${maxRows} to be served`),
        );
      return Result.ok({ query, keyOf });
    });
  };

  /** One read's rows as a page; a value no cell can carry refuses it. */
  const toPage = (
    query: Parameters<typeof driverValues>[0],
    rows: readonly unknown[],
    keyOf: (row: unknown) => string,
  ): Answer => {
    const { toDriver } = driverValues(query);
    const page: WindowRow[] = [];
    for (const record of rows) {
      // SAFETY: a select answers one record per row, keyed by the fields it selected
      const row = toRow(toDriver(record as Record<string, unknown>));
      if (row.isErr()) return Result.err(row.error);
      page.push({ key: keyOf(record), row: row.value });
    }
    return Result.ok({ rows: page, tables: queryTables(query) });
  };

  /** One read, built and run on a `db` that is revoked once its rows are in. */
  const runRead = async (
    tx: ServedTx,
    read: Planned,
    guard: Parameters<typeof revocable>[2],
  ): Promise<Answer> => {
    const fence = revocable(
      tx,
      () =>
        refused(`${read.path} used its db after its read ended: a handler's db is for that read`),
      guard,
    );
    try {
      const built = build(fence.db, read);
      if (built.isErr()) return Result.err(built.error);
      const { query, keyOf } = built.value;
      const rows = await Result.tryPromise({
        // SAFETY: a handler's select runs on await, and answers its rows
        try: async () => (await query) as readonly unknown[],
        catch: (cause) => classifyFailure(read.key, cause),
      });
      return rows.andThen((found) => toPage(query, found, keyOf));
    } finally {
      fence.revoke();
    }
  };

  /**
   * Runs `reads` in one transaction, in order, after the statement that makes it this reader's.
   * Each read ends with a rollback to before the reads, once every statement its handler started
   * has settled: whatever one did, a refused statement or a setting included, the next does not
   * inherit.
   *
   * Before the transaction's rollback, the session-level advisory locks a read took are let go: a
   * rollback keeps them, and the pool hands the connection to the next pass still holding them.
   */
  const pass = async (reads: readonly Planned[]): Promise<readonly Answer[]> => {
    const answers: Answer[] = [];
    const client = servedClient();
    let stop = () => Promise.resolve<unknown>(undefined);
    const ended = await Result.tryPromise({
      try: () =>
        db.transaction(
          async (tx) => {
            await tx.execute(drizzleStatement(settings));
            stop = watchdog(timeout, reads.length, client.cancel);
            await tx.execute(sql`SAVEPOINT syncmesh_reads`);
            for (const read of reads) {
              const from = client.mark();
              answers.push(await runRead(tx, read, client.guard));
              await client.settled(from);
              await tx.execute(sql`ROLLBACK TO SAVEPOINT syncmesh_reads`);
            }
            await tx.execute(sql`SELECT pg_advisory_unlock_all()`);
            // nothing a read does is kept: the principal's row least of all
            tx.rollback();
          },
          reads.length > 1 ? SNAPSHOT : undefined,
        ),
      catch: (cause) => cause,
    });
    await stop();
    const cause = ended.isErr() ? ended.error : undefined;
    if (cause !== undefined && !(cause instanceof TransactionRollbackError))
      // the transaction itself did not run: every read it had not answered failed with it
      return [
        ...answers,
        ...reads.slice(answers.length).map((read) => Result.err(classifyFailure(read.key, cause))),
      ];
    for (const [n, answer] of answers.entries()) {
      const key = reads[n]?.key;
      if (key !== undefined && answer.isOk()) settled(key);
    }
    return answers;
  };

  const readPages = async (requests: readonly ReadRequest[]): Promise<readonly Answer[]> => {
    // fail closed: without the role a raw fragment would read as the login, so nothing is read
    if (typeof readRole !== "string" || readRole === "")
      return requests.map(() =>
        Result.err(refused("no readRole is configured, so this server serves no read")),
      );
    const plans = requests.map((request) => planRead(router, request));
    const runnable = plans.flatMap((planned) => (planned.isOk() ? [planned.value] : []));
    const ran = runnable.length === 0 ? [] : await pass(runnable);
    let next = 0;
    return plans.map((planned) =>
      planned.isErr() ? Result.err(planned.error) : (ran[next++] ?? Result.err(refused("unread"))),
    );
  };

  const readPage = async (request: ReadRequest): Promise<Answer> =>
    (await readPages([request]))[0] ?? Result.err(refused("unread"));

  const source = { readPage, readPages, onCommit };
  return onFeed === undefined ? source : { ...source, onFeed };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

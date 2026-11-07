import type { Principal, ValidatorSchema } from "@syncmesh/engine";
import type { CellValue, ColumnName, PeerId, Row } from "@syncmesh/kernel";
import type { SchemaEntry } from "@syncmesh/schema";
import type { PrincipalStatement } from "@syncmesh/storage";
import type { Page, PageSource, ReadRequest, WindowRow } from "@syncmesh/window";
import type { SQL } from "drizzle-orm";

import {
  driverValues,
  keyOfRows,
  limitOfRows,
  readOnly,
  readPredicate,
  scopeReads,
  tableIdentity,
  tablesOf,
} from "@syncmesh/drizzle";
import { Result } from "@syncmesh/result";
import { servedReadSettings } from "@syncmesh/storage";
import { MAX_ROWS, ReadFailed, ReadRefused } from "@syncmesh/window";
import { Table, getTableName, is, sql } from "drizzle-orm";

import type { QueryContext, QueryDef, Router } from "./procedures.js";

import { isDef } from "./procedures.js";
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
  /** The app's Drizzle over the Postgres that holds the served tables. */
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
}

const refused = (message: string) => new ReadRefused({ message });

/**
 * SQLSTATE classes that say the read itself is wrong, so asking again gives the same answer:
 * `42` (a name it may not use, or that does not exist), `22` (a value it cannot take), `0A`
 * (something Postgres does not do) and `25` (a write inside a read-only transaction).
 */
const REFUSING = new Set(["42", "22", "0A", "25"]);

/** The driver's own error under Drizzle's wrapper, and its SQLSTATE: what Postgres said, not the query it said it about. */
const driverErrorOf = (cause: unknown) => {
  for (let at = cause; at instanceof Error; at = at.cause) {
    const code: unknown = "code" in at ? at.code : undefined;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
      return { state: code, message: at.message };
  }
  return undefined;
};

/** A read that threw, as a refusal when asking again cannot help, and a failure when it may. */
const failureOf = (cause: unknown): ReadRefused | ReadFailed => {
  if (cause instanceof ReadRefused || cause instanceof ReadFailed) return cause;
  const driver = driverErrorOf(cause);
  const message = driver?.message ?? (cause instanceof Error ? cause.message : "the read failed");
  return driver !== undefined && REFUSING.has(driver.state.slice(0, 2))
    ? refused(message)
    : new ReadFailed({ message });
};

/** `SELECT set_config('…', $1, TRUE)` as a Drizzle statement, each `$n` bound to its param. */
const statementOf = ({ sql: text, params }: PrincipalStatement): SQL =>
  sql.join(
    text
      .split(/\$(\d+)/)
      .map((part, i) => (i % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1] ?? null}`)),
  );

/** The parts of a Postgres Drizzle a served read uses: a transaction, and SQL in it. */
interface ServedDb {
  readonly transaction: <T>(body: (tx: ServedTx) => Promise<T>) => Promise<T>;
}

interface ServedTx {
  readonly execute: (query: SQL) => PromiseLike<unknown>;
  readonly select: () => {
    from: (t: Table) => { where: (w: unknown) => { as: (n: string) => unknown } };
  };
}

/** The leaf `path` names, if it is a query: a window serves reads and nothing else. */
const queryAt = (router: Router, path: string): QueryDef<never, unknown> | undefined => {
  let node: Router[string] | undefined = router;
  // own keys only: `constructor` or `__proto__` names something every object has, and no procedure
  for (const step of path.split("."))
    node = node !== undefined && !isDef(node) && Object.hasOwn(node, step) ? node[step] : undefined;
  return node !== undefined && isDef(node) && node.kind === "query" ? node : undefined;
};

const isCell = (value: unknown): value is CellValue =>
  value === null ||
  value instanceof Uint8Array ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "object" && value.constructor === Object) ||
  Array.isArray(value);

/** One returned row as wire cells, keyed by the field names the handler selected. */
const toRow = (record: Record<string, unknown>): Result<Row, ReadRefused> => {
  const cells = new Map<ColumnName, CellValue>();
  for (const [field, value] of Object.entries(record)) {
    const cell = value instanceof Uint8Array ? Uint8Array.from(value) : value;
    if (!isCell(cell))
      return Result.err(refused(`${field} holds a ${typeof value}, which no cell can carry`));
    // SAFETY: a selected field's name is the column name the client rebuilds the row under
    cells.set(field as ColumnName, cell);
  }
  return Result.ok(cells);
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
 * A read the database refuses for what it asks (a table the role may not read, a value it cannot
 * take) is {@link ReadRefused}; one that did not run this time (a timeout, a lost connection) is
 * {@link ReadFailed}, and the window keeps its rows and reads again.
 *
 * A served read selects one table's rows with its primary key, as a live query does, at most
 * {@link ServedReadsOptions.maxRows} of them; the key is how a page names its rows to the client.
 *
 * @example
 * for (const statement of servedReadDdl(schema, "syncmesh_reader")) await pg.unsafe(statement);
 * const feed = commitFeed(await postgresChangeSource({ … }).start({ after: null }));
 * serveWindows(socket, {
 *   source: servedReads({ router, schema, db, principal, self, onCommit: feed.onCommit, readRole: "syncmesh_reader" }),
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
  } = options;
  // SAFETY: `db` is a Postgres Drizzle, which has `transaction`; its transaction has `execute`
  // and the select chain every dialect has, and the subquery goes straight back into the
  // handler's own chain
  const db = options.db as ServedDb;
  const settings = servedReadSettings(readRole, principal);

  /** The table as this principal may read it: the read rule compiled in, or a refusal. */
  const canRead = (tx: ServedTx, table: Table): unknown => {
    const name = tableIdentity(table);
    const entry = schema.entries.find((e) => e.table.name === name);
    if (entry?.sync !== "window")
      throw refused(`${name} is not served: only a sync: "window" table is read on the server`);
    if (entry.allow === undefined) throw refused(`${name} has no read rule, so no one may read it`);
    const rule = readPredicate(name, { schema, dialect: "postgres", actor: principal });
    // named as the query calls it, so an alias's columns still resolve
    return tx.select().from(table).where(rule).as(getTableName(table));
  };

  /** Runs the handler's query inside `tx` and reads its page; a refusal is thrown, to roll back. */
  const run = async (tx: ServedTx, path: string, def: QueryDef<never, unknown>, input: never) => {
    const scoped = readOnly(
      scopeReads(tx, (table: never) => (is(table, Table) ? canRead(tx, table) : table)),
    );
    /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the handler is written against the app's Drizzle; a Postgres Drizzle has the same read verbs, and the handler only chains them */
    const context = { input, db: scoped, principal, self } as unknown as QueryContext<never>;
    const query = def.run(context);
    const keyOf = keyOfRows(query);
    if (keyOf === undefined)
      throw refused(
        `${path} must select one table's rows with its primary key to be served a page at a time`,
      );
    const limit = limitOfRows(query);
    if (limit === undefined || limit > maxRows)
      throw refused(`${path} must .limit() its rows to at most ${maxRows} to be served`);
    // read-only, as the read role, as this reader: one round trip before the read itself
    await tx.execute(statementOf(settings));
    const rows = await query;
    const { toDriver } = driverValues(query);
    const page: WindowRow[] = [];
    for (const record of rows) {
      // SAFETY: a select answers one record per row, keyed by the fields it selected
      const row = toRow(toDriver(record as Record<string, unknown>));
      if (row.isErr()) throw row.error;
      page.push({ key: keyOf(record), row: row.value });
    }
    return { rows: page, tables: tablesOf(query) } satisfies Page;
  };

  const readPage = async ({ path, input }: ReadRequest) => {
    // fail closed: without the role a raw fragment would read as the app, so nothing is read
    if (typeof readRole !== "string" || readRole === "")
      return Result.err(refused("no readRole is configured, so this server serves no read"));
    const def = queryAt(router, path);
    if (def === undefined) return Result.err(refused(`no read ${path}`));
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return Result.err(refused(parsed.error.message));
    return Result.tryPromise({
      try: () => db.transaction((tx) => run(tx, path, def, parsed.value)),
      catch: failureOf,
    });
  };

  return onFeed === undefined ? { readPage, onCommit } : { readPage, onCommit, onFeed };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

import type { Principal, ValidatorSchema } from "@syncmesh/engine";
import type { CellValue, ColumnName, PeerId, Row } from "@syncmesh/kernel";
import type { SchemaEntry } from "@syncmesh/schema";
import type { Page, PageSource, ReadRequest, WindowRow } from "@syncmesh/window";

import {
  driverValues,
  keyOfRows,
  readOnly,
  readPredicate,
  scopeReads,
  tablesOf,
} from "@syncmesh/drizzle";
import { Result } from "@syncmesh/result";
import { ReadRefused } from "@syncmesh/window";
import { Table, getTableName, is } from "drizzle-orm";

import type { QueryContext, QueryDef, Router } from "./procedures.js";

import { isDef } from "./procedures.js";
import { validate } from "./validate.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this module is the boundary where a Drizzle row (whatever the handler selected) becomes wire cells, and where a table is swapped for a Drizzle subquery that goes straight back to Drizzle, as `scopeReads` does; every row value is checked before it is trusted */

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
}

const refused = (message: string) => new ReadRefused({ message });

/** The leaf `path` names, if it is a query: a window serves reads and nothing else. */
const queryAt = (router: Router, path: string): QueryDef<never, unknown> | undefined => {
  let node: Router[string] | undefined = router;
  for (const step of path.split("."))
    node = node !== undefined && !isDef(node) ? node[step] : undefined;
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
 * (D39). A window names a procedure and its input; this runs that procedure's handler on the
 * server, exactly as it would run on a device, and returns its rows.
 *
 * **Permission is the read rule, applied before the handler's `where`** (E13). Every table the
 * handler selects from is replaced by the table as this principal may read it, as on a device,
 * so the handler's own filter only ever narrows. It fails closed: a table that is not
 * `sync: "window"`, or that has no rule to apply, is refused rather than read.
 *
 * A served read selects one table's rows with its primary key, as a live query does; the key
 * is how a page names its rows to the client.
 *
 * @example
 * const feed = commitFeed(await postgresChangeSource({ … }).start({ after: null }));
 * serveWindows(socket, {
 *   source: servedReads({ router, schema, db, principal, self, onCommit: feed.onCommit }),
 * });
 */
export function servedReads(options: ServedReadsOptions): PageSource {
  const { router, schema, principal, self, onCommit } = options;
  // SAFETY: `db` is a Drizzle database, and these are the three builder calls every dialect's
  // select chain has; the subquery goes straight back into the handler's own chain
  const db = options.db as {
    readonly select: () => {
      from: (t: Table) => { where: (w: unknown) => { as: (n: string) => unknown } };
    };
  };

  /** The table as this principal may read it: the read rule compiled in, or a refusal. */
  const canRead = (table: Table): unknown => {
    const name = getTableName(table);
    const entry = schema.entries.find((e) => e.table.name === name);
    if (entry?.sync !== "window")
      throw refused(`${name} is not served: only a sync: "window" table is read on the server`);
    if (entry.allow === undefined) throw refused(`${name} has no read rule, so no one may read it`);
    const rule = readPredicate(name, { schema, dialect: "postgres", actor: principal });
    return db.select().from(table).where(rule).as(name);
  };

  const readPage = async ({ path, input }: ReadRequest): Promise<Result<Page, ReadRefused>> => {
    const def = queryAt(router, path);
    if (def === undefined) return Result.err(refused(`no read ${path}`));
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return Result.err(refused(parsed.error.message));
    const scoped = readOnly(
      scopeReads(db, (table: never) => (is(table, Table) ? canRead(table) : table)),
    );
    /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the handler is written against the app's Drizzle; a Postgres Drizzle has the same read verbs, and the handler only chains them */
    const context = {
      input: parsed.value,
      db: scoped,
      principal,
      self,
    } as unknown as QueryContext<never>;
    // boxed, because a built query is a thenable and the box keeps it from being awaited here
    const built = Result.try({
      try: () => ({ query: def.run(context) }),
      catch: (cause) =>
        cause instanceof ReadRefused
          ? cause
          : refused(cause instanceof Error ? cause.message : "the handler failed"),
    });
    if (built.isErr()) return Result.err(built.error);
    const { query } = built.value;
    const keyOf = keyOfRows(query);
    if (keyOf === undefined)
      return Result.err(
        refused(
          `${path} must select one table's rows with its primary key to be served a page at a time`,
        ),
      );
    const rows = await Result.tryPromise({
      try: async () => query,
      catch: (cause) =>
        cause instanceof ReadRefused
          ? cause
          : refused(cause instanceof Error ? cause.message : "the read failed"),
    });
    if (rows.isErr()) return rows;
    const { toDriver } = driverValues(query);
    const page: WindowRow[] = [];
    for (const record of rows.value) {
      // SAFETY: a select answers one record per row, keyed by the fields it selected
      const row = toRow(toDriver(record as Record<string, unknown>));
      if (row.isErr()) return row;
      page.push({ key: keyOf(record), row: row.value });
    }
    return Result.ok({ rows: page, tables: tablesOf(query) });
  };

  return { readPage, onCommit };
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

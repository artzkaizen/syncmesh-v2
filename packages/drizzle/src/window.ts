import type { SQLWrapper } from "drizzle-orm";

import {
  Column,
  SQL,
  StringChunk,
  Subquery,
  Table,
  and,
  getTableName,
  inArray,
  is,
} from "drizzle-orm";

import type { Runnable } from "./live.js";
import type { Cell, Cells } from "./order.js";

import { compareCells } from "./order.js";
import { walkSql } from "./tree.js";

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- this file reads a query builder's own internals: a select's projection is whatever the caller selected, its source whatever they selected it from, and Drizzle's `is()` is the parse that turns either into something with a contract. Typing the input narrower than `unknown` here would be a claim about a shape nobody promised */

/**
 * A query whose answer can be **maintained** from the keys a fold names, instead of re-read.
 *
 * A fold hands live queries the exact `(table, key)` pairs it wrote (`FoldBatch.writeKeys`).
 * Given those, the new answer to `SELECT … WHERE … ORDER BY … LIMIT n` is the old answer with
 * those keys taken out and their current rows — read back with one small statement — put in at
 * the position the same `ORDER BY` gives them. Nothing else in the list can have moved, because
 * nothing else was written. The cost is the size of the change, not the size of the list.
 *
 * Only some queries admit that, and the checks in {@link windowOf} are what say which. A query
 * that fails one is not broken and is not slower than it was: it re-runs, exactly as every query
 * did before this existed.
 */
export interface LiveWindow<T> {
  /** The one table this query draws rows from. A fold that wrote any *other* table it reads forces a re-run. */
  readonly table: string;
  /** The row's primary key, as the string a `RowKey` is. */
  readonly keyOf: (row: T) => string;
  /** SQLite's own ordering of two rows under this query's `ORDER BY`. */
  readonly order: (left: T, right: T) => number;
  /** The `LIMIT`, or `undefined` for a query that draws everything it matches. */
  readonly limit: number | undefined;
  /** The same question asked of these keys alone and unlimited — the one statement maintenance costs. */
  readonly probe: (keys: readonly string[]) => Runnable<T> | undefined;
}

/**
 * The select Drizzle built, before a dialect rendered it.
 *
 * Structural rather than imported, because the two dialects declare their own
 * (`SQLiteSelectConfig`, `PgSelectConfig`) and this package must read either without loading
 * `pg-core` onto a phone. Every field named here is on both.
 */
interface SelectConfig {
  readonly fields: Record<string, unknown>;
  where?: SQL | undefined;
  readonly having?: unknown;
  readonly table: unknown;
  limit?: unknown;
  offset?: unknown;
  readonly joins?: readonly unknown[] | undefined;
  readonly orderBy?: readonly unknown[] | undefined;
  readonly groupBy?: readonly unknown[] | undefined;
  readonly distinct?: boolean | undefined;
  readonly setOperators?: readonly unknown[] | undefined;
  readonly withList?: readonly unknown[] | undefined;
}

const configOf = (query: SQLWrapper): SelectConfig | undefined => {
  // SAFETY: `_` is Drizzle's own bag on every select, read here only to be probed; nothing is
  // assumed about it beyond the three checks below
  const bag: unknown = (query as { readonly _?: unknown })._;
  if (typeof bag !== "object" || bag === null || !("config" in bag)) return undefined;
  const config = bag.config;
  if (typeof config !== "object" || config === null) return undefined;
  if (!("fields" in config) || !("table" in config)) return undefined;
  /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: a bag carrying `config.fields` and `config.table` is a built select, and `SelectConfig` names only fields both dialects declare; every one of them is read back through a guard */
  return config as unknown as SelectConfig;
};

/**
 * The single table a source is a view of: the table itself, or a plain filtered select over one
 * — which is what `read(table)` hands back, the table with the caller's read rule compiled in.
 *
 * A subquery that *computed* a column is rejected, and that rejection is load-bearing:
 * `issues.list` with `perStatus` numbers its rows with `row_number() OVER (PARTITION BY
 * status …)`, whose value depends on every other row in the partition. A probe restricted to the
 * keys a fold wrote would number those keys 1, 2, 3, and the outer `WHERE within <= n` would
 * admit rows that belong nowhere near the top of their column.
 */
const sourceTableOf = (source: unknown): string | undefined => {
  if (is(source, Table)) return getTableName(source);
  if (!is(source, Subquery)) return undefined;
  for (const field of Object.values(source._.selectedFields))
    if (!is(field, Column)) return undefined;
  const named = new Set<string>();
  walkSql(source._.sql, (chunk) => {
    if (is(chunk, Table)) named.add(getTableName(chunk));
    else if (is(chunk, Column)) named.add(getTableName(chunk.table));
  });
  const [only] = named;
  return named.size === 1 ? only : undefined;
};

/**
 * Which output field each of the source's columns became, and `undefined` if any field is not a
 * plain column.
 *
 * Matched by column name rather than by identity, because a subquery hands out a fresh proxy per
 * access — `source.rank` is not `source.rank` — so the only stable thing the two sides share is
 * the name. Within one source that is unique, which is what makes the map a map.
 */
const fieldsByColumn = (
  fields: Record<string, unknown>,
): ReadonlyMap<string, string> | undefined => {
  const named = new Map<string, string>();
  for (const [field, value] of Object.entries(fields)) {
    if (!is(value, Column)) return undefined;
    named.set(value.name, field);
  }
  return named;
};

/** The one field carrying the primary key, which is what a `RowKey` is — or nothing to key by. */
const keyFieldOf = (fields: Record<string, unknown>): string | undefined => {
  const keyed = Object.entries(fields)
    .filter(([, value]) => is(value, Column) && value.primary)
    .map(([field]) => field);
  // a key spread over two columns is not one string, and a row a fold names is
  return keyed.length === 1 ? keyed[0] : undefined;
};

/**
 * Whether this is one plain select over one source.
 *
 * Every shape rejected here makes a row's presence, or its value, depend on rows the fold did
 * not name — a join's other side, a group's other members, a second branch of a union.
 */
const isPlain = (config: SelectConfig): boolean => {
  const composed =
    (config.joins?.length ?? 0) +
    (config.groupBy?.length ?? 0) +
    (config.setOperators?.length ?? 0) +
    (config.withList?.length ?? 0);
  return composed === 0 && config.having === undefined && config.distinct !== true;
};

/** One `ORDER BY` term, once it is known to be a plain column and a direction. */
interface Sorted {
  readonly field: string;
  readonly descending: boolean;
}

const DIRECTION = /^\s*(asc|desc)\s*$/i;

/**
 * `ORDER BY` as a list of (field, direction), or `undefined` for anything else.
 *
 * `asc(col)` and `desc(col)` are the only two shapes read here, because they are the only two
 * whose ordering can be reproduced from the row in hand. `issues.search` sorts by
 * `sql`${number} = ${n} desc`` — an expression over a bind — and so re-runs, which is the right
 * answer: nothing on the row says what that predicate evaluates to.
 */
const sortedBy = (
  terms: readonly unknown[],
  byColumn: ReadonlyMap<string, string>,
): readonly Sorted[] | undefined => {
  const order: Sorted[] = [];
  for (const term of terms) {
    if (is(term, Column)) {
      const field = byColumn.get(term.name);
      if (field === undefined) return undefined;
      order.push({ field, descending: false });
      continue;
    }
    if (!is(term, SQL) || term.queryChunks.length !== 3) return undefined;
    const [head, column, tail] = term.queryChunks;
    if (!is(column, Column) || !is(head, StringChunk) || !is(tail, StringChunk)) return undefined;
    if (head.value.join("") !== "") return undefined;
    const direction = DIRECTION.exec(tail.value.join(""))?.[1];
    const field = byColumn.get(column.name);
    if (direction === undefined || field === undefined) return undefined;
    order.push({ field, descending: direction.toLowerCase() === "desc" });
  }
  return order;
};

// SAFETY: a row is whatever the driver returned for this projection — an object of cells under
// the very field names this plan read off that same projection
const cellOf = (row: unknown, field: string): Cell => ((row ?? {}) as Cells)[field];

/** The query's `ORDER BY`, as the comparison that decides where a changed row now belongs. */
const orderBy =
  <T>(sorted: readonly Sorted[]) =>
  (left: T, right: T): number => {
    for (const { field, descending } of sorted) {
      const side = compareCells(cellOf(left, field), cellOf(right, field));
      if (side !== 0) return descending ? -side : side;
    }
    return 0;
  };

/** What {@link limitOf} says when the window is one this cannot stand behind. */
const REFUSED = Symbol("refused");

/**
 * The `LIMIT` as a number, `undefined` for a query that draws everything, or {@link REFUSED}.
 *
 * A truncated window can only be maintained under a **total** order, and the key is what makes
 * one total. The rows below the limit were never read, and all that is known about them is that
 * they sorted after the last row drawn; with a tie at that boundary an unseen row can sort level
 * with it, and nothing in hand says which of the two belongs in the window.
 */
const limitOf = (
  config: SelectConfig,
  sorted: readonly Sorted[],
  keyField: string,
): number | undefined | typeof REFUSED => {
  if (config.limit === undefined) return undefined;
  // a placeholder limit is bound at execution, so this build does not know what it is
  if (typeof config.limit !== "number") return REFUSED;
  return sorted.at(-1)?.field === keyField ? config.limit : REFUSED;
};

/**
 * The plan for maintaining this query, or `undefined` to say it must re-run.
 *
 * `again` rebuilds the same question — the procedure's handler run a second time — because the
 * probe is that question with a key filter added and the limit dropped, and a Drizzle builder is
 * mutated by its own chained calls: narrowing the one the caller is holding would narrow the
 * query it is about to await.
 */
export const windowOf = <T>(
  query: Runnable<T>,
  again: () => Runnable<T>,
): LiveWindow<T> | undefined => {
  const config = configOf(query);
  // an offset addresses a position, and every position below it moves when a row above changes
  if (config === undefined || !isPlain(config) || config.offset !== undefined) return undefined;

  const table = sourceTableOf(config.table);
  const byColumn = fieldsByColumn(config.fields);
  const keyField = keyFieldOf(config.fields);
  if (table === undefined || byColumn === undefined || keyField === undefined) return undefined;

  const terms = config.orderBy ?? [];
  const sorted = terms.length === 0 ? undefined : sortedBy(terms, byColumn);
  if (sorted === undefined) return undefined;

  const limit = limitOf(config, sorted, keyField);
  if (limit === REFUSED) return undefined;

  const probe = (keys: readonly string[]): Runnable<T> | undefined => {
    const fresh = again();
    const narrowed = configOf(fresh);
    if (narrowed === undefined) return undefined;
    // taken off the rebuilt query rather than the sample: a subquery mints a fresh column proxy
    // per access, and the filter belongs to the statement that will carry it
    const keyed = narrowed.fields[keyField];
    if (!is(keyed, Column)) return undefined;
    const filter = inArray(keyed, [...keys]);
    narrowed.where = narrowed.where === undefined ? filter : and(narrowed.where, filter);
    // the limit belonged to the window, not to the question: these keys are wanted wherever they
    // now sort, including past the end of what is on screen
    narrowed.limit = undefined;
    return fresh;
  };

  return {
    table,
    keyOf: (row) => String(cellOf(row, keyField)),
    order: orderBy<T>(sorted),
    limit,
    probe,
  };
};

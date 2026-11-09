import { panic } from "@syncmesh/result";

import type { SqlDialect, SqlDriver, SqlValue } from "./driver.js";

/**
 * Rows per statement at most, and never more binds than this: under SQLite's 32,766 and
 * Postgres's 65,535 alike, whatever the row's width.
 */
const MOST_ROWS = 512;
const MOST_BINDS = 30_000;

/** `$4` → `$9` when the tuple moves along by 5; SQLite's `?` carries no position. */
const POSITIONAL = /\$(\d+)/g;

/** One statement's text, split once around its only `VALUES (…)` tuple, and its rewrites per row count. */
interface Template {
  readonly head: string;
  readonly tuple: string;
  readonly tail: string;
  readonly width: number;
  readonly texts: Map<number, string>;
}

const templates = new Map<string, Template>();

/**
 * Where the one `VALUES (…)` tuple of an insert is, and how many binds it holds. A statement
 * with a bind outside it cannot be repeated row by row, and is a programming error here.
 */
const template = (sql: string, dialect: SqlDialect): Template => {
  const known = templates.get(sql);
  if (known !== undefined) return known;
  const open = sql.indexOf("VALUES (");
  if (open === -1) return panic(`not a single-tuple insert: ${sql}`);
  const start = open + "VALUES ".length;
  let depth = 0;
  let end = start;
  for (; end < sql.length; end += 1) {
    if (sql[end] === "(") depth += 1;
    else if (sql[end] === ")" && --depth === 0) break;
  }
  const head = sql.slice(0, start);
  const tuple = sql.slice(start, end + 1);
  const tail = sql.slice(end + 1);
  const binds = (text: string) =>
    dialect === "postgres" ? (text.match(POSITIONAL) ?? []).length : text.split("?").length - 1;
  if (binds(head) + binds(tail) > 0) return panic(`binds outside the VALUES tuple: ${sql}`);
  const made = { head, tuple, tail, width: binds(tuple), texts: new Map<number, string>() };
  templates.set(sql, made);
  return made;
};

/** `count` copies of the tuple, Postgres positions moved along row by row. */
const text = (insert: Template, count: number, dialect: SqlDialect): string => {
  const known = insert.texts.get(count);
  if (known !== undefined) return known;
  const tuples = Array.from({ length: count }, (_, row) =>
    dialect === "postgres"
      ? insert.tuple.replace(POSITIONAL, (_, at: string) => `$${Number(at) + row * insert.width}`)
      : insert.tuple,
  );
  const made = `${insert.head}${tuples.join(", ")}${insert.tail}`;
  insert.texts.set(count, made);
  return made;
};

/**
 * Runs a one-row `INSERT … VALUES (…) …` for every row in `rows` as a few multi-row statements:
 * a round trip per chunk rather than per row. Chunks are powers of two, so a driver that caches
 * statements by text caches a handful per insert, whatever the batch sizes.
 *
 * Postgres refuses an `ON CONFLICT DO UPDATE` that meets one key twice in one statement: the
 * caller passes each key once.
 *
 * @example
 * await insertRows(driver, SQL.upsertRow, rows.map((r) => [r.table, r.key, r.bytes]));
 */
export async function insertRows(
  driver: SqlDriver,
  sql: string,
  rows: readonly (readonly SqlValue[])[],
): Promise<void> {
  if (rows.length === 0) return;
  const dialect = driver.dialect ?? "sqlite";
  const insert = template(sql, dialect);
  const most = Math.max(1, Math.min(MOST_ROWS, Math.floor(MOST_BINDS / Math.max(1, insert.width))));
  let at = 0;
  while (at < rows.length) {
    let count = 1;
    while (count * 2 <= Math.min(most, rows.length - at)) count *= 2;
    const chunk = rows.slice(at, at + count);
    await driver.run(text(insert, count, dialect), chunk.flat());
    at += count;
  }
}

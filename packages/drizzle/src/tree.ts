import type { SQLChunk, SQLWrapper } from "drizzle-orm";

import { Column, Param, SQL, StringChunk, Subquery, Table, getTableName, is } from "drizzle-orm";

/**
 * Drizzle's own chunk tree, walked — the shape a built query is, before it is text.
 *
 * Read from the typed tree rather than from `toSQL()` because the tree is what Drizzle
 * guarantees: a builder promises the chunks it composed, never the string a dialect will render
 * them into, and every question asked here — which tables, which identity — is one about the
 * composition.
 */

/** Visits every chunk of a query, descending through subqueries and nested fragments. */
export const walkSql = (chunk: SQLChunk, visit: (node: SQLChunk) => void): void => {
  visit(chunk);
  if (is(chunk, Subquery)) walkSql(chunk._.sql, visit);
  else if (is(chunk, SQL)) for (const inner of chunk.queryChunks) walkSql(inner, visit);
};

/** Every table a query's SQL mentions, through columns, subqueries and nested fragments. */
export const tablesOf = (query: SQLWrapper): ReadonlySet<string> => {
  const names = new Set<string>();
  walkSql(query.getSQL(), (chunk) => {
    if (is(chunk, Table)) names.add(getTableName(chunk));
    else if (is(chunk, Column)) names.add(getTableName(chunk.table));
  });
  return names;
};

/** The separator between identity parts: a byte no identifier or literal can contain. */
const BETWEEN = String.fromCharCode(0);

/**
 * A query's identity for sharing: every table, column, literal and bind it names, in order.
 *
 * Two callers asking the same question get one subscription and one re-run, and this string is
 * what "the same question" means — so it has to separate `assigneeId = alice` from `assigneeId =
 * bob`, which is why the bound params are in it and not only the shape around them.
 */
export const identityOf = (query: SQLWrapper): string => {
  const parts: string[] = [];
  walkSql(query.getSQL(), (chunk) => {
    if (is(chunk, Table)) parts.push(`t:${getTableName(chunk)}`);
    else if (is(chunk, Column)) parts.push(`c:${getTableName(chunk.table)}.${chunk.name}`);
    else if (is(chunk, Param)) parts.push(`p:${JSON.stringify(chunk.value) ?? "?"}`);
    else if (is(chunk, StringChunk)) parts.push(`s:${chunk.value.join("")}`);
    // a chunk kind this build does not name: never shared, always safe
    else if (!is(chunk, SQL) && !is(chunk, Subquery)) parts.push("?");
  });
  return parts.join(BETWEEN);
};

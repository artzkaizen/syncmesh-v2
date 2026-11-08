import type { SQLChunk, SQLWrapper } from "drizzle-orm";

import {
  Column,
  Param,
  SQL,
  StringChunk,
  Subquery,
  Table,
  getColumnTable,
  getTableName,
  is,
} from "drizzle-orm";

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

/** Drizzle's own keys for a table's source name and schema, which an alias forwards to its source. */
// SAFETY: a unique symbol type can only be declared, so the registered symbol is asserted onto it
const ORIGINAL_NAME: unique symbol = Symbol.for("drizzle:OriginalName") as never;
// SAFETY: as above
const SCHEMA: unique symbol = Symbol.for("drizzle:Schema") as never;

/**
 * The table a source **is**, as the manifest and the change feed name it: `mail`, or
 * `crm.mail` outside Postgres's `public` schema.
 *
 * Not `getTableName`, which answers the name the query calls it by. `alias(mail, "m2")` is
 * called `m2`, and a read rule looked up under `m2` is no rule at all; a commit to `mail` is a
 * commit to `m2` too. Two tables named `mail` in two schemas are two tables.
 *
 * @example
 * tableIdentity(alias(mail, "m2")); // "mail"
 * tableIdentity(pgSchema("crm").table("mail", { … })); // "crm.mail"
 */
export const tableIdentity = (table: Table): string => {
  const original = ORIGINAL_NAME in table ? table[ORIGINAL_NAME] : undefined;
  const schema = SCHEMA in table ? table[SCHEMA] : undefined;
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a symbol Drizzle keeps holds whatever Drizzle put there: this is the parse */
  const name = typeof original === "string" ? original : getTableName(table);
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- as above */
  if (typeof schema !== "string" || schema === "public") return name;
  return `${schema}.${name}`;
};

/** Every table a query's SQL mentions, through columns, subqueries and nested fragments. */
export const queryTables = (query: SQLWrapper): ReadonlySet<string> => {
  const names = new Set<string>();
  walkSql(query.getSQL(), (chunk) => {
    if (is(chunk, Table)) names.add(tableIdentity(chunk));
    else if (is(chunk, Column)) names.add(tableIdentity(getColumnTable(chunk)));
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
export const queryIdentity = (query: SQLWrapper): string => {
  const parts: string[] = [];
  walkSql(query.getSQL(), (chunk) => {
    if (is(chunk, Table)) parts.push(`t:${getTableName(chunk)}`);
    else if (is(chunk, Column))
      parts.push(`c:${getTableName(getColumnTable(chunk))}.${chunk.name}`);
    else if (is(chunk, Param)) parts.push(`p:${JSON.stringify(chunk.value) ?? "?"}`);
    else if (is(chunk, StringChunk)) parts.push(`s:${chunk.value.join("")}`);
    // a chunk kind this build does not name: never shared, always safe
    else if (!is(chunk, SQL) && !is(chunk, Subquery)) parts.push("?");
  });
  return parts.join(BETWEEN);
};

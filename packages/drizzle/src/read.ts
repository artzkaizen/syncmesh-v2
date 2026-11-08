import type { Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { Compiled, SqlDialect } from "@syncmesh/storage";
import type { SQL } from "drizzle-orm";

import { compileField, compileRead } from "@syncmesh/storage";
import { getColumns, sql, type Column, type Table } from "drizzle-orm";

/** A compiled predicate as a Drizzle fragment: raw text between the `?`s, each param bound by Drizzle for its dialect. */
const fragment = ({ sql: text, params }: Compiled): SQL => {
  const pieces = text.split("?");
  const chunks: SQL[] = [];
  pieces.forEach((piece, i) => {
    chunks.push(sql.raw(piece));
    if (i < params.length) chunks.push(sql`${params[i]}`);
  });
  return sql.join(chunks);
};

/** One column's read rule: the policy node `compileField` takes. */
type FieldRule = Parameters<typeof compileField>[2];

/**
 * What a scoped read needs of a schema: validation's view of it, plus each table's field rules
 * (E06, D40) — which only a read honours, so validation never names them.
 */
export interface ReadSchema extends ValidatorSchema {
  readonly entries: readonly (ValidatorSchema["entries"][number] & {
    readonly fields?: Readonly<Record<string, FieldRule>>;
  })[];
}

export interface ReadScope {
  readonly schema: ReadSchema;
  readonly dialect: SqlDialect;
  readonly partition?: PartitionKey;
  readonly actor?: Principal;
}

/** A face's read scope from its deps, without carrying absent keys. */
export const readScope = (
  dialect: SqlDialect,
  deps: {
    readonly schema: ReadSchema;
    readonly partition?: PartitionKey;
    readonly actor?: Principal;
  },
): ReadScope => {
  const scope: ReadScope = { schema: deps.schema, dialect };
  if (deps.partition !== undefined) Object.assign(scope, { partition: deps.partition });
  if (deps.actor !== undefined) Object.assign(scope, { actor: deps.actor });
  return scope;
};

/** The `WHERE` a source carries: the actor's `read` rule and the pin, or nothing to filter. */
export const readPredicate = (name: string, scope: ReadScope): SQL => {
  const { schema, dialect, partition, actor } = scope;
  const entry = schema.entries.find((e) => String(e.table.name) === name);
  const filters: SQL[] = [];
  if (actor !== undefined && entry !== undefined) {
    // SAFETY: rolesFor is typed by the manifest's own kinds; this entry's partition is one of them
    const roles = schema.rolesFor(entry.partition as never);
    filters.push(fragment(compileRead(entry.table, roles, entry.allow, actor, { dialect })));
  }
  if (partition !== undefined) filters.push(sql`"_partition" = ${String(partition)}`);
  if (filters.length === 0) return dialect === "postgres" ? sql`TRUE` : sql`1`;
  return sql.join(
    filters.map((f) => sql`(${f})`),
    sql` AND `,
  );
};

/**
 * The columns a source selects, when its table rules any of them (E06, D40): the table's own,
 * with each ruled column behind its rule — `CASE WHEN rule THEN column ELSE NULL END`, aliased to
 * the column's own name and decoded as the column, so a caller the rule refuses reads `null`
 * there and every other column exactly as before. `undefined` selects the table as it is.
 *
 * Applied wherever a source is scoped, on both dialects. On the server that answers a query over
 * a caller's grant it keeps the value from ever crossing; on a device that syncs the partition the
 * value is already in its log, and the `null` is cosmetic — which D40 says, in those words.
 */
export const readColumns = (
  name: string,
  table: Table,
  scope: ReadScope,
): Readonly<Record<string, Column | SQL.Aliased>> | undefined => {
  const { schema, dialect, actor } = scope;
  const entry = schema.entries.find((e) => String(e.table.name) === name);
  const fields = entry?.fields;
  if (actor === undefined || entry === undefined || fields === undefined) return undefined;
  // SAFETY: rolesFor is typed by the manifest's own kinds; this entry's partition is one of them
  const roles = schema.rolesFor(entry.partition as never);
  /** The syncmesh column key a Drizzle column answers to, by its SQL name or its key. */
  const ruleOf = (jsKey: string, column: Column) =>
    Object.entries(fields).find(
      ([key]) => String(entry.table.columnNames[key] ?? key) === column.name || key === jsKey,
    )?.[1];
  return Object.fromEntries(
    Object.entries(getColumns(table)).map(([jsKey, column]): [string, Column | SQL.Aliased] => {
      const rule = ruleOf(jsKey, column);
      if (rule === undefined) return [jsKey, column];
      const allowed = fragment(compileField(entry.table, roles, rule, actor, { dialect }));
      const guarded = sql`CASE WHEN ${allowed} THEN ${column} ELSE NULL END`
        .mapWith(column)
        .as(column.name);
      return [jsKey, guarded];
    }),
  );
};

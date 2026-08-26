import type { Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { Compiled, SqlDialect } from "@syncmesh/storage";
import type { SQL } from "drizzle-orm";

import { compileRead } from "@syncmesh/storage";
import { sql } from "drizzle-orm";

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

export interface ReadScope {
  readonly schema: ValidatorSchema;
  readonly dialect: SqlDialect;
  readonly partition?: PartitionKey;
  readonly actor?: Principal;
}

/** A face's read scope from its deps, without carrying absent keys. */
export const readScope = (
  dialect: SqlDialect,
  deps: {
    readonly schema: ValidatorSchema;
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
    const ladder = schema.rolesFor(entry.partition as never);
    filters.push(fragment(compileRead(entry.table, ladder, entry.allow, actor, { dialect })));
  }
  if (partition !== undefined) filters.push(sql`"_partition" = ${String(partition)}`);
  if (filters.length === 0) return dialect === "postgres" ? sql`TRUE` : sql`1`;
  return sql.join(
    filters.map((f) => sql`(${f})`),
    sql` AND `,
  );
};

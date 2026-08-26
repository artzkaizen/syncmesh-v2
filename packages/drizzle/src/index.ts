import type { Principal, Validator, ValidatorSchema } from "@syncmesh/engine";
import type { Engine } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { SqlValue, SqliteDriver } from "@syncmesh/storage";
import type { SQLChunk, SQLWrapper, Table as DrizzleTable } from "drizzle-orm";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import { createWriter, type SqlWriteError } from "@syncmesh/client";
import { compileRead, type Compiled } from "@syncmesh/storage";
import { Column, SQL, Subquery, Table, getTableName, is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";

/**
 * Drizzle over a mesh (D20). The app reads and writes its tables with Drizzle; underneath, every
 * write statement is captured into one signed event, every read source carries the caller's
 * `read` rule, and a live query re-runs when a fold touches its tables. Drizzle executes through
 * its proxy driver over the mesh's own `SqliteDriver`, so there is one connection and one
 * ordering of transactions on it.
 */

export interface MeshDrizzleOptions {
  readonly engine: Engine;
  readonly validate: Validator;
  /** The connection the tables live on, with capture installed (`openStores` does both). */
  readonly driver: SqliteDriver;
  /** The manifest: which tables sync, their rules, the role ladders. */
  readonly schema: ValidatorSchema;
  /** The instance every write runs under and every read is confined to. */
  readonly partition?: PartitionKey;
  /**
   * Act as this principal: `read()` sources admit only rows their `read` rule admits, and a
   * write their rules deny is refused before COMMIT. The events stay the device's.
   */
  readonly as?: Principal;
}

export interface Written<T> {
  readonly eventId: string;
  readonly value: T;
}

export interface Live<T> {
  /** The rows as of the last run; `undefined` until `ready` resolves. */
  readonly data: () => readonly T[] | undefined;
  readonly ready: Promise<readonly T[]>;
  /** Fires once per fold batch that touched one of the query's tables, and only when the rows changed. */
  readonly subscribe: (listener: (rows: readonly T[]) => void) => () => void;
  readonly release: () => void;
}

/** What a live query needs from a Drizzle query: its SQL to find the tables, and to be awaited. */
export type Runnable<T> = SQLWrapper & PromiseLike<readonly T[]>;

/** Drizzle's remote callback hands values as it mapped them; the driver binds SQL scalars. */
const bind = (params: readonly unknown[]): readonly SqlValue[] =>
  params.map((p) => {
    if (p === undefined || p === null) return null;
    if (p === true) return 1;
    if (p === false) return 0;
    // SAFETY: Drizzle maps every other column value to a SQL scalar (string, number, bigint) or bytes before the driver sees it
    return p as SqlValue;
  });

/** `INSERT INTO "jobs"` / `UPDATE "jobs"` / `DELETE FROM "jobs"` → `jobs.insert`; anything else is a plain `sql.write`. */
const labelOf = (statement: string): string => {
  const match =
    /^\s*(insert|update|delete)\s+(?:into\s+|from\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(
      statement,
    );
  return match === null
    ? "sql.write"
    : `${match[2] ?? "sql"}.${(match[1] ?? "write").toLowerCase()}`;
};

const isWrite = (statement: string): boolean => /^\s*(insert|update|delete)\b/i.test(statement);

/** A compiled predicate as a Drizzle fragment: raw text between the `?`s, each param bound. */
const fragment = ({ sql: text, params }: Compiled): SQL => {
  const pieces = text.split("?");
  const chunks: SQL[] = [];
  pieces.forEach((piece, i) => {
    chunks.push(sql.raw(piece));
    if (i < params.length) chunks.push(sql`${params[i]}`);
  });
  return sql.join(chunks);
};

/** Every table a query's SQL mentions, through columns, subqueries and nested fragments. */
const tablesOf = (query: SQLWrapper): ReadonlySet<string> => {
  const names = new Set<string>();
  const walk = (chunk: SQLChunk): void => {
    if (is(chunk, Table)) names.add(getTableName(chunk));
    else if (is(chunk, Column)) names.add(getTableName(chunk.table));
    else if (is(chunk, Subquery)) walk(chunk._.sql);
    else if (is(chunk, SQL)) for (const inner of chunk.queryChunks) walk(inner);
  };
  walk(query.getSQL());
  return names;
};

export type MeshDb = SqliteRemoteDatabase<Record<string, never>>;

export function meshDrizzle(options: MeshDrizzleOptions) {
  const { engine, validate, driver, schema, partition, as: actor } = options;
  const entries = new Map(schema.entries.map((e) => [String(e.table.name), e]));
  const tables = schema.entries.map((e) => e.table);
  const writerDeps = { engine, validate, driver, tables, schema };
  if (actor !== undefined) Object.assign(writerDeps, { actor });
  const writer = createWriter(writerDeps);
  const writeOptions = partition === undefined ? {} : { partition };
  let inWrite = false;

  const execute = async (statement: string, params: readonly SqlValue[], method: string) => {
    if (method === "run") {
      await driver.run(statement, params);
      return { rows: [] };
    }
    const rows = await driver.all(statement, params);
    return { rows: method === "get" ? [...(rows[0] ?? [])] : rows.map((r) => [...r]) };
  };

  const db: MeshDb = drizzle(async (statement, params, method) => {
    const bound = bind(params);
    if (inWrite || !isWrite(statement)) return execute(statement, bound, method);
    // a statement on its own is its own transaction, hence its own event
    let result: Awaited<ReturnType<typeof execute>> = { rows: [] };
    const written = await writer(
      labelOf(statement),
      async () => {
        result = await execute(statement, bound, method);
      },
      writeOptions,
    );
    if (written.isErr()) throw written.error;
    return result;
  });

  /** The table as this principal may read it: a subquery with the `read` rule (and the pin) compiled in. */
  const read = <T extends DrizzleTable>(table: T) => {
    const name = getTableName(table);
    const entry = entries.get(name);
    const filters: SQL[] = [];
    if (actor !== undefined && entry !== undefined) {
      // SAFETY: rolesFor is typed by the manifest's own kinds; this entry's partition is one of them
      const ladder = schema.rolesFor(entry.partition as never);
      filters.push(fragment(compileRead(entry.table, ladder, entry.allow, actor)));
    }
    if (partition !== undefined) filters.push(sql`"_partition" = ${String(partition)}`);
    const where =
      filters.length === 0
        ? sql`1`
        : sql.join(
            filters.map((f) => sql`(${f})`),
            sql` AND `,
          );
    return db.select().from(table).where(where).as(name);
  };

  const write = async <T>(
    label: string,
    fn: (tx: MeshDb) => Promise<T>,
  ): Promise<Result<Written<T>, SqlWriteError>> => {
    let value: T | undefined;
    const receipt = await writer(
      label,
      async () => {
        inWrite = true;
        try {
          value = await fn(db);
        } finally {
          inWrite = false;
        }
      },
      writeOptions,
    );
    // SAFETY: fn ran to completion inside the capture when the receipt is Ok, so value was assigned
    return receipt.map((r) => ({ eventId: String(r.eventId), value: value as T }));
  };

  const live = <T>(query: Runnable<T>): Live<T> => {
    const touched = tablesOf(query);
    const listeners = new Set<(rows: readonly T[]) => void>();
    let current: readonly T[] | undefined;
    let last = "";
    const run = async (): Promise<readonly T[]> => {
      const rows = await query;
      const key = JSON.stringify(rows);
      const changed = key !== last;
      last = key;
      current = rows;
      if (changed) for (const listener of listeners) listener(rows);
      return rows;
    };
    const ready = run();
    const off = engine.onFoldBatch((batch) => {
      for (const table of batch.writeTables) {
        if (touched.has(String(table))) {
          void run();
          return;
        }
      }
    });
    return {
      data: () => current,
      ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      release: off,
    };
  };

  return { db, read, write, live };
}

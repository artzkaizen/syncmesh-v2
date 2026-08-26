import type { Principal, Validator, ValidatorSchema } from "@syncmesh/engine";
import type { Engine } from "@syncmesh/engine";
import type { Change, PartitionKey } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { SqlValue, SqliteDriver } from "@syncmesh/storage";
import type { SQLChunk, SQLWrapper, Table as DrizzleTable } from "drizzle-orm";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import { createWriter, type SqlWriteError, type TxReceipt } from "@syncmesh/storage";
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

const isWrite = (statement: string): boolean => /^\s*(insert|update|delete)\b/i.test(statement);

/** The label an event carries when nobody named it: what the transaction turned out to do. */
const derivedLabel = (changes: readonly Change[]): string =>
  changes.length === 0
    ? "sql.write"
    : [...new Set(changes.map((c) => `${String(c.table)}.${c.kind}`))].join("+");

/** Carries Drizzle's `rollback` out through the capture without it becoming an app error. */
class TxRollback extends Error {}

/**
 * The mesh's tagged error inside a rejected statement or transaction — Drizzle wraps proxy
 * failures, so `PolicyDenied` and friends ride the `cause` chain. `undefined` for anything else.
 */
export const taggedCause = (thrown: Error): (Error & { readonly _tag: string }) | undefined => {
  let current: unknown = thrown;
  while (current instanceof Error) {
    // SAFETY: reading an optional discriminant off an Error; absent on plain errors, the walk continues
    const tagged = current as Error & { readonly _tag?: string };
    if (tagged._tag !== undefined) {
      // SAFETY: _tag was just checked present — restated as required for the caller
      return tagged as Error & { readonly _tag: string };
    }
    current = current.cause;
  }
  return undefined;
};

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

  /** Drizzle's own `db.transaction()` drives this: `begin` opens a capture, `commit` settles it. */
  interface OpenTx {
    readonly done: () => void;
    readonly fail: (cause: unknown) => void;
    readonly settled: Promise<Result<TxReceipt, SqlWriteError>>;
  }
  let openTx: OpenTx | undefined;
  let txTail: Promise<unknown> = Promise.resolve();

  const begin = async (): Promise<void> => {
    await txTail; // one app transaction at a time on this handle
    let began!: () => void;
    let done!: () => void;
    let fail!: (cause: unknown) => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve, reject) => {
      done = resolve;
      fail = reject;
    });
    const settled = writer(
      derivedLabel,
      () => {
        began(); // the capture transaction is now open; statements may flow
        return gate;
      },
      writeOptions,
    );
    txTail = settled.then(
      () => undefined,
      () => undefined,
    );
    openTx = { done, fail, settled };
    await started;
  };

  const commit = async (): Promise<void> => {
    const tx = openTx;
    if (tx === undefined) return;
    openTx = undefined;
    tx.done();
    const written = await tx.settled;
    // a read-only transaction is fine — it just is not an event
    if (written.isErr() && written.error._tag !== "EmptyMutation") throw written.error;
  };

  const rollback = async (): Promise<void> => {
    const tx = openTx;
    if (tx === undefined) return;
    openTx = undefined;
    tx.fail(new TxRollback());
    await tx.settled; // the capture rolled back; Drizzle rethrows the app's own error
  };

  const execute = async (statement: string, params: readonly SqlValue[], method: string) => {
    if (method === "run") {
      await driver.run(statement, params);
      return { rows: [] };
    }
    const rows = await driver.all(statement, params);
    return { rows: method === "get" ? [...(rows[0] ?? [])] : rows.map((r) => [...r]) };
  };

  const db: MeshDb = drizzle(async (statement, params, method) => {
    const control = statement.trim().toLowerCase();
    if (control.startsWith("begin")) return begin().then(() => ({ rows: [] }));
    if (control === "commit") return commit().then(() => ({ rows: [] }));
    if (control === "rollback") return rollback().then(() => ({ rows: [] }));
    const bound = bind(params);
    if (openTx !== undefined || !isWrite(statement)) return execute(statement, bound, method);
    // a statement on its own is its own transaction, hence its own event
    let result: Awaited<ReturnType<typeof execute>> = { rows: [] };
    const written = await writer(
      derivedLabel,
      async () => {
        result = await execute(statement, bound, method);
      },
      writeOptions,
    );
    // a statement that changed nothing is not an event, and not an error either
    if (written.isErr() && written.error._tag !== "EmptyMutation") throw written.error;
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

  return { db, read, live };
}

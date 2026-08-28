import type { SqlRow, SqlValue, SqliteDriver } from "@syncmesh/storage";

/**
 * A value the Durable Object's SQLite takes and hands back. Narrower than {@link SqlValue} in
 * three ways that each need converting: no boolean, no `Date`, and bytes are an `ArrayBuffer`
 * rather than a `Uint8Array`.
 */
export type DurableSqlValue = ArrayBuffer | string | number | null;

/**
 * The slice of `ctx.storage.sql` a room needs. Structural on purpose: naming
 * `@cloudflare/workers-types` in a runtime import would make this package unloadable — and so
 * untestable — anywhere but the platform, which is the one place `wrangler` is required to run it.
 */
export interface DurableSqlStorage {
  readonly exec: (
    query: string,
    ...bindings: DurableSqlValue[]
  ) => { readonly raw: () => IterableIterator<DurableSqlValue[]> };
}

/** Copied rather than handed over: `bytes.buffer` is often a window into a larger, shared one. */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

const toDurable = (value: SqlValue): DurableSqlValue => {
  if (value instanceof Uint8Array) return toArrayBuffer(value);
  if (value instanceof Date) return value.getTime();
  /* oxlint-disable anti-slop/no-runtime-typeof -- the host's own SQL boundary: these arrive untyped from the platform */
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "bigint") return value;
  /* oxlint-enable anti-slop/no-runtime-typeof */
  const asNumber = Number(value);
  // the store binds branded numbers today; a bigint past 2^53 would arrive in the row as a
  // different integer, so it stops here rather than in a signature that no longer verifies
  if (!Number.isSafeInteger(asNumber)) throw new RangeError(`${value} does not fit a DO SQL bind`);
  return asNumber;
};

/** A blob comes back as an `ArrayBuffer`; every store above this checks `instanceof Uint8Array`. */
const fromDurable = (value: DurableSqlValue): SqlValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

/**
 * `ctx.storage.sql` as the driver `@syncmesh/storage` runs its statements through, so a Durable
 * Object's room log is the same SQLite event store every other peer keeps (RFC-0004).
 *
 * No `transaction`: `sql.exec` refuses `BEGIN`, and the only transaction the platform offers —
 * `ctx.storage.transactionSync` — must finish before it returns, which an async port cannot
 * promise. What is left is the object's own turn: every write between two real awaits commits
 * together, and a turn that throws commits none of it. Because `exec` is synchronous here, a
 * batch the store awaits statement by statement still lands in one turn, which is the atomicity
 * `appendBatch` asks for. What it does **not** cover is a failure the store catches and returns
 * as an `Err`: the turn survives, so the statements before the failure survive with it.
 *
 * No `close` either: the storage outlives every object that opens it.
 *
 * @example
 * const store = (await sqliteEventStore(doSqliteDriver(ctx.storage.sql))).unwrap();
 */
/**
 * Every row of one statement, read inside the turn that opened the cursor: a cursor's snapshot
 * is only guaranteed before the next await, and a statement whose cursor is never stepped is a
 * statement that may not have run.
 */
const rowsOf = (
  sql: DurableSqlStorage,
  statement: string,
  params: readonly SqlValue[],
): SqlRow[] => {
  const rows: SqlRow[] = [];
  for (const row of sql.exec(statement, ...params.map(toDurable)).raw())
    rows.push(row.map(fromDurable));
  return rows;
};

/**
 * `ctx.storage.sql` as the driver `@syncmesh/storage` runs its statements through, so a Durable
 * Object's room log is the same SQLite event store every other peer keeps (RFC-0004).
 *
 * No `transaction`: `sql.exec` refuses `BEGIN`, and the only transaction the platform offers —
 * `ctx.storage.transactionSync` — must finish before it returns, which an async port cannot
 * promise. What is left is the object's own turn: every write between two real awaits commits
 * together, and a turn that throws commits none of it. Because `exec` is synchronous here, a
 * batch the store awaits statement by statement still lands in one turn, which is the atomicity
 * `appendBatch` asks for. What it does **not** cover is a failure the store catches and returns
 * as an `Err`: the turn survives, so the statements before the failure survive with it.
 *
 * No `close` either: the storage outlives every object that opens it.
 *
 * @example
 * const store = (await sqliteEventStore(doSqliteDriver(ctx.storage.sql))).unwrap();
 */
export function doSqliteDriver(sql: DurableSqlStorage): SqliteDriver {
  return {
    dialect: "sqlite",
    // async so a binding this driver refuses arrives as a rejection, which is the port's one
    // failure channel — a synchronous throw would escape the store's `attempt` wrapper
    run: async (statement, params = []) => {
      rowsOf(sql, statement, params);
    },
    all: async (query, params = []) => rowsOf(sql, query, params),
  };
}

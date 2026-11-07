import type { SqlRow, SqlValue, SqliteDriver } from "@syncmesh/storage";

/** What Rivet's SQLite binds: text, numbers, bigints, bytes and NULL — no boolean, no `Date`. */
export type RivetSqlValue = string | number | bigint | Uint8Array | null;

/** One row as `execute` answers it: column name to value, a blob possibly as an `ArrayBuffer`. */
export type RivetSqlRow = Readonly<Record<string, RivetSqlValue | ArrayBuffer>>;

/**
 * The slice of a Rivet actor's `c.db` (the raw `db()` provider) a room needs. Structural on
 * purpose, as the Durable Object's is: naming `rivetkit` in a runtime import would pull its
 * native engine into every process that loads this package, and make it untestable anywhere the
 * engine is not.
 *
 * `execute` answers **objects** keyed by column name, not positional rows. The driver below reads
 * a row's values in column order, which is the order SQLite reports them in; a statement that
 * selects two columns under one name would collapse to one key, and nothing in the stores does.
 */
export interface RivetDatabase {
  readonly execute: (query: string, ...args: RivetSqlValue[]) => Promise<readonly RivetSqlRow[]>;
  /** Runs `callback` in one SQLite transaction; the handle it is given is the one to write through. */
  readonly transaction?: <T>(callback: (tx: RivetDatabase) => Promise<T>) => Promise<T>;
}

const toRivet = (value: SqlValue): RivetSqlValue => {
  if (value instanceof Date) return value.getTime();
  /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- the host's own SQL boundary: values arrive untyped */
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
};

/** A blob may come back as an `ArrayBuffer`; every store above this checks `instanceof Uint8Array`. */
const fromRivet = (value: RivetSqlValue | ArrayBuffer): SqlValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value;

/**
 * A Rivet actor's SQLite as the driver `@syncmesh/storage` runs its statements through, so the
 * actor's room log is the same SQLite event store every other peer keeps (RFC-0004).
 *
 * **`log: "inline"`**, as on a Durable Object: the log's tables sit beside the state's in the
 * actor's one database under the `syncmesh_` prefix rather than in an attached second file, which
 * an actor's storage does not offer.
 *
 * `transaction` is the actor's own, when `c.db` has one: every statement the callback runs goes
 * through the transaction's handle, so an append and the rows it materialises land together or
 * not at all. While it is open, *any* statement on this driver goes through that handle, so a
 * caller that shares the driver with a store must not run statements during the store's
 * transaction. Within a relay room that holds because the room serialises its appends and blob
 * puts; a second, unserialised user of the same driver would land inside the open transaction.
 *
 * No `close`: the actor's storage is the platform's, and outlives every instance that opens it.
 *
 * @example
 * const store = (await sqliteEventStore(rivetSqlDriver(c.db))).unwrap();
 */
export function rivetSqlDriver(db: RivetDatabase): SqliteDriver {
  /** The open transaction's handle while one is running; the actor's database otherwise. */
  let current = db;
  const rows = async (statement: string, params: readonly SqlValue[]): Promise<SqlRow[]> => {
    const answered = await current.execute(statement, ...params.map(toRivet));
    return answered.map((row) => Object.values(row).map(fromRivet));
  };
  const driver: SqliteDriver = {
    dialect: "sqlite",
    log: "inline",
    run: async (statement, params = []) => {
      await rows(statement, params);
    },
    all: (query, params = []) => rows(query, params),
  };
  const { transaction } = db;
  if (transaction === undefined) return driver;
  return {
    ...driver,
    transaction: (fn) =>
      transaction(async (tx) => {
        current = tx;
        try {
          return await fn();
        } finally {
          current = db;
        }
      }),
  };
}

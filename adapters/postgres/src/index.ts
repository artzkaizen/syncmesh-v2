import type { PostgresDriver, SqlRow, SqlValue } from "@syncmesh/storage";

/**
 * What this adapter needs from a postgres.js client — the `sql` an app already hands to
 * `drizzle-orm/postgres-js`, so the mesh's log, its state and the app's queries share one pool
 * and, inside `transaction`, one connection. Structural on purpose: no dependency on the
 * package, only on the four calls.
 */
export interface PostgresQuerier {
  unsafe(
    query: string,
    params?: unknown[],
  ): PromiseLike<unknown> & { values(): PromiseLike<readonly (readonly unknown[])[]> };
}

export interface PostgresClient extends PostgresQuerier {
  /** Runs `fn` on one connection inside BEGIN/COMMIT; the handle it passes cannot nest another. */
  begin<T>(fn: (tx: PostgresQuerier) => Promise<T>): Promise<T>;
  end?(): Promise<void>;
}

/** The subset of a PGlite instance the driver uses: Postgres in-process, for tests and small tools. */
export interface PgliteClient {
  query(
    query: string,
    params?: unknown[],
    options?: { rowMode: "array" },
  ): Promise<{ rows: unknown[] }>;
  transaction<T>(fn: (tx: PgliteTransaction) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export interface PgliteTransaction {
  query: PgliteClient["query"];
}

/** postgres.js takes `Buffer` for `bytea`; everything else binds as it is. */
const bind = (params: readonly SqlValue[]): unknown[] =>
  params.map((p) => (p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p));

// SAFETY: a Postgres row is text, integers (number, or a decimal string for bigint), doubles, booleans, timestamps as Date, bytea as Buffer and NULL — every one a SqlValue
const asRows = (rows: readonly (readonly unknown[])[]): readonly SqlRow[] =>
  rows as readonly SqlRow[];

/**
 * A `SqlDriver` over a postgres.js client. `transaction` runs its body on one connection from
 * the pool through `sql.begin`; the storage layer serializes transactions per driver, so a
 * `run`/`all` issued while one is open joins it — the same single-connection semantics the
 * device's SQLite driver has.
 *
 * @example
 * const sql = postgres(process.env.DATABASE_URL!);
 * const stores = (await openStores(postgresDriver(sql), { tables })).unwrap();
 */
export function postgresDriver(sql: PostgresClient): PostgresDriver {
  let current: PostgresQuerier = sql;
  return {
    dialect: "postgres",
    run: async (query, params = []) => {
      await current.unsafe(query, bind(params));
    },
    all: async (query, params = []) => asRows(await current.unsafe(query, bind(params)).values()),
    transaction: (fn) =>
      sql.begin(async (tx) => {
        current = tx;
        try {
          return await fn();
        } finally {
          current = sql;
        }
      }),
    close: () => sql.end?.() ?? Promise.resolve(),
  };
}

/**
 * A `SqlDriver` over PGlite: the same Postgres dialect with no server — what this adapter's own
 * contract suite runs on, and enough for a single-process tool.
 *
 * @example
 * const stores = (await openStores(pgliteDriver(new PGlite()))).unwrap();
 */
export function pgliteDriver(db: PgliteClient): PostgresDriver {
  let current: { readonly query: PgliteClient["query"] } = db;
  const rows = async (query: string, params: readonly SqlValue[]) => {
    const result = await current.query(query, [...params], { rowMode: "array" });
    // SAFETY: rowMode "array" makes every row a positional array
    return asRows(result.rows as readonly (readonly unknown[])[]);
  };
  return {
    dialect: "postgres",
    run: async (query, params = []) => {
      await rows(query, params);
    },
    all: (query, params = []) => rows(query, params),
    transaction: (fn) =>
      db.transaction(async (tx) => {
        current = tx;
        try {
          return await fn();
        } finally {
          current = db;
        }
      }),
    close: () => db.close?.() ?? Promise.resolve(),
  };
}

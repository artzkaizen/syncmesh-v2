import type { PostgresDriver, SqlRow, SqlValue } from "@syncmesh/storage";

import { Temporal } from "@syncmesh/temporal";

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
  ): PromiseLike<unknown> & { values(): PromiseLike<PostgresValues> };
}

/** Rows as postgres.js answers `.values()`: positional cells, and each column's type. */
export type PostgresValues = readonly (readonly unknown[])[] & {
  readonly columns?: readonly { readonly type: number }[];
};

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

/**
 * Params as postgres.js sends them whoever set its serializers: `bytea` as a `Buffer`, and a
 * timestamp as its ISO text, which a client Drizzle wrapped (it sends a time as it is given)
 * sends as well as postgres.js's own serializer does. Everything else binds as it is.
 */
const bind = (params: readonly SqlValue[]): unknown[] =>
  params.map((p) =>
    p instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(p.getTime()).toString()
      : p instanceof Uint8Array && !Buffer.isBuffer(p)
        ? Buffer.from(p)
        : p,
  );

// SAFETY: a Postgres row is text, integers (number, or a decimal string for bigint), doubles, booleans, timestamps as Date, bytea as Buffer and NULL — every one a SqlValue
const asRows = (rows: readonly (readonly unknown[])[]): readonly SqlRow[] =>
  rows as readonly SqlRow[];

/** `timestamptz`'s type oid: the only time type the mesh's tables hold. */
const TIMESTAMPTZ = 1184;

/**
 * Rows with each `timestamptz` a `Date`, whoever set the client's parsers: postgres.js parses
 * one into a `Date`, and a client Drizzle wrapped first hands back the text Postgres sent.
 */
const withDates = (rows: PostgresValues): readonly SqlRow[] => {
  const times = (rows.columns ?? []).flatMap((c, i) => (c.type === TIMESTAMPTZ ? [i] : []));
  if (times.length === 0) return asRows(rows);
  return asRows(
    rows.map((row) => {
      const cells = [...row];
      for (const i of times) {
        const cell = cells[i];
        /* oxlint-disable-next-line anti-slop/no-runtime-typeof -- a cell is whatever the client's parser made of it: this is the parse */
        if (typeof cell === "string")
          cells[i] = new Date(Temporal.Instant.from(cell).epochMilliseconds);
      }
      return cells;
    }),
  );
};

/**
 * A `SqlDriver` over a postgres.js client. `transaction` runs its body on one connection from
 * the pool through `sql.begin`; the storage layer serializes transactions per driver, so a
 * `run`/`all` issued while one is open joins it — the same single-connection semantics the
 * device's SQLite driver has.
 *
 * The client may be one Drizzle wraps too, before or after this: what Drizzle changes on it (how
 * `json` is sent, how a `timestamptz` is read) changes nothing here.
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
    all: async (query, params = []) =>
      withDates(await current.unsafe(query, bind(params)).values()),
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

export type { Lsn } from "./lsn.js";
export { InvalidLsn, lsnText, lsnWatermark, parseLsn, parseLsnWatermark } from "./lsn.js";
export type {
  OldTuple,
  PgOutputMessage,
  Relation,
  RelationColumn,
  ReplicaIdentity,
  ServerFrame,
  Tuple,
  TupleCell,
} from "./pgoutput.js";
export { MalformedMessage, decodePgOutput, parseServerFrame, standbyStatus } from "./pgoutput.js";
export { cellValue } from "./values.js";
export type { LagAlarm, PostgresChangeSource, PostgresChangeSourceOptions } from "./replication.js";
export { postgresChangeSource } from "./replication.js";
export type { ReplicationClient, ReplicationStream } from "./link.js";
export type { SlotStatus } from "./slot.js";
export type { PostgresSourceError } from "./replication-errors.js";
export {
  PartialKeyChange,
  PublicationMissing,
  ReplicationFailed,
  SlotBusy,
  SlotLost,
  SlotMismatch,
  UnkeyedChange,
} from "./replication-errors.js";

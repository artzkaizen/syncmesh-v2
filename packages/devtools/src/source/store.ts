import type { Mesh } from "@syncmesh/client";
import type { Result as ResultType } from "@syncmesh/result";

import { Result } from "@syncmesh/result";

import type { DevtoolsStore, SqlRow } from "../contract.js";

import { QueryFailed } from "../contract.js";

/**
 * What the database can be asked about itself, without ever being asked what it holds.
 *
 * Every statement here counts, groups or measures. None of them selects `core`, and the one that
 * comes near it selects `length(core)` — those are the exact bytes an author signed, and a devtool
 * is owed the weight of the log and not a word of its contents. The same line separates this from
 * the app's own tables: a row count is a fact about storage, a row is somebody's data.
 *
 * Two dialects and two spellings of one namespace: `syncmesh_events` in the single file SQLite
 * has, `syncmesh.events` in the real schema Postgres gets (RFC-0022). Nothing on `Mesh` says
 * which one is underneath (`query` is the driver's
 * `all` and nothing else), so this asks: it runs the SQLite-shaped count once and, if the database
 * has never heard of that table, runs the Postgres-shaped one. The answer is remembered.
 */

interface StoreSql {
  readonly log: string;
  readonly tables: string;
  readonly floors: string;
  readonly writes: string;
  readonly version: string;
}

const SQLITE = {
  log: "SELECT peer, local, COUNT(*), MAX(seq), SUM(length(core)) FROM syncmesh_events GROUP BY peer, local",
  tables: "SELECT tbl, COUNT(*) FROM syncmesh_state_rows GROUP BY tbl",
  floors: "SELECT peer, local, seq FROM syncmesh_compaction",
  writes: "SELECT status, COUNT(*) FROM syncmesh_operations GROUP BY status",
  version: "PRAGMA user_version",
} satisfies StoreSql;

const POSTGRES = {
  log: "SELECT peer, local, COUNT(*), MAX(seq), SUM(length(core)) FROM syncmesh.events GROUP BY peer, local",
  tables: "SELECT tbl, COUNT(*) FROM syncmesh.state_rows GROUP BY tbl",
  floors: "SELECT peer, local, seq FROM syncmesh.compaction",
  writes: "SELECT status, COUNT(*) FROM syncmesh.operations GROUP BY status",
  version: "SELECT value FROM syncmesh.meta WHERE key = 'version'",
} satisfies StoreSql;

/** Which set of names to use, when the host already knows and would rather not pay for the probe. */
export type StoreDialect = "sqlite" | "postgres";

/**
 * A counted cell as a number.
 *
 * Postgres hands `COUNT(*)` back as a bigint, and a binding may present that as a string; SQLite
 * hands back a number. `Number` reads all three, and anything it cannot read — a NULL `SUM` over
 * no rows, a column that turned out to be bytes — becomes zero rather than a `NaN` that would
 * spread through every total on the panel.
 */
const counted = (cell: SqlRow[number] | undefined): number => {
  const value = Number(cell ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const storeOf = (
  log: readonly SqlRow[],
  tables: readonly SqlRow[],
  floors: readonly SqlRow[],
  writes: readonly SqlRow[],
  version: readonly SqlRow[],
): DevtoolsStore => ({
  version: version[0]?.[0] === undefined ? undefined : counted(version[0][0]),
  log: log.map((row) => ({
    peer: String(row[0]),
    local: counted(row[1]) === 1,
    events: counted(row[2]),
    topSeq: counted(row[3]),
    bytes: counted(row[4]),
  })),
  tables: tables.map((row) => ({ table: String(row[0]), rows: counted(row[1]) })),
  floors: floors.map((row) => ({
    peer: String(row[0]),
    local: counted(row[1]) === 1,
    seq: counted(row[2]),
  })),
  writes: writes.map((row) => ({ status: String(row[0]), count: counted(row[1]) })),
});

export type StoreReader = () => Promise<ResultType<DevtoolsStore, QueryFailed>>;

export function createStoreReader(
  query: NonNullable<Mesh["query"]>,
  hint?: StoreDialect,
): StoreReader {
  const ask = (sql: string) =>
    Result.tryPromise({
      try: () => query(sql),
      catch: (cause: unknown) => new QueryFailed({ sql, cause }),
    });

  /**
   * A statement whose failure is not the panel's failure.
   *
   * The write ledger, the compaction table and the migration marker are each absent from some
   * legitimate mesh, and a `COUNT(*)` that could not run is not a reason to blank a panel whose
   * other four numbers are fine. The log count is the exception and stays hard: without it there
   * is nothing here worth drawing.
   */
  const soft = async (sql: string): Promise<readonly SqlRow[]> => (await ask(sql)).unwrapOr([]);

  let chosen: StoreSql | undefined =
    hint === undefined ? undefined : hint === "postgres" ? POSTGRES : SQLITE;

  const resolve = async (): Promise<ResultType<StoreSql, QueryFailed>> => {
    if (chosen !== undefined) return Result.ok(chosen);
    const sqlite = await ask(SQLITE.log);
    if (sqlite.isOk()) {
      chosen = SQLITE;
      return Result.ok(SQLITE);
    }
    // the second shape, and its failure is the one worth reporting: a database that is neither
    // has told us so twice, and the Postgres message is the more specific of the two
    const postgres = await ask(POSTGRES.log);
    if (postgres.isErr()) return postgres;
    chosen = POSTGRES;
    return Result.ok(POSTGRES);
  };

  return async () => {
    const sql = await resolve();
    if (sql.isErr()) return sql;
    const log = await ask(sql.value.log);
    if (log.isErr()) return log;
    const [tables, floors, writes, version] = await Promise.all([
      soft(sql.value.tables),
      soft(sql.value.floors),
      soft(sql.value.writes),
      soft(sql.value.version),
    ]);
    return Result.ok(storeOf(log.value, tables, floors, writes, version));
  };
}

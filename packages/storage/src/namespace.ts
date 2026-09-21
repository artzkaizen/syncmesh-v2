import type { LogPlacement, SqlDialect, SqlDriver } from "./driver.js";

/**
 * How the mesh's own tables are named, in each of the three places they can live.
 *
 * A leaf on purpose: the dialect modules build their statements out of these, and `dialect.ts`
 * imports those modules back, so anything runtime here would be a cycle — and was one, caught as
 * `Cannot access 'sqliteLogIndex' before initialization` at the first test that opened a store.
 * Nothing in this file imports anything of ours but the driver's types.
 */

/**
 * Where the log lives, and therefore how its tables are spelled.
 *
 * SQLite has no schemas, so the log is a **second file attached under the name `syncmesh`** —
 * which is the one mechanism that gives real `syncmesh.events` there, and the reason the durable
 * half can be backed up, vacuumed and reasoned about on its own (RFC-0022). Postgres has one
 * database and one `CREATE SCHEMA syncmesh`, so both halves already live under that name. A
 * runtime whose SQL surface has no `ATTACH` — a Durable Object — falls back to the prefix the
 * derived half already uses, and gets the namespace without the second file.
 *
 * The derived half is whatever the connection opened as `main`, because the app's own tables are
 * there and must stay unqualified: every Drizzle query in every procedure names them directly,
 * and a trigger cannot write across an attached database anyway. So the engine's derived tables
 * share `main` with the app's and take a `syncmesh_` prefix to stay out of their way.
 */
export const ATTACHED_LOG = "syncmesh";

/**
 * A durable table: the log's own. `syncmesh.events` on both dialects — an attached database on
 * SQLite, a schema on Postgres — because the durable half is the half that is named the same
 * everywhere, and a reader should not have to know which mechanism is underneath.
 */
export const logTable = (name: string, log: LogPlacement = "attached"): string =>
  log === "inline" ? `${ATTACHED_LOG}_${name}` : `${ATTACHED_LOG}.${name}`;

/**
 * `CREATE INDEX` over a log table, which is the one statement the two SQLite spellings cannot
 * share a shape for.
 *
 * An index must live in the same database as its table, and SQLite spells that by **qualifying
 * the index name and leaving the table bare** — `CREATE INDEX syncmesh.events_hlc ON events`.
 * Naming both is a syntax error, and there is no `ALTER INDEX` to fix one after the fact. In one
 * database there is nothing to qualify and both names are plain.
 *
 * A function rather than two strings per index because getting it wrong fails at migration time
 * on one runtime only, which is the worst place for a difference this small to live.
 */
export const sqliteLogIndex =
  (log: LogPlacement) =>
  (name: string, table: string, columns: string, options: { unique?: boolean } = {}): string => {
    const unique = options.unique === true ? "UNIQUE " : "";
    return log === "inline"
      ? `CREATE ${unique}INDEX IF NOT EXISTS ${ATTACHED_LOG}_${name} ON ${ATTACHED_LOG}_${table} ${columns}`
      : `CREATE ${unique}INDEX IF NOT EXISTS ${ATTACHED_LOG}.${name} ON ${table} ${columns}`;
  };

/**
 * Which spelling this connection's log takes.
 *
 * Postgres has a real schema, so the question does not arise and the answer is the qualified
 * name either way. On SQLite it is the driver's to answer, because it is the driver that knows
 * whether it was able to attach a second database at all — see {@link SqlDriver.log}.
 */
export const placementOf = (driver: Pick<SqlDriver, "dialect" | "log">): LogPlacement =>
  driver.dialect !== "postgres" && driver.log === "inline" ? "inline" : "attached";

/**
 * A derived table: rebuilt by folding the log, up to a compaction floor (see `refoldable`).
 *
 * `syncmesh.state_rows` on Postgres, where one schema holds both halves; `syncmesh_state_rows` on
 * SQLite, where this half shares `main` with the app's own tables and a prefix is the only
 * separator available.
 */
export const stateTable = (name: string, dialect: SqlDialect = "sqlite"): string =>
  dialect === "postgres" ? `${ATTACHED_LOG}.${name}` : `${ATTACHED_LOG}_${name}`;

/**
 * Making the namespace, for a dialect that has one to make.
 *
 * Every store here creates its own tables and several are opened directly — a blob store without
 * an event store, capture without either — so "the schema exists" cannot be something only
 * `migrate` arranges. Each of them runs this first instead, and on SQLite it is nothing.
 *
 * The grants restore exactly the reach these tables had in `public` and add none: a schema is a
 * permission boundary that `public` was not, and a role that could read them yesterday would
 * otherwise fail to resolve their names today. Row-level security is what guards the app's data
 * (`rls.ts`), and permission to *name* a table is not permission to read a row of it.
 */
export const namespaceDdl = (dialect: SqlDialect): readonly string[] =>
  dialect === "postgres"
    ? [
        `CREATE SCHEMA IF NOT EXISTS syncmesh`,
        `GRANT USAGE ON SCHEMA syncmesh TO PUBLIC`,
        `GRANT ALL ON ALL TABLES IN SCHEMA syncmesh TO PUBLIC`,
        `GRANT USAGE ON ALL SEQUENCES IN SCHEMA syncmesh TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA syncmesh GRANT ALL ON TABLES TO PUBLIC`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA syncmesh GRANT USAGE ON SEQUENCES TO PUBLIC`,
      ]
    : [];

/**
 * Which half of the store each engine table belongs to (RFC-0022).
 *
 * **The durable half cannot be recomputed; the derived half can** — up to a compaction floor, and
 * `refoldable` is the runtime form of that caveat. Written down as data rather than prose because
 * three separate things need to agree on it and each of them drifts on its own otherwise: what a
 * backup has to include, what may be discarded and refolded, and which file each table lands in
 * if the two are ever separated.
 *
 * Splitting them into two SQLite files **is** done on every runtime that can `ATTACH`: the log is
 * its own file and the derived half is `main`. Each file carries its own `PRAGMA user_version`,
 * so the two ladders never have to know when the other moved — which is the thing that made the
 * split tractable, and the opposite of what this paragraph used to predict.
 *
 * A runtime that cannot attach keeps both halves in one database and spells the log
 * `syncmesh_events`. The line below still holds there: it says which tables a backup must include
 * and which may be discarded and refolded, and neither of those is a question about files.
 */
export const LOG_TABLES = [
  "events",
  "compaction",
  "scope",
  "operations",
  "receipts",
  "grants",
  "blobs",
  "meta",
] as const;

/** The other half: a pure function of {@link LOG_TABLES}, while `refoldable` says so. */
export const STATE_TABLES = [
  "state_rows",
  "cursors",
  "row_sync",
  "acked",
  "changes",
  "capture",
] as const;

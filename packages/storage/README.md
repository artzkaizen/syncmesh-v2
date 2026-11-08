# @syncmesh/storage

The `SqlDriver` port, the one SQLite event store every driver runs, the state store beside it,
and `driverTests` — the suite that decides whether something is a driver.

## Bindings that ship with a runtime have an adapter

`@syncmesh/sqlite-node` (`node:sqlite`), `@syncmesh/sqlite-bun` (`bun:sqlite`) and
`@syncmesh/cloudflare-do` (a Durable Object's `ctx.storage.sql`) are the three, and there will
not be a fourth. Each is versioned by the runtime that carries it, so there is no version matrix
underneath it and nothing to release when the binding moves. `adapters/` names _bindings that
come free with a runtime_, not _platforms syncmesh supports_.

## A binding you install is eight lines of your own

`expo-sqlite`, `@op-engineering/op-sqlite` and `better-sqlite3` get no package — a wrapper would
owe you a dependency, a version matrix and a release per release of theirs, and save you this.
`sqliteDriver` already owns everything that is the same in every SQLite driver: booleans and
`Date` bound down to the integers SQLite stores, `BEGIN IMMEDIATE` around `transaction`, the
dialect tag, the promises the port returns. What is left is the four calls your binding spells
its own way.

```ts
import { openStores, sqliteDriver } from "@syncmesh/storage";
import { openDatabaseSync } from "expo-sqlite";

export function expoDriver(file: string) {
  const db = openDatabaseSync(file);
  db.execSync("PRAGMA journal_mode = WAL");
  db.execSync("PRAGMA synchronous = NORMAL");

  return sqliteDriver({
    exec: (sql) => db.execSync(sql),
    run: (sql, params) => void db.runSync(sql, [...params]),
    all: (sql, params) => db.getAllSync(sql, [...params]).map(Object.values),
    close: () => db.closeSync(),
  });
}

const stores = (await openStores(expoDriver("app.db"), { tables })).unwrap();
```

`stores` is what the client takes as its `stores` option; the log, the state and the app's
tables then live in that one file exactly as they do on Node and Bun.

A binding whose calls return promises — a browser's OPFS worker, a remote database — cannot be a
`SqliteBinding` at all. Write the `SqlDriver` yourself and call `bindSqlite(params)` for the
conversion; the rest of the port is four methods.

## Certify it

```ts
import { driverTests } from "@syncmesh/storage/driver-tests";
import { test } from "bun:test";

for (const c of driverTests((name) => Promise.resolve(expoDriver(`${name}.db`))))
  test(c.name, c.run);
```

The suite the three adapters run, shipped for yours: the event log, the state store, compaction,
change capture, the app's tables and the compiled read filter. Reopening the same `name` must
reach the same database, because half the cases close and reopen it. It passes, or the driver
is not one.

## Serving `sync: "window"` reads from Postgres (D43)

A `sync: "window"` table stays on the server, and `servedReads` (in `@syncmesh/orpc`) runs a
device's `query` procedure against it, a page at a time. Postgres bounds those reads, not only
the procedure: each one runs as a **read role** that may `SELECT` the served tables and nothing
else, with each table's read rule as its row-level policy. Two pieces put that in place:
`servedReadDdl` in a migration, and a login of its own for the reads.

**Why a login of its own.** A transaction can always go back to the role it logged in as
(`set_config('role', 'none', true)`, inside any statement). If served reads ran on the app's own
connection, a `sql` fragment could switch back to the app and read what the app reads. So the
reads connect as a login that holds the read role and nothing else; going back to it gains
nothing. The DDL refuses a login that owns a table, is granted one, or holds another role, and
`enter` checks again on every read: a login with the privileges of any role besides itself and
the read role (`pg_read_all_data`, or an app role granted to the read role), one that owns or
was granted anything in the database, or a read role granted a table the DDL does not serve, is
refused before a statement of the handler's runs.

**Who the reader is.** The policies do not read a setting, since a fragment can set any setting
too. Each served read calls `syncmesh_served.enter(…)` first, which writes the principal into an
unlogged table, then turns the transaction read-only. The row is never committed, only that
transaction sees it, and once the transaction is read-only nothing can write another.

### Once, as a role that may create roles

```sql
CREATE ROLE syncmesh_reads LOGIN PASSWORD '…';
-- only when the migrator below may not create roles (then pass createRole: false):
CREATE ROLE syncmesh_reader NOLOGIN;
GRANT syncmesh_reader TO syncmesh_reads;
```

### In a migration, as the tables' owner

Run it after every change to the served tables or their rules. It is idempotent: a table that
lost its rule or its `sync: "window"` loses the role's grant and policies.

```ts
import { servedReadDdl } from "@syncmesh/storage";
import { schema } from "./schema";

export async function up(sql: postgres.Sql) {
  for (const statement of servedReadDdl(schema, {
    role: "syncmesh_reader",
    grantTo: "syncmesh_reads",
  }))
    await sql.unsafe(statement);
}
```

The migrator needs `CREATE` on the database (for the `syncmesh_served` schema) and must own the
served tables (for their policies). A migrator without `CREATEROLE` is told which statement to
have someone else run.

The rule's policy is restrictive, so a policy of yours that is open to `PUBLIC` does not widen
what the read role sees. A table that had no row-level security gets an open policy for every
other role, so turning it on changes nothing for the app. `rlsDdl` (`createMesh({ rls: true })`)
drops that open policy when it installs the app's own, so the two run in either order.

A served table with a column rule (`fields`) is read through a view the DDL makes in
`syncmesh_served` (`"syncmesh_served"."read:mail"` for `mail`), with `security_barrier`: its rows
are the ones the read rule admits, and each ruled column reads `NULL` where its rule refuses.
The read role may `SELECT` the view, and of the table only the columns no rule hides, so a `sql`
fragment that names a hidden column of the table is `permission denied`. The DDL rebuilds the
view from the table's columns each time it runs, so run it after a column changes, and drops it
when the table loses its last ruled column.

### In the server

```ts
import { servedReads } from "@syncmesh/orpc";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// the app's own Drizzle stays as it is; the reads get a pool of their own
const reads = drizzle({ client: postgres(process.env.SYNCMESH_READS_URL) });

const source = servedReads({
  router,
  schema,
  db: reads,
  principal, // from your auth, for this socket
  self,
  onCommit: feed.onCommit,
  onFeed: feed.onFeed,
  readRole: "syncmesh_reader",
});
```

Each read is a transaction that is rolled back. A statement runs at most `timeout` (5 seconds by
default), and a pass of N reads that is still running after `timeout × (N + 1)` is cancelled with
postgres.js's `query.cancel()`, over a socket of its own, so a pool of one or a full pool still
cancels it. `db` must be a postgres.js Drizzle (`drizzle-orm/postgres-js`). Each read ends with a
rollback to before the reads, so what one read set or broke the next does not inherit. A table the role
may not read, or that does not exist, is retried for `grace` (1 minute by default, for a deploy
whose migration has not run yet), then refused. A handler's `db` is for its read: one it keeps
is refused once the read's rows are in.

**What a read costs the database.** Writing the principal's row assigns a transaction id: one per
pass of reads (a socket's re-reads share one pass), and one dead row in the unlogged
`syncmesh_served.principal` for autovacuum. So served reads need a primary, not a hot standby,
and their login must not have `default_transaction_read_only = on`.

### What the read role can still do

- **Run a `SECURITY DEFINER` function.** It runs as its owner, past every policy. Postgres grants
  `EXECUTE` to `PUBLIC` by default, and the DDL cannot take that back from one role, so it raises
  a `WARNING` naming each such function the role can run. Revoke `EXECUTE` from `PUBLIC` and grant
  it to the roles that call it.
- **Read a table granted to `PUBLIC`.** Every role holds what `PUBLIC` holds, and no role can give
  it back, so the DDL raises a `WARNING` naming each table or view the role can read that the
  manifest does not serve. Revoke `SELECT` from `PUBLIC` and grant it to the roles that read it.
  The DDL looks when it runs; a read does not look again.
- **Change a setting** such as `statement_timeout` for the statements after its own. The pass's
  own deadline (above) still cancels it, and the change ends with the read. A session advisory
  lock it takes is let go before the rollback, and session settings, transaction-scoped locks
  and `pg_notify` end with it.
- **See how big a served table is.** `pg_class.reltuples` and the `pg_stat_*` views are
  readable by every role, so a read can see roughly how many rows a table holds, everyone's
  together. It sees no row it may not read.
- **See and end the other served reads.** They all log in as one login, so a read can see their
  SQL in `pg_stat_activity` (never their values, which Drizzle binds) and `pg_terminate_backend`
  them. Revoke `EXECUTE` on `pg_terminate_backend` and `pg_cancel_backend` from `PUBLIC` if that
  matters to you; the deadline needs neither, as it sends a cancel request of its own. A read whose backend is ended mid-transaction is worse
  than failed: postgres.js 3.4.9 writes its `ROLLBACK` to the closed socket inside a
  `setImmediate`, which throws outside every promise, an uncaught exception the process dies
  of unless the host handles `uncaughtException`.

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

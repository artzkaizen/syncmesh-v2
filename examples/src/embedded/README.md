# A · The relay inside the backend you already run

Two function calls in one process (D09-A, API.md §14-A): `startRelay()` serves the room, and
`createMesh({ store, stateStore })` is the server peer that folds what devices write into _your_
tables. No second deployment, no queue, no separate sync service.

```sh
bun run --cwd examples server
bun run --cwd examples device alice "first note"
bun run --cwd examples device bob   "second note"
curl localhost:5199
```

`bob` catches up `alice`'s note through the relay, and both rows come back out of the backend's
own SQLite file over plain Drizzle — `db.select().from(notes)`, no mesh API in the query path.

## What it demonstrates

**The relay is a peer, and its log is an `EventStore`.** `startRelay(5198, { dataDir })` keeps one
SQLite file per room under `dataDir`, with the room's epoch persisted beside it. Stop the server
and start it again: devices reconnect on their own and only what is missing crosses.

**`stateStore` is where "your database" is said out loud.** `server.ts` opens one
`bunSqliteDriver` on the app's own file and builds both stores over it — `sqlEventStore` for the
log, `sqlStateStore` with a `tablesProjection` for the rows. Every fold UPSERTs the changed rows
into `notes` and deletes tombstones, in one transaction with the sidecar that holds their stamps.
Restart the server and the API answers immediately: boot reads the state back rather than
replaying the log.

**Grants, on the real path.** The server holds the issuer key and answers `onGrantRequest`. A
device starts with nothing, calls `requestGrant(invite)`, and the signed grant travels back
through the relay — flow A, over a socket, not a fixture.

## What it deliberately leaves out

- **The server never writes.** `store` and `stateStore` are two homes for one log, so `createMesh`
  takes them _instead of_ `driver` — and without a `driver` there is no SQL connection for
  `mesh.on()` to hand out, so a server built this way reads its tables and folds into them but
  cannot write through a handle. A backend that must also write (a correction, a policy publish)
  passes `driver` instead and lets `openStores` build both, which also gets it the atomic
  append-and-materialise that this shape does not have: with stores you built yourself, the engine
  is given no `atomic`, and a crash between the append and the commit is recovered from the log on
  the next boot rather than prevented.
- **Two ports, not one.** `startRelay` owns its own `Bun.serve`, so the relay listens on 5198 and
  the app's API on 5199. To serve both from one port, mount `openRelayRoom` on the server you
  already have — the room core is host-agnostic, and `startRelay` is only its first mount.
  Nothing here needs one port, so nothing here does it.
- **Postgres.** The `StateStore` port is synchronous, so the rows land in SQLite. Postgres needs
  the async state port (D05); until then this shape holds your tables in a SQLite file your
  tooling can read, not in your production database.
- **Everything an operator would add**: a `posture` deciding who may open a socket and onto which
  rooms, TLS, `limits` tuned for the traffic, retention, telemetry, and an approval screen where
  `onGrantRequest` currently compares one hard-coded invite string.

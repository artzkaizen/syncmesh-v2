# @syncmesh/orpc

The app's procedures over a mesh: `query` and `mutation`, the client every screen calls, and the
server half that serves `sync: "window"` reads from Postgres.

## Serving windowed reads

`servedReads` runs a device's `query` procedure on the server, against Postgres, a page at a
time (D43). It takes a Drizzle of its own: one logged in as a login that holds the read role and
nothing else, never the app's own connection. The role, its policies and the login's grant come
from `servedReadDdl` in a migration.

The whole deployment, the migration and the server wiring, is in
[`@syncmesh/storage`'s README](../storage/README.md#serving-sync-window-reads-from-postgres-d43).

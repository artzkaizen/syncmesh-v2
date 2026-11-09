# Rounds, on the web

The ward station: a TanStack Start app whose **server** holds the partition and is on the relay,
and whose **browser** calls the very procedures a phone runs in-process.

```sh
bun run --cwd apps/rounds-web dev      # http://localhost:5199
bun run --cwd apps/rounds-web relay    # optional: the relay the phones also dial
```

## Why the mesh is on the server

A browser has no SQLite. `sqlite-wasm` over OPFS is unbuilt (E04's one open hole), so a web app
cannot hold a partition, cannot fold events, and cannot run a read locally. Saying otherwise
would be the honest failure of this example.

So this is **not a local-first app**. It is an ordinary web app on top of a mesh node — and the
reason to build it is what that node is connected to: the ward's phones are on the same relay, so
a reading taken with no signal appears here when it syncs, without this server polling anything.

## What crosses, and what does not

`src/rounds.ts` re-exports the schema and procedures from `examples/src/rounds`. Not a
convenience — the phones and this station **must** agree on the schema or they cannot sync, so
sharing the definition is the requirement, not the shortcut.

The browser imports the procedures with `import type`, which is erased. `RemoteApi<R>` reads each
return type off the procedure that produces it, so nothing is cast and a page that misreads a row
does not compile. The mesh is imported _inside_ the server function's handler: a top-level import
would pull SQLite and the relay into the browser graph. Verified — `dist/client` contains no
`bun:sqlite`, no `createMesh`, and no relay.

`RemoteApi` has no `QueryCall`, deliberately. A live query is a fold on the device holding the
log, and this browser holds nothing; a subscription here would promise a freshness it cannot
keep. Reads are one round trip.

## Tested in a browser

`bun run --cwd apps/rounds-web test` (and so `vp run -r test` and CI) starts a relay, starts
`vite dev` under **Node** in a scratch directory, and drives the page with Chromium: it admits two
patients and records a reading, and fails on any page error or console error
(`src/__tests__/ward.test.ts`). It replaced a manual smoke script, because every fault this app
has had left the page rendering perfectly and doing nothing — a missing React Refresh runtime,
`bun:sqlite` and `Bun.env` under Node, a mutation answering with its handle instead of its commit,
and calls that named no practice and were refused `WrongPartition`. None of them is visible to a
test that fetches html.

## Worth knowing before you copy it

The app pins upstream `vite` 7 for TanStack Start, beside the repo's Vite+; `vp run -r build`
runs its `vite build` script.

**`nodeSqliteDriver(path)` opens a file; it does not create the directory.** Only `defaultStore`
does the `mkdir`, so a driver given `.syncmesh/x.db` on a fresh checkout fails with
`SQLITE_CANTOPEN`. This app does its own `mkdirSync`.

It uses the **Node** driver, not the Bun one. Vite runs the server modules under Node, so
`bun:sqlite` cannot even be imported — and a web app should not be tied to one runtime anyway.
Bun implements `node:sqlite` too, so the same driver serves both. For the same reason, config
comes from `import.meta.env` rather than `Bun.env` or `process.env`.

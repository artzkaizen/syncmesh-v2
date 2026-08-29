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

## Two things this cost, worth knowing before you copy it

**The repo's `overrides: { vite: "catalog:" }` rewrites every `vite` to `vite-plus-core@0.3.0`,
and TanStack Start wants `vite >=7`.** Bun's overrides are global with no per-package scoping, so
the two cannot both be satisfied inside one install. This app is a workspace member (its
`@syncmesh/*` deps resolve through `workspace:*`, which is why it cannot simply be moved out) and
is built with `bunx vite`, which fetches upstream Vite rather than taking the override. That is a
workaround, not a solution, and the real fix is a decision about whether the override should be
repo-wide.

Its scripts are named `web:*` for the same reason: `vp run -r build` would otherwise try to build
this app with a `vite` that is not the one it needs, and fail the whole repo's CI. So the app is
in the workspace for dependency resolution and outside it for the build, which is exactly as
awkward as it sounds and is written down here rather than hidden.

**And it is why `dev` is a rebuild loop rather than HMR.** Start's dev middleware installs only
when Vite's SSR environment passes an `isRunnableDevEnvironment` check, and that check is a brand
comparison against the `vite` _the plugin resolves_ — which here is `vite-plus-core`, while the
CLI is upstream Vite. Two copies, so the check fails and the middleware silently declines to
install; `vite dev` answered a bare 404 with no error at all until the check was forced. So
`dev.ts` watches `src`, reruns the build (~1s) and restarts the server. Save, wait a beat,
refresh — you just do not keep component state.

**`bunSqliteDriver(path)` opens a file; it does not create the directory.** Only `defaultStore`
does the `mkdir`, so a driver given `.syncmesh/x.db` on a fresh checkout fails with
`SQLITE_CANTOPEN`. This app does its own `mkdirSync`.

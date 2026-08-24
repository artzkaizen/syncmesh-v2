---
rfc: 0009
title: Client & Reactive Layer
package: syncmesh/client · syncmesh/react
layer: 3
status: implemented
standalone: false
deps: ["0003", "0004", "0005", "0008"]
---

# RFC-0009 — Client & Reactive Layer

## Purpose

The developer surface: collections you write to, live queries that re-emit,
partition scope that is ambient instead of threaded through every call. Two
subpackages so the boundary is enforceable: `/client` is framework-free;
`/react` is the only place React exists.

## `/client` — createClient

```
const client = createClient({ sync, account, identity, grants,
                              transports: [relay(url, room)],
                              storeFor: (scope) => EventStore })   // optional per-org stores
client.setWorkspace(id)            // GENERATED from the app's own partition kinds
tasks.insert({...})                // → Result; NoActivePartition names the setter to call
tasks.update(id, patch)           tasks.delete(id)
client.transaction(() => {...})    // one atomic multi-collection event
client.can("tasks.update", row)    // same policy AST as validation (RFC-0008)
client.request(name, input)        // server ops (RFC-0010): { committed, result() }
client.stop()
```

Decisions carried from the API research (api-shape v13, workspace-scoping):

- **Ambient partition scope.** Setters generated from the app's declared
  kinds (`setOrg`/`setWorkspace`, typed via template-literal mapped types);
  a silent cross-workspace write is inexpressible. Rejected: per-call
  `{group}` options, scoped wrapper objects, registry addressing.
- **No client-side handlers.** Local writes ARE collection mutations,
  captured as changes (RFC-0002). Handlers exist only on the authority
  (RFC-0010).
- **No optimistic overlay.** The local commit IS the truth; write handle
  stages are `committed` (the mutate Result) → `synced({minAcks, timeoutMs})`
  (real relay acks, or a typed `SyncTimeout` value — the event ships later
  via push-outstanding) → rejection arrives, if ever, as settlement data.
- **Errors are values.** better-result throughout; a complete app can be
  written without importing `Result` once (fire-and-forget writes, live
  queries, `can()` are Result-free surfaces).

## `/react` — the thin reactive layer

Own implementation (~small): `QueryRegistry` + `useLiveQuery` /
`useLiveInfiniteQuery` on `useSyncExternalStore`. Re-run-SQL + structural
equality cutoff + row-identity preservation — **no db-ivm**; at mesh data
volumes, re-running the query is microseconds and the cutoff makes gossip
echoes free. One fold notification per batch → one render per burst (5k-event
catch-up = one notification, load-tested). Keyset window pagination; offset
is banned (unstable under live edits). Deps array is REQUIRED — Hermes
`fn.toString()` returns `[native code]`.

## Presence — the ephemeral surface `[N2a]`

Designed in RFC-0020 §6; this is the developer's half of it. Topics are declared
next to the tables, because a presence value needs a shape for the same reason a
row does — an unvalidated `value` from a peer is an injection surface:

```ts
const sync = defineSync({ task }, {
  partitions: { org: {}, board: { parent: "org" } },
  tables: { task: { partition: "board", allow: { ... } } },
  presence: {
    cursor: { partition: "board", of: { x: t.float(), y: t.float(), anchor: t.text().nullable() } },
    typing: { partition: "board", of: { taskId: t.text() }, ttlMs: 5_000 },
  },
})
```

```ts
client.presence.cursor.set({ x, y, anchor })   // conflated; safe at pointer rate
client.presence.cursor.clear()                 // explicit departure
client.presence.cursor.peers()                 // → { peerId, account, value, at }[]
client.presence.cursor.subscribe(cb)           // → unsubscribe
```

Decisions, and why they differ from the collection surface:

- **`set()` returns `void`, not a `Result`.** Everywhere else in this codebase a
  runtime failure is a value you can inspect. Presence is the exception, and it is
  a deliberate one: the call sits in a pointer-move handler at 60 Hz, and a
  `Result` nobody unwraps is worse than no `Result` — it is ceremony that trains
  people to ignore return values. Misuse (no active partition, unknown topic,
  value failing its shape) goes to the **diagnostics channel** with a hint naming
  the setter to call (RFC-0020 §3.5), which is precisely what an advisory path
  should do: be loud in development, be silent and harmless in production.
- **Ambient partition scope, same as collections.** `setBoard(id)` moves your
  cursor with you; a cross-board presence leak stays inexpressible.
- **`peers()` is current, never historical.** There is no `presenceLog`, no
  "who was here", no infinite scroll of departed cursors. If an app wants that,
  it is writing rows — which is a different, durable, deliberate decision.
- **Not a collection.** It is deliberately *not* reachable through
  `client.collections`, and it produces no `SyncEvent`. Nothing about presence
  should be one refactor away from becoming durable by accident.

`/react` adds one hook, on the same `useSyncExternalStore` machinery:

```ts
const cursors = usePresence(client.presence.cursor)   // → { peerId, account, value, at }[]
```

It re-renders on the frame scheduler like `useLiveQuery`, so a room of twenty
moving pointers is one render per frame, not twenty.

## Forbidden leaks

- `/client` must never import React (`grep -r "react" src/client` = empty).
- Neither may name a storage backend, radio, or channel — transports arrive
  as adapter values (RFC-0005), stores via `storeFor` (RFC-0004).

## Remaining work

- Presence topics + `usePresence` (N2a) — see above and RFC-0020 §6.
- `useMeshStatus()` from per-peer cursors/acks (N1).
- Port the Expo app: `SyncProvider.tsx` → `createClient` + `useLiveQuery`
  (N2) — deletes `loadNotes()` and the four hand-wired listeners.
- Windowing polish for large lists on phones (keyset windows exist; measure).

# Building the book — progress ledger

> Running record of the ch. 27 build order as it lands on this branch. Updated 2026-09-11.
> Tree state at last update: `vp check` 0 errors, every package suite green, chaos runs
> (fresh seeds) converged with zero leaked handles. Commits are pending on the 1Password
> signer being unlocked; the work is in the tree.

## Phase 0 — DONE

- Store lock-on-open: `StoreLocked` + `acquireStoreLock` (`storage/lock.ts`), held via
  `BEGIN EXCLUSIVE` on a `<store>.lock` sidecar; both sqlite adapters' `defaultStore`;
  `MeshOpenError` widened. Double-open fails typed; close admits the next opener.
- Handles leak loudly: `createHandleTally`/`meterHandles`/`meterBlobs` (`client/inspect.ts`),
  `mesh.inspect.handles()` counting observers/subscriptions/operations/fetches/links;
  teardowns Disposable + idempotent; chaos epilogue fails a run ending with seats held.
- Error catalog crosses the wire: `serializeTagged`/`createTaggedCatalog`/`ForeignTagged`
  (`result/wire.ts`); orpc `createHandler` serializes `{ _tag, ...fields }`, `httpLink`
  revives into the caller's declared classes.

## Phase 1 — core DONE, two deferrals

- Operation records: `operationStore` (`storage/operation-store.ts`) over per-dialect SQL
  (`storage/dialect-operations.ts`; short names on device, `_syncmesh_` on Postgres);
  `MutateOptions.record` runs inside the engine's atomic boundary — record and event land
  together or neither (proven by the rolled-back-transaction case); the writer allocates the
  id before commit and returns it on `TxReceipt.operationId`; local-only writes get no record.
- Receipts: `openOperations` (`client/operations.ts`) turns acknowledged cursors into
  idempotent receipt rows; `_corrections` folds mark displaced records superseded with the
  reason; `mesh.operations` reads the ledger back (proven across restart from disk).
- Deferred: the `Write<T>` statement tracker (its ergonomic home is the Phase 3 call
  surface); **signed** custody receipts (a transport frame — belongs with the peer session).

## Phase 2 — surface DONE, jobs deferred

- `mesh.recovery`: quarantine read back as stable causes (`missing-capability` for the grant
  verdict family, `refused` otherwise), `run()` = idempotent re-admission. Proven: ungranted
  author parks as NoGrant, grant + run folds it.
- `watch()` (orpc): detection over state, latest-wins coalescing, converging reactions —
  the price-floor watchdog test reaches its fixed point.
- Deferred: persisted retry jobs with dependency edges; `explain`/`export`/`rebuild`.

## Phase 3 — grammar and server DONE, surface rename pending

- The terminals: `query`/`mutation` gained `.route()` (metadata only), `.input()`,
  `.output()` (parsed at the trust boundary on both ends), `.errors()` (declared tags over
  the wire), `.authority()` — typestate leaves no `.handler` after `.output()`. The legacy
  `authority.input().returns<T>()` builder is cut (book's cut list).
- `AuthorityHandlers<R>`: the router filtered to its gates as a mapped type; `satisfies`
  makes a missing/extra/drifted body a compile error. `createHandler({ gate })` dispatches
  with parsed input, lazily opened handle, and per-declared-error throwers.
- `createServer` (orpc/server.ts): createApp + gate binding + watchdogs with teardowns +
  `openapi()` from `.route()` metadata. Proven end to end over a real socket (reserve,
  refuse by tag, read back, spec shape).
- `useOperation` (react) over `mesh.operations.onChange`.
- Pending: `createClient` regroup (procedures at top level + `$`-spellings), `useQuery`
  dialect with `coverage`, TanStack collection adapter, `syncOf`/`operationOf` as selectable
  columns (needs a joinable row-sync table maintained by fold/ack — design before code).

## Phase 6 — counter and detach DONE

- `merge: "counter"` end to end: the kernel cell is a PN pair (per-author totals up and
  down, both monotone — a single non-monotone map is not a lattice under max, whatever the
  shorthand said), increments `{"+": n}` accumulate on the in-order fold path, normal forms
  join per-author max, `counterValue` reads the difference. **No increment API**: capture
  holds OLD and NEW, so `SET stock = stock - 2` becomes the delta; the projection writes the
  sum into the app's table; validation accepts exactly the two wire shapes; the old test
  pinning counter's absence is flipped (ch. 26's named first task). Proven at the kernel
  (both orders, 24−2−1=21, idempotent snapshot joins) and through two real meshes.
- `detachScope` (storage): refuses with the unsent operation ids while the ledger holds
  unreceipted intent, else closes the scope and hands file deletion to the caller (ch. 13).
  The guard is the Phase 1 ledger paying rent.

## Gap-audit P1 items closed this pass

- Relay connection cap (№5): `limits.maxConnections` (default 10 000), refused at upgrade
  with 503 before any handshake spend; a close frees the seat.
- Byte-bounded backlog (№6): `limits.maxBacklogBytes` (default 64 MiB) alongside the frame
  count; a stalled socket is closed before it retains gigabytes.
- Chaos in CI (№10): `chaos` now has a `test` task running a fixed-seed smoke through the
  real harness — the convergence oracle and zero-handles epilogue guard every `vp run test`.

## Phase 6 continued — budget and the blob surface

- `sweepBudget` (storage): pressure sheds whole idle partitions, least-recently-opened
  first, through `detachScope` — so the unsent-intent guard outranks disk pressure by
  construction; `"suggest"` reports without touching anything. Platform facts (file sizes,
  idleness, deletion) stay the caller's.
- Blob surface (client): `stream()` (the seam chunked frames will fill; metered like any
  fetch, seat freed on close/error/cancel), `retain`/`release`/`retained` refcounts for the
  eviction sweep to consult, and `onProgress` with the two honest ticks a whole-buffer
  transfer can give — documented as such until the peer session's blob frames land.

## Phase 3 continued — the read dialect

- `useQuery` (react): the book's ch. 9 hook — conditional queries disable instead of
  crashing, `data` is `undefined` until local stabilization, and `isReady` and `coverage`
  are two facts that settle apart (proven: rows ready while coverage still `local-only`,
  then `caught-up` when settled resolves). `Coverage` ships as the honest two-kind union;
  per-source checkpoints grow onto it without a shape change. `useLiveQuery` now tolerates
  `undefined` underneath it.

## Runtime transports — DONE (reconciles gap-audit №23)

`mesh.transports.add/remove/list` (book ch. 8, 16): the runner now holds a live set instead
of the constructor's frozen array — `add` starts a medium mid-life and returns a typed
`TransportAddFailed` rather than throwing (a failed start is rolled out of the set), `remove`
takes the route away by name with optional drain, and routing, flush, `settled`, `withBlobs`
and the link count all read the live set. The admission watch stays lazy — subscribed only
once something boundable is present, re-checked on `add` — so a transport driven with no mesh
behind it still never touches the engine.

This settles the E24/E09 contradiction the audit flagged (№23) in E24's and the book's favour.
Proven by removing the original radio and watching the mesh keep converging over the late one:
a route left, the rows stayed.

## Status diagnosis — DONE

`mesh.status` (book ch. 18): per-source conditions plus one overall health, so a settings
screen can say "Bluetooth is off — turn it on to sync with nearby devices" rather than draw a
red dot. Two optional facts joined the transport port — `kind` (the medium, so AWDL and
Wi-Fi Aware are never merged into a lying "p2p-wifi") and `condition` (what the platform says
about its own radio); a medium that declares neither is still diagnosed from `onStatus` as
`ok`/`temporarily-unavailable`. Sources are keyed by the transport's own name rather than by
medium, because a fleet runs two radios of one kind and `remove` takes that name.

`auth-required` and `storage-degraded` are in the book's vocabulary and deliberately left out:
nothing reports either yet, and a health a UI cannot trust is worse than one word fewer.

## One noun — `createClient` DONE

`createClient` (orpc/client.ts, book ch. 8 and rule 1): the client **is** the api. Procedures
sit at the top level and the machinery sits beside them as `$operations`, `$recovery`,
`$status`, `$transports`, `$blobs`, `$grants`, `$presence`, `$inspect`, `$accounts`,
`$flush()`, `$close()`, plus `$mesh` for the handful of facts that are neither a procedure nor
a `$`-surface. Three tiers, three spellings, and the collision is impossible by construction
rather than by a reserved-word list. `createApp` stays as the construction step both doors
share — `createServer` is the other one.

## Still open (the honest remainder)

Phase 3: TanStack collection,
`syncOf`/`operationOf` selectable columns (needs a joinable row-sync table — design first).
Phase 4: `lan()`/`awdl()`/`wifiAware()` adapters, PeerSession re-key, mesh shaping, `$status`
vocabulary — `awdl`/`wifiAware` need native modules and hardware. Phase 5: presence graph,
fail-closed admission gate, N-hop routing. Phase 6: storage budget (`lru-idle`), blob
progress/streams. Plus: signed custody receipts (transport frame), fan-out metering (№7),
retention defaults (№8), BLE hardware checklist (№9), sealed partitions, checkpoints.

# Durable storage in a browser: where the boundary goes

Status: **decided and half-built.** The single-tab half ships; the multi-tab half is specified
here and is not built.

## 1. The measurement that started it

`adapters/sqlite-wasm` shipped a driver whose doc comment said `opfs-sahpool` is "synchronous on
the page's own thread, no COOP/COEP needed". The second half is true. The first half is not
attainable in a window in any browser.

```
window:           FileSystemFileHandle.prototype.createSyncAccessHandle → undefined
dedicated worker: FileSystemFileHandle.prototype.createSyncAccessHandle → function
```

Measured again on `localhost:5188` while writing this: `undefined` in the page, with
`crossOriginIsolated: false`, and the app on OPFS regardless — because the database is in a worker.

The rule is the platform's, not SQLite's. `createSyncAccessHandle` is `[Exposed=DedicatedWorker]`.
TypeScript's own libraries are the shortest proof: the method is declared in `lib.webworker.d.ts`
and appears nowhere in `lib.dom.d.ts`, and MDN's line in that declaration says "it is only usable
inside dedicated Web Workers".

Both of SQLite's OPFS backends gate on it, and the gates are in
`@sqlite.org/sqlite-wasm@3.53.0`'s own source:

- `installOpfsSAHPoolVfs` — `if (!globalThis.FileSystemHandle || … ||
  !globalThis.FileSystemFileHandle.prototype.createSyncAccessHandle || …) return
  Promise.reject(new Error("Missing required OPFS APIs."))`. No worker check; the method's absence
  *is* the check.
- the `opfs` VFS — `vfsInstallationFeatureCheck` in order: `SharedArrayBuffer`/`Atomics` (else
  "The server must emit the COOP/COEP response headers"), then `"undefined" === typeof
  WorkerGlobalScope` (else "cannot run in the main thread … because it requires `Atomics.wait()`"),
  then the same `createSyncAccessHandle` probe.

So serving the page with COOP/COEP to get `crossOriginIsolated: true` and a `SharedArrayBuffer`
does not buy `"opfs"` either: it clears the first gate and fails the third. A window cannot have a
durable VFS, and no header, flag or browser version changes that.

`opfs-sahpool` needs a dedicated worker and **nothing else** — no cross-origin isolation, no
headers. `opfs` needs a dedicated worker **and** COOP/COEP. That distinction is what the corrected
docs now say.

## 2. Where the boundary goes

### The premise that was wrong

The brief said: "A `SqlDriver` is **synchronous**, which is why this has not simply been 'run it in
a worker' already." It is not. `packages/storage/src/driver.ts`:

```ts
readonly run: (sql: string, params?: readonly SqlValue[]) => Promise<void>;
readonly all: (sql: string, params?: readonly SqlValue[]) => Promise<readonly SqlRow[]>;
readonly transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
```

The port has always been asynchronous. What is synchronous is the *binding* — `SqliteBinding`, the
~8 lines a platform writes — and `sqliteDriver` is the adapter that puts promises around it.
`bindSqlite` is even exported with the doc line "Exported for a binding whose calls are async and
so cannot be a `SqliteBinding`." E04 recorded that `bindSqlite` "went unused". It is used now.

So the choice was never "change a synchronous interface". It was "which side of the thread does the
engine sit on".

### Option A — driver in the worker, engine in the page. **Chosen.**

The worker owns SQLite's WASM heap, the access-handle pool and the databases. The page holds a
`SqlDriver` whose four calls are `postMessage` round trips. Nothing above the driver knows: the
engine, the stores, Drizzle and every live query run unchanged.

- New code: a protocol, a host (`serveSqlite(port)`), a page-side client (`connectSqlite(port)`), a
  worker entry. No change to any interface anything else depends on.
- Certified by the existing conformance suite rather than a parallel one — `driverTests` runs over
  a `MessageChannel` with the host in-process, 35/35, including `BEGIN IMMEDIATE`, a transaction
  whose body throws and rolls back, blob round trips and the read filters.
- Transactions are safe because the port is ordered and there is one writer per driver: `BEGIN
  IMMEDIATE` goes over the wire, the body's statements follow on the same connection in the order
  posted, `COMMIT` last. That is the same rule `sqliteDriver` already relies on in-process.

### Option B — the whole mesh in the worker, the page a thin client. **Rejected, for one tab.**

The page's React hooks would talk to the worker; engine, store and driver all live where
`createSyncAccessHandle` exists. It is what LiveStore does.

Rejected because for *one tab* it buys nothing option A does not, and costs a second
implementation of the client surface. `Mesh` is seventeen sub-surfaces (`operations`, `recovery`,
`status`, `transports`, `peers`, `routes`, `blobs`, `grants`, `auth`, `drafts`, `presence`,
`inspect`, `schema`, `query`, `accounts`, `flush`, `stop`) plus `on(partition)` returning a
`Handle` carrying Drizzle's `db`, `read` and `live` — live queries with subscriptions. Mirroring
that across a port is a new public surface with its own drift risk, and it would move the app's own
procedure handlers into the worker bundle. The book has no such surface; `createClient` *is* the
client.

Note what this rejection was and was not: it was a rejection **for durability in one tab**. §4
reopens it for multiple tabs, where it turns out to be the only sound answer.

### What the worker costs, measured

The objection to option A is a message round trip per statement. Measured in Chrome on the machine
this was built on, 2000 page↔worker round trips:

```
0.0142 ms per round trip  (28.3 ms total for 2000)
```

Fourteen microseconds. A thousand-statement transaction pays ~14 ms. `apps/issues` boots, seeds 120
issues and paints in a 190 ms page load over this driver. The cost is real and it is not the reason
to choose anything.

## 3. What shipped for one tab

- `wasmSqliteDriver` called in a window with OPFS starts `worker.js`, opens the database there and
  returns a port-backed driver. Called inside a worker it opens in place. Called where there is no
  OPFS at all (a test runner) it stays on the thread and gives `"memory"`.
- `openDatabase` — the in-thread opener — now asks `threadHasSyncAccessHandles()` *before*
  attempting anything, so `"auto"` in a window resolves to `"memory"` deliberately rather than
  after a rejected install, and an explicit `"opfs-sahpool"` or `"opfs"` from a window returns
  `OpfsUnavailable` whose message states the rule:

  > a durable VFS needs FileSystemFileHandle.createSyncAccessHandle, which the File System API
  > exposes only in a dedicated worker; this thread is not one, so the only VFS it can open is
  > memory. Open the database in a worker — wasmSqliteDriver does that for you.

- `apps/issues` did not change to get this. Its `openDriver()` ladder was written so the first rung
  would start succeeding the moment the adapter could be durable, and it did.

Verified in a browser: badge `OPFS`, 120 issues, full reload, the write still there, still 120 —
see §6.

## 4. The second tab

`opfs-sahpool` takes exclusive access handles for **every slot in its pool directory** the moment
it installs. The exclusion is per origin directory, not per database: a second tab asking for a
database name nobody has ever opened is refused exactly as firmly as one asking for the first tab's.
One browsing context of an origin holds it; the rest are refused.

Measured, with one tab holding it:

```
navigator.locks.query()  →  held: [{ name: "syncmesh-opfs:/syncmesh/pool", mode: "exclusive" }]
navigator.locks.request(same, { ifAvailable: true })  →  refused
```

### The candidates, and why both are unsound as posed

Both proposed answers — a `SharedWorker` hosting the database, or Web Locks leader election with
followers proxying to the leader — share one shape: **two tabs, one SQLite database, two meshes.**
That shape is not merely "not live". It is silently corrupting, for two reasons:

1. **Sequence numbers.** `openEngine` reads `lastSeq(peer)` and `maxHlc()` once, at boot, and
   allocates upward from there in memory. Two tabs of one app are one device identity, so two
   engines booted at the same `lastSeq` both issue `(author, seq)` pairs starting at the same
   number with different contents. E04's own "Watch out" names this exact failure and calls it
   invisible: "new events stamped below ones peers already saw → silently discarded as stale."
2. **In-memory state.** A live query re-runs only when its own tab's engine emits a `FoldBatch` —
   `createHub<FoldBatch>` inside `createEngine`, consumed at `packages/drizzle/src/live.ts:148`.
   Nothing re-reads the log after boot; there is no `invalidate(tables)` anywhere. Tab A would go
   stale indefinitely, and its in-memory `State` — which `can()`, validation and `rowsIn` read —
   would diverge from the file underneath it.

A `SharedWorker` cannot host the database at all, which removes one of the two candidates before
the argument even starts. Measured on one page, three scopes:

```
page              typeof FileSystemFileHandle.prototype.createSyncAccessHandle → "undefined"
dedicated worker                                                              → "function"
SharedWorker                                                                  → "undefined"
navigator.locks.request                                                       → "function"
```

`SharedWorkerGlobalScope` is not a `DedicatedWorkerGlobalScope`, so it hits exactly the wall the
page hits. **Anything that owns an OPFS SQLite database is a dedicated worker, full stop.** A
`SharedWorker` may only be a rendezvous — and it is absent from Chrome on Android entirely, which
is not a platform a local-first web app may quietly drop.

### The decision

**One engine per origin.** The mesh moves into the worker and every tab holds a thin client —
option B from §2, reopened and now chosen, because multiple tabs are the case that makes it the
only sound shape. It is also what the repository's own documents already say, in the one place they
say anything: RFC-0004 §"Scoped stores" — "runs **one engine per storage scope**" — and
`research/tanstack-db-validation.md:133`, rejecting a tab leader-election dependency because "our
answer is one engine per storage scope".

The shape is therefore forced, and it is the one LiveStore arrived at:

- **A dedicated worker per tab.** Every tab *can* host the database; exactly one *may*.
- **`navigator.locks` elects which one.** The winner's worker is the single writer and owns the
  OPFS files. The lock releases when its holder's context dies, so handover after a tab closes or
  crashes needs no heartbeat, no lease expiry and no stale-lock recovery — which is most of why it
  beats rolling an election by hand. It is also present wherever OPFS is, Chrome on Android
  included.
- **A `SharedWorker` as the message bus, and nothing else.** A follower tab cannot address another
  tab's dedicated worker directly, and a `SharedWorker` is the origin's only singleton rendezvous.
  It proxies ports; it never touches a file.
- **Chrome on Android has no `SharedWorker`,** so there is no rendezvous there and the origin falls
  back to single-tab mode: one durable tab, the rest saying which mode they are in. Naming the mode
  rather than degrading silently is the same rule the storage badge already follows.

The protocol for this mostly exists. `protocol.ts` / `host.ts` / `remote.ts` is a `RemoteSqlite`
talking to a host over a `WirePort`, and page→own-worker and follower→leader's-worker are the same
conversation over a port that arrived from somewhere else. What is missing is above it, not below.

### What a follower tab is

Two readings, and they are not equivalent.

1. **A follower is a full syncmesh peer,** reaching the leader over a `MessagePort` transport.
   Tab-to-tab becomes another carrier and the mesh is reused wholesale.
2. **A follower is a thin client of the leader,** sharing its identity and its log, holding local
   state only for reads.

**(2), and (1) is not close.** The decisive argument is the constraint this whole document is
about, turned around: a peer owns a log, and **only one browsing context of an origin can persist
one**. Under (1) every tab but the leader is a peer whose replica is a `memory` database — so five
tabs are one durable device and four devices that lose everything on every reload and re-sync the
whole log from the leader each time a tab is refreshed. (1) does not make tabs peers; it makes them
*memory* peers, which is the failure this work exists to remove, re-introduced one level up.

The identity costs are the rest of it, and they are not cheap to solve:

- Five tabs would be five device keys. Each needs a grant, and in a real deployment `issueGrant` is
  an authority round trip — so opening a tab becomes an authorization event.
- Five keys per person is five to revoke, five to seal, five in every custody receipt, and five
  peers appearing and disappearing in every *remote* device's `$peers` and `$routes` as someone
  opens and closes tabs.
- Five copies of the same log, each re-verifying the same signatures on each reload.

The only way to avoid all of that under (1) is to share one device identity across the tabs — at
which point it is (2) with a replication protocol bolted on and a signature bill attached.

**Has the book ruled?** Not directly; there is no chapter, decision or RFC on two tabs sharing a
local database. Two things lean on it, in opposite-looking directions, and only one is really
about this:

- RFC-0004, "Scoped stores": "runs **one engine per storage scope**". And
  `research/tanstack-db-validation.md:133` declines a tab leader-election dependency precisely
  because "our answer is one engine per storage scope". Both are (2).
- D16:45: "Identity is `(account, peerId)`, never the connection: two tabs of one person are two
  peers under one account, and a reconnect does not become a second ghost." This reads like (1) and
  is not: it is a *presence* rule about how remote observers group what they see, and its point is
  that two things must not become a ghost. One engine per origin satisfies it trivially — there is
  one `peerId` and nothing to group. If two tabs should ever genuinely be two peers, they need two
  device identities and a transport between them, and that is a different product with a different
  consent story.

### Staged, because it is a build and not an increment

1. **Done.** The second tab's failure is legible: `OpfsPoolHeld` is its own `TaggedError`, distinct
   from `OpfsUnavailable`, carrying the directory and a message that says another browsing context
   holds it and that it clears when that one closes. It is decided by a Web Lock taken *before*
   SQLite is touched, so it is a plain yes/no rather than a `DOMException` about writable streams
   thrown from halfway through an install. `apps/issues` shows "Another tab owns the database"
   instead of "Memory — not saved".
2. **Not done.** `Mesh` and `Api` over a `MessagePort`, with live-query subscriptions crossing it;
   the worker entry that constructs the mesh; the `SharedWorker` rendezvous that hands a follower a
   port to the leader's dedicated worker; `navigator.locks` election and re-plumbing of followers
   on failover; and the single-tab fallback, named on screen, where there is no `SharedWorker`.
   This is the work E04 left open as "concurrency, not storage", and it is a week, not an
   afternoon.

Until stage 2, exactly one tab of an origin is durable and every other tab says so in the header.
That is worse than two live tabs and much better than two tabs that look alike while one quietly
keeps nothing — which is what shipped before, and is what stage 1 fixed.

## 5. Where the code lives

In `adapters/`, never `packages/` — this touches `Worker`, `navigator.locks`, `FileSystemFileHandle`
and the DOM, and `packages/*` is runtime-neutral by D01-B and lint-enforced.

Stage 2 added one entry beside it: **`@syncmesh/browser`**, which is not a binding at all and so
is not covered by the rule that closed `adapters/` at four. It ships no library and wraps none; it
is the origin's *concurrency* layer — the mesh served over a port, the thin client every tab holds,
the election and the rendezvous. It is not inside `@syncmesh/sqlite-wasm` because the host builds a
whole mesh, and putting it there would make the browser's storage binding depend on
`@syncmesh/client` and `@syncmesh/drizzle`: a driver importing the engine that drives it. The
argument, and the amendment to the rule, are in `plan/epics/E04.md`.

It did **not** become a fifth adapter. `@syncmesh/sqlite-wasm` is one binding —
`@sqlite.org/sqlite-wasm` — and the worker is where that binding is *hosted*, not a second one; see
the argument added to E04. The only thing that went into `packages/storage` is `asyncSqliteDriver`,
the asynchronous twin of `sqliteDriver`, which belongs beside the port it implements and shares its
transaction statements with it.

## 6. Browser evidence

`apps/issues` on `http://localhost:5188/`, Chrome:

| step | measurement |
|---|---|
| page thread probe | `FileSystemFileHandle.prototype.createSyncAccessHandle → undefined`, `crossOriginIsolated: false` |
| first load | badge `OPFS`, title "…on the access-handle pool, in a dedicated worker — this is saved"; `ISSUES 120 / OPEN 84 / UNNUMBERED 30` |
| OPFS on disk | `/syncmesh/pool/.opaque/…` 1 454 080 B; `navigator.storage.estimate().usage` 1 484 574 B |
| write | ENG-4 priority → urgent; history "Ada Okonkwo set priority to urgent · now" |
| full reload | badge `OPFS`; history still "Ada Okonkwo set priority to urgent"; still `120 / 84 / 30` — not re-seeded |
| lock held | `navigator.locks.query().held → [{ name: "syncmesh-opfs:/syncmesh/pool", mode: "exclusive" }]` |
| second tab | badge "Another tab owns the database"; 120 issues, in memory, and saying so |
| round trip | 0.0142 ms/call over 2000 page↔worker round trips |

A control, worth recording because it is the failure this exists to prevent: while a second tab of
the same origin held the pool, a write made in the memory tab ("set priority to urgent") was
**absent** from the durable database after that tab reloaded into the pool. The badge said it would
be. That is the whole argument for carrying the tier to the header.

## 7. Stage 2 as built: the surface over a port

### The seam

`MeshLink` — a `WirePort`, a `role`, an `onLost`, a `close`. One half of the work finds it
(`navigator.locks`, a `SharedWorker` rendezvous, failover); the other half speaks over it
(`serveMesh` in the elected worker, `connectMesh` in every tab). Neither half can tell what the
other did, which is why both are testable alone: every test of the surface runs over a plain
`MessageChannel`, exactly as `driverTests` already certifies the SQLite wire with no browser.

### Two shapes, not one

`adapters/sqlite-wasm`'s protocol is strictly request/reply. This one is not, and it is the
difference that makes a second tab live: the host **speaks first**. A fold on the host's thread is
broadcast to every tab that subscribed, and each tab's live queries re-run on it — so a write in
tab A re-renders a `useLiveQuery` in tab B. Standing interests are refcounted at both ends: a tab
holds one host-side subscription per topic however many queries watch it, and the last interested
tab closing releases the host's own subscription on the mesh. `host.census()` reports clients,
standing interests, feeds and busy handles, and the test that a tab closing leaves nothing behind
asserts it goes to `{ 0, 0, 0, 0 }`.

### A handle is a turn, because a connection is a transaction

Drizzle's proxy is handed `(statement, params, method)` and told nothing about who asked. That is
what lets `db.transaction()` in a tab post `begin`, its statements and `commit` to the host and
open the *host's* capture — the event is signed by the origin's one identity and numbered in its
one log. It is also the hazard: `createProxy`'s own rule is "never fire statements at a handle from
a task running beside its transaction", and two tabs are exactly that task. `mesh.on` hands both
tabs the same `Handle`, so the host takes a **turn** on it for the whole of a tab's span — its
`BEGIN` through its `COMMIT`, or its `under`/`rehearse` through its close — and the other tab waits.
A tab that dies mid-span has its transaction rolled back and the handle handed on, rather than
wedging every other tab on that instance.

### Reading over the port, not mirroring

The open question was whether a follower should keep an in-memory mirror, as LiveStore does.
Measured (`bun run --cwd bench browser`), the same Drizzle query over the same database:

```
empty round trip over a MessageChannel: 0.0023 ms

| rows | in process | over the port | difference |
|    1 | 0.0111 ms  | 0.0129 ms     | +0.0018 ms |
|   10 | 0.0100 ms  | 0.0174 ms     | +0.0074 ms |
|  100 | 0.0249 ms  | 0.0596 ms     | +0.0347 ms |
| 1000 | 0.1940 ms  | 0.4220 ms     | +0.2281 ms |
```

A hundred-row list re-runs for **+0.035 ms**; the browser's page↔worker hop is dearer than bun's
in-process one (0.0142 ms against 0.0023 ms, §2), so call it +0.05 ms there. It does not scale per
row the way the objection assumes, because a statement and its whole result set are one round trip.
**No mirror**, then: what it would buy back is that 0.035 ms, and what it charges is a second
materialised copy of every table in every tab plus a second fold pipeline keeping it current —
which is the second engine over one log §4 rejects, arriving as a "cache".

### What a follower mesh does not have

`transports`, `routes`, `recovery`, `auth`, `accounts`, `blobs`, `presence`. Those are facts and
controls of **the device**, and a follower tab is not a device — it is one of several windows onto
one. A radio toggled in tab three is the origin's radio, and what that should mean is a product
question this work did not settle. What is there is what a *window* needs, and it is enough that
`@syncmesh/orpc`'s `meshApi` binds to it unchanged: the app's own api, in a tab that holds no
engine, is the acceptance test.

## 7. Stage 2: election, rendezvous and handover, measured

`@syncmesh/browser` — the packaging argument is in E04 — with a three-tab harness on
`http://localhost:5199/verify/`, Chrome. Each tab starts its own dedicated worker; the worker
contends for `syncmesh-mesh:/syncmesh` and serves an echo that names itself, so `host` below is
*which tab's worker* actually answered.

| step | measurement |
|---|---|
| three tabs open | roles `leader / follower / follower`; all three answered by `host: n59u6g` |
| the lock, then | `held: [{ name: "syncmesh-mesh:/syncmesh", mode: "exclusive", clientId: 44F8…1CB7 }]`, `pending: [73E4…8B61, 16C7…B130]` |
| leader's tab goes | survivors: `lost: 1`, `reconnects: 1`, roles `leader / follower`, both answered by `host: n3w079` |
| the lock, after | `held: [{ …, clientId: 73E4…8B61 }]`, `pending: [16C7…B130]` — the first waiter, and only it |
| the new leader's tab goes | last tab: `lost: 2`, `reconnects: 2`, `role: leader`, `host: pk3qyo`, `held: [16C7…B130]`, `pending: []` |
| no `SharedWorker` | `mode: "single-tab"`, `role: "none"`, `NoRendezvous: this browser has no SharedWorker…`; its worker is `pending` on the lock throughout |
| the durable tab goes | the named tab is promoted: `role: leader`, `host: mf8k9o`, `pending: []`, still `mode: "single-tab"` |

Three things that row of `clientId`s is evidence for, and they are the three ways this goes wrong:
**one** exclusive holder at every moment, never two; the **first** waiter promoted, not an arbitrary
one; and every follower re-plumbed to the same new host rather than left on a port whose worker is
gone — a lost link closes its `MessagePort` as it dies, so a dead port cannot be read from at all.

Nothing polls and nothing expires. The fast notice is the leaving tab's `pagehide`, the slow one is
the new leader announcing, and where the fast notice never comes — a crash, a kill — the slow one
still does, so a lost message costs latency and never correctness.

## 8. A private window has no OPFS, and Firefox and Chrome disagree about it

Found by running `apps/issues` in a Zen (Firefox) private window, where it would not start at all.
The reason it gave was the empty string.

### The behaviour

`navigator.storage.getDirectory()` **throws** in Firefox private browsing:

```
SecurityError: Security error when calling GetDirectory
```

That is by design and not a bug in Firefox. Private browsing has no profile directory to put an
origin private file system in, so the API is refused rather than emptied. Chrome disagrees:
incognito **does** get an OPFS, a real one, discarded when the last incognito window closes. So the
same code, the same origin and the same API give opposite answers in the two browsers, and only one
of them is the one a developer tests in first.

| | Chrome incognito | Firefox / Zen private |
|---|---|---|
| `navigator.storage.getDirectory` | present | present |
| `FileSystemFileHandle.prototype.createSyncAccessHandle` | present in a worker | present in a worker |
| calling `getDirectory()` | resolves; ephemeral OPFS | **throws `SecurityError`** |
| what the app could do before | ran durably | would not start |

Note the first two rows: **every capability probe says yes.** `threadHasSyncAccessHandles()` and
`originHasOpfs()` both pass in a Firefox private window, because both ask whether a method exists
and the method does exist. The refusal is a *permission*, and the only way to discover it is to
call and be told no. That is why this could not have been decided before attempting the open, and
why the classification has to happen where the `DOMException` still is.

The same `SecurityError` comes from two settings a person may not know are on:

- **Never Remember History** (Firefox Settings → Privacy) makes every window private, permanently.
  A developer with this set has no durable browser storage anywhere and no window that behaves
  differently to compare against.
- **Cookies and site data blocked** — the Custom cookie setting at *All cookies*, or a per-site
  block. Denying site storage denies OPFS with it.

### Why it presented as a syncmesh bug

Three layers each dropped the browser's sentence, and the screen ended in a bare colon:

1. `OpfsUnavailable` declared `message?: string`. The construction sites that had a `cause` in hand
   left the message unset, on the reasoning that the cause carried the words — so the error's own
   sentence was empty.
2. `apps/issues`'s `reasonOf` read `.message` and nothing else, so a wrapped error reported the
   wrapper's sentence and discarded the chain under it.
3. `sahPoolDatabase` built its result with `Result.map`, which turns a throwing callback into a
   `Panic` — untyped, and illegible by the time it crosses a port. It also left the pool's access
   handles and the Web Lock held, so the *next* attempt was told another tab owned the database,
   by the corpse of the first.

All three are fixed. `message` is required on `OpfsUnavailable`, `reasonOf` walks the cause chain
and falls back to the tag where a message is empty, and the pool's open runs under `Result.try`
with the lease released on failure. The lesson generalises past this incident: **a tagged error
with an optional message is an error that some screen will render as silence**, and the place that
knows the cause is never the place that prints it.

### The happy path

`OpfsDenied` is now its own tag, classified from the `DOMException` name where it is raised, beside
`OpfsPoolHeld` and for the same reason: a different remedy deserves a different tag. Contention
clears by waiting. Denial never clears, and there is nothing the app can do about it.

So **`"auto"` resolves a denial to `"memory"`**, and this is the existing rule rather than an
exception to it. `"auto"` has always meant "the best this context can have", and has always
answered `"memory"` where no thread could be durable. A browser refusing the origin a file system
answers the same question just as completely. Asking for `"opfs-sahpool"` *by name* still errors —
a caller who named a VFS was not asking what was available.

What keeps this from being the silent downgrade the rest of this document argues against is that
the driver reports `storage: "memory"`, and `apps/issues` already draws that tier in the header as
`Memory — not saved`, at critical severity. The app degrades, says so in the one place a person is
looking, and never claims a write survived. That badge's sentence was corrected here too: it named
a single cause — a browser with no synchronous file handles anywhere — which is a confident
diagnosis of the wrong thing in a private window, where the handles are present and the origin is
refused.

**For testing a second device, a private window was the wrong tool regardless.** Its log dies with
the window, so convergence cannot be observed across a restart and a second device that forgets
everything is not a second device. A separate browser profile (`about:profiles`) is the one that
works: isolated storage, its own device key, durable across restarts, and it dials the same relay.

# reflectdb — gap analysis against syncmesh-next

> Read 2026-08-24 against `TimMikeladze/reflectdb@0.1.3` (cloned to
> `internal/exisiting/reflectdb`) and `../syncmesh-next` at HEAD.
> syncmesh-next state that day: **332 pass / 1 skip / 0 fail**, 48 test files.
> reflectdb: **714 test cases**, 65 test files, 18.6k test LOC, 14.4k src LOC.

## What it is

A server-authoritative real-time sync engine for TypeScript. Per-row ops stamped with
HLCs, pushed through a server pipeline into *your* database (any ORM, raw SQL, or a
`Map`), broadcast back as diffs against a per-client cached result set. Offline-first
browser clients with optimistic writes. WS / SSE / long-polling. React, Svelte and
vanilla bindings. Drizzle-inferred row types. Two live demos on Fly.

It is not our competitor on architecture — it is our competitor on **finish**. Their
engine is smaller and less ambitious than ours; their *product* is further along in
every dimension that isn't the kernel.

## The structural difference — read this before copying anything

| | reflectdb | syncmesh |
|---|---|---|
| Authority | The server. Fully trusted by construction. | Nobody. Every receiver re-verifies sig → grant → policy. |
| Truth | Your database; clients hold a cache | The local log; the local commit **is** the truth |
| Conflict resolution runs | Once, on the server, against reflectdb's own mirror | On every device, fixed apply routine, no app code |
| Topology | star (client ⇄ server, optional Postgres-shared fleet) | mesh (relay is one peer with better uptime; BLE/Wi-Fi Aware next) |
| Reach | anywhere HTTP goes | anywhere *radio* goes, including no internet |

So: do **not** import their conflict callbacks, their `groupBy`, or their two-store
mirror. Their server-trust assumption is what buys them those, and giving it up is our
entire reason to exist. What *is* transferable is everything below the architecture
line — hardening, transports, versioning, packaging, telemetry, proof.

---

## A · Real gaps in ours, ranked

### A1 — The relay has no guards at all  ⚠️ highest severity

`syncmesh-next/server/relay.ts` (392 lines) accepts any socket, from any origin, into
any room, with any frame, at any rate, forever.

| Missing | reflectdb's answer | Failure it lets through |
|---|---|---|
| Origin allowlist | `isOriginAllowed(req, ["https://app.example"])` | `relay.ts:249` upgrades unconditionally — any web page can open a socket |
| Max frame bytes | `maxMessageBytes: 1_000_000` on all three transports | Bun's 16 MB default is the only ceiling; `blob-put` carries arbitrary base64 |
| Rate limiting | global + per-table + **always-on** ephemeral metering | Every `event` fans out to every socket in the room. Unmetered fan-out is an amplification vector — reflectdb documents this as exactly why they meter ephemeral *even without* a `rateLimit()` call |
| Connection cap | `maxConnectionsPerUser: 10` | none |
| Send-queue ceiling | `maxBufferedBytes: 8_000_000`, and the send **rejects** | `sendOrQueue` (`relay.ts:146`) pushes into an unbounded array. A stalled socket OOMs the relay. We traded a dropped frame for a dead process |
| Retention | `compaction({ clientInactivityTimeout, interval, minOpAge })`, ephemeral TTL + `maxEntries` | `room.events`, `room.ids`, `room.blobs` only grow; `rooms` never evicts an empty room; `stateOf(room)` folds the whole room into an `Engine` on first `desire` with no bound |

Their transport contract is also better *specified* than ours: **"`ServerTransport.send`
must reject when the frame did not reach the peer"**, with the reason spelled out — a
resolved send is treated as "this delta landed" and commits the client's cached result
set, so a transport that swallows failures makes the server believe a client holds rows
it never got. Our `sendOrQueue` has the right instinct (the comment cites the 100k-event
load rig) but resolves the tension by growing without limit.

### A2 — Nothing authorizes a `join`; confidentiality at the relay is zero

Any socket can `{t:"join", room:"<name>", cursors:{}}` and receive **the entire room
log** in catch-up pages. Grants are opaque store-and-forward — the relay never reads
one. Our threat model buys *integrity* (a compromised relay can drop but not forge) and
says nothing about *read access*.

reflectdb: `auth()` on every connection returning an `AuthContext`, `room("org/:orgId",
cb)` that fails closed, and an explicitly documented rule that a room key which only
*partially* matches a pattern is rejected rather than falling back to an unscoped
cross-room subscription.

This needs a decision written into RFC-0017, not left implicit. Either:
- a `verifyJoin(req, room)` hook on `startRelay` plus per-partition payload encryption, or
- an explicit statement that **a room name is a bearer secret** (TLS + unguessable names).

Right now it is neither, and the docs don't say which.

### A3 — No durability, no fleet

Rooms are in-memory. A relay restart is a new `epoch` (correctly invalidating visibility
tokens) and total data loss — survivable only because clients are full replicas, which
is worth stating out loud rather than leaving as an inference. Two relay processes share
nothing.

reflectdb: sqlite (`bun:sqlite`) or Postgres op log; HA active-active with a shared
Postgres plus `poll: 500`; clients reconnecting to a *different* instance resume from
their HLC watermark. Their idle poll tick costs one `MAX(hlc)` query and broadcasts
nothing, and it re-merges the shared clock watermark so a lagging instance stops
stamping below HLCs clients have already seen. That last detail is a nice one.

This is GUIDE's N4 "durable relay storage". reflectdb shows the shape it should take.

### A4 — One conflict policy, no escape hatch

We have field-level LWW and only field-level LWW (`src/core/kernel.ts`). No per-table
choice, no way to express a counter, a highest-bid-wins auction, an append-only list, or
a config table that should reject concurrent writes. `$conflicts` and
restore-as-new-event are parked at N4.

reflectdb: `conflict: "lww" | "merge" | "server" | { policy: "custom", resolve }` per
query. `merge` is our field-level LWW. `server` is first-write-wins. `custom` hands you
the incoming op, the existing row and its per-column clocks, and you throw to reject.

We cannot copy `custom` — D1 forbids running app code on receive, and that decision is
load-bearing for determinism, version skew and the Swift/Rust ports. **The right answer
for us is declarative merge strategies in the schema** — `t.counter()`, `t.max()`,
`t.min()`, `t.set()` — registers whose merge a *fixed* apply routine can execute on
every device without app code. That's an RFC worth writing; it closes the biggest
capability gap without touching D1.

### A5 — No protocol/schema version negotiation on the wire

Events carry `v: 1` (`src/core/types.ts:15`). The wire handshake does not: `join` has no
version field, the relay's `hello` announces only `keepalive` and `epoch`, and there is
no floor and no typed close reason for a mismatch.

reflectdb: exported `PROTOCOL_VERSION`, `hello` → `hello_ack {protocol, serverId}`,
`server.minSchemaVersion(n)`, and a `schema_outdated` error reason.

RFC-0013 exists on paper. For a system whose whole pitch is byte-frozen conformance
vectors that Swift and Rust ports must reproduce, a missing version handshake is a real
hole — and adding it later is a breaking change to the thing we promised was frozen. Do
it now, with its own conformance vector.

### A6 — Transport monoculture

We ship `relay(url, room)` over WebSocket, plus a framed-link port with BLE pending.
That's it. reflectdb ships three, each as framework-agnostic handler functions you wire
to your own routes:

- **WS** — `handleOpen/handleMessage/handleClose/handlePong`
- **SSE** — `GET /sync/events/:id` + `POST /sync/messages/:id`, with a `Last-Event-ID` replay window (`replayBufferSize: 256`)
- **long-polling** — three endpoints, "works anywhere HTTP does"

Corporate proxies that strip upgrades kill us dead with no fallback. Our framed-link
port (M19: a radio is `send(frame)` + `onFrame(cb)`) makes SSE or polling cheap to add —
so either add one, or write down that WS-only on the web is intentional.

### A7 — No telemetry seam

`grep -rniE 'onEvent|telemetry|metric|observab' src/ server/` returns nothing. We have
`engine.onError` and `engine.onFoldBatch`.

reflectdb: `createSyncServer({ onEvent: (event) => … })` for lifecycle telemetry, with
named events (`ephemeral_rate_limited` is one). GUIDE parks "feed the inspector from
next's telemetry" at N4 — but there is no seam to feed it *from*. A small named-event
union threaded through `startRelay` and `createClient` is cheap today and a
touch-every-call-site retrofit later.

### A8 — Packaging is not a product yet

`syncmesh-next/package.json`: `private: true`, name `syncmesh-next`, version `0.0.1`, no
`exports` map, no build, no lint, no format, no `engines`, ESM only. API.md admits real
code imports `../src/schema/column`.

reflectdb: conditional `exports` for **15 subpaths**, dual ESM + CJS via `bunup`, all
peer deps optional with `peerDependenciesMeta`, `files: ["dist"]`, `engines: node
>=22.3`, `oxlint` + `oxfmt`, `bumpp` release, and — the part to steal outright — three
verify scripts:

- **`scripts/verify-exports.ts`** — cross-checks the hand-maintained exports map against
  actual `dist/` output. Its header names the exact failure: *"every subpath import
  fails for consumers while type-check, lint, and tests all still pass, so the breakage
  only surfaces after publish."*
- **`scripts/verify-node-consumer.ts`** — packs the tarball, installs it into a
  throwaway Node project, imports every subpath by package name. Its header lists four
  packaging regressions they actually shipped: a top-level `bun:sqlite` import that made
  `reflectdb/server` unloadable on Node, a `bun:sqlite` type reference in the emitted
  `.d.ts`, a `Buffer` in an exported signature, an entry point built but never listed in
  `exports`.
- **`verify-jsx.ts`**, **`verify-presence.ts`**.

That second one is aimed straight at us. We import `bun:sqlite`
(`src/storage/bun-sqlite-store.ts`) and `@sqlite.org/sqlite-wasm`
(`src/storage/opfs-sqlite-store.ts`). The moment N3 adds an exports map, a Node consumer
importing `syncmesh/client` walks into precisely the trap that comment describes. Their
mitigation is worth copying too: `createSqliteStorage` resolves `bun:sqlite` **lazily**,
so importing `reflectdb/server` on Node is fine and only *calling* it there throws.

### A9 — No CI

`syncmesh-next` has no `.github` directory. 332 tests that nothing runs on push. (The
old repo has a 4-line typecheck+test workflow; next has none.)

reflectdb: CI on `ubuntu-latest` × `macos-latest` running build → `verify:exports` →
type-check → lint → test, **plus** a `node-consumer` job across Node 22 and 24, **plus**
demos that deploy only from a green main (`workflow_run` gated on `conclusion ==
'success'`, with the reason in a comment: *"a broken build should never reach
reflectdb-tetris.fly.dev, which the README and the landing page both link to"*).

This is the cheapest item on the list and the most embarrassing to be missing.

### A10 — No running proof

reflectdb has two deployed demos linked from the README — infinite multiplayer Tetris
and a collaborative whiteboard with a Pictionary mode — auto-deployed from green main,
each with a table mapping every pattern to the file that implements it. Plus a landing
page with OG social cards.

We have `rfcs/index.html` and a vite demo that isn't deployed. The two-phone BLE demo
lives in the *other* repo on the *legacy* engine. For a mesh database, "open two tabs"
— or better, "put two phones in airplane mode" — is the entire pitch, and we can't hand
anyone a link.

### A11 — The server-side toolkit is one function

We have `attachAuthority(engine, handlers)`, `setPolicy`, `mountRest`. reflectdb has:

`tx` (transaction + one `notifyChange` per touched table, on success only) · `lock` /
`tryLock` (per-key serialization; `tryLock` returns `null` instead of queueing) ·
`interval` / `timeout` (a throw inside is logged not fatal, cleared by `close()`, and
**disposed on `bun --hot` reload** so an edit-save loop doesn't leave orphaned timers
ticking against the same rows) · `emit` · `applyServerOp` · `notifyChange` ·
`reserveOpId` · `runCompaction` · `minSchemaVersion` · `rateLimit` · `compaction` ·
`close`.

Anything clock-driven — a round timer, an expiring claim, a scheduled rotation — we
write from scratch, and the orphaned-timer problem they solved is one we hit the first
time a demo has a timer.

Note that our `attachAuthority`'s `inFlight` Set *is* their `lock` primitive,
un-generalized — see B1.

### A12 — `mountRest` maps handlers; theirs generates CRUD

`server.rest({ prefix: "/api" })` derives the full surface from the schema —
`GET/POST /api/<table>`, `GET/PATCH/DELETE /api/<table>/:id`, `?where=&limit=&offset=`
— routed through the identical pipeline as sync writes, broadcasting deltas. Ours needs
a handler written per operation. For "let a cron job or a webhook write a row", they
have zero-config and we have a chore.

### A13 — React only

reflectdb: `createSyncReact(queries)` / `createSyncSvelte(queries)` /
`createSyncVanilla(queries)` — each returning a *typed* hook/store/callback set derived
from the schema. Not urgent for us, but their typed-factory pattern is a nicer answer to
the inference problem than our `useLiveQuery(fn, deps)` + `[table]` deps array. (Ours
has a real excuse — Hermes returns `[native code]` for `fn.toString()` — theirs doesn't
run on Hermes.)

---

## B · Defects found in ours while reading

### B1 — `attachAuthority`: `inFlight` is never cleared

`src/authority/authority.ts:45,68,69` — `inFlight.add(key)` with no corresponding
`delete` anywhere.

- It grows one string per request, forever, in a long-running authority.
- Worse: `settle()` calls `res.unwrap(...)`, which **throws** if the mutate is denied.
  That throw escapes an `async process()` invoked as `void process()` — an unhandled
  rejection — and the key stays in `inFlight`. The request is then stuck `pending`
  forever with no retry path in that process, because line 68 skips it on every
  subsequent fold batch.

The comment's intent (once-execution within a process, durable guard is `status !==
"pending"`) is right; the implementation makes a settle failure permanent. Fix: delete
the key in a `finally` after settle succeeds, or track `{key → attempts}` and allow a
bounded retry.

---

## C · Where we are clearly better — do not lose these

1. **Trustless by construction.** Signed events plus the same policy AST evaluated at
   the call site, on the local write path, and on *every receiving peer*. A compromised
   relay drops traffic; it cannot forge. reflectdb's server is trusted absolutely.
2. **Runtime schema validation.** Their `t<MyRow>()` is a compile-time phantom that
   erases — they document that a client can send `{ title: 12345 }` or extra keys and it
   reaches your `mutate` untouched, and that you must bring zod yourself. We reject at
   admission with `InvalidColumnValue` / `UnknownColumn` / `MissingColumn` /
   `ImmutableColumn`, and `t.uuid()` *refuses* non-canonical input rather than
   normalizing it. Say this out loud in our README; it's a genuine differentiator.
3. **Policy as synced data.** `_policy` as a reserved table means a permission change
   deploys by sync, not by app release. Their `auth`/`room`/`authorize` are server
   callbacks — a redeploy.
4. **Ambient partitions.** Generated `setOrg`/`setWorkspace` make a cross-tenant write
   *inexpressible*. reflectdb passes `params: { orgId }` per `sync()` call and has to
   warn that a wrong `groupBy` key "leaks rows across the boundary" — a footgun the
   ambient design structurally doesn't have.
5. **Offline is the default, not a mode.** No optimistic overlay to reconcile; the local
   commit is the truth.
6. **Errors as typed values.** `Result` everywhere vs. throw-`MutationError`-or-be-
   reported-as-`server_error`.
7. **Frozen conformance vectors** for cross-language ports. They're TS-only JSON.
8. **Keyset windows only** — offset pagination banned as unstable under live edits.
   Their REST exposes `?offset=`, and without a `count` + `ctx.limit` implementation
   their server "fetches every matching row on every broadcast and slices in JS."
9. **Fold cost is O(changes)**, not O(subscribers × query cost) — see D6.

---

## D · Their weaknesses — don't copy, and useful framing against them

1. **Two stores, one sync.** Conflict resolution reads reflectdb's *own* JSONB mirror,
   not your database, and the mirror commit and your `mutate` are **separate commits**.
   They document it honestly: a crash between the two leaves your DB ahead of the
   mirror; if `mutate` transforms the payload, or a DB default/trigger rewrites it, or
   anything writes out of band, the mirror drifts from what clients see. We have one
   log, so there is nothing to drift.
2. **Both eager broadcast modes skip conflict resolution entirely.** Their recommended
   low-latency mode (`eager-durable`) silently ignores the table's declared `conflict`
   policy and lands last-writer-wins. A declared policy that doesn't hold in the
   recommended mode is a design smell.
3. **Client-side `merge` isn't per-column causality.** Their own words: a diff-driven
   broadcast can't attribute a column to the op that produced it, so every column
   changed in one broadcast carries that broadcast's HLC. `merge` is a server-side-only
   guarantee.
4. **Presence is keyed by connection, not account** — two tabs from one login are two
   peers with two cursors, and display identity must be hand-carried in `state`.
5. **The rate limiter is fail-open** — limiter errors mean ops still flow. Defensible,
   the opposite of our instinct; worth a conscious choice on our side rather than an
   accident.
6. **N query executions per write.** Subscriber groups default to `(auth, params,
   roomKey)`, so with per-user auth that's one full query re-execution *per connected
   client per write*. `groupBy` is the opt-out, it's manual, and getting the key wrong
   leaks rows across a tenant boundary.
7. **`window` is an entitlement, not a row count.** A subscriber with `window: 50` whose
   query matched 3 rows still receives the next 47 inserts, and `loadMore(20)` widens by
   20 regardless. They had to document this at length — a sign the abstraction leaks.
8. **82 KB README in one file.** The *content* is excellent; the packaging isn't. Our
   `rfcs/` split is the better container. Copy their density, not their layout.

---

## E · Standards to adopt — concrete, ordered

| # | Task | Size |
|---|---|---|
| 1 | `.github/workflows/ci.yml` in syncmesh-next: typecheck + `bun test tests` on push/PR, ubuntu + macos | 20 min |
| 2 | Relay hardening, one PR per row of A1, each with a test: origin allowlist option · `maxFrameBytes` · per-socket token bucket on `event`/`blob-put`/`desire` · backlog ceiling that **closes** the socket instead of growing · room eviction at `sockets.size === 0` · retention cap on `room.events` and `room.blobs` | 1–2 days |
| 3 | Fix B1 (`inFlight` leak + permanently-stuck request), with a regression test | 1 hour |
| 4 | Decide and write the relay's confidentiality posture into RFC-0017: `verifyJoin` hook + per-partition payload encryption, **or** "a room name is a bearer secret" stated explicitly | ½ day + impl |
| 5 | Wire version negotiation: `join` carries `v`, `hello` replies with `v` + a floor, mismatch closes with a typed reason; add a conformance vector | ½ day |
| 6 | Add the telemetry seam now — `startRelay(port, { onEvent })` and `createClient({ onEvent })` over a small named-event union | ½ day |
| 7 | RFC: declarative merge strategies (`t.counter/max/min/set`) — our D1-preserving answer to `conflict: custom` | 1 day writing |
| 8 | Port the three verify scripts **before** N3 packaging: exports-vs-dist, Node-consumer tarball install, bun-only-import guard. Make `bun:sqlite` resolution lazy the way they do | 1 day |
| 9 | Deploy one demo from green main and link it in the README. Browser demo + relay on Fly is the cheap version; two phones in airplane mode is the one that sells | 1 day |
| 10 | Add SSE or long-polling as a second web transport over the framed-link port — or write down that WS-only is intentional | 1 day / 10 min |
| 11 | Adopt their documentation standard: every subsystem gets a short "details worth knowing" block naming the footgun and the failure it causes. Our RFCs argue *design*; their docs tell you what will *bite* you. Both are needed | ongoing |

Items 1, 3 and 11 cost almost nothing and close the widest credibility gap.

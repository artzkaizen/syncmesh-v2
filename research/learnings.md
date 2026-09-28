# Session learnings — 2026-08-24

> What was decided, corrected, and discovered in one working session. Written so
> none of it has to be rediscovered. Companions: `internal-gap-analysis.md`,
> `implementation-notes.md`, `tanstack-db-validation.md`, `competitor-reflectdb.md`,
> and `syncmesh-next/API.md`.

---

## 1 · The API principle that drove everything

**One object owns the engine; everything else is configuration.**

The old surface had **fifteen** construction idioms — `new Engine`,
`createClient`, `startRelay(port, opts)`, `attachAuthority(engine, handlers)`,
`setPolicy(engine, …)`, `mountRest({engine, …})`, `new RelayTransport(engine, …)`,
`relay(url, room)`, `bridgeFramedLink(engine, link, …)`, `new Link(a, b)`,
`Store.open(path)`, `new MemoryEventStore()`, `ivmQuery(engine, …)`,
`bindApi(engine, router)`, `sm.meta().input().handler()`.

**Six of them took `engine` as a leading argument.** That is the diagnostic: the
engine was passed around because nothing owned it. Whenever a free function needs
the core object handed to it, the core object has no home.

Now: `new Syncmesh({ identity, account, collections, store, transports })`,
`mesh.collections.*`, `mesh.tx()`, `mesh.ops.*`, `mesh.blobs`, `mesh.visibility`.

### Corollary — stringly-typed anything is a smell

`engine.mutate("task.reassign", tx => …)` took a **provenance label** — stamped on
the event, never executed — as positional argument #1, where it read like a route.
Collection writes now derive their own label (`books.insert`); `tx()` derives one
from what was written (`audit.insert+books.update`); an override is *named*
metadata, never positional.

---

## 2 · Where the handler boundary actually is

This took four wrong answers to get right. The final rule:

> **A handler's world is `input` and `context`. Nothing else.**
>
> ```ts
> { input, context, account, requestId, errors }
> ```

The wrong answers, and why each failed:

1. **`db.books.find(id)`** — invented API. Real apps use Drizzle
   (`db.select().from(books).where(eq(books.id, id))`), Kysely
   (`db.selectFrom("books")…`), or Prisma (`prisma.book.findUnique({where:{id}})`).
   Never write a data-access call that is not one of those.
2. **`tx.update("books", id, …)`** — reintroduced the magic string one turn after
   killing it, and made reads and writes use *different objects for the same table*.
3. **`collections.books.update(…)` in a handler** — if an op only writes a
   collection, **the op should not exist**: the client can do that itself, offline,
   with no round trip. Giving handlers write access invites exactly that mistake.
4. **`collections.cartLines.rows()` in a handler** — the fatal one. The server
   *does* eventually hold synced data (the authority is a peer), but:
   - the request row lives in the caller's `user` partition and the data may live
     in `org:…` — **different engines over different stores under `storeFor`**, so
     there is no ordering relationship between them;
   - the authority may not hold that partition at all;
   - and if it can read the cart, the client could have run the check locally.

   `input` is the **only** thing guaranteed present when a handler runs: it is
   inside the request row, signed with it, arriving atomically with it.

**Trust boundary this produces:** the client sends **intent**, the server owns
**value**. The cart lines are input; the prices are never in the input, so a
hostile client cannot name its own.

**Where reading synced data IS fine:** outside a handler — a sweep, a reconciler,
the server acting as an ordinary peer with nothing waiting on it. The distinction
is whether something is blocked on you with an expectation about what has arrived.

---

## 3 · Errors — Result, and why we do not throw

oRPC resolves throw-vs-value with `safe()`: handlers `throw errors.NOT_FOUND()`,
callers opt into a tuple. We take the ergonomics and reject the mechanism.

The distinction is **who the failure is for**:

- a **declared outcome** (`NOT_FOUND`) is in the contract, has a status, travels
  to the client, and the caller is expected to handle it → **a value**;
- a **defect** (a `TypeError`, a driver exploding) is undeclared and unhandleable
  → **throws**, and the boundary contains it as `INTERNAL`, logged server-side only.

`throw errors.NOT_FOUND()` expresses a declared outcome with the defect mechanism.
So handlers **return**:

```ts
if (!book) return errors.NOT_FOUND()          // errors.X() IS an Err
return { archivedAt: Date.now() }              // a bare value auto-wraps as Ok
```

One keyword different from the throwing version, no second error model.

### The friction, honestly

1. **No `?` operator** — multi-step fallible logic is guard blocks.
2. **A floating Result is silent.** An unhandled rejection at least logs; a
   dropped Result does nothing, ever. **Needs a `no-floating-results` lint rule
   before this ships.** Sharpest cost on the list.
3. Double unwrap (`await` then `isErr()`).
4. Fat unions — declared errors *plus* `WriteDenied`, `NoActivePartition`, timeout.
5. Exhaustive switches break on every added error (a feature and a chore).
6. Third-party libs throw, so handler bodies mix models anyway.
7. `.unwrap()` is the lazy path and reintroduces throws in the worst place.
8. Stacks are fine — our `TaggedError`s carry them.

**Mitigations chosen:** split `RequestTimeout` out of the error union (it means
*still pending*, not failed, and every call site got it wrong), auto-wrap bare
returns, add the lint rule.

---

## 4 · Schema evolution — upcasters are dead

LiveStore's answer, read from their docs:

- **State schema changes need "no further consideration"** — state is derived, so
  migration = drop it and re-fold the eventlog (`auto` "rematerializes the state
  from the eventlog").
- **Event changes are additive by rule**, versioned in the *name* (`todoCreated-v1`):
  never remove a definition, add only optional/defaulted fields, old data must
  decode under the new schema. No upcasters, no chain, no registry.
- **Unknown events are a config knob**: `unknownEventHandling: 'warn' | 'ignore' |
  'fail' | 'callback'`, default warn.

**Rule 1 does not transfer.** Their events carry *intent* plus a materializer;
ours carry *captured changes* applied by a fixed routine (D1). We cannot re-derive.

**Rules 2 and 3 transfer completely and kill upcasters:**

- additive-only, enforced as a rule — our codec already ignores unknown keys;
- **a rename becomes an add**: keep `owner` readable, add `assignee`, read
  `assignee ?? owner`. One line at a read site instead of a versioned chain you
  maintain forever;
- `unknownHandling` as config, replacing today's hard-coded drop-as-malformed —
  which is *worse* than LiveStore's default, because MAX cursors then hide the
  hole forever.

The user's instinct was right: a migration system the user maintains is the wrong
price. Delete the `version` + `upcasters` block from `implementation-notes.md` §4b.

---

## 5 · Define tables once — `fromDrizzle` **[built]**

`src/schema/from-drizzle.ts` + `tests/from-drizzle.test.ts` (11 tests). Row types
come from Drizzle's own inference, so they cannot drift from what your queries
return; only `timestamp` is overridden (Drizzle hands back a `Date`, the wire
carries epoch ms).

### The bug this nearly shipped

The mapping was first keyed off Drizzle's `columnType`. A test then failed **one
way under `bun test` and another under `bun run`** — one copy on disk,
`drizzle-orm@1.0.0-rc.4`. **Conditional exports resolve different builds**: the
same `blob("x")` reports `SQLiteBlobBuffer` in one and `SQLiteBlobJson` in the
other, and `dataType` went from `"string"` to `"string uuid"`.

RFC-0013 calls this mapping *"a frozen artifact — it determines wire bytes."* A
frozen artifact resting on a string that changes with a bundler condition is a
live wire-corruption bug.

**Keyed off the semantic `dataType` instead, read as base + qualifier:**

| `dataType` | → | why |
|---|---|---|
| `"string uuid"` | `uuid` | |
| `"string date"` | `text` | an ISO **string** |
| `"object date"` | `timestamp` | a real `Date` |
| `"object buffer"` | `blob` | |
| `"object json"` | `json` | |
| `"number int53"` | `integer` | float only for Real/Double/Numeric |

`"string date"` vs `"object date"` is the sharp edge — read the qualifier alone
and every ISO date string silently becomes a timestamp.

**General lesson: never key a wire-affecting decision off a third-party string
that is not part of that library's public contract.**

### Pinned to Drizzle 1.0 RC

Every workspace pins `drizzle-orm@1.0.0-rc.4` through the root catalog; peers
ask for `^1.0.0-rc.4`. Nothing in the repo needs `drizzle-kit`, `drizzle-zod` or
`drizzle-valibot` (1.0 folds the validators into `drizzle-orm/zod` etc.). What
1.0 changed underneath us:

- `dataType` became `"<type> <constraint>"`; `fromDrizzle` reads the 0.45 base
  back out of it, so no kind moved. pg-core's own `bytea` is `"object buffer"`
  → `blob`.
- A Postgres array is the element's `dataType` plus `dimensions > 0` —
  `integer().array()` reports `"number int32"` / `PgInteger`. Refused explicitly;
  read naively it imports as an integer.
- SQLite `blob()` without a mode is JSON now (was a buffer). The mapping follows
  what Drizzle stores; an app that meant bytes writes `blob({ mode: "buffer" })`.
- pg-core types every built column `isPrimaryKey: false`, so a Postgres table's
  key is only known at runtime. `fromDrizzle` types its `primaryKey` as the
  union of the non-null columns there (SQLite keeps the exact key).
- `pg-proxy` lost its transaction class; the mesh's Postgres face declares its
  own over `PgAsyncTransaction`. Handles are typed with `EmptyRelations`: the
  relational API (`db.query`, RQB v2) needs `defineRelations`, which the mesh
  does not take yet.

---

## 6 · Change data capture — RFC-0021 **[written]**

Zero's seam is two types: `startStream(afterWatermark) → { changes, acks }`.
Their stream is transaction-framed (`begin → insert|update|delete → commit`),
**which is already our event boundary** — a Postgres transaction becomes one
SyncMesh event. Closest model fit we have found to anyone else's.

**Direction is fixed and that is the design:** DB → mesh only, CDC-backed
collections are read-only on devices, and writes go the other way as ops. Each
direction has one mechanism, so there is no mirror and no drift.

Cost stated plainly: **a CDC-backed table is not offline-writable.** Correct
trade — the database is authoritative, so an offline write against it is a promise
we cannot keep.

---

## 7 · Defects found in our own code

| Where | What |
|---|---|
| `src/core/engine.ts` `revert()` | Built its compensating event with **no partition**, so undo failed validation whenever partitions were in use — broken, not merely disabled. **Fixed**: the undo log captures the original event's partition. |
| `src/core/engine.ts:211` | `undoDepth` defaults to 0, so `revert()` cannot succeed unless set; `createClient` never forwarded it. **Fixed.** |
| `src/client/transports.ts` | `putBlob`/`fetchBlob` live on `RelayTransport`, but the handle `relay()` returns exposed only `stop/onStatus/token/visibleAt` — **blobs were unreachable from the supported entry point.** **Fixed** via `mesh.blobs`. |
| `src/authority/authority.ts` | `inFlight` never cleared: leaked a string per request, and a settle failure stranded the request `pending` forever. **Fixed** — the guard now covers execution only (released in `finally`); a succeeded-but-unsettled outcome is held so the retry re-runs the WRITE, never the handler; attempts are capped at 5 and the failure is logged loudly. `tests/authority-settle.test.ts`. |
| `src/client/client.ts` + `src/policy/validate.ts` | **Schema validation was switched on by grants** — no grants meant no column checking, and `1.5` went into an integer column. **Fixed** — `createValidator`'s `grantFor` is now nullable: `null` is *ungranted mode* (grant/policy checks skipped, schema checks unconditional), a function is granted mode (unchanged). The client always builds a validator. `tests/validation-without-grants.test.ts`. |
| `src/syncmesh.ts` | `_policy` / `_requests` leaked into `mesh.collections`. **Fixed** — moved to `mesh.internal`. |
| `src/syncmesh.ts` | `rows()` returned `{key,row}` while `byId()` returned the row. The key is always `row[primaryKey]` — an internal detail on the app surface. **Fixed.** |
| grants | `partitions: ["acme"]` takes **bare instance ids** while events carry `"org:acme"`. Cost a debugging cycle; documented, not fixed. |

---

## 7b · Conflict resolution — decided

**Built:** per-column declarative strategies, `merge: { peak: "max" | "min" | "lww" }`
in `defineSync`, wired into the kernel (`beats()` in `src/core/kernel.ts`).
`tests/merge-strategies.test.ts` — property tests over random delivery orders, plus a
three-peer triangle. Conformance vectors byte-identical, because no declared strategy
means `lww` exactly as before.

**Rejected: a custom resolver callback.** Not on taste — on cost:

- A merge function runs on **every device**, so it must be pure, and purity is
  unverifiable. Impurity splits into *varies between two calls here* (`Date.now()`,
  catchable by a double-run) and *stable here, different elsewhere*
  (`navigator.language`, a helper differing between app versions) — **the second class
  is undetectable locally, because the other device is not here.**
- It fails **silently**: both peers accept, both compute, neither notices.
- The only backstop is cross-peer state digests, which report *that* you diverged and
  not why, need the peers to meet, and are ambiguous in a mixed-version fleet
  (RFC-0013 G18).
- `fn.toString()` is `"[native code]"` on Hermes, so any static check must be a
  build-time lint — a denylist, therefore holey.

**The principle that settles it: a string is data.** It can sync like `_policy`, so every
peer provably runs the same rule and there is nothing to verify. A function can never be
made verifiable, only watched. That is why the declarative tier is primary rather than a
fallback.

**`"manual"` was also dropped**, and the conflict-record store with it. A losing write is
gone from *state* but still in the *log*, so `collections.x.history(key)` answers "what did
this overwrite?" over data we already keep — more general than a store of losers, no
declaration needed, nothing until asked. And choose-one-side is the wrong answer for the
case that motivated it: collaborative prose wants a text CRDT, not a chooser. **Built:**
`src/core/history.ts`, `tests/history.test.ts`. This strikes `$conflicts` + `restore()`
from RFC-0014's remaining work; what stays there is corrective events and state digests —
correctness, not UI.

Escape hatch when a string will not do: an authority-decided op (§13).

**Found while building it:** `_partition` — the signed row-stamp (M6) — was leaking into
every row the app read, from `byId`, `rows()` and live queries. Not a declared column, so
the row type was lying, and a row spread into a later write would carry a stale stamp.
**Fixed** with `publicRow()` at every app-facing boundary; the live-query paths already
spread, so it costs nothing there.

**Corollary — why `.check()` schemas survive the same argument.** A check schema is also
a function running on every peer, but a disagreement produces a **visible typed
quarantine**, not silent state drift. Announced divergence is a different risk class from
unannounced divergence.

**Rename done:** `peak: t.float().onConflict("max")`. The rule applies to one column and
lives beside it. Constrained by the VALUE type rather than the kind —
`StrategyFor<T> = [T] extends [number | null] ? "lww"|"max"|"min" : "lww"` — so
`t.text().onConflict("max")` is a compile error and no kind parameter had to be threaded
through `Column`'s generics. Table-level `merge` survives only for `fromDrizzle`-imported
tables; declaring both for one column throws rather than establishing a precedence rule.

## 7c · `t.json(schema)` and `.check()` — built

`case "json": return true` accepted anything: `t.json<{tags: string[]}>()` was a phantom
that erased, **the same hole we criticised in reflectdb's `t<Row>()`**, in the one kind
with no floor of its own. Worse for us than for them: their server is trusted and the
developer writes `mutate`; our events arrive signed by other people's devices and are
folded by a fixed routine with nowhere to hook validation.

Now: `t.json(schema)` infers the type from the schema, and `.check(schema)` works on any
kind. Standard Schema declared **structurally**, so zod/valibot/arktype all work with zero
dependencies. Kind check runs first; `.nullable()` still owns `null`; async validators
fail loudly on every write rather than being skipped, because the fold is synchronous.
`tests/column-check.test.ts`.

## 7d · Divergence and corrections — RFC-0014 rung 5 and section 3, both built

**State digests** — `src/core/digest.ts`, `tests/digest.test.ts`.
`engine.digest()` / `rowDigests()` / `divergentTables()` / `divergentRows()` /
`rowRecords()` / `repairRows()`.

Cursors prove two peers **have** the same events; nothing proved they **computed** the
same state, which is the gap an impure merge, a version skew or a torn write falls
through. One string per table on catch-up; matching costs nothing more; on mismatch,
drill to per-row hashes and exchange only what differs.

**Repair is the ordinary merge.** `repairRows` runs the same `mergeRecord` a snapshot
install uses, so a stale row loses to the higher stamp and genuine concurrency resolves
as it would have. Both sides do it to each other and converge — no special repair
semantics to get wrong. It adopts **no cursors**: the events were never in question, only
the state computed from them.

**RFC-0014's open question answered: sum, not XOR.** Both are order-free (required —
peers fold in radio-delivery order). XOR is self-cancelling: any two rows hashing alike
erase each other, so a paired corruption is invisible. Addition mod 2^64 has no such
pair. Pinned by a test asserting that duplicating a row changes the digest — precisely
what XOR would miss.

Implementation detail worth keeping: an absent table and an empty one must report
identically, or two peers "diverge" over a table nobody ever used.

**Still scoped, not universal:** a digest covers the rows a peer HOLDS, so peers with
different interests (RFC-0019) differ legitimately. Compare within one scope. Open: should
the digest carry its interest so a cross-scope mismatch dismisses itself?

---

**Corrective events** — `src/authority/corrections.ts`, `tests/corrections.test.ts`.

The insight that only landed while building it: **the authority cannot reject.** An
unreachable peer would keep the provisional value with nothing ever contradicting it, and
there is deliberately no client rollback machinery (receivers check grants and claims,
never local mutable state — RFC-0008). So a rejection **is** an authoritative overwrite:
fresh higher stamp, LWW does the rest.

What makes it a *correction* rather than an anonymous overwrite is that the reason rides
in the **same event** — one signed thing saying both "the value is now X" and "because Y,
and it was Z's write I overrode". A test asserts `eventCount` rises by exactly one.

`_corrections` is **deny-all**; only the authority bypass admits a write. A forged one is
denied at its own author *and* never applies at a peer (both tested) — otherwise it would
be a way to blame someone else for your own write.

Client surface: `mesh.corrections.{all,mine,forEvent}`.

**Two things fixed on the way:**

- **`*any*` partition kind was overloaded.** It carried a "key must equal the partition"
  rule that is specific to `_policy` (so a hacked authority cannot plant policy for a
  partition it does not govern). `_corrections` keys by the corrected *event id*, so that
  check is now scoped to the policy table by name.
- **`_corrections` leaked into `mesh.collections`** — caught by the existing test pinning
  the app namespace. Moved to `mesh.internal`, third time that test has earned its keep.

**Honest remaining gap:** divergence detection is *available*, not *automatic*. Nothing
piggybacks a digest onto the final catch-up frame yet, and nothing pushes `event-rejected`
at an author — a correction carries the reason as data, but the author has to look.

## 7e · `tx` — what it is actually for, and two non-uses

**On the author's device `tx` changes nothing.** Both writes apply instantly and
durably; there is no network in the write path. Its entire purpose is what OTHER peers
may observe: two writes are two events, two events replicate independently, and a peer
can hold the first without the second — briefly if in flight, **permanently** if the
second is denied by policy there or dropped by a radio.

The test for whether you need it: *can a peer that sees only the first change do
something harmful?* Transfer (money vanishes), move-between-lists (in both or neither),
claim handoff (a gap where nobody owns it), swap. If the worst case is "a number is
briefly stale", you do not need it.

**Two things that look like they need `tx` and do not:**

- **An audit row.** The event log already IS an append-only signed record of who changed
  what and when — that is what `history()` reads. A parallel audit table duplicates it
  into a synced table that can be denied by policy or compacted on a different schedule
  than the thing it audits. *(I used this as the headline example in three places before
  noticing. It is not a use case; it is an argument against having an audit table.)*
- **A denormalised counter.** That exists in server-backed apps because counting is a
  round trip. Here the rows are local — `rows().filter(...).length` is free and a live
  query re-emits it. Denormalise only when you do NOT hold the rows (a scoped join) or
  the count is genuinely large.

Net: `tx` is a rare escape hatch, and documenting it as a headline feature oversold it.

## 7f · Server-side storage and the durable relay — built (by a background agent)

**Shipped:** `drizzleStateStore(db, { tables, schema })`; `RelayRoom` extracted from
`Bun.serve` into `src/relay/room.ts` with `server/relay.ts` a ~90-line host;
`startRelay(port, { store?, dataDir?, fanout?, keepaliveMs? })` durable by default at
`.syncmesh/relay/<room>.db`; `Fanout` port with `memoryFanout()` and
`redisFanout({ client })`; `doSqliteDriver(ctx.storage.sql)`. 437 pass / 1 skip / 0 fail.
Conformance vectors byte-identical.

**The finding that matters:** the `StateStore` port is synchronous — `Engine`'s constructor
reads `isEmpty/loadAll/loadCursors` synchronously — and **every Postgres Drizzle driver is
async**. So `drizzleStateStore` works today over `bun:sqlite` / `better-sqlite3`, and the
"rows into your Postgres" promise in API.md §13.2 is **not deliverable without an async
state port**. Same wall for Rivet: it reaches SQLite through Drizzle, async, so the sync
`SqliteDriver` port cannot host a `RelayRoom` there. Both are now §25. Do not promise
Postgres until that port exists.

Decisions worth keeping:
- App tables cannot hold stamps and boot needs them, so `drizzleStateStore` keeps a sidecar
  `_syncmesh_state(tbl, key, rec)` (column is `tbl` — `TABLE` is reserved in both
  dialects) plus `_syncmesh_cursors`. Rows of tables not in `tables` (`_policy`, local)
  go to the sidecar only.
- Relay `epoch` persists in the store's snapshot slot (the relay never folds into an
  Engine, so the slot is free) — a visibility token issued before a restart keeps its
  meaning.
- The old host silently let a second `join` switch rooms while leaking the socket in the
  first; now the first `join` binds the socket and a re-join stays put.
- The relay re-encodes decoded events on catch-up — one `sigOf` per event, and a full
  `store.all()` at construction to seed cursors. Cheap now, a store method later.
- `changeId` turned out to already be gone from the tree when the agent looked.

Process note: the agent was told mid-run to leave API.md and this file alone and report
signatures instead. That worked — no conflicts, and the doc got written from the report
rather than from intent.

## 8 · Standards worth stealing (from the competitor reads)

- **reflectdb** — `verify-exports.ts` (exports map vs. dist) and
  `verify-node-consumer.ts` (pack the tarball, install it into a throwaway Node
  project, import every subpath). Their header lists four packaging regressions
  they actually shipped. We import `bun:sqlite` and `@sqlite.org/sqlite-wasm`, so
  N3's exports map walks into the same trap. Also: lazy-resolve `bun:sqlite` so
  importing on Node is fine and only *calling* it throws.
- **reflectdb** — the transport contract is *specified*: `send` MUST reject when
  the frame did not reach the peer, with the failure named. Adopted verbatim.
- **oRPC** — contract separate from implementation; router is a plain nested
  object; **pre-configured base builders** (`publicOS`/`protectedOS`) so auth is
  not repeated per procedure; context injected at handle time so the router stays
  portable; one router served by many handlers (`RPCHandler` + `OpenAPIHandler`).
- **Zero** — a two-type port for change sources, and transaction framing.
- **Everyone** — small interfaces keep implementations short. reflectdb's
  `TableAdapter`: *"Per-row I/O only — bulk paths intentionally absent so adapters
  stay short."*

---

## 9 · Standing decisions

- **We do not build the user's functions.** Ops, handlers, and data access are
  authored by the app. We ship the contract, the wiring, and the guarantees.
- **We do not ship transports.** We ship a port anything can implement
  (`name` + `start(ctx)` + `stop()`, with `visibility` and `blobs` optional). An
  absent optional capability is a fact about the medium, not a missing feature.
- **A table is either synced or private, never both** — except through CDC, which
  is one-way by construction.
- **TanStack DB is not the client layer.** `mutationFn` is mandatory
  (`transactions.ts:226` throws `MissingMutationFunctionError`), and that encodes
  an optimistic-overlay model we do not have: our local commit *is* the truth.
  The read seam would fit in ~150 lines; writes are where it breaks. Our client
  live query is already incremental — the only thing `db-ivm` would add is joins.

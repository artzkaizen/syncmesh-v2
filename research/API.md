# SyncMesh — the API

> **SUPERSEDED (2026-08-26, D20).** This document describes the collection-era surface —
> `mesh.<table>.create/update/list`, `tx()`, `scoped()`, query descriptors — which was retired
> when SQL became the data API. The current surface is: `createMesh({ driver })` →
> `mesh.on(instance?, { as? })` → a Drizzle handle (`db`, `read`, `live`), with `db.transaction()`
> as the capture boundary, `@syncmesh/orpc`'s `withMesh` for procedures, `@syncmesh/react` for
> hooks, and `rls: true` for Postgres-enforced reads. Read `plan/decisions/D20.md` and the
> epics E09/E10/E12/E17 for what is true now; read on only for the historical rationale.

> Read off the source; every untagged example runs and is covered by tests.
> Anything not built yet is in one list at the end (§25), not sprinkled through.

**Markers.** Every section is tagged so there is no guessing:

| | Meaning |
|---|---|
| *(untagged)* | built and covered by tests |
| `[design]` | decided and specified, not yet built. The owning RFC is named. |

This describes the API as decided. Where the code has not caught up, the section
says so — but no superseded form is documented, and none should be inferred.

One import root, one constructor, one trail:

```ts
import { createMesh, createIdentity, defineSchema, table, t, Relay } from "syncmesh"
```

---

## 0 · Every import, in one place

Nothing below is left to inference. If a snippet uses a name, it is in this table.

```ts
import {
  // schema — data, portable, no functions
  t, table, defineSchema, fromDrizzle,          // defineSchema is [design]; today: defineSync
  // identity and grants
  createIdentity, issueGrant, verifyGrant, GrantRegistry,
  // the mesh
  createMesh,
  // transports
  Relay, FrameTransport, LinkTransport,
  // storage — usually untouched: the platform default is durable
  memory, sqliteEventStore, drizzleStateStore,
  // blobs
  hashOf,
  // the authority
  setPolicy, correct,
} from "syncmesh"

import type {
  Column, Table, RowOf, InsertRowOf, Schema, PartitionDef, MergeStrategy, StandardSchema,
  PolicyNode, PolicyDoc, AllowBlock,
  Identity, GrantCore,
  Mesh, MeshCollection, TxCollection, MeshConfig, QueryDescriptor, ListOptions,
  Transport, TransportContext, TransportStatus, FrameLink, VisibilityCapability, BlobCapability,
  EventStore, StateStore, SqliteDriver,
  Revision, Correction, CorrectionInput, DigestOptions,
  Tx, SyncEvent, Change, Hlc, PeerId,
} from "syncmesh"
```

Runtime-specific, so not from the root:

```ts
import { openBunSqlite } from "syncmesh/storage/bun"          // a SqliteDriver over bun:sqlite
import { openOpfsSqlite } from "syncmesh/storage/opfs"        // a SqliteDriver over sqlite-wasm, async
import { doSqliteDriver } from "syncmesh/storage/durable-object"

import { startRelay } from "syncmesh/server"
import { RelayRoom, memoryFanout, redisFanout, type Fanout, type RelaySocket, type RedisLike } from "syncmesh/relay"

import { useLiveQuery, useLiveInfiniteQuery, useLiveQueryEffect } from "syncmesh/react"
```

Test doubles, exported for contract tests and nothing else: `LoopbackFramedLink`,
`Link` (two engines in one process), `Engine` (the escape hatch, §16).

Errors are values and are matched on `_tag`, not imported: `WriteDenied`,
`NoActivePartition`, `CrossPartitionTx`, `NoSuchCapability`, `CheckFailed`, … (§8).

> Until the N3 package split, these resolve as relative paths — `../src/schema/column`,
> `../server/relay`. The subpaths are what the split will be; nothing else changes.

## 1 · Columns

```ts
t.text()  t.integer()  t.float()  t.boolean()
t.timestamp()  t.json<T>()  t.blob()  t.uuid()
```

Modifiers chain; each returns a new column (plain data, nothing executes):

```ts
t.text().primaryKey()
t.text().nullable()          // → T | null, and OPTIONAL on insert
t.integer().unique()
t.boolean().default(false)   // → OPTIONAL on insert
```

| Kind | Accepts | Rejects |
|---|---|---|
| `text` | any string, `""` included | numbers, objects |
| `integer` | `Number.isSafeInteger` | `1.5`, `NaN`, `Infinity` |
| `float` | any finite number | `NaN`, `Infinity` |
| `boolean` | `true` / `false` | `0`, `1`, `"true"` |
| `timestamp` | any finite number (epoch ms, negatives fine) | `NaN` |
| `json<T>` | **anything** the CBOR codec encodes — the `<T>` is a phantom | functions, symbols |
| `json(schema)` | only what the schema accepts | everything else |
| `blob` | `Uint8Array`, zero-length included | plain arrays |
| `uuid` | canonical lowercase 8-4-4-4-12 — v4, v7, nil, max | `"A1B2…"`, braces, anything non-canonical |
| `.nullable()` | `null` | — |
| not nullable | — | `null`, `undefined` |

`t.uuid()` **refuses** instead of normalizing: the kernel keys rows by the primary-key
*string*, so `"A1B2…"` and `"a1b2…"` would be two rows for one entity, and two devices
with different generators would never converge.

### Validating contents — `t.json(schema)` and `.check()`

Any column can carry a schema, checked at admission on every peer.

```ts
meta:   t.json(z.object({ tags: z.array(z.string()), pinned: z.boolean() })),
//       ^ the type is INFERRED from the schema — no type parameter
email:  t.text().check(z.string().email()),
age:    t.integer().check(z.number().int().min(0).max(150)),
status: t.text().check(z.enum(["open", "done"])),   // narrows the type to "open" | "done"
```

Uses **Standard Schema**, declared structurally, so zod / valibot / arktype all work and
we depend on none of them.

- Runs **before the fold**, on every device — the event arrived signed by someone else's
  device, so "verify before apply" has to cover contents too.
- The **kind check runs first**: `1.5` into a checked integer is `KindMismatch`, not a
  schema issue.
- `.nullable()` still wins for `null` — nullability is the column's, not the schema's.
- **Must be synchronous.** The fold is. An async validator fails *every* write to that
  column with a message saying so, rather than being silently skipped.
- **Must be pure** — same value, same verdict. A schema whose answer depends on a locale
  or an env var makes one peer quarantine what another accepted. That divergence is at
  least *visible* (a typed quarantine, not silent state drift), which is why a check
  schema is acceptable where a merge callback is not (§4b).

`t.json<T>()` — no schema — accepts **any** json value at runtime; the type parameter is
a phantom that erases. Reach for it only when the payload is genuinely opaque (a
third-party blob you do not own), and understand that you are opting out of checking.

Validation returns values — `checkValue` gives
`Result<void, NullConstraintViolation | KindMismatch | CheckFailed>` and never throws.

## 2 · Tables

```ts
export const books = table("books", {
  id:      t.uuid().primaryKey(),
  title:   t.text(),
  author:  t.text(),
  addedAt: t.timestamp(),
  addedBy: t.text(),
  tags:    t.json<string[]>(),
  cover:   t.blob(),
  note:    t.text().nullable(),
  starred: t.boolean().default(false),
})

// a primary key that isn't `id`
export const settings = table("settings", { key: t.text().primaryKey(), value: t.json() })
```

Returns `{ name, columns, primaryKey }`. The row type is **inferred** — `books` yields
`{ id: string; title: string; …; note: string | null }` with no separate declaration, and
`addedBy`-style required columns stay required while `starred` and `note` become optional
on insert.

Zero or two `.primaryKey()` columns throws `InvalidTableDefinition` **at module load**.

## 2b · One definition — `fromDrizzle`

If your tables already live in Drizzle, do not write them twice. Two definitions
of one table, in two dialects, kept in step by hand, is a guaranteed drift.

```ts
// db/schema.ts — the ONLY place the table exists
export const books = pgTable("books", {
  id:      uuid("id").primaryKey(),
  title:   text("title").notNull(),
  pages:   integer("pages"),
})

// shared/collections.ts
import { fromDrizzle } from "syncmesh"
export const booksTable = fromDrizzle(books)
```

Row types come from Drizzle's own inference, so they cannot drift from what your
queries return. Only `timestamp` is overridden — Drizzle hands back a `Date`, the
wire carries epoch ms.

**Refused at module load** (definition-time defects, not runtime values):

| | Why |
|---|---|
| `serial` / `bigserial` | there is no value to convert — two offline devices cannot both be given the next number. Use `t.uuid()`. |
| generated columns | evaluated by a database that is not on the phone |
| `numeric` with no precision, or > 15 digits | a double cannot hold it — use `text()` for exactness, or a scaled integer |
| no single-column primary key | the kernel keys rows by ONE string |

**Warned** — the column maps, the constraint does not: `unique()` (two offline
devices can both insert it), database-computed defaults like `defaultNow()`
(nothing to carry, so the column stays required), and `Date`-returning columns.
Pass `onWarn` to collect or silence them.

The mapping is keyed off Drizzle's semantic `dataType`, read as **base +
qualifier** — `"string date"` is an ISO string and becomes `text`, `"object date"`
is a real `Date` and becomes `timestamp`. It is deliberately NOT keyed off
`columnType`, which differs between builds of the same installed version.

**The mapping is a frozen artifact**: it determines wire bytes, so changing it
invalidates every event in an existing log, exactly like the conformance vectors.

## 3 · The schema — one manifest

Everything about the data model in one place: columns, partitions, roles,
permissions, conflict rules. Nothing is declared in a second structure far from
the thing it governs.

```ts
export const schema = defineSchema({
  // app-wide, because a hierarchy spans collections
  partitions: {
    org:   { isolation: "database" },   // top level: its own engine, its own store
    shelf: { parent: "org" },           // nested: inside the parent's store
  },
  roles: {
    org: ["owner", "admin", "member", "viewer"],   // senior → junior
  },

  tables: {
    books: {
      columns: {
        id:        t.uuid().primaryKey(),
        title:     t.text(),
        rating:    t.float().onConflict("max"),   // ← conflict rule ON the column
        addedAt:   t.timestamp(),
        createdBy: t.text(),
      },

      partition: "shelf",
      //         ^ typed against the partitions above, plus "user" and "local".
      //           a typo is a compile error, and autocomplete lists YOUR kinds.

      allow: ({ role, owner, any, all, not, rowIs, patchOnly }) => ({
        $default: role("member"),
        //             ^ typed: "owner" | "admin" | "member" | "viewer", read off
        //               roles.org — `shelf` inherits from its parent
        update: any(owner("createdBy"), role("admin")),
        //                  ^ typed: a COLUMN OF THIS TABLE. `owner("createdby")`
        //                    is a compile error; today it silently never matches.
        delete: all(role("admin"), not(rowIs({ rating: 5 }))),
      }),
    },

    notes: {
      columns: { id: t.uuid().primaryKey(), body: t.text() },
      partition: "user",                 // account-private; no allow block needed
    },

    drafts: {
      columns: { id: t.uuid().primaryKey(), body: t.text() },
      partition: "local",                // device-only; refused on the wire
    },
  },
})
```

### Why it is shaped this way

**`allow` is a function** so the combinators can be *bound to this table*.
`role` knows your role list, `owner` / `rowIs` / `patchOnly` know your columns.
As free imports taking `string`, `owner("createdby")` compiles and silently
matches nobody — a typo that fails open.

**`partition` is checked against the manifest**, so the string is real.

**Conflict rules live on the column** (§4b), because that is the only scope they
apply to.

**Partitions and roles stay at the top** because they are a hierarchy across
collections, not a property of one.

### Importing a table from Drizzle

A table you did not write has no columns to hang `.onConflict()` on, so it takes
the table-level form:

```ts
tables: {
  books: {
    table: fromDrizzle(booksDrizzle),    // instead of `columns:`
    merge: { views: "max" },             // table-level, for exactly this reason
    partition: "org",
    allow: ({ role }) => ({ $default: role("member") }),
  },
}
```

Declaring the same column in both places throws `InvalidSyncDefinition` —
ambiguity is a definition mistake, not a precedence rule to memorise.

### The four partition kinds

| Declaration | Meaning | Storage | On the wire |
|---|---|---|---|
| `{ isolation: "database" }` | top-level tenant | its own store via `storeFor` | `"org:acme"` |
| `{ parent: "org" }` | nested scope | inside the parent's store | `"shelf:s1"` |
| `"user"` (reserved) | account-private | the `"user"` scope | `"user:acct_a"` |
| `"local"` (reserved) | device-only | local store | **refused on the wire** |

The partition rides **inside the signed payload**, and the author also stamps
`_partition` on the row within the same signature — a receiver verifies row-stamp
≡ event-stamp rather than trusting either. One event = one partition.

`tables` is exhaustive both ways: miss one and it is a type error; add an unknown
key and it is a type error.

### What the code takes today `[design]`

The manifest above is the decided shape. `defineSync` currently takes two
arguments — tables separately from their config — and `allow` is a plain object
using free-imported combinators, so `role` and `owner` are untyped strings:

```ts
defineSync({ books }, { partitions, roles, tables: { books: { partition, allow } } })
```

Everything else in this section — column-level `onConflict`, the partition kinds,
exhaustiveness, `fromDrizzle` — is built. What is missing is the single-argument
manifest and the bound combinators. The types follow the rename: `Schema` for
what `defineSchema` returns and `MeshConfig` for `createMesh`'s argument — today
`Sync` and `SyncmeshConfig`.

## 4 · Permissions

Rules compile to a **JSON AST**, not to functions — same nodes, same interpreter, on every
device, which is why a verdict cannot differ across app versions.

```ts
books: {
  partition: "shelf",
  allow: ({ role, owner, any, all, not, rowIs }) => ({
    $default: role("member"),                        // mandatory deny-floor
    read:     role("viewer"),
    insert:   role("member"),
    update:   any(owner("addedBy"), role("admin")),
    delete:   all(role("admin"), not(rowIs({ starred: true }))),
  }),
}
```

| Combinator | True when | Reads |
|---|---|---|
| `allow` / `deny` | always / never | — |
| `role("admin")` | actor's role is `admin` or senior | the grant |
| `owner("addedBy")` | `row.addedBy === actor.account` | row + grant |
| `rowIs({ starred: true })` | every named field matches | the row |
| `patchOnly("title","note")` | the update touches ONLY these | the patch |
| `any` / `all` / `not` | boolean composition | children |

Resolution:

```
read   → read   ?? $default
insert → insert ?? write ?? $default
update → update ?? write ?? $default
delete → delete ?? write ?? $default
```

`write` is the insert+update+delete shorthand. Append-only is `$default: deny` plus
`insert: allow` — update and delete fall through to the floor and are denied.

The same rule runs in **three** places: `mesh.can(...)` at your call site, your local write
path (a denial returns `Err(WriteDenied)` and never enters the log), and **every receiving
peer**. That third one is why a hacked client cannot forge permission — it can sign
whatever it likes, and the mesh refuses it.

```ts
schema.policy                                    // the compiled document
JSON.parse(JSON.stringify(schema.policy))        // round-trips unchanged
```

## 4b · Conflict resolution

Declared on the column, because that is the scope the rule applies to.

```ts
const auctions = table("auctions", {
  id:      t.text().primaryKey(),
  title:   t.text(),                        // lww is the default — say nothing
  highBid: t.integer().onConflict("max"),   // the larger VALUE wins
  lowAsk:  t.integer().onConflict("min"),   // the smaller VALUE wins
  seenAt:  t.timestamp().onConflict("max"), // a high-water mark that only moves forward
})
```

`t.text().onConflict("max")` is a **compile error**, not a module-load throw —
`max`/`min` compare values, so the type only offers them where values compare
(every numeric kind carries `number`). `defineSync` re-checks at runtime as a
backstop in case a cast slips past.

Tables imported with `fromDrizzle` have no columns to hang this on and take a
table-level `merge` instead — §3.

| Strategy | Wins | Use for |
|---|---|---|
| `lww` *(default)* | the later stamp | ordinary fields — names, statuses, bodies |
| `max` | the larger value; stamp breaks exact ties | highest bid, high-water marks, furthest progress |
| `min` | the smaller value; stamp breaks exact ties | lowest ask, earliest deadline |

**Why this matters.** Under `lww`, two offline bids of 500 and 200 resolve by
*who wrote last* — so a lower late bid silently destroys a higher early one.
Under `max`, 500 wins on every peer regardless of order.

All three are **lattice joins** — commutative, associative, idempotent — so peers
converge under any delivery order, duplicated, forever. A property test drives
random bid sequences from two peers through random gossip and asserts both land
on the maximum; a three-peer test does the same over a triangle.

**Not yet: `counter` and `set`** `[design]`. A counter carries a *delta*, which is
a new change kind, which needs RFC-0013's evolution block first so an older peer
**parks** it instead of dropping it. `max`/`min` shipped now precisely because
they need no wire change — the change already carries the value, only the
comparator differs. Conformance vectors are byte-identical.

### Not a custom resolver function — decided against

A per-column callback (`onConflict: ({ incoming, current }) => …`) was designed and
**rejected**. The reasoning, so it does not come back:

A merge function runs independently on **every device**, so it must be pure — and
purity here is unverifiable. Impurity splits in two:

| | Example | Detectable locally? |
|---|---|---|
| varies between two calls on one device | `Date.now()`, `Math.random()` | yes — run it twice |
| stable here, different elsewhere | `navigator.language`, `process.env.TZ`, **a helper that differs between app versions** | **no. the other device is not here.** |

The second class passes every test on your machine and diverges in the field,
**silently** — both peers accept, both compute, neither notices. The only thing
that catches it is cross-peer state digests, which report *that* you diverged and
not why, require the peers to actually meet, and are ambiguous in a mixed-version
fleet (RFC-0013's open question G18). Source-scanning is unavailable to us
regardless: `fn.toString()` is `"[native code]"` on Hermes.

That is a large amount of machinery to make one extension point *watchable* rather
than *correct* — for a rule most apps write as one word.

**A string is data.** It can ship as a `_policy`-style synced row, so every peer
provably evaluates the same rule and there is nothing to verify. That is the actual
reason the declarative tier is primary rather than a fallback.

If a field's rule cannot be expressed as a string, the answer is an authority
correction (§9d) — not a resolver.

*(This is why `.check()` schemas survive and merge callbacks do not: a check that
disagrees between peers produces a visible, typed **quarantine**; a merge callback
that disagrees produces silently different state.)*

### History — what a row has been

A losing write is gone from **state** but both writes are still in the **log**.
Nothing is lost, so "what did this overwrite?" is a read over history we already
keep rather than a second store of discarded values:

```ts
mesh.collections.notes.history(noteId)   // → Revision<Note>[], oldest first
```

```ts
interface Revision<Row> {
  at: number                // epoch ms, from the HLC — not local wall time
  by: string                // the ACCOUNT, resolved through grants
  peerId: string            // the device that wrote it
  eventId: string
  procedure: string         // the label the author gave the write
  kind: "insert" | "update" | "delete"
  changed: Partial<Row>     // what THIS write set. empty for a delete.
  row: Row | null           // the row as of this revision; null once deleted
}
```

One method answers what three would have:

```ts
const revs = mesh.collections.notes.history(id)
revs                                        // timeline: who changed what, when
revs.filter((r) => "title" in r.changed)    // one column — a FILTER, not an argument
revs.at(-2)?.row.title                      // what the current value overwrote
```

Ordered by **stamp, not arrival**, so every peer computes the identical sequence
(pinned by a test over two peers that merged offline edits). Bounded by the log:
compaction (RFC-0015) is how far back it reaches, and it does not pretend
otherwise.

**There is no conflict store and no `"manual"` strategy**, deliberately. History is
strictly more general — the whole sequence rather than the last loser — needs no
declaration on a column, and costs nothing until asked. Restoring an old value is
just writing it again, which goes through policy like any other write.

Choose-one-side is also the wrong shape for the case that seems to want it:
collaborative prose needs a text CRDT, not a chooser, and everything else is
better served by `lww`, `max`/`min`, or modelling the conflict away with
append-only children.

**Cost:** `history()` scans the log — 63 ms at 50k events on SQLite, ~6 ms at 1k.
It is a detail-view API, not a list API. If audit trails become a product
requirement the right home is a server-side projection: the authority holds the
whole log anyway and can index it without every phone paying a write-path cost.

## 5 · Identity and grants

```ts
const issuer   = createIdentity(process.env.ISSUER_SEED)  // its PUBLIC key ships in the app
const identity = createIdentity(seed)                     // peerId IS the Ed25519 pubkey

const wire = issueGrant(issuer, {
  account: "acct_a",
  device:  identity.peerId,
  role:    "member",
  partitions: ["acme", "s1"],        // ⚠ bare INSTANCE ids, not "org:acme"
  issuedAt: now,
  expiresAt: now + 30 * DAY,
})

const grants = new GrantRegistry(issuer.peerId, () => Date.now())
grants.register(wire)      // → Result<GrantCore, MalformedGrant|BadGrantSignature|GrantExpired>
grants.coreFor(peerId)     // → GrantCore | null
grants.wireFor(peerId)     // → the SAME signed bytes, for byte-identical re-forwarding
grants.allWires()          // → everything held; ships FIRST on every connect
grants.onRegistered((core, wire) => pushToPeers(wire))
verifyGrant(wire, issuer.peerId, Date.now())   // standalone, offline, no lookups
```

| State | Behaviour |
|---|---|
| absent | that peer's events quarantine on `NoGrant` |
| valid | admitted; role feeds `role()`, account feeds `owner()` |
| expired | reads as **absent** — staleness, not a tombstone |
| newer arrives | replaces |
| **older** arrives | ignored — a stale replay cannot downgrade someone |
| device ≠ author | `GrantDeviceMismatch` |
| partition not listed | `PartitionNotGranted`, locally **and** at every peer |

## 5b · Bringing your own auth

**SyncMesh has no users, no login, no sessions, and no membership.** It has one
question — *may this device do this?* — and one answer: a signed grant.

Everything before that is yours. better-auth, Clerk, Auth0, WorkOS, a password
table you wrote: we never see it and never care.

### The flow, end to end

```
1. user signs in                          YOUR auth, YOUR session
2. client sends its DEVICE PUBLIC KEY     identity.peerId — never the private key
3. your server checks its own session     YOUR code, YOUR rules
4. your server issues a grant             issueGrant(issuer, {...}) — one call
5. client registers it                    grants.register(wire)
```

```ts
// server/login.ts — inside YOUR existing auth route, after it already said yes
import { issueGrant, createIdentity } from "syncmesh"

const issuer = createIdentity(process.env.SITEWIRE_ISSUER_SEED)   // its PUBLIC key ships in the app

app.post("/mesh/grant", async (req) => {
  const session = await auth.getSession(req)          // ← whatever you already use
  if (!session) return new Response(null, { status: 401 })

  const { devicePeerId } = await req.json()
  const now = Date.now()

  return Response.json({
    grant: [...issueGrant(issuer, {
      account:    session.userId,                     // ← your id, verbatim
      device:     devicePeerId,
      role:       session.role,                       // ← your roles
      partitions: session.orgIds,                     // instance ids the user may touch
      issuedAt:   now,
      expiresAt:  now + 30 * 86_400_000,
    })],
  })
})
```

```ts
// client
const identity = createIdentity(await loadOrMintSeed())
const { grant } = await fetch("/mesh/grant", {
  method: "POST",
  headers: { cookie: document.cookie },               // ← your session, however you carry it
  body: JSON.stringify({ devicePeerId: identity.peerId }),
}).then((r) => r.json())

const grants = new GrantRegistry(ISSUER_PUBLIC_KEY)
grants.register(Uint8Array.from(grant))

const mesh = createMesh({ identity, account: session.userId, schema, grants, … })
```

### Why the grant and not the session

A session token is a bearer credential your server checks. That works when your
server is in the path. **It is not, here** — two phones on a job site with no
internet still have to decide whether each other's writes are admissible.

A grant is verified **offline, by every peer, against the issuer's public key**.
No lookup, no network, no shared secret. That is the only shape that works when
the authority is unreachable, which is the whole product.

### `account` is a convenience; the grant is the boundary

`createMesh({ account })` only decides which `user:<account>` partition your own
writes land in. It is not trusted:

- a write into another account's user partition is compared against
  **`grant.account`** and denied locally *and* quarantined at every peer;
- `owner("createdBy")` compares the grant's account, never the config;
- the grant is bound to `device`, so a stolen grant is useless without the
  matching private key, which never leaves the device.

### What we deliberately do not provide

No user table, no roles table, no invites, no membership, no password reset, no
JWT verification. **Roles are strings you choose** and declare in `roles`;
partitions are ids you choose. If you want a members list, it is your data —
model it as a synced table like anything else.

The one thing to get right on your side: **`expiresAt` is a staleness bound, not
a revocation mechanism.** Expiry reads as absent, so a short validity window
(hours, with renewal) is the real containment for a stolen device. `revoke()`
exists but is local-only today — propagation is RFC-0016 and unbuilt.

## 6 · The mesh — one constructor

```ts
import { createMesh, createIdentity, Relay } from "syncmesh"
import { schema } from "./shared/schema"

const mesh = createMesh({
  schema,
  identity:   createIdentity(await loadOrMintSeed()),
  account:    session.account,
  grants,
  transports: [new Relay("wss://sync.example.com", { room: "acme" })],
})
// no `store`: the platform's durable default. see §12.
```

| Key | Meaning |
|---|---|
| `schema` | from `defineSchema` — tables, partitions, roles, policy, conflict rules |
| `identity` | this device's keypair. **XOR** `peerId` for unsigned mode |
| `account` | the signed-in account; `user`-partition tables resolve against it |
| `store` | the event log. **Omit it and the platform's durable default is used** — a SQLite file on Bun, localStorage in a browser. Memory is never a default |
| `dataDir` | where the default store's file goes on Bun. Default `.syncmesh` |
| `storeFor(scope)` | one store per tenant — `"org:acme"`, `"user"`. Overrides the default |
| `transports` | anything implementing the port (§9) |
| `grants` | signed proofs of what this device may do. **Optional** — see below |
| `stateStore` | materialized rows: boot becomes an open, not a replay |
| `snapshotEvery` | hot-tier snapshot every N events: boot = snapshot + tail |
| `undoDepth` | before-images for the last N events — **required for `revert()`** |
| `isAuthority` | which grants carry authority (default: `role === "authority"`) |
| `now` | injectable clock |

### Grants are optional; schema checking is not

Omit `grants` and you are in **ungranted mode**: a sandbox, a test, a
single-device app. Grant and policy checks are skipped, because with no grant
there is no account, no role, and no principal to evaluate a rule against.

**Schema checks still run.** A `1.5` in an integer column, an unknown column, a
`null` in a non-nullable one, a non-canonical uuid — all refused, with or without
identity. A type system that switches off when you are not looking is worse than
none, because the failure surfaces later, on someone else's device, on data that
has already replicated.

The one consequence to know: in ungranted mode a `deny` rule is not enforced.
There is nobody for it to deny.

### Ambient partition — setters named after YOUR kinds

```ts
mesh.setOrg("acme")     // ← generated from partitions.org
mesh.setShelf("s1")     // ← generated from partitions.shelf
```

Scope is **ambient**: there is no `{ shelf }` option on any call, which is the point — a
silent cross-shelf write is inexpressible. Forget one and the error names it:

```
NoActivePartition: no active shelf — call setShelf(id) at the navigation boundary
```

`user` tables resolve to the signed-in account; you never set that one.

## 7 · Reading

### React

```tsx
const { data: books } = useLiveQuery(mesh.collections.books.list())

const { data: recent } = useLiveQuery(
  mesh.collections.books.list({ orderBy: "addedAt", dir: "desc", limit: 20 }),
)

const { data: starred } = useLiveQuery(
  mesh.collections.books.list({ where: (b) => b.starred }),
)
```

A `list()` is **data**, not a closure — so no deps array, and two components asking the
same question share one subscription. A `where` closure gets its own subscription, because
closures are not comparable.

The builder form still exists for joins and projections, and there deps are required —
Hermes returns `"[native code]"` for `fn.toString()`:

```tsx
const { data } = useLiveQuery(
  (q) => q.from({ b: books }).where(({ b }) => b.starred)
          .orderBy(({ b }) => b.addedAt, "desc")
          .select(({ b }) => ({ id: b.id, title: b.title })),
  [books],
)
```

Also `useLiveInfiniteQuery` (keyset windows only — offset pagination is banned as
unstable under live edits) and `useLiveQueryEffect` (a side effect on row deltas,
no re-render). That is the whole React surface.

**One fold notification per batch means one render per burst** — a 5,000-event catch-up is
one notification, load-tested.

### Without a framework

```ts
const live = mesh.liveQuery(mesh.collections.books.list({ orderBy: "title" }))
live.data()
const off = live.subscribe(() => render(live.data()))
mesh.releaseQuery(live)
```

### Synchronous

```ts
mesh.collections.books.rows()      // → Book[]      every row in the ambient partition
mesh.collections.books.byId(id)    // → Book | null  the same shape rows() yields
mesh.collections.books.history(id) // → Revision<Book>[]  every version, oldest first
```

Live queries are incrementally maintained, O(changed · log n) — §21.

## 8 · Writing

```ts
const books = mesh.collections.books

books.insert({ id, title: "Dune", author: "Herbert", addedAt: Date.now(), addedBy: acct })
books.update(id, (draft) => { draft.title = "Dune (rev)" })   // an UPDATER, diffed to a patch
books.delete(id)
```

`update` diffs the draft against the current row and writes only changed columns;
an unchanged draft is `Err(EmptyMutation)` rather than a no-op event. The event's
provenance label is derived — `books.insert` — so there is no string to pass.

**Every table gets these verbs.** Policy decides whether a call *succeeds*, not
whether the method *exists*: with `delete: deny` in the schema, `books.delete(id)`
typechecks and returns `Err(WriteDenied)`. A statically-`deny` rule should remove
the method from the type `[design]` — a read-only collection, such as every
CDC-backed one (RFC-0021), would then have no write surface to call.

### Multi-collection, atomic — `tx`

```ts
mesh.tx((t) => {
  t.accounts.update(from, (a) => { a.balance -= amount })
  t.accounts.update(to,   (a) => { a.balance += amount })
})
// ONE event, one signature, one HLC stamp. Label derived: "accounts.update"

mesh.tx(fn, { label: "ledger.transfer" })   // naming it is metadata, not argument #1
```

**On your own device `tx` changes nothing.** Two separate writes both apply
instantly and durably; there is no network in the write path, so nothing can fail
halfway. The reason it exists is what **other** devices are allowed to observe.

Two separate writes are two events, and two events replicate independently. So a
peer can hold the debit without the credit — briefly if the second is still in
flight, **permanently** if the second is denied by policy there or dropped by a
radio. One event carries both changes and receivers apply an event's `changes` as
a unit, so no peer can see half of it.

Secondarily: if the second write would be denied, `tx` refuses the whole thing and
returns one `Err`. Without it the first has already committed and you are holding
a half-applied pair to unwind yourself.

**When you actually need it.** The test is: *can a peer that sees only the first
change do something harmful?*

| | |
|---|---|
| a transfer | debit without credit = money has vanished |
| moving between lists | absent from both, or present in both |
| a claim handoff | the gap is "unowned", and another device may act on it |
| a swap or reorder | two rows exchanging positions |

If the worst case is "a number is briefly stale", you do not need `tx`.

**Two things that look like they need it and do not.** An *audit row* — the event
log already **is** an append-only signed record of who changed what and when;
that is what `history()` reads, and a parallel audit table only adds a copy that
can be denied or compacted separately. A *denormalised counter* — the rows are
local, so counting is free and a live query re-emits it; denormalise only when you
do not hold the rows (a scoped join) or the count is genuinely large.

One event is one partition, so a `tx` spanning two is `Err(CrossPartitionTx)`,
refused before anything commits — splitting it into two events is exactly what you
were avoiding. An empty `tx` is `Err(EmptyTx)`.

### Every write returns a value

| Error | Cause |
|---|---|
| `NoActivePartition` | you forgot a setter — the message names it |
| `WriteDenied` | policy said no, from the AST peers will run |
| `UnknownCollection` | no such table |
| `LocalTablesNotYetWritable` | a `partition: "local"` table |
| `MissingPrimaryKey` / `RowNotFound` | key problems |
| `EmptyMutation` / `EmptyTx` / `CrossPartitionTx` | nothing to write, or too much |
| `UnknownColumn` / `MissingColumn` / `ImmutableColumn` / `InvalidColumnValue` | row shape |
| `NullConstraintViolation` / `KindMismatch` | a value's type |
| `CheckFailed` | a value passed its kind check and failed the column's schema |

```ts
const r = books.insert(row)
if (r.isErr()) {
  switch (r.error._tag) {
    case "WriteDenied":       return toast("Not yours")
    case "NoActivePartition": return nav.toShelfPicker()
  }
}
```

**There is no optimistic overlay: the local commit IS the truth.** Nothing to await back,
nothing to roll back on network failure — there is no network in the write path.

### Predicting and undoing

```ts
mesh.can("books.update", row)     // → boolean; the same computation validation runs

mesh.canRevert(eventId)           // needs undoDepth at construction
mesh.revert(eventId)              // a NEW compensating event, not a log rewrite
```

### What the server does with your write

Nothing you have to ask for. The server is a peer: your write reaches it, it
folds it, and — if it has a `stateStore` — the row lands in **your Postgres**
(§13.2). From there everything is ordinary: `SELECT`, joins, cron, reports.

For a question that needs an answer *now* — charge a card, mint a signed URL —
use `fetch`. Your server, your auth, your response. It *should* fail offline,
because a payment queued for three days is wrong rather than helpful.

There is no request channel, no RPC, no server-side hook that runs when data
changes. Zero, LiveStore and reflectdb each put server logic where a *mutation*
enters the server; we deliberately have no such point (D1 — receivers never run
app code), and the state is in your database, so your existing tools react to it.

## 8b · The path of one write, end to end

Concrete, with the real functions. One person marks a job complete; the server
ends up holding it in Postgres.

### 1 · The collection turns your call into a patch

```ts
mesh.collections.jobs.update("j17", (d) => { d.status = "complete" })
```

`client.ts` reads the current row, hands you a **copy** as `draft`, then **diffs**
it — only columns you actually changed become the change:

```
current { id:"j17", status:"open",     assignee:"bob", siteId:"s1" }
draft   { id:"j17", status:"complete", assignee:"bob", siteId:"s1" }
patch   {           status:"complete" }                     ← this, and only this
```

That diff is why two people editing different fields of one row both survive: the
event carries `status` alone and never mentions `assignee`, so it cannot clobber
it. An unchanged draft produces an empty patch → `Err(EmptyMutation)`, and no
event at all.

Then `engine.mutate("jobs.update", (tx) => tx.update("jobs", "j17", patch), { partition })`.

### 2 · `engine.mutate` — validate, stamp, sign, append, fold

`src/core/engine.ts:318`, in this order, and the order matters:

```
1. run your fn against a recording Tx      → changes[]  (+ stamp _partition INSIDE the row)
2. no changes?                             → Err(EmptyMutation). nothing ticks, nothing appends.
3. clock.tick()                            → HLC [physicalMs, logical]
4. VALIDATE A PROBE EVENT                  → schema + policy + partition + grant
     denied → Err(WriteDenied) and RETURN. No seq burned, nothing appended.
     "a denied local write is a value at the call site, not a quarantined event"
5. re-read store.lastSeq(peerId)           → a SIBLING TAB may have allocated since boot
6. seqNum = ++                             → this author's monotonic counter
7. sign(encodeEventCore(event))            → detached Ed25519 over canonical CBOR
8. store.append(event, sigHex)             → durable NOW. this is the commit.
9. advanceFeed(...)                        → sha256 chain, so a later CHUNK can be one signature
10. fold([event], "local")                 → apply to state, emit ONE FoldBatch
11. outboundListeners(event)               → hand to every transport
```

Step 8 is the moment the write is real. Everything after is propagation.

### 3 · Fold — where live queries wake up

`fold()` walks the events, calls `foldOne` on each accumulating `writeTables`,
and emits **one** `FoldBatch` for the whole array:

```ts
{ writeTables: Set{"jobs"}, writeKeys: Map{"jobs" → Set{"j17"}}, source: "local", eventCount: 1 }
```

`LiveQuery` is subscribed. It does **not** re-scan `jobs` — it takes
`writeKeys.get("jobs")`, and for that one key decides **enter / leave / move /
update-in-place**, binary-searching the sorted result for position. Your list
re-renders; nothing else was touched.

### 4 · Out to the transports — or not

`onOutbound` fires. `RelayTransport` sends `{ t:"event", w: base64(wire) }`.

**Offline, this goes nowhere and nothing is queued** — the event is already in the
`EventStore`, which *is* the outbox. There is no pending-writes table.

### 5 · The relay — dedup, store, ack, fan out

`ingest()` in `server/relay.ts`: decode enough to read `peerId` and `seqNum`, dedup
on `${peerId}-${seqNum}`, append to the room, `{t:"ack"}` to the author, and fan
`{t:"event"}` to every other socket. It never verifies a signature and never
executes anything — it holds no keys.

### 6 · The server peer receives it

Its `RelayTransport` calls `engine.receiveWire(bytes)` → `decodeAndVerify` →
**verify signature** → `admit()` (grant → policy → partition) → dedup → `foldOne`
→ emit `FoldBatch`.

Same gauntlet your own device ran. The server is a peer.

### 7 · The row lands in Postgres

The server peer's `stateStore` is `drizzleStateStore(db, { jobs, … })` (§13.2).
`fold` calls `stateStore.commit(rows, cursors)` → an `UPSERT` into your `jobs`
table. Your cron, your reports, your joins with private tables: all ordinary SQL.

The offline path is §9b — same steps, batched.

### Where diffing happens — three different places

| | Diffs what | Into what | Why |
|---|---|---|---|
| `collection.update` | draft vs current row | a patch of changed columns only | so concurrent edits to other columns survive |
| `LiveQuery` | changed keys vs its sorted result | enter / leave / move / update | so a write does not re-scan the table |
| relay `ClientView` | query result vs last sent | row patches | so a server does not resend whole result sets |

### Where reconciliation happens

| | Reconciles | Mechanism |
|---|---|---|
| two writes to one column | by stamp, or by value (§4b) | `applyChange` / `beats()` |
| two peers' logs | by cursors — each sends what the other lacks | §17 |
| two peers' *state* from the same events | by digest, then per-row repair | §9c |
| the authority disagreeing | overwrite + a reason | §9d |

## 9 · The transport port

SyncMesh does not ship radios. It ships a contract:

```ts
interface Transport {
  readonly name: string
  start(ctx: TransportContext): void | Promise<void>
  stop(): void | Promise<void>
  onStatus?(cb: (s: "connected" | "disconnected") => void): () => void
  readonly visibility?: VisibilityCapability   // only with an ordered log
  readonly blobs?: BlobCapability              // only with a side channel
}
```

Required tier is what a dumb radio can honestly provide. Optional tier is for transports
that have more. **An absent capability is a fact about the medium, not a missing feature** —
a relay has an ordered log so it can answer "is my write visible yet?"; a mesh has no
single position to be *at*, so it must not pretend.

Most transports never write `start` — extend `FrameTransport` and give it a byte pipe:

```ts
class Ble extends FrameTransport {
  readonly name = "ble"
  protected link(): FrameLink {
    return {
      send:    (frame) => native.write(this.handle, frame),   // MUST throw if it did not leave
      onFrame: (cb) => native.subscribe(this.handle, cb),
      close:   () => native.disconnect(this.handle),
    }
  }
}
```

That is the whole implementation. Signing, verification, grant exchange, cursors,
catch-up, dedup and merge are all on our side of the line. Already have a pipe?
`new LinkTransport("ble", myLink)`.

`send` **must throw when the frame did not leave**. Swallowing it makes the engine believe
a peer holds events it never received, and the divergence persists until something forces a
resync. Losing a frame loudly is recoverable; losing it quietly is not.

```ts
transport.resync()   // radios drop frames out of range — re-run the handshake on reconnect
```

Shipping today: `Relay` (WebSocket — declares both optional capabilities),
`LinkTransport`, `LoopbackFramedLink` for contract-testing without hardware.

## 9b · Offline, then back — how catch-up actually works

There is no outbox, no retry queue, no pending-writes table. **The log is the
outbox**, and reconnect is symmetric anti-entropy by cursors.

### While offline

```ts
mesh.collections.books.insert({ id, title: "Dune", … })   // → Ok, immediately
```

Validate → capture changes → stamp HLC → increment this device's `seqNum` → sign
→ append to the `EventStore` → live queries re-emit. `engine.onOutbound` fires
and the transport drops it, because the socket is closed. **The write is already
durable and already the truth locally.** Nothing is waiting.

### On reconnect, in order

```
1. client → { t:"join", room, cursors }          cursors = engine.cursors()
                                                  peerId → highest seqNum held

2. relay  → { t:"catch-up", ws[…2000], cursors, grants?, more?, o }
            everything past the client's cursors, PAGED.
            grants ride the FIRST page — events from an author you have never
            met would otherwise quarantine on NoGrant before their grant lands.

3. client   applies pages STRICTLY IN ORDER, in time slices, each committing —
            so a 300k-event join neither freezes the UI nor loses progress on a
            crash halfway.

4. client → { t:"event", w } × N        ← push-outstanding
            engine.wireEventsSince(relayCursors): everything the relay's own
            cursors say it lacks. THESE ARE THE OFFLINE WRITES.
            Sent only after the LAST page: you cannot know what you hold that
            they do not until you have applied what they have.

5. relay    ingest(): decode → dedup by `${peerId}-${seqNum}` → append
          → { t:"ack", id, o }  to the author  (this is what engine.synced() waits on)
          → { t:"event", w, o }  fanned out to every other socket in the room

6. the server peer (one of those sockets) receives, and its engine runs the same
   path every peer runs: verify signature → grant → policy → dedup → HLC field-LWW
   merge → fold → stateStore.commit — the rows land in Postgres now.
```

Step 6 is `receiveWireBatch` (`engine.ts:439`), and it is where batching lives:

```
for each wire:  decodeAndVerify → skip own / already-folded / dupes-within-batch
for each fresh: admit()  ← INTERLEAVED, so later events in the batch see rows
                            earlier ones created
                clock.receive(hlc) · advanceFeed · foldOne → accumulate writeTables
persist(pending)                     ← ONE store transaction (1k/s → 650k/s)
emit ONE FoldBatch { source: "catch-up", eventCount: applied }
```

**5,000 events produce one `FoldBatch`, not 5,000** — one render on a phone, one
Postgres transaction on the server, never a freeze.

### Why it is shaped this way

- **Nobody asks "what did you do while away?"** Both sides state their cursors and
  each sends what the other lacks. The same exchange works peer-to-peer over BLE
  with no server in it.
- **Dedup makes double delivery a no-op**, so a flaky reconnect that re-sends is
  harmless — which is what lets step 4 be unconditional rather than careful.
- **Asking the server to do something just works**, because it is not a call. You
  wrote a row offline; it is data, so it replicates in step 4 like everything
  else, and the server folds it in step 6 — into your Postgres, if it has a
  `stateStore`. There is no request to time out, no queue to drain, nothing to retry.
- **Order is not lost.** Per-author `seqNum` preserves that device's own causal
  order; HLC plus field-level LWW resolves concurrent edits across devices.
  Two devices that edited different fields of one row both land.

### What the client is owed

```ts
await mesh.engine.synced(eventId, { minAcks: 1, timeoutMs: 5_000 })
// Ok                  — the relay durably holds it (step 5's ack)
// Err(SyncTimeout)    — STILL PENDING, not failed. The event stays in the log
//                       and ships on the next reconnect.
```

## 9c · Divergence — detecting it, and healing it

Cursors prove two peers **have** the same events. Nothing proved they
**computed** the same state — and an impure merge, a version skew or a torn
write leaves them silently holding different rows from identical inputs.

```ts
// cheap: one string per table, exchanged on catch-up. matching costs nothing more.
const theirs = await peer.digest({ partition: "site:s1" })
const tables = mesh.engine.divergentTables(theirs, { partition: "site:s1" })

// drill down only into a table that actually mismatched
for (const table of tables) {
  const keys = mesh.engine.divergentRows(table, await peer.rowDigests(table))
  // repair SYMMETRICALLY — each side folds the other's records
  mesh.engine.repairRows(table, await peer.rowRecords(table, keys))
}
```

**Repair is the ordinary merge**, not a special path: `repairRows` runs the same
`mergeRecord` a snapshot install uses, so a stale row loses to the higher stamp
and genuine concurrency resolves exactly as it would have. Both sides do it to
each other and converge. It adopts **no cursors** — the events were never in
question, only the state computed from them.

**The digest is a sum, not an XOR.** Both are order-free, which is required
because peers fold in whatever order their radios delivered. XOR is
self-cancelling: any two rows hashing alike erase each other, so a paired
corruption is invisible. Addition mod 2^64 has no such pair. (This answers
RFC-0014's open question; a test pins that duplicating a row changes the digest.)

**Compare within one scope.** A digest covers the rows a peer *holds*, so two
peers with different interests (RFC-0019 scoped joins) differ legitimately and a
mismatch between them means nothing.

## 9d · Corrections — the authority overruling, without rollback

When the authority disagrees with something peers **already applied**, rejecting
it does not work: an unreachable peer keeps the provisional value with nothing
ever contradicting it, and there is deliberately no client rollback machinery.

So a rejection **is** an authoritative overwrite — fresh higher stamp, and LWW
does the rest. What makes it a *correction* rather than an anonymous overwrite is
that the reason rides in the **same event**:

```ts
// on the authority
correct(engine, {
  event: offending.id,            // the write being overridden
  table: "bids", key: bidId,
  reason: "OVER_CAP",             // a stable tag the author can switch on
  detail: { cap },
  author: "acct_c",               // whose write it was
  partition: "room:r1",
}, (tx) => tx.update("bids", bidId, { amount: cap }))
```

```tsx
// on the client whose write was overridden
mesh.corrections.mine()            // → Correction[]
mesh.corrections.forEvent(id)      // → Correction | null
// { event, table, key, reason, detail, author, at }
```

One signed event says both *the value is now X* and *because Y, and it was Z's
write I overrode* — so the author renders an explanation instead of watching
their data change for no visible reason.

`_corrections` is **deny-all**: only the authority bypass admits a write. A
correction anyone could forge would be a way to blame someone else for your own
write, and a test pins that a member's forged one is denied at its own author
*and* never applies at a peer.

## 10 · Capabilities

```ts
mesh.visibility.token()                        // → { epoch, offset } | null
await mesh.visibility.visibleAt(tok, { timeoutMs: 3_000 })
// Ok · Err(VisibilityLost) — the log lineage changed
//    · Err(VisibilityTimeout) — you stopped waiting; the write is unaffected

mesh.blobs.available                           // → boolean
mesh.blobs.put(bytes)                          // → Result<hash, NoSuchCapability>
await mesh.blobs.fetch(hash, { timeoutMs: 5_000 })
```

`engine.synced()` answers *"did the relay durably take it?"*. `visibleAt` answers *"can I
read it back yet?"* — the question a UI asks after a write it wants to show as settled.
Both are surfaced from whichever transport has the capability; with none, you get a
typed value, not a crash.

Blobs travel **outside** the event log (BLE is 3–50 KB/s with a 128 KiB reassembly cap);
rows carry the hash. The relay verifies before storing, so junk cannot squat a hash, and
the client verifies on fetch.

## 11 · Lifecycle

```ts
mesh.collections     // YOUR namespace
mesh.internal        // _policy, _corrections — machinery, kept out of yours
mesh.transports      // for status indicators
mesh.running
mesh.stop()          // stops transports; engine and log stay intact
mesh.engine          // the escape hatch — everything above is built on it
```

## 12 · Storage

Most apps never name a store — the platform default is durable (below). When you
do, there is one SQLite store and a driver per runtime:

```ts
memory()                                              // in-memory; you have to ask for it
sqliteEventStore(openBunSqlite("./app.db"))           // Bun
sqliteEventStore(await openOpfsSqlite("app.db"))      // browser; crossOriginIsolated worker
sqliteEventStore(doSqliteDriver(ctx.storage.sql))     // Durable Object
sqliteEventStore(yourDriver)                          // anything else: 5 methods, §12 below
```

One store, N drivers. Every statement, the schema and its migration live once —
a driver never sees SQL, so it cannot get the schema wrong.

```ts
interface SqliteDriver {
  run(sql, params?): { changes: number }
  all<T>(sql, params?): T[]
  get<T>(sql, params?): T | undefined
  transaction?(fn): void      // optional — and a 650x difference on catch-up
  close?(): void
}
```

### The state tier — `stateStore`

The `EventStore` is the log. The `StateStore` is the materialised rows — a cache
of a value the log can always recompute, kept so boot is an open rather than a
replay. Its port is three methods: `isEmpty()`, `loadAll()`, `commit(rows, cursors)`.

| | Where rows go | Use |
|---|---|---|
| `BunSqliteStateStore.open(path)` | our table, in SQLite | a phone, or a server that only needs fast boot |
| `drizzleStateStore(db, { tables, schema })` | **your** Drizzle tables | the authoritative server — §13.2 |

Same port, two destinations. The second is how synced data reaches Postgres.

### Why we ship stores at all, when there is a port

The `EventStore` contract is 15 members, half optional, and the optional half is
where the traps are:

- **`maxHlc()` / `lastSeq(peer)` gate clock monotonicity across a restart.** Get
  them wrong and the clock regresses — you stamp new events *below* ones peers
  already saw, and they are silently discarded as stale. Invisible, unrecoverable.
- **`appendBatch` is a 650x difference.** Per-event append on SQLite is its own
  implicit transaction, one fsync each: ~1k events/s, versus ~650k/s for the same
  events in one transaction.
- **`allSince(floor)` is the difference between an O(log) and an O(state) boot.**
  Omit it and `all()` decodes every row just to skip it.
- **`saveSnapshot` must copy or serialize SYNCHRONOUSLY** — the caller's object
  keeps mutating after the call returns.

So the reference implementations exist because the contract is hard, not because
we want to own storage. Implement the port and the engine does not care.

**Durable by default, memory by choice.** Omit `store` and `createMesh` picks the
durable store this platform has — a SQLite file on Bun (`.syncmesh/<account>.db`),
localStorage in a browser. That is what LiveStore's platform adapters do, and it
is why you never construct a store there.

Memory has to be asked for: `store: memory()`. It is never chosen for you, because
a default that loses every write on restart is the wrong shape.

OPFS remains an explicit upgrade in the browser — it needs a crossOriginIsolated
worker, so it cannot be a silent default: `store: await OpfsSqliteEventStore.open()`.

Boot is one of three states: empty; rematerialize (fold the stored log); or snapshot +
tail when `snapshotEvery` is set. Construction is synchronous and reads `maxHlc()` and
`lastSeq(peerId)`, so the clock and sequence never regress across a restart. Compaction is
clamped to the *persisted* snapshot's coverage, so a restart can never lose the tail.

## 13 · The server

The server is **a peer with three extras**: it is always on, it holds the whole
log, and its grant carries authority so it can publish policy and corrections.
It is not a different animal, and there is no second write path.

### 13.1 · The rules

**A table is defined once, in Drizzle, and synced through the mesh.** The
server peer materialises it into that same Drizzle table (§13.2), so your
Postgres holds the rows and your tooling works on them. Private tables — price
lists, cost basis, payment records, anything a stolen phone must never hold —
live only in Postgres and never appear in the schema.

**Permissions are the schema's**, evaluated at the call site, on the local write
path, and at every receiving peer (§4). There is no second permission model,
because there is no second write path.

**Do not write synced tables directly with SQL on the server.** The engine owns
them; a direct write would be invisible to the mesh. If something else must
write them — a migration, another service — that is CDC (RFC-0021): the database
becomes authoritative for that table, devices get a read-only projection, and the
write path runs the other way.

### 13.2 · The server peer — rows into your database

```ts
import { createMesh, Relay, drizzleStateStore, sqliteEventStore } from "syncmesh"
import { openBunSqlite } from "syncmesh/storage/bun"
import { db } from "./db"                          // your Drizzle instance
import { jobs, sites, photos } from "./db/schema"  // the same tables `fromDrizzle` imported

const server = createMesh({
  schema, identity: issuer, grants,
  transports: [new Relay("ws://localhost:5198", { room: "acme" })],
  store:      sqliteEventStore(openBunSqlite(".syncmesh/log.db")),          // the log — ours
  stateStore: drizzleStateStore(db, { tables: { jobs, sites, photos }, schema }),   // the rows — YOURS
})
```

`drizzleStateStore` implements the `StateStore` port (§12) over your tables. On
every fold the engine calls `commit(rows, cursors)`, and in **one transaction** the
store `UPSERT`s each changed row into the matching Drizzle table by primary key,
`DELETE`s tombstones, and writes two sidecar tables it owns: `_syncmesh_state`
(the full `RowRecord` with stamps, which app tables cannot hold and boot needs)
and `_syncmesh_cursors`. Boot reads them back, so a restart resumes rather than
replays — even over an empty event log.

| | |
|---|---|
| **validation** | at construction: an unknown mesh table, a mesh column the Drizzle table lacks, or a primary key that differs, throws `InvalidTableDefinition` |
| **columns** | by name; a `date`-typed Drizzle column receives `new Date(ms)` |
| **`_partition`** | written to a `partition` column if the table has one; otherwise stripped |
| **tables not in `tables`** | `_policy`, local tables — sidecar only, never your schema |
| **the reverse** | something else writing these tables is CDC (RFC-0021) — one-way, never both at once |

**The limit, stated plainly: this is synchronous, so it takes a synchronous Drizzle
driver** — `bun:sqlite`, `better-sqlite3`. The `StateStore` port and `Engine`'s
constructor are sync, and every Postgres Drizzle driver is async. **Rows into
Postgres therefore need an async state port**, which does not exist yet (§25).
Today the server peer holds your tables in a SQLite database you can `SELECT`
from with Drizzle; Postgres is the next step, not the current one.

This is the materialiser every other engine has — Zero's replicator,
LiveStore's `materialize-event` — and the one legitimate consumer of the engine's
fold notification on the server. Not app code: the thing that writes rows.

### 13.3 · Authority

```ts
setPolicy(engine, "org:acme", schema.policy)   // permissions deploy by SYNC, not by release
correct(engine, { event, table, key, reason, author, partition }, fix)   // §9d
```

Both need a grant carrying role `"authority"`; `_policy` and `_corrections` are
deny-all, so the authority bypass is what admits them.

### 13.4 · The relay

Store-and-forward of **signed bytes**, holding no keys — it can drop traffic but
never forge. Rooms, per-author cursors, paged catch-up (2,000 events/frame,
grants first), durability acks, an opaque grant store, a verify-on-put blob
store, per-socket backpressure.

**Its room log is an `EventStore`** — the same port every peer uses, because the
relay *is* a peer — and it is **durable by default**:

```ts
startRelay(5198)                                   // room logs at .syncmesh/relay/<room>.db
startRelay(5198, { dataDir: "/data" })
startRelay(5198, { store: (room) => sqliteEventStore(openBunSqlite(`/data/${room}.db`)) })
startRelay(5198, { store: () => memory() })        // explicit, like everywhere else
```

A relay restarted over the same file serves the old events on catch-up and keeps
the same `epoch` — the room's lineage id is persisted alongside the log, so a
visibility token issued before the restart still means what it meant.

**The room logic is host-agnostic.** `RelayRoom` owns ingest, catch-up, fan-out
and backpressure against an `EventStore` and a socket that can `send`, so the
same code runs under any host:

```ts
import { RelayRoom, type RelaySocket } from "syncmesh/relay"

const room = new RelayRoom({ name: "acme", store: sqliteEventStore(driver), keepaliveMs: 15_000 })
room.join(socket, msg)      // { t:"join", cursors }  → hello + paged catch-up. binds the socket.
room.message(socket, raw)   // event · grant · blob-put · blob-get · desire · undesire
room.drain(socket)          // flush backlog after backpressure
room.leave(socket)
room.epoch                  // the lineage id

interface RelaySocket { send(data: string): number | void; close?(): void }
```

| Host | What it adds | Status |
|---|---|---|
| **Bun** — `startRelay` | `Bun.serve` upgrade + websocket callbacks → `RelayRoom`, ~90 lines | built |
| **Durable Object** | `webSocketMessage/Close` → `RelayRoom`; storage via `doSqliteDriver(ctx.storage.sql)` | driver built; the DO class itself is yours to write, ~30 lines |
| **Rivet actor** | same shape as a DO | **not adaptable yet** — Rivet reaches SQLite through Drizzle, async; needs an async driver port (§25) |

The actor hosts get durability, single-writer-per-room, WebSocket hibernation and
multi-region from the platform. Because the platform routes every socket for a
room to one actor, **there is no fleet problem and no Redis** in that shape.

### 13.5 · A fleet — several relays, one room

When the relay is your own process and you run more than one, instances must
hear each other. That is a **fan-out port**, not a new concept:

```ts
interface Fanout {
  publish(room: string, frame: string): void
  subscribe(room: string, cb: (frame: string) => void): () => void
}

startRelay(5198, { fanout: redisFanout({ client: redis }) })     // client: { publish, subscribe }
startRelay(5198, { fanout: memoryFanout() })                      // one process, tests
```

`redisFanout` takes any client with `publish(channel, message)` and
`subscribe(channel, onMessage)` — ioredis has both natively, and nothing is
imported. On ingest a relay appends locally, then `publish`es; every other
instance `subscribe`d to that room ingests the frame (dedup makes double
delivery a no-op) and fans it to *its* sockets. Pub/sub is **best-effort** and
correctness never depends on it: a test drops every fanout message and shows the
clients' cursor exchange recovers all of them (§9b). NATS or Postgres
`LISTEN/NOTIFY` fit the same port.

## 14 · Deployment — the three shapes

The device side (§8b) and the Postgres side (§13.2) are identical in all three.
Only the middle changes.

### A · Your existing server is the relay — zero extra deployments

```
 phone A ──ws──┐
 phone B ──ws──┤        ┌─ your backend process (Bun / Node) ──────────────────┐
 phone C ──ws──┘        │  startRelay(5198)          room log: sqliteEventStore  │
        ▲               │    ingest → dedup(peer-seq) → append → ack → fan-out   │
        │ BLE           │                                                        │
 phone A ◄──► phone B   │  createMesh({ grants: authority,                       │
                        │               transports: [Relay("ws://localhost:5198")],
                        │               stateStore: drizzleStateStore(db, tables) })
                        │    receiveWire → verify → admit → fold → UPSERT Postgres│
                        │                                                        │
                        │  your app: SELECT … · cron · reports · joins           │
                        └────────────────────────────────────────────────────────┘
```

Two function calls inside the server you already run. This is the minimum.

### B · A fleet, Redis between instances

```
 phones ──ws──► LB ──► relay-1 ─┐              each: room log = sqliteEventStore
 phones ──ws──► LB ──► relay-2 ─┼── Redis ──┐        ingest → append → PUBLISH room
 phones ──ws──► LB ──► relay-3 ─┘  pub/sub  │        on message → fan-out to MY sockets
                                            │
   Redis = a TRANSPORT between relays,      │  best-effort. a missed message is
   not the relay. optional: Redis Streams   │  re-requested by cursors — correctness
   as the shared room log (Iris).           │  never depends on pub/sub.
                                            ▼
                     authority peer: createMesh + Relay(any instance) → Postgres
```

### C · One actor per room — Rivet or Durable Object

```
 phone A ──ws──► edge ─┐
 phone B ──ws──► edge ─┼──► actor "room:acme"      the platform routes every socket
 phone C ──ws──► edge ─┘    ┌────────────────┐     for a room to ONE actor →
                            │ RelayRoom      │     no fleet problem, no Redis
                            │ same code as A │
                            │ SqliteDriver → ctx.storage.sql (DO) / Rivet SQLite
                            └────────────────┘
                                    ▲
                     authority peer: createMesh + Relay("wss://…/room:acme") → Postgres
```

Durable, single-writer per room, hibernating WebSockets, multi-region — from the
host. `RelayRoom` is the same code in all three; the host is ~30 lines each.

### The Postgres side — every shape

```
authority mesh: receiveWire → verify sig → grant → policy → dedup → fold
                                                              │
                                stateStore.commit(rows, cursors)
                                                              ▼
                                drizzleStateStore → UPSERT jobs / sites / photos
                                                              │
                                your Postgres ◄───────────────┘
                                   SELECT · joins with private tables · cron · reports

reverse (something ELSE writes Postgres) → CDC, RFC-0021, one-way, read-only on devices
```

### Reconnect — every shape

```
phone → { join, cursors }        "I hold up to seq N from each author"
relay → { catch-up, pages… }     what you lack, grants first
phone → { event } × N            what THEY lack — your offline writes
```

Symmetric. No shape-specific reconciliation, because the relay is a peer.

### Built vs. designed, by shape

| | A · embedded | B · Redis fleet | C · actor |
|---|---|---|---|
| device path | ✅ | ✅ | ✅ |
| relay ingest / fan-out / catch-up | ✅ `RelayRoom` under Bun | ✅ | ✅ `RelayRoom`; the DO class is ~30 lines of yours |
| durable room log | ✅ sqlite, default | ✅ | ✅ `doSqliteDriver`; Rivet needs an async port |
| cross-instance fan-out | n/a | ✅ `redisFanout` | n/a — platform routes |
| `drizzleStateStore` → your DB | ✅ sqlite-backed Drizzle | ✅ | ✅ |
| → **Postgres** | async state port `[design]` | same | same |

## 15 · The wire — what actually travels

Everything a peer sends is **canonical CBOR, signed, and byte-frozen**. Two ports
in different languages must produce identical bytes, which is why the encoding is
specified rather than incidental.

### The event core — seven keys, integer-keyed

```
key 0  v          uint    format version, pinned to 1; a decoder REFUSES anything else
key 1  peerId     bstr    raw 32-byte Ed25519 public key (not hex on the wire)
key 2  seqNum     uint    this author's monotonic counter
key 3  hlc        [uint, uint]   [physicalMs, logical]
key 5  procedure  text    provenance label — NEVER executed on apply
key 6  partition  text    "kind:id". OPTIONAL — omitted entirely for pre-M6 events
key 7  changes    array   [{ 0: kind, 1: table, 2: key, 3: data }]
                          kind: 0 insert · 1 update · 2 delete
```

Key 4 is unused and reserved. **Absent optionals are skipped, not encoded as
null** — that is the canonical rule that lets a pre-partition event keep its
frozen byte shape while a partitioned one adds a key.

Map keys are written in ascending order; object keys inside `data` are sorted.
Two encoders that disagree on ordering produce different signatures over the
same logical event, so ordering is part of the contract, not an implementation
detail.

### The envelope

```
wire = [ core, sig ]     // CBOR array of two byte strings
sig  = Ed25519 detached signature over the core bytes, by the author's device key
```

The signature covers the **received bytes**, not a re-encoding — which is what
lets a relay or a peer re-forward an event **byte-identically** without holding
any key. It is also why an upcaster (if we ever add one) must run at *fold* time
and never at decode time: rewriting the bytes would invalidate the signature.

Grants use the **same** `[core, sig]` envelope, so they ride any transport that
can carry an event.

### Verify before anything

```
decode → verify signature → grant lookup → policy → dedup → merge → fold
```

A malformed frame costs one decode; a forged one costs one signature check.
Neither allocates durable state. This ordering is the reason a hostile peer
cannot make you spend disk.

### Conformance vectors — the cross-language contract

`conformance/vectors.json` freezes real events as hex:

```json
{
  "peerId": "9da891814f903cea…",
  "vectors": [
    { "description": "notes.create seq=1", "coreHex": "a6000101582…", "sigHex": "9c310f15…" }
  ]
}
```

A Rust or Swift port is correct when it reproduces these **byte for byte**. That
is the actual definition of "compatible" — not a spec document, a file of bytes.

**Consequence for every design decision in this API:** anything that changes
encoding invalidates every event in every existing log. That is why the Drizzle
type mapping is called a frozen artifact, why `t.uuid()` is a validated string
rather than 16 bytes, and why `counter` waits for a version story.

## 16 · The engine — the whole surface

`mesh.engine` is the escape hatch. Everything above is built on these, and
reaching for them means doing something the mesh does not yet do.

```ts
import { Engine, createValidator, sqliteEventStore } from "syncmesh"
import { openBunSqlite } from "syncmesh/storage/bun"

const engine = new Engine({
  identity,
  store:      sqliteEventStore(openBunSqlite("./app.db")),
  snapshotEvery: 5_000,
  undoDepth:  50,
  merge:      schema.merge,
  validate:   createValidator(schema, grants.grantFor),
})
```

`createMesh` builds exactly this for you; construct one by hand only to drive it
from a test or a tool.

**Writing**

```ts
engine.mutate(procedure, (tx) => { … }, { partition?, local? })  // → Result<SyncEvent, MutateError>
engine.revert(eventId)          engine.canRevert(eventId)        // needs undoDepth > 0
```

**Reading**

```ts
engine.row(table, key)          engine.rows(table)               engine.rowsIn(table, partition)
engine.eventLog()               engine.eventCount()              engine.now()
```

**Receiving**

```ts
engine.receiveWire(bytes)                 engine.receiveWireBatch(wires)
engine.receiveChunk(bytes)                // → Result<number, EngineError>
```

**Sending**

```ts
engine.wireFor(event)                     // → the exact signed bytes, or null
engine.wireEventsSince(theirCursors, interest?)
engine.eventsSince(theirCursors, interest?)
engine.chunkSince(afterSeq)               // → one signed chunk, or null
```

**Cursors and durability**

```ts
engine.cursors()                          // → Map<PeerId, seqNum>
await engine.synced(eventId, { minAcks, timeoutMs })   // → Result<void, SyncTimeout>
```

**Snapshots** — §18. **Compaction** — §19. **Digests and repair** — §9c.

**Observing**

```ts
engine.onFoldBatch((b) => { b.writeTables; b.writeKeys; b.source; b.eventCount })
engine.onOutbound((e) => radio.send(e))   // every locally-authored event
engine.onError((err) => report(err))      // typed quarantine reasons
```

`onFoldBatch` fires **once per batch**, not per event — a 5,000-event catch-up is
one notification, which is what keeps a burst to one render.

## 17 · Anti-entropy — how two peers actually converge

There is no master, no leader election, and no ordering service. Two peers state
what they have and each sends what the other lacks. That is the whole protocol,
and it is identical over BLE, WebSocket, or a loopback in one process.

The whole protocol fits in a test double — two engines in one process, with an
offline switch — which is what every convergence test in the repo uses:

```ts
import { Link } from "syncmesh"
const link = new Link(a, b, { grantsA, grantsB })
link.setOnline(false)  …  link.setOnline(true)  link.catchUp()   // → { aApplied, bApplied }
```

### Cursors

A cursor map is `peerId → highest seqNum held from that author`. It is the entire
state of a sync relationship — there is no session, no subscription list, no
server-side per-client bookkeeping.

```ts
engine.cursors()                                   // what I have
engine.wireEventsSince(theirCursors, interest?)    // what you are missing
```

Because cursors are per-**author** rather than per-connection, a peer that
learned an event from *anyone* never asks for it again. That is what makes
multi-hop gossip cheap: the third device to hear something asks nobody for it.

**Today they are MAX cursors**, which means a dropped event leaves a hole the
cursor advances past. RFC-0013 calls for contiguous cursors so a hole stays
visible; that is unbuilt, and it is the prerequisite for quarantine-with-retry.

### Interest — asking for less than everything `[design]`

The engine can filter what it sends by an *interest* — partitions, tables, a time
floor, a per-table row predicate — so the **sender** drops bytes before they reach
the radio, which is the only place filtering saves anything on a 24 kbps link:

```ts
engine.wireEventsSince(theirCursors, {
  partitions: ["site:s17"],
  tables: ["tasks", "photos"],
  since: Date.now() - 30 * 86_400_000,
  where: { tasks: eq("status", "open") },      // predicates are DATA, so they can cross a wire
})
```

**Nothing sends one yet.** `join` carries `room` and `cursors` only, `Link` and the
framed bridge exchange bare cursors, and `createMesh` has no way to declare an
interest — so today every peer receives everything for its room, and the filter is
reachable only by driving the engine by hand. Carrying an interest on the wire is
RFC-0019's scoped join, unbuilt. Until then the predicate builders (`eq`, `and`,
`isIn`, …) are not part of the app surface.

### Grants travel first

On every connect, before any event. An event from an author whose grant you do
not hold quarantines on `NoGrant` — so ordering here is not an optimisation, it
is correctness. Both `Link` and the relay do this, and `FrameTransport.resync()`
re-runs it after a radio comes back in range.

## 18 · Joining — snapshots, chunks, and scope

A device joining a room that holds 300k events should not replay 300k events.

### State, not history

```ts
const snap = engine.snapshotFor({
  interest: { tables: ["tasks"], partitions: ["site:s17"] },
  window: [{ table: "tasks", sortBy: "dueAt", dir: "desc", limit: 500 }],
})
// → { rows: Array<{ table, key, rec }>, cursors }

peer.installScopedSnapshot(snap)   // merges by stamp, adopts cursors, ONE fold batch
```

`installScopedSnapshot` merges **stamp-respectingly** (`mergeRecord`), so it is
safe on a device that already holds data and two overlapping snapshots commute.
Adopting `cursors` is the saving *and* the risk: a snapshot must be COMPLETE for
its scope, or the missing rows are missing forever.

```ts
engine.snapshot()                  // → { tables, cursors } — everything
engine.installSnapshot(snap)
```

### Chunks

```ts
const chunk = engine.chunkSince(afterSeq)   // → Uint8Array | null, signed
peer.receiveChunk(chunk)                    // → Result<number, EngineError>
```

One signed unit covering a run of events — cheaper than per-event signatures over
a slow radio.

### What is NOT built

Snapshots have **no wire message**. `snapshotFor` / `installScopedSnapshot` are
in-process only, so every join that crosses a network today is paged event
catch-up (§9b). RFC-0019 specifies the manifest-plus-chunks protocol; it is
unbuilt, and it is the largest gap between a documented strategy and a reachable
code path.

## 19 · Compaction and retention

A phone is a full replica with finite disk. The log must be bounded, and the
bound must never lose data a peer still needs.

```ts
const dropped = engine.compact([peerACursors, peerBCursors, relayCursors])
```

The floor is the **per-author minimum across every supplied cursor map** — drop
only what *everyone listed* has acknowledged. Supply fewer maps and you compact
more aggressively at the risk of a peer having to re-bootstrap.

**Clamped to the persisted snapshot.** Compaction never goes past what a snapshot
covers, so a restart can always rebuild: boot is snapshot + tail, never a
full-log refold.

```ts
new Engine({ …, snapshotEvery: 5_000 })   // persist a hot-tier snapshot every N events
```

**Consequences to design around:**

- **A device cannot rebuild from its own log after compaction** — the tail is gone
  by design. That is why RFC-0014's rung 6 (re-bootstrap via the snapshot join)
  exists, and why local corruption is a snapshot problem rather than a replay one.
- **`history()` is bounded by the log** (§8) — it reaches exactly as far back as
  compaction has left, and does not pretend otherwise.
- **A dead peer pins the floor.** A device that never returns freezes `ackFloor`
  forever. Evicting it from the known-peer set has data-loss teeth, and choosing
  the policy is an open question in RFC-0015.

**Not built:** automatic ack floors derived from peer cursor exchanges, and
`keepAtLeastDays`. Today the caller supplies the maps.

## 20 · Routing — why a second radio does not slow you down

Like §21, this is not something you call. It is why sending is not stupid once a
device has two transports open.

**When it matters: only when a narrow radio and a wide one are open at once.**
With one transport there is nothing to choose. Today that is every device — the
relay is the only transport and BLE is not ported — so this is **dead code until
RFC-0006 lands**, which is why it is wired to nothing and the engine sends on
every link.

Once a phone holds both, the problem is concrete: BLE is ~24 kbps. A 2 MB photo
blob pushed over it is eleven minutes of blocked radio, during which nothing else
converges — while a relay would have taken a second. Equally, a 64-byte presence
update should not pay the relay's 180 ms round trip when a peer is two metres
away.

So the send path scores each candidate against the message:

```ts
scoreRoute({ id: "ble", online: true, direct: true, bandwidthBps: 24_000, mtu: 512 },
           { bytes: 64, urgent: true })     // → high
scoreRoute({ id: "ble", … }, { bytes: 2_000_000 })   // → low; the relay wins
```

The bias, in order: an **offline** candidate is never picked; a **direct** link
beats a relayed one (a mesh should not touch the cloud when it does not have to);
a **costly** path is penalised heavily unless the message is `urgent`; large
payloads avoid narrow pipes. `redundancy` fans out best-first when a message is
worth sending twice.

It is a **pure function** — no clock, no state, no I/O — so the choice is
testable, deterministic, and identical on every device. That matters less for
correctness than for debuggability: a routing decision you cannot reproduce is a
bug you cannot find.

**What is missing to wire it:** every outbound message needs a traffic class
(`live` / `bulk` / `presence` / `snapshot`) attached where it is created, so the
send path has a `bytes` and an `urgent` to score with. That is RFC-0012's work and
lands with the second transport.

## 21 · Incremental view maintenance — why two things are fast

IVM is not a feature you call. It is the answer to one question asked in two
places: **"what changed about the answer?"** rather than **"what is the answer
now?"** — because only the first form is cheap to render, and only the first form
can go on a wire at all.

### On the client: rendering

With 200 live queries open, recomputing each on every write means re-filtering and
re-sorting whole tables, repeatedly. Instead `LiveQuery` keeps the full filtered
result in sort order plus a key index; a fold batch hands it the exact keys
touched, and per key it decides **enter / leave / move / update-in-place**,
binary-searching for position.

Cost is O(changed · log n) rather than O(n log n). A full scan happens only on
first run, a spec change, or a batch whose keys cannot be attributed. The safety
invariant — a maintained result must equal what a full re-run would produce — is
property-tested against a re-run oracle over randomised operation sequences.

That is what makes a 5,000-event catch-up **one render** instead of a freeze.

You never touch this. It is what `useLiveQuery` is.

### On the relay: serving rows

A relay with 500 subscribed clients cannot recompute each client's query per event
and ship whole result sets. It needs **patches**, and it needs refcounting so a row
shared by six queries is sent once and evicted at zero references.

```
client → { t: "desire",   hash, q }
client → { t: "undesire", hash }
relay  → { t: "rows", patch }
```

This is the only thing the operator engine in `src/ivm` exists for — its single
consumer in the product is the relay's `ClientView`. It is machinery, not API.

Note what it costs architecturally: a relay serving queries **holds materialised
state**, which departs from "the relay executes nothing". It still cannot forge —
it holds no keys and folds the same signed events every client folds — but it is a
second product lane sharing a codebase, and should be read as one.

**Server half only** `[design]`. There is no client counterpart, so the row path is
reachable only by hand-writing frames; and `ClientView` emits patches with no epoch
and no monotone id, so a reconnect can only `clear()` and re-desire everything.
Both are RFC-0020 N3a/N3b.

### Predicates — data, so they could cross a wire

The same predicate language (`eq`, `and`, `isIn`, …) is what an *interest* (§17)
and a relay row subscription (`desire`) carry. It is data rather than a closure
precisely so it can be serialised. Today nothing on the app surface sends either,
so the builders are internal; they become public with the scoped join (§25).

## 22 · Blobs — bytes that do not belong in a log

BLE runs at 3–50 KB/s with a 128 KiB reassembly cap. A megabyte photo in the
event log would block convergence for everything else, and it would be replicated
to every peer forever.

```ts
const bytes = await compress(await camera.capture())
const put   = mesh.blobs.put(bytes)         // → Result<hash, NoSuchCapability>
if (put.isErr()) return offlineOnly()       // no transport carries a blob channel

photos.insert({ id: crypto.randomUUID(), taskId, hash: put.value,
                thumb: await thumbnail(bytes), takenAt: Date.now() })

const got = await mesh.blobs.fetch(hash, { timeoutMs: 5_000 })
// → Result<Uint8Array, BlobCorrupt | BlobNotFound | BlobTimeout>
```

The row carries the **hash** (`hashOf(bytes)`, sha-256); the bytes travel out of
band. Content-addressing is what makes that safe: the relay verifies **before**
storing, so junk cannot squat a hash, and the client verifies on fetch. Neither
has to trust the other. A raw radio has no blob channel, and `NoSuchCapability`
is a fact about the medium rather than a missing feature.

**Not built:** a persistent local blob store (memory only today), range fetch,
refcount GC over live rows, and per-partition quotas. RFC-0015 has the open
questions — chiefly *who is obliged to keep a blob*, and what happens when a
delete races an offline reference.

## 23 · Transport lifecycle — starting, stopping, switching

```ts
const mesh = createMesh({
  …,
  transports: [new Relay("wss://sync.example.com", { room: "acme" }), new Ble()],
})

mesh.transports                      // → readonly Transport[]
mesh.running                         // → boolean
mesh.stop()                          // stops every transport; engine and log stay intact
```

Each transport is `start(ctx)`-ed **once per storage scope**. With `storeFor`,
one engine exists per top-level instance, so `new Relay(...)` is started once per
org and its room name is scope-qualified (`acme/org:acme`) — two tenants never
share a channel.

### Status, per transport

```ts
for (const t of mesh.transports) {
  t.onStatus?.((s) => badge(t.name, s))   // "connected" | "disconnected"
}
```

`onStatus` is optional because not every medium can tell. A relay knows; a BLE
radio between advertisements often does not, and inventing a value would be worse
than admitting the gap.

### Reconnecting a radio

```ts
class Ble extends FrameTransport {
  onNativeReconnect() {
    this.resync()      // grants FIRST, then cursor catch-up
  }
}
```

Frames dropped while out of range are simply gone — there is no per-frame
retransmit. `resync()` re-runs the handshake, and the cursor exchange discovers
exactly what was missed. That is why losing frames is cheap and losing them
*silently* is not (§9, the `send` contract).

### Running several at once

Every transport subscribes to `engine.onOutbound`, so an event goes out on all of
them, and inbound dedup (`peerId-seqNum` plus per-column stamps) makes double
delivery a no-op. **Convergence does not depend on which link delivered first** —
which is what makes adding a second radio safe rather than a coordination problem.

Until `pickRoutes` is wired (§20), that is also literally what happens: every
message on every link.

### What is NOT built

**Transports are fixed at construction.** There is no `mesh.addTransport()` or
`mesh.removeTransport()`, so "switch from relay to BLE when the user goes into a
tunnel" means constructing a new mesh — which is wrong, because the engine and
its store would be rebuilt too.

The shape it wants is small and is not blocked by anything:

```ts
mesh.transports.add(new Ble())        // [design]
mesh.transports.remove("relay")       // [design]
```

Also absent: `mesh.start()`. Engines and their transports start eagerly at
construction, so there is a `stop()` with no matching `start()`. Asymmetric, and
worth fixing at the same time.

## 25 · Not built yet

Everything above that is untagged runs. These do not:

| | Where |
|---|---|
| `defineSchema` — the one-argument manifest with bound `allow` combinators. Today: `defineSync(tables, config)` and untyped `role("…")` / `owner("…")` | §3 |
| **Async `StateStore` and `SqliteDriver` ports** — what stands between `drizzleStateStore` and Postgres, and between `RelayRoom` and a Rivet actor. Every Postgres Drizzle driver is async; the engine's boot is sync | §13.2, §13.4 |
| Relay store methods `peers()` / `allWithSigs()` — catch-up does one `sigOf` per event and room construction scans the log to seed cursors | §13.4 |
| Type-level narrowing of collection verbs from a `deny` rule | §8 |
| `mesh.transports.add/remove`, and a `mesh.start()` to match `stop()` | §23 |
| `new Ble()`, `new WifiAware()` — the port is done, the radios are not | RFC-0006 / 0007 |
| `pickRoutes` wired into the send path — needs a traffic class per message | §20, RFC-0012 |
| Interest on the wire — the engine filters by it, nothing sends one; and snapshot over the wire — so every network join is paged catch-up of everything in the room | §17, §18, RFC-0019 |
| Contiguous cursors — MAX cursors let a dropped event leave an invisible hole | §17, RFC-0013 |
| Schema evolution — additive-only rule + `unknownHandling` knob | RFC-0013 |
| `onConflict("counter")` / `("set")` — need a delta-carrying change kind, so RFC-0013 first | §4b |
| Automatic ack floors + `keepAtLeastDays` — the caller supplies cursor maps today | §19, RFC-0015 |
| Persistent blob store, range fetch, refcount GC, quotas | §22, RFC-0015 |
| Digests piggybacked on the catch-up frame — the primitives exist, nothing calls them | §9c, RFC-0014 |
| Thin client for the relay's row path, and versioned row patches | §21, RFC-0020 |
| Presence / ephemeral tier | RFC-0020 §6 |
| Change data capture — sync an existing Postgres into the mesh | RFC-0021 |
| Revocation propagation — `revoke()` is local-only | RFC-0016 |
| Relay hardening: origin allowlist, frame caps, rate limits, retention | RFC-0017 |
| Telemetry seam | RFC-0011 |

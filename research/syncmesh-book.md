# Syncmesh: the whole system in one file

Status: **the book**. This file supersedes the split corpus (`api-v3-surface.md`,
`ultimate-spec.md`, `api-v3-walkthrough.md`, `keep-refine-build.md`, `ditto-comparison.md`)
as the single reading; those files remain as history and deep-dive detail (protocol depth —
recovery algorithm internals, retention rules, snapshot manifests, idempotency horizons —
stays in `proposed-node-api-and-recovery.md`). Everything here is **IN or NEVER**; "later"
does not appear. What is present is specified to work; what is absent is absent by principle,
with the principle recorded where it died.

**The contract in one paragraph.** An app constructs one object and calls procedures on it:
`client.products.list(input)`, `client.products.create(input)`. Construction names no tenant,
no workspace, no shop — scope is a question, questions ride in inputs, and authorization is
the schema's rules plus the session, enforced identically on every peer. Reads return
descriptors that adapters consume; writes are statements whose effects the app watches
reactively; every failure is a typed error value; what lives on a device is decided by grants
over whole partitions; and the durable machinery underneath — operations, receipts, recovery,
routing — is reachable through a small `$`-surface when a screen or an operator needs it, and
invisible otherwise.

**How to read this book.** Part One is the model — the physics everything else obeys. Part
Two is the one shared definition (errors, schema, procedures). Part Three is the client an
app developer touches. Part Four is trust; Part Five is movement; Part Six is the server.
Part Seven walks one real app through every tier and traces its pipelines. Part Eight maps
the specification onto the code that already exists — keep, refine, build, cut. Part Nine is
the codex: the rules, the NEVERs, the inventory, the glossary.

---

# Part One — The model

## Chapter 1. The event log

Every write anywhere in the system is an **event** in its author's append-only log, numbered
`(author, seq)` and signed. That one sentence is the system; the rest of this book is its
consequences. The log's physical shape — Postgres on the server, the same logical shape in
SQLite on every device, and that symmetry *is* the design:

```sql
CREATE TABLE event_log (
  scope    text        NOT NULL,  -- partition: 'shop:lagos-01'
  author   text        NOT NULL,  -- device key id, stable per install
  seq      bigint      NOT NULL,  -- contiguous per author, no gaps ever
  ts       timestamptz NOT NULL,  -- author clock (HLC), LWW tiebreak per cell
  op_id    text        NOT NULL,  -- operation record this write belongs to (ch. 10)
  "table"  text        NOT NULL,
  row_id   text        NOT NULL,
  cells    jsonb       NOT NULL,  -- column → value, or {"+": n} for counter columns
  reason   text,                  -- present only on corrections (ch. 20)
  sig      bytea       NOT NULL,  -- author's signature over everything above
  PRIMARY KEY (author, seq)
);
CREATE INDEX event_log_scope ON event_log (scope, author, seq);
```

Note what is deliberately **not** there: no procedure name to re-execute, no handler code
reference, no "applied" flag, no server-assigned anything. The handler that produced this
event ran once, at origination (ch. 2); receivers verify and merge, never re-run. `(author,
seq)` makes delivery **idempotent** (a duplicate is a skip) and **carrier-independent**
(phone B can carry phone A's events to the server without the server caring who brought
them). The signature makes it **trustable across any path**: a relay that forwards the
author's original bytes never invalidates it.

Identity is always client-generated — there is no server-assigned id mode, ever: a
human-facing number (invoice #, room #) is ordinary **data** the authority fills through a
watch (ch. 20) — a nullable column, not an id policy, and never a hidden temporary primary
key. **The generator is the app's own column default, not the framework**: an app-side
`$defaultFn` on the primary key (`v7` from the `uuid` package, `randomUUID` from
`expo-crypto`, CUID2 — the app's choice of format), called by Drizzle's insert path in the
device's own process at origination. Syncmesh ships no id generator and takes no id config;
it checks exactly one property at schema construction — **the id could have been born
offline** — refusing `serial`/auto-increment (a database sequence cannot exist in a dead
zone) and SQL-side defaults like `gen_random_uuid()` (that expression runs in Postgres, but
the row is born in the phone's SQLite), each with an error naming the fix. `id` is optional
in derived inputs: supply one when a flow needs it before the write, omit it and the default
fires. Database defaults run at origination only and their values enter the event and the
operation record — which is all idempotent retry ever needs; receivers never rerun them.

## Chapter 2. The fold, not a replay

**Replication is a fold, not a replay.** A mutation's handler runs **once**, at origination,
on the device that made the write; what replicates is the event it became — table, row key,
cells, stamps, author, signature. Every receiver — phone, server, browser tab — admits the
event through the same pipeline: verify the signature and the author's grants, check the
schema's rules (`allow`, immutable fields, types), merge by the table's declared semantics,
and materialize the surviving cells into its own tables. Rerunning handlers would be wrong,
not merely wasteful: a handler re-executed later, elsewhere, with other clocks and other ids
**diverges**, while the fold of the same events **converges from any order**. That is why the
server needs no per-table ingestion code: the schema compiled the mapping, and a listening
transport is the door events arrive through.

Merge is per column, declared in the schema (ch. 6), and there are exactly two semantics:

- **`lww`** — last-writer-wins by stamp `(hlc, author)`, the default.
- **`counter`** — a PN-counter: writes are increments (`set({ stock: increment(-2) })`), the
  event carries `{"stock": {"+": -2}}`, and the fold sums per-author contributions. A counter
  cell is a map `author → running contribution`; its join is per-author max (each author's
  log is ordered, so a later contribution subsumes earlier ones); its read is the sum.
  Concurrent +1/+1 folds to 2 on every holder. Inventory counts merge *wrong* under `lww`,
  which is why the schema names the exceptions.

**Why not Zero's model?** Zero (Rocicorp) deliberately runs one mutator on *both* sides:
optimistically on the client, then authoritatively on the server's push endpoint, with queued
offline mutations replayed in order and the client's optimistic state rebased. That is
correct **for a star topology** — Zero clients never talk to each other, so "server state +
my pending mutations, rebased when the server speaks" is cheap. It is impossible for a mesh:
syncmesh phones fold each other's writes over BLE for weeks with no server, so a later server
replay computing different results would force every peer that already folded to rebase
transitively — the P2P edge and server replay are mutually exclusive. Same guarantee,
different mechanism: Zero re-executes code; syncmesh re-checks **data** (the fold), gates
what must be preemptive (ch. 7's `.authority()`), and repairs the rest (watchdogs +
corrections, ch. 20).

The reason syncmesh cannot take Zero's "permissions are just server code" position is one
sentence: **checks live where writes are seen first.** In Zero the server sees every write
before any other client, so imperative server code suffices. In syncmesh a BLE peer may fold
your write weeks before any server — so the checks peers run must be declarative data rules
(`allow`, immutables, merge) that ship to everyone, and imperative server code is left
exactly two seats: before the event exists (the gate) or after the fold (the watchdog). A
fold-time veto — refusing to fold an event other peers already folded — is the one option
that does not exist, because it is divergence by construction.

## Chapter 3. Partitions and custody

**Scope is input, never construction.** A client is constructed once and knows no tenant,
workspace, or shop. Any shape that binds a scope at construction —
`createClient({ instance: session.org })`, or its app-layer twin, one client instance per org
in a map — is rejected for one reason: a scope ID is ordinary **data**, and data changes
without reconstruction. The kept shape passes the scope with every call:

```ts
const products = client.products.list({ shopId: selectedShop.id });
client.products.create({ shopId: selectedShop.id, name: "Desk lamp", priceCents: 4900 });
```

- Which scopes exist for this caller is **discovered** — session, grants, an ordinary
  procedure like `client.shops.list({})` — never declared.
- Switching scope is new input ⇒ new query identity ⇒ new subscription and new collection.
  No shared mutable "current shop" anywhere.

**A scope ID in an input is a claim, never a capability.** Naming a shop grants nothing:
every peer that folds the resulting event checks the claim against the author's grants and
the schema's rules — the same evaluation everywhere. Scope can travel freely in inputs
*because* carrying it proves nothing.

**The partition is the unit of custody — held whole, or not at all.** (Custody, not
"presence": `$presence` is who is reachable; custody is what lives here.) A device holds,
entire, the partitions its grants name: the grant *is* the declaration of what lives here,
and every holder of a partition folds the same events to the exact same state — **the
invariant everything else stands on**. A query never triggers replication; it answers from
what custody already holds, and `coverage` (ch. 9) says honestly how much of the world that
is.

**Replica state is never query-shaped.** A filtered projection of a log does not fold to
identical state, so a device that folds may not hold a subset of a partition it claims —
that is a NEVER. Distinct from it, and allowed, is **transfer narrowing**: a peer may ask a
sender for some of its granted partitions now and others later — a request that shapes which
bytes travel, at partition granularity and no finer, never a permission and never a claim to
hold less than all of what it accepts. The row- and table-level interest machinery in
today's code is not carried forward (ch. 26); narrowing below the partition is the NEVER
above wearing transport clothes.

The tell, from the Ditto study: **Ditto needs query subscriptions because Ditto has no
partitions** — one database per app, so the query is their only knife. Syncmesh's knife is
the schema: `partition: shop` already exists, and "a 1 GB catalog on a clerk's phone"
means the partition is drawn too coarse — a partition per shop, per ward, per region,
granted precisely. Genuinely-global reference data that is too big for edges is
authority-`query` territory (ch. 7), or drawn finer. Scale answers every sizing question
with the same knife: finer partitions, granted precisely.

**Storage layout matches the model.** One store per partition (the *replica*: its own file,
credentials, coverage, recovery state), so leaving one is closing and deleting one file
(ch. 13). Opening, routing reads and writes to, and recovering these replicas is the
client's job, keyed by the scope already present in input and rows. The public API mentions
replicas nowhere; `$status` and `$recovery` aggregate across them and name the scope in
their reports.

## Chapter 4. Convergence: how everybody catches up

A node holds the events it has admitted — its own and everyone else's — plus the tables
folded from them. When any two nodes link (phone–server over WebSocket, phone–phone over
BLE), they exchange **cursors**: maps of *author → highest contiguous seq I hold*. Each side
then streams exactly what the other lacks, **in both directions at once** — the phone's
offline Tuesday goes up, the office's corrections and the other devices' edits come down, in
the same session. Catching up is not a mode — it is the same exchange with a bigger gap. A
brand-new device is cursor zero everywhere and receives history, or a **verified checkpoint
plus the tail** where history has been compacted. No procedure is involved anywhere in this:
procedures are how *this* node asks questions and makes writes; the exchange beneath them
moves only events.

**A real Tuesday, concretely.** Amara's phone is BLE-only in the stockroom; Bola's is on
Wi-Fi at the counter. The rows that exist after the morning:

| author | seq | row_id | cells | born from |
|---|---|---|---|---|
| dev_amara | 41 | prod_9metq | `{"name":"Blue Bic Biro","price":150,"stock":{"+":24}}` | `addProduct` |
| dev_amara | 42 | prod_9metq | `{"stock":{"+":-2}}` | `recordSale` |
| dev_bola | 17 | prod_9metq | `{"price":90}` | `setPrice` — a typo |
| dev_bola | 18 | prod_9metq | `{"stock":{"+":-1}}` | concurrent sale |
| srv_authority | 305 | prod_9metq | `{"price":120}` + `reason:"below category floor 120"` | `priceFloor` watchdog |

Every holder folds the identical row in any arrival order: `name` from the one writer;
`price` = 120 (`lww`, latest wins — the correction is just the newest write, carrying a
reason); `stock` = 24 − 2 − 1 = **21**, because `counter` sums increments per author — the
cell where `lww` would silently eat a sale.

Amara and Bola link over BLE and exchange cursors:

```
Amara → Bola:  { dev_amara: 42, dev_bola: 15, srv_authority: 290 }
Bola  → Amara: { dev_amara: 40, dev_bola: 18, srv_authority: 305 }
```

Amara's 41–42 go over; Bola's 16–18 *plus the server's 291–305* come back — so Amara's
screen shows the corrected price, reason attached, without her ever touching the internet.
Bola later carries Amara's events to the server (a **courier**); the server admits, folds,
commits — and that commit wakes every open session to push its peer's gap (ch. 21). If Amara
later syncs with the server directly, her 41–42 are duplicates → skipped. Nobody tracks who
carried what.

**There is no broadcast.** A node never sends anything "to everyone"; it answers each open
connection's gap. Its state is signed events keyed `(author, seq)` plus, per connected peer,
that peer's cursors. When a new event arrives on any link, it checks every *currently open*
link: whoever's cursor shows the gap gets it pushed now; whoever is offline gets nothing —
the event sits in custody until their next cursor exchange claims it. "Everyone eventually
has everything" is not a broadcast primitive; it is the emergent sum of pairwise
gap-filling, which is why one code path serves the live case and the 2 AM/9 AM
never-co-present case with no special mode.

**Checkpoints are verified, both halves.** The tail is hash-chained per author with signed
feed certificates; the checkpoint (the folded state at the compaction floor) carries its own
certificate — state hash, coverage map, issuer signature — verified against `trust` before
adoption. A peer cannot mint one; device-to-device snapshots relay the authority's
certificate.

---

# Part Two — The one shared definition

## Chapter 5. Errors are tagged values, on `@syncmesh/result`

`Result`, `Result.try`, `Result.tryPromise` and the errors themselves come from
`@syncmesh/result` — the in-repo better-result. There is no error-code map, no shared error
base class, and **no separate errors package**: each failure class is declared in the
package that owns the failure. A stringly code map is Ditto's design (every error flattened
to code + message, no `cause`); `TaggedError` is strictly stronger — each failure is a real
`Error` subclass with a literal `_tag` and **typed fields**, narrowed exhaustively by the
compiler.

```ts
import { TaggedError } from "@syncmesh/result";

export class StoreLocked extends TaggedError("StoreLocked")<{ readonly path: string }> {}
export class Unreachable extends TaggedError("Unreachable")<{
  readonly service: string;
  readonly triedRoutes: number;
}> {}
export class NoSecureRandomness extends TaggedError("NoSecureRandomness")<{
  readonly neededBy: "createClient" | "createServer";
}> {}   // "pass entropy: getRandomValues from 'expo-crypto' (RN) — no CSPRNG on this platform"
export class BlobDeleted extends TaggedError("BlobDeleted")<{ readonly bytesReceived: number }> {}
export class HistoryUnavailable extends TaggedError("HistoryUnavailable")<{
  readonly operationId: OperationId;
  readonly sourcesTried: readonly SourceId[];
}> {}
// … the catalog grows with implementation; domains are UNIONS, not string prefixes:
export type SyncError = Unreachable;   // CallError / WriteError / WaitError are such unions
```

- Typed payloads, not message archaeology: `BlobDeleted` *carries* how far the fetch got;
  `HistoryUnavailable` carries the sources tried.
- Handling is `matchError`/`matchErrorPartial`/union guards — adding a variant breaks every
  non-exhaustive match at compile time; never `switch` on a code string.
- Every throwing boundary (drivers, `JSON.parse`, third-party promises) is crossed with
  `Result.try`/`Result.tryPromise` into the named tagged error, **`cause` kept**.
- Exactly one `Internal`, reserved for the genuinely impossible — everything nameable gets
  its own class.
- Errors cross the wire without degrading: an authority handler's declared `.errors()` and
  any thrown `TaggedError` serialize as `{ _tag, ...fields }` and revive at the client
  boundary into the same classes — the tag never leaves the type system.

## Chapter 6. The schema: tables and policies, declared once

```ts
// db/schema.ts — the app's existing Drizzle tables; the id default is the app's own
import { v7 } from "uuid";               // or randomUUID from expo-crypto, or CUID2 — ch. 1

export const products = pgTable("products", {
  id: uuid().primaryKey().$defaultFn(v7),   // client-generatable: the one property checked
  name: text().notNull(),
  priceCents: integer().notNull(),
  stock: integer().notNull().default(0),
  createdBy: text().notNull(),
});

// sync/schema.ts — a build input, never a live connection
import { drizzleTable, ladder, partition, syncSchema } from "@syncmesh/schema";

// a kind is a value: a name, a role set (senior first) and `sealed` — `sealed: true` is ch. 14
export const shop = partition("shop", { roles: ladder("owner", "editor", "viewer") });

export const schema = syncSchema({
  tables: {
    // the wrapper names its ORM, so no separate adapter declaration exists to drift from it
    products: drizzleTable(products, {
      partition: shop,
      immutable: ["createdBy"],
      merge: { name: "lww", priceCents: "lww", stock: "counter" },
      allow: ({ role }) => ({
        read: role("viewer"),
        insert: role("editor"),
        update: role("editor"),
        delete: role("owner"),
      }),
    }),
  },
});
```

The adapter derives types, nullability, keys and validators; only sync-specific policy is
declared. **Nothing is generated.** The `schema` value derives everything at construction —
`schema.tables` (query-side table objects), `schema.inputs`/`schema.rows` (validators, the
way drizzle-zod derives them), the SQLite mapping, and `schema.manifest` (the shareable
partition/grant half) — because a Drizzle table is driverless metadata with no connection to
exclude. Private tables stay out the only way that cannot drift: the **module boundary** —
`db/private.ts` is never imported by `sync/schema.ts`, so it is not in the value. Private
data is excluded from events, snapshots, exports and handler outputs, not merely hidden in
the UI. Unsupported database features fail at schema construction with actionable errors —
a boot error on the developer's machine, not a build step.

**A partition kind is a value.** `partition("shop", { roles: ladder(…) })` declares a kind
with a name, a role set and `sealed` (default `false`), and a table names it the way a query
names a Drizzle table — `partition: shop`, never a string; the reserved kinds ship as values
too (`global`, `user`, `local`). A kind that shares a ladder references it:
`partition("vault", { sealed: true, roles: shop.roles })`. There is no nesting. D07 had
decided a nested kind (`{ org: { shelf: {} } }`) would live in its parent's store, but that
was never implemented — `storeNameFor` built every filename from `kind:id` with no parent
lookup, and instance keys are flat, so a "nested" instance never recorded which parent it
belonged to — and the tree had silently degraded into "inherit the parent's ladder". The
schema describes the data model; where files go is storage's business (ch. 13).

**Ids: the platform generates, syncmesh only checks.** The primary key's `$defaultFn` is the
id generator — ordinary app code riding the platform's entropy: `crypto.getRandomValues` is
built into Node, Bun, browsers and Workers; on React Native `expo-crypto` provides it (and
id libraries expose their own injection points — `v7({ rng })` — where needed). The
construction check refuses what cannot be born offline (ch. 1); nothing about *format* is
enforced. Recommended in a doc comment only: a time-ordered format (UUIDv7, ULID) for
primary-key index locality.

**Immutable columns are birth facts.** `immutable: ["createdBy"]` marks columns written
once — in the row's insert event — and frozen after: any update event carrying one is
refused at every fold, from any author, the authority included. What it prevents is
concrete: `allow.update` says *who* may update, so without `immutable`, any permitted editor
(or a modified client holding an editor grant) could send an update carrying
`{ createdBy: … }` and rewrite attribution — and since `owner(column)` policies read that
column, rewriting it is privilege escalation. `allow` decides who; `immutable` subtracts
columns no one may ever re-touch. The primary key needs no listing — it is immutable by
construction (an event naming a different row id is a different row), and listing it is a
boot error naming the redundancy; `immutable` + `counter` on one column is a contradiction
the schema refuses. The escape for a genuinely broken row is data modeling, never an
exception: delete and recreate — a new row, history preserved.

The `allow` rules are a closed data AST (no closures), which is what lets them do triple
duty: evaluated at every fold on every peer, compiled to Postgres RLS on the server (a
handler's plain `db.select()` is already the caller's view), and synced as a `_policy` row
so a policy change propagates like any data.

**Policy inputs are four things, and nothing else: the event, the author's grant, the row's
prior state, and the policy itself.** All replicated data — so every peer computes the
identical verdict at any time: an event folded Tuesday on a phone and Thursday on the server
must pass or fail identically, which rules out clocks, network lookups, and every
environment fact ("on shift", an IP address) as policy inputs. Time-scoped access is grant
expiry, checked at admission with the grace rules — never a clock inside a rule. Within that
boundary the AST is a full attribute evaluator (ABAC in the literature's terms): `role()` is
one vouched attribute wearing its everyday name, and role-based rules are the default
dialect because the deployments this system is for — shops, wards, convoys — have job
titles, not attribute matrices. Claims-based rules are the named escalation and need no new
machinery: `claimHas("pharmacist")` gating controlled columns, `rowIs(status, "draft")`
making only drafts editable, `patchOnly` scoping a role to named columns. Claims are
vouched — signed into the grant by the issuer — never self-asserted (ch. 14).

**There is deliberately no review/approval machinery in the schema.** A server-enforced rule
maps to one of three existing primitives, and needs no fourth: if the rule must gate the
write, the operation is an authority mutation (ch. 7) — that is the test for when one should
exist at all; if the rule is mechanical (types, policies, immutable fields, merge), every
receiver already enforces it with no judge; and if bad data must be fixed after the fact,
the authority **corrects** it — an ordinary authoritative write naming its reason (ch. 20),
recorded on the displaced operation (ch. 10). "Changes need sign-off" is an app workflow — a
proposals table written locally plus an `approve` authority procedure — not an engine mode.

## Chapter 7. Procedures: kind first, then the terminal

TanStack Start puts run-location in the name (`createServerFn` bodies run only on the
server; the client gets a stub); Zero puts one mutator on both sides on purpose. Syncmesh's
grammar: the first word says **what** it is — `query` or `mutation` — and the chain's
**terminal** says who has the body. `.handler(fn)` means the body is right here and runs
where your replica is; `.output(schema).authority()` means there is no body here — the
**authority** decides, and the shared chain is the contract for its answer. The terminal
sits exactly where a reader looks for the code, so a bodiless chain answers "where's the
body?" in the same breath. Each method does one job: `.output()` declares the answer's shape
(parsed at the trust boundary — the one payload a client consumes straight off the wire),
`.authority()` names who decides, nothing more:

|  | ends in `.handler(fn)` — the replica runs it | ends in `.authority()` — the authority decides |
| --- | --- | --- |
| `query` | live local reads | private-table reads, reports |
| `mutation` | offline writes → events | the gate: uniqueness, payments |

`authority` is the system's own noun — the peer entitled to decide *before an event exists*
(ch. 20) — not a deployment location. Reaching for the terminal means answering "does this
decision need the authority?", never "should this run on the backend to be safe?".

```ts
// shared/products.ts — ships in every bundle
export const productProcedures = {
  list: query
    .route({ method: "GET", path: "/products", tags: ["Products"] })
    .input(z.object({ shopId: z.string(), search: z.string().optional() }))
    .handler(({ input, db }) =>
      db.select().from(tables.products)
        .where(and(
          eq(tables.products.shopId, input.shopId),
          input.search === undefined ? undefined : like(tables.products.name, `%${input.search}%`),
        ))
        .orderBy(asc(tables.products.name), asc(tables.products.id)),
    ),

  create: mutation
    .route({ method: "POST", path: "/products", tags: ["Products"] })
    .input(inputs.products.pick({ shopId: true, name: true, priceCents: true }))
    .handler(({ input, db, principal }) =>
      db.insert(tables.products)
        .values({ ...input, createdBy: principal.accountId })   // id: the column default fires
        .returning(),
    ),
};

// shared/rooms.ts — the contract only; the body lives in a *.server.ts module (ch. 19)
export const roomProcedures = {
  reserveName: mutation
    // no offline mode exists on authority calls: unreachable fails now, honestly — durable
    // intent is a request ROW (a .handler mutation), because events are already the queue
    .route({ method: "POST", path: "/room-names", tags: ["Rooms"] })
    .input(z.object({ shopId: z.string(), name: z.string().min(1) }))
    .output(z.object({ roomId: z.string() }))
    .errors({ NAME_TAKEN: { message: "That name is already reserved" } })
    .authority(),
};

export const router = { products: productProcedures, rooms: roomProcedures };
```

- `query…handler()` — a read that runs where your replica is: the device's SQLite (a thin
  browser client's replica lives on the server, so there it crosses the wire). The handler
  returns the Drizzle query **un-run**, which is what makes it subscribable.
- `mutation…handler()` — a write that runs on the device, **once**, inside one transaction,
  as one event. Its handler *must* ship with the client — that is the offline feature, the
  opposite of TanStack's stripping — and it never runs anywhere else: what travels is the
  event it became (ch. 2, fold not replay).
- `mutation…authority()` — TanStack's `createServerFn`, syncmesh-flavored: the body runs
  only at the authority, ever. The shared chain holds the **contract** — `.input()`,
  `.output()`, `.errors()` — and the `.authority()` terminal stands where the body would be.
  After it, no `.handler` exists to call: typestate makes a gate body in shared code
  unrepresentable, not merely forbidden. An authority call is request/response and needs a
  **route to the authority, now** — and a route counts hops: a phone with no internet
  standing next to a peer that has it is *routable*, and the call rides A → B → server with
  the response riding back, in seconds (ch. 17). Only when no path exists at all does it
  fail — immediately, typed, like every RPC ever. There is deliberately no queue mode — the
  mesh already has exactly one durable park-and-deliver-and-answer system, events, and a
  queued RPC would be a second one. When intent must outlive the dead zone, the intent is
  **data**: a `.handler` mutation writes a request row, the server answers it through a
  watch, and the answer folds back as data your ordinary query renders (worked example:
  ch. 24's room names). The body lives in a `*.server.ts` module the build refuses to bundle
  client-side — importing one from client code is a resolution error, not a review comment.
  An app whose needs are all local declares **zero** of these.
- `query…authority()` — the read-shaped gate: reports over private tables, admin views,
  anything a device must ask for because it may not hold the rows. Contract shared, body in
  `*.server.ts`, same as the authority mutation.
- `.route()` is HTTP/OpenAPI metadata and nothing else. The HTTP method describes HTTP
  semantics, never transaction behavior.
- Inputs derive from the schema value. `id` is optional — supply one when a flow needs it
  before the write (validated as the column's type), or omit it and the column's default
  fires; the principal comes from the session and a caller's input can never set it.

**What ships to the browser, and is that a security issue?** Yes, `.handler()` code is in
the app bundle and anyone can read it. It is not a security issue, because of a line worth
learning once: **client code is UX; enforcement is what receivers accept.** A modified
client skips any client-side check anyway, so shipping a check reveals nothing an attacker
couldn't already do — what receivers verify (signature, grants, `allow`, immutables) doesn't
weaken by being known, the same way a lock's design being public doesn't open it. The real
rule is about *which kind* of business logic a handler contains: **mechanics** (what fields
exist, how a list is filtered, how a total renders) ships and is harmless; **judgment** (the
supplier floor, fraud thresholds, pricing algorithms, anything whose *value* or *existence*
is a secret) must never ship — it belongs in `*.server.ts` bodies, private tables, and
watchdogs, and both fences are mechanical: a `*.server.ts` import fails client resolution,
and a private table never enters the schema value.

Where everything runs, in one table — including what the server still checks when a device
was offline for two months:

| You wrote | Runs | Offline for two months | When its effect reaches the server |
| --- | --- | --- | --- |
| `query…handler()` | against the local replica | works — local data, honest `coverage` | reads never travel |
| `mutation…handler()` | on the device, once | works — events wait in the outbox | the **fold** re-checks signature, grant, `allow`, immutables, merge — mechanically, always; your handler is **not** re-run |
| `mutation…authority()` | at the authority, always | fails now, typed — durable intent is a request row | the body itself, in one transaction |
| `query…authority()` | at the authority, always | fails as unreachable — it needs rows this device may not hold | the body, read-only |

So no — your mutation `.handler` is not a hot path on the server. The server's hot path for
incoming events is the fold, which is engine code running the declarative checks. Your code
runs on the server in exactly two places: `*.server` bodies and watchdogs.

---

# Part Three — The client

## Chapter 8. One noun

```ts
// client/runtime.ts — the only wiring file a client app has
export const client = await createClient({
  schema,
  procedures: router,
  storage: sqlite(),                 // platform default location; OPFS-backed WASM SQLite in
                                     // the browser — a tab holds a real replica (ch. 16)
  entropy?: getRandomValues,         // the engine's CSPRNG (device keys, handshake nonces):
                                     // pass expo-crypto's on RN; defaults to globalThis.crypto;
                                     // neither present → NoSecureRandomness, before keys exist
  auth: sessionProvider,             // who is calling; tokens; refresh — ch. 14
  trust: { issuer, authority },      // shipped config, identical on every peer: who signs
                                     // grants, and whose writes may correct — never runtime-derived
  admission?: denyBleOnSite,         // optional OVERRIDE only — by default admission is
                                     // derived from grants: overlapping grant, or asking
                                     // for one, else deny — ch. 14
  transports: [
    ble({ id: "nearby" }),
    lan({ id: "room", mdns: true }),
    awdl({ id: "apple-fast" }),      // Apple ↔ Apple peer-to-peer Wi-Fi — ch. 16
    wifiAware({ id: "fast" }),       // the NAN standard: Android 8+, iOS 26+ — ch. 16
    webSocket({ id: "internet", bootstrap: [SERVER_URL] }),
  ],
  mesh?: { group?, maxLinks?, churn? }, // fleet shaping, defaults tuned — ch. 17
});
```

The client **is** the api. Procedures sit at the top level; there is no second handle.
Device identity (keys, peer id, writer incarnation) is the library's problem: generated on
first run, persisted in a secure key store, never cloned by copying a data file. Entropy
resolves before any key exists — the `entropy` option, else
`globalThis.crypto.getRandomValues`, else a typed `NoSecureRandomness` naming the fix. Opening
takes an **exclusive lock** on the data directory — a second open fails *now* with
`StoreLocked`, never silent corruption (ch. 13). Opening succeeds once local recovery and
migrations finish — it does not wait for the internet, and a networking timeout never means
"caught up".

The non-procedure surface is `$`-prefixed, grouped by what it answers:

| Surface | Operations | Answers |
| --- | --- | --- |
| `$operations` | `get`, `list` | the write's durable record, as a subscribable ref — after restart too (ch. 10) |
| `$recovery` | `list`, `explain`, `run`, `export`, `rebuild` | what is stuck and why (ch. 18) |
| `$transports` | `add`, `remove`, `$peers.graph`, `$routes.to` | who can I reach, over what, through whom (ch. 17–17) |
| `$status` | `get`, `subscribe` | overall health plus per-source transport diagnosis (ch. 18) |
| `$auth` | `update`, `signOut`, `status` | credential lifecycle, with `expiresAt` (ch. 14) |
| `$grants` | `request`, `issue`, `revoke`, `renew`, `expiring`, `devicesOf` | how a device's events get admitted at all (ch. 14–15) |
| `$drafts` | `save`, `get` | local-only data with no replication promise |
| `$presence` | `channel(topic, key)`, `self.set` | ephemeral values; this peer's self-asserted metadata (ch. 14) |
| `$blobs` | `put`, `get`, `stream`, `retain`, `release` | bytes outside the log, content-addressed (ch. 12) |
| `$inspect` | `operation(id)`, `handles()`, `exportLogs`, `storagePath` | traces, leak counters, the flight recorder (ch. 12) |
| `$flush()` / `$close()` | — | honest barriers (ch. 13) |

`$` is framework surface, `~` is adapter surface (ch. 9), plain names are the app's
procedures. Three tiers, three spellings, no collisions by construction.

## Chapter 9. Reads: an opaque descriptor, and coverage with every answer

`client.products.list(input)` returns a `Query<T>` whose public surface is **`then` and
nothing else** — everything else rides the adapter key:

```ts
interface Query<T> extends PromiseLike<Result<ReadAnswer<T>, CallError>> {
  /** Adapter surface. Not for application code. */
  readonly "~mesh": {
    readonly path: string;      // "products.list" — devtools, and half the identity
    readonly key: string;       // path + input: same question, same subscription
    readonly run: () => Runnable<T>;
    readonly live: () => Live<T>;
    readonly coverage: () => Coverage;
    readonly onCoverage: (listener: () => void) => () => void;
  };
}

interface ReadAnswer<T> {
  readonly data: readonly T[];
  readonly coverage: Coverage;
}

type Coverage =
  | { readonly kind: "local-only" }
  | { readonly kind: "partial"; readonly source: SourceId; readonly checkpoint: Checkpoint }
  | { readonly kind: "caught-up"; readonly source: SourceId; readonly checkpoint: Checkpoint };

interface Checkpoint {
  readonly at: Temporal.Instant;   // when that source finished its first pass
  readonly cursors: Cursors;       // the per-author cursors this device held at that moment
}
```

Every answer carries its coverage, because empty local rows are not proof the remote scope
is empty, and `caught-up` means coverage to an identified source's checkpoint over the
partitions this query reads (ch. 3) — never permanent global completeness.

**Four live invariants**, written into `~mesh.live` and tested in chaos (each one deletes a
race-bug class Ditto documents around):

1. The first delivery is **always asynchronous** — never during subscribe.
2. The first delivery is the **complete current result set**.
3. Delivery is **coalesced, latest-wins, always** — a slow consumer never queues snapshots;
   backpressure is the only mode, not an opt-in (`for await` and React's own scheduling are
   the ready-signals).
4. **Unchanged rows keep object identity** across deliveries, and each delivery exposes a
   **keyed diff** — `{ added, removed, changed }` by primary key — computed inside the
   subscription layer. This is what makes React memo work and what the collection adapter
   feeds from; index-based bolt-on differs are the counterexample.

**The hook speaks TanStack DB's dialect**, then adds the one word HTTP-born libraries cannot
have:

```tsx
const { data, state, status, isReady, isEnabled, coverage, error } =
  useQuery(client.products.list({ shopId }));
//    data:     readonly T[] | undefined — undefined until first stabilization, then the rows
//    state:    ReadonlyMap<RowKey, T>  — keyed access, same identity the live layer diffs by
//    status:   "idle" | "pending" | "error" | "success" | "disabled"
//    isReady:  the *local* query stabilized — TanStack's word, kept with TanStack's meaning
//    coverage: how much of the *world* has answered — the word TanStack cannot have

if (!isReady) return <Spinner />;
if (data.length === 0)
  return coverage.kind === "caught-up" ? <NoProducts /> : <StillSyncing />;
```

`isReady` and `coverage` are deliberately different facts: a query over an empty local store
stabilizes instantly (`isReady: true`) while the server has not yet spoken
(`coverage: "local-only"`). Conflating them is how offline apps draw confident empty states.

Two more TanStack conventions carried over whole: **conditional queries disable, they don't
crash** (`useQuery(shopId ? client.products.list({ shopId }) : undefined)` yields
`status: "disabled"`, `isEnabled: false`, no subscription), and **no dependency array,
ever** — a descriptor's input is plain data, so `~mesh.key` (path + input) *is* the
identity, and there is no opaque-closure case to leak.

The descriptor stays inert until consumed — `then` runs it lazily, never at construction, so
building one in a component body is free. Awaiting returns `Result`: errors are values here
like everywhere else. Reads are the one thenable surface because a read's only product is
its answer; a write's product is its effect.

## Chapter 10. Writes are statements, not promises

TanStack DB has this right and it is the precedent to copy exactly: `collection.insert()`
returns a `Transaction`, optimistic state lands synchronously, the UI updates through the
reactive layer, and `tx.isPersisted.promise` exists for the rare call site that cares.
Nobody awaits an insert to see it. A local-first store deserves nothing less:

```ts
client.products.create({ shopId, name: "Desk lamp", priceCents: 4900 });
// the whole call site — the live query shows the row, and its sync column tracks the journey
```

The call returns a `Write<T>` — a tracker, deliberately **not** thenable, so the bare
statement is the blessed form rather than a floating-promise lint hit:

```ts
interface Write<T> {
  /** Allocated before commit: what an unknown outcome is looked up by after a crash. */
  readonly id: OperationId;
  /** Local durable commit. Resolves to a Result — it never rejects, so ignoring it is safe. */
  readonly committed: Promise<Result<WriteResult<T>, WriteError>>;
  /** One milestone, bounded. A timeout ends this wait and nothing else: delivery continues. */
  readonly waitFor: (goal: Milestone) => Promise<Result<OperationStatus, WaitError>>;
  readonly status: () => OperationStatus;
  readonly subscribe: (listener: () => void) => () => void;
}

type Milestone =
  | { readonly milestone: "committed"; readonly within?: Temporal.Duration }
  | { readonly milestone: "replicated"; readonly remoteCopies: number; readonly within?: Temporal.Duration };
```

The local transaction is one boundary: intent, generated changes, materialized state, outbox
and the operation record commit together, or none do. A commit whose outcome is ambiguous
returns `CommitUnknown` **with the operation id**, so the caller looks it up instead of
retrying into a duplicate.

**Operation state is a record, not an enum.** Where a write has reached is several
orthogonal facts, and flattening them into one linear status is how "delivered" gets misread
as "accepted":

```ts
interface OperationStatus {
  readonly id: OperationId;
  readonly local: "durable";
  readonly replication: {
    /** Distinct authenticated peers that issued durable custody receipts — not links, not
     *  unsigned cursor claims, and two copies on one host are one failure domain. */
    readonly receipts: readonly CustodyReceipt[];
    readonly targetMet: boolean;
  };
  /** Derived, never passed: an authoritative write with a reason displaced this one's values,
   *  and the log knows which operation it displaced, so the engine makes the link (ch. 20). */
  readonly correction?: { readonly by: OperationId; readonly reason: string };
  readonly materialization: "applied" | "blocked" | "superseded";
  readonly blockers: readonly RecoveryIssue[];
}
```

The axes deliberately do not imply each other: `applied` does not mean anything approved it
— it means this device folded it; a receipt is evidence of acknowledged custody under named
retention terms — it identifies the peer and its storage incarnation, and a peer that loses
its log has its assurance marked lost and the copies replenished. Receipts persist like
events do. A correction never deletes what it overwrites: it is a new signed operation
naming what it corrects and why, the original intent stays in history, and the reason
renders where the author is — the operation record.

**Row state is a column, not a lookup.** An earlier draft had
`useSyncOf(client.$sync, "products", product.id)` — a string table name and a foreign key,
correlated by hand against rows that came out of a **handwritten** query. That cannot work:
queries are the app's own Drizzle — joins, projections, renames — so the framework does not
know which table a row "is", and asking the developer to restate it as a string is the bug,
not the fix. The place that already names the table, typed, is the query. So that is where
row state lives — as a selectable value:

```ts
list: query
  .input(z.object({ shopId: z.string() }))
  .handler(({ input, db }) =>
    db.select({ ...columns(tables.products), sync: syncOf(tables.products) })
      .from(tables.products)
      .where(eq(tables.products.shopId, input.shopId)),
  ),
```

`.sync` is not framework magic on the result — it is a column the handler put in its own
`select`, exactly like `name`. A query whose handler never selects `syncOf` returns rows
with no `.sync`, and the type says so.

**Cost, concretely.** The engine keeps per-row write progress once, in one internal state
table (row key → state), maintained regardless of who asks — that is what acks update.
`syncOf(table)` compiles to a join against that table on the named table's primary key at
query time; nothing is stored per query. This is *cheaper* than the alternative: a
`useSyncOf` hook per row means one subscription per visible row all poked by a global
"something acked" signal, while a selected column means sync transitions invalidate only the
queries that asked — a query that selects no `syncOf` never re-runs on an ack at all. It is
opt-in per query on purpose: the two screens with a sync badge select it; reports, pickers
and settings queries don't and pay nothing. `operationOf(table)` is the sibling column
carrying the row's pending operation id — the join key into `$operations`. There is
deliberately no `correctionOf` column: a correction's *why* matters to the author of the
displaced write, and lives on their operation record — to a reader who never wrote the old
value, the corrected value is simply the value. Where the why must be public forever, it is
data: a column or audit table the correction also writes.

**The handle survives restart:**

```ts
const restored = client.$operations.get(operationId);   // an OperationRef: same identity, subscribable
const unsettled = await client.$operations.list({ unsettled: true });
```

```tsx
const op = useOperation(client.$operations.get(operationId)); // the full record, for a detail view
const allowed = useCan(client.products.create.can({ shopId })); // the rehearsal descriptor (ch. 15)
```

Which is the deeper reason a write must not be a promise: its interesting states outlive any
call site — a write made offline on Tuesday replicates on Thursday and may be corrected next
month. The general rule all three surfaces obey: **a hook takes exactly one descriptor, and
a descriptor is built from a typed reference — a procedure call (or its `.can` rehearsal,
ch. 15), an operation ref — never from a string naming something the type system already
knows.** And
every handle — an `OperationRef`, a watch registration, any observer — is `Disposable`
(`Symbol.dispose`), idempotent to cancel, and **never GC-coupled**: dropping a reference
leaks loudly into `$inspect.handles()` rather than silently killing a subscription, which is
the failure mode Ditto documents instead of fixing.

**Failure channels, each in its place:**

- **Invalid input** throws synchronously at the call — the input schema validates
  synchronously, so a bad call never becomes a background mystery.
- **A refused transaction** (rules deny, storage full, capability expired) retracts the
  staged rows, resolves `committed` with the typed error, and emits telemetry — visible even
  when nobody kept the `Write`. Keep the user's draft (`$drafts`); show no saved indicator.
- **A correction** arrives as an authoritative overwrite, recorded on the displaced
  operation — days later if need be, never as an exception anywhere.

A caller that needs the row's id synchronously supplies it in the input (client-generated
ids are the default). A caller that must gate on durability awaits `.committed` —
save-and-navigate, tests. Everything else writes and moves on. The contract is
**read-your-own-writes, same tick**: a query built after the statement reflects the staged
row — how the engine achieves that is its business, but the guarantee is not optional and
not phased. And deliberately still no `useMutation`: there is no in-flight state worth a
hook.

## Chapter 11. Collections

```ts
const products = createCollection(
  syncmeshCollection(client.products.list({ shopId: selectedShop.id }), {
    onInsert: ({ transaction }) => client.products.create(rowOf(transaction)).committed,
  }),
);
```

The adapter opens `~mesh` like every adapter: `key` is the collection identity (new input ⇒
new collection — dynamic scope falls out for free), `live()` is the sync source with ch. 9's
keyed diffs and row-identity preservation, `coverage()` gates the ready state. Row identity
defaults to the schema's primary key, `getKey` overrides for joins. Mutation handlers are
explicit bindings to procedures and **non-optimistic passthroughs** returning `.committed`:
the local commit is already the fast path, and layering TanStack's optimistic overlay on a
local-first store is where phantom rollbacks come from. Per-row sync state rides the rows
themselves — a query that selects `syncOf` carries it into the collection as an ordinary
column.

## Chapter 12. Blobs and diagnostics

**Blobs: cheap refs replicate eagerly; bytes move on demand, observably.** What lives in a
row is a branded `BlobRef` — `{ hash, byteLength, hints }` — small, replicating with the
document, sufficient to render filename/size UI and start a fetch before a single payload
byte arrives. (Ditto's token-in-document pattern, kept; its forgeable structural token
replaced by a brand, which deletes their invalid-token error class at compile time.)

```ts
const put = await client.$blobs.put(fileOrBytes, { hints });   // → Result<BlobRef, …>
const fetch = client.$blobs.get(ref, { onProgress?: (got: number, total: number) => void });
const done: Result<Blob, BlobDeleted | BlobTransferFailed> = await fetch; // PromiseLike + events
fetch.release();                                    // one verb: cancels in-flight, releases held
client.$blobs.stream(ref): ReadableStream<Uint8Array>;  // no whole-buffer forcing on RN video
client.$blobs.retain(ref); client.$blobs.release(ref);  // refcounted local presence for bytes
```

One tagged terminal instead of Ditto's three channels (throw vs rejection vs sentinel
`null`): `BlobDeleted` — every replica released the blob before a full copy arrived — is a
named error *with evidence* (`bytesReceived`), not a `null`. A fetch pins bytes locally;
`retain`/`release` refcount them; an unreachable blob never completes and is visible in
`$inspect` until released.

**`$inspect` has teeth:**

```ts
client.$inspect.operation(id);      // the full trace an operator pastes into a bug report
client.$inspect.handles();          // { observers, subscriptions, operations, fetches, links } —
                                    // live counts; chaos asserts all zeros after every scenario
client.$inspect.exportLogs(path);   // per-INSTANCE bounded flight recorder: always-on at debug,
                                    // JSONL-gz, size- and age-capped — noise is evidence
client.$inspect.storagePath;        // the resolved path, whatever sugar configured it
```

The flight recorder and leak counters are Ditto's two best ops ideas (`getBridgeLoad`, the
15 MB/15-day debug ring buffer) with their process-global, last-instance-wins disease
removed: everything here is per-instance and dies with `$close()`.

## Chapter 13. Honest barriers, and storage that sheds whole partitions

```ts
const drained = await client.$flush();   // Result<FlushReport, FlushError>: failed jobs named
const closed = await client.$close({ within: Temporal.Duration.from({ seconds: 5 }) });
// stop admitting work, establish a barrier, drain what started, close stores, release the
// directory lock — never wait forever for remote delivery, never claim more than committed
```

Normal termination is not required for durability — every acknowledged write already
committed. Boot and shutdown bracket the same lock: opening takes it exclusively
(`StoreLocked` for a second opener), `$close()` releases it.

**Storage pressure: partitions detach wholly; there is no row eviction.** A device sheds
storage the way the architecture sheds everything — whole partitions, whole files. Detaching
closes the replica and deletes its file (the same gesture as leaving a scope); re-attaching
later is a grant plus checkpoint + tail, converging like any newcomer. Local forgetting,
never deletion: every other holder keeps the data. Two guards, absolute: a partition holding
**unacknowledged local intent refuses to detach** (the refusal reports what is unsent), and
compaction floors remain protocol. The automatic variant is a budget —
`sqlite({ budget: { maxBytes, detach: "suggest" | "lru-idle" } })` — that sheds
least-recently-used *idle* partitions, never guarded ones. Row-level eviction would create
partial partitions, which is ch. 3's rejected projection wearing a storage hat; "the phone
filled up" is answered with the same knife as every scaling question: finer partitions,
granted precisely. **Forgetting** remains a separate destructive action that reports pending
work before deleting anything.

---

# Part Four — Trust

## Chapter 14. Sessions, grants, admission, and sealing

Four different doors, in decreasing order of how often an app thinks about them.

**The session: who is the user.** `auth: sessionProvider` supplies who this device's user is
and how to prove it. Application calls never name a principal — a device has one caller, and
letting a call site pick one is how "acting as" bugs ship. The provider **is** the refresh
handler — Ditto's real insight, kept, with its runtime crash deleted (their
`setExpirationHandler` is optional-until-sync-start and missing it throws; ours is a
required constructor argument, so the mistake is unrepresentable):

```ts
type SessionAsk = {
  readonly reason: "initial" | "refresh" | "expired";   // one callback covers all three
  readonly deadline: Temporal.Instant | null;           // Temporal, never bare seconds
};

client.$auth.status();  // { principal: Principal | null, expiresAt: Temporal.Instant | null }
                        // one source of truth for session logic AND the "expires in 4 min" UI
await client.$auth.update({ capability: refreshed });   // wakes blocked work waiting on it
await client.$auth.signOut({ then?: async (client) => void });
// `then` runs after sync stops and before credentials drop — purge and credential-clear
// cannot interleave with new writes
```

Denials are structured data — the grant set or a typed reason — never a JSON string to
parse. A changed session invalidates affected subscriptions and prepared statements rather
than letting them keep answering as the old caller. Revocation prevents future
participation; it cannot unread plaintext an offline device already holds — the API does not
pretend otherwise.

**The grant: whose events are admitted.** Session auth is not mesh admission. `auth` says
who the *user* is; a device also needs its *events* admitted by peers, and that is a
**grant** — a signed statement from the scope's issuer (`trust.issuer`) that this peer may
write these partitions, which is what every receiver's fold checks. A new device asks on
every available link with `client.$grants.request(invite)`; the admitting side — an admin
device holding the issuer key, or the server — answers with
`$grants.issue({ device, partitions, role })`. Until a grant lands, the device runs locally
and nothing it writes is folded by anyone else; when one lands, its blocked work wakes.
Revoking a grant is the real enforcement everything else defers to: the door, closed.

**Relationships flatten into grants — there is no graph engine.** A Zanzibar-style ReBAC
check is a graph walk against a central tuple store, and a fold-time check cannot call one —
even replicated relationship rows would make the verdict depend on each peer's convergence
state mid-sync, which is divergence wearing an org chart. But look at what a grant already
is: a signed relationship tuple — *(device, partition, role, claims)* — compiled into a
portable, self-contained credential. So the blessed pattern for relationship semantics is:
**relationships are rows; the authority flattens them into credentials.** Worked example:
"add Bola to project X" is an ordinary membership row; a watchdog (or the issuer's admin
app) sees it and issues Bola's device a grant for project X's partition; removing the
membership row revokes the grant the same way. Per-*thing* sharing gets the standing answer
to every sizing question: a document that needs its own membership is its own partition —
the partition is the relationship boundary. The whole authorization layering in one
sentence: **the fold checks credentials; the gate checks anything.** Portable,
deterministic, data-shaped rules — roles, vouched claims, row state — replicate to every
peer and run at every fold; relationship graphs and environment-sensitive judgment run
where one node decides — an `.authority()` body or a watchdog — and their *outcomes*
flatten into what does replicate: grants, claims, and corrections.

**The admission gate: whether a link forms at all — derived from grants by default.**
Admission needs no configuration, because the grant is this door too. With no handler set,
the rule is:

```
admit(peer, transport) =
     peer proves a grant overlapping my partitions   → allow   (signed by the pinned
  or peer is asking for one                          → allow    issuer — verified offline)
       — the grant-request channel: one frame type, rate-limited, no event exchange;
         forced by bootstrap, since a joining device must be able to ask before it holds
         anything
  else                                               → deny, retry-after-backoff
```

That default already answers the lobby economics with zero code: the other company's phones
in the warehouse hold no overlapping grant, so they get no link, no handshake spend, no BLE
slot. The optional `admission` handler is an **override for what membership cannot
express** — policies about the radio, not about who belongs. It decides per
**(peer, transport)** pair:

```ts
admission?: (ask: {
  readonly peer: PeerId;
  readonly transport: TransportSource;
  readonly metadata: Readonly<Record<string, unknown>>;   // self-asserted — never a security input
  readonly vouched: Readonly<Record<string, unknown>>;    // the grant's claims — the trusted channel
}) => Promise<"allow" | "deny">;

// deny-despite-grant is the real use: "no BLE links inside this facility" (compliance);
// "battery under 10% → keep the server link only"; quarantine a suspect device
// TOPOLOGICALLY, now, while its revocation — which is data — is still propagating.
// Or tighten the ask-corridor: grant requests only during onboarding hours, only with a
// well-formed invite, only N per minute.
```

It is an override of the grant-derived default, never a second trust system — its one
trusted input is the grant's own vouched claims. Three properties, all field-proven by
Ditto's gate: it **fails closed** (a slow or throwing
handler denies, bounded by a `Temporal.Duration` timeout); a deny is **retry-after-backoff**,
so policy changes heal the mesh without a rendezvous; and it shapes **topology only** — an
allowed connection grants no data access, and grants/`allow` rules can never be bypassed by
one. The two metadata channels feed it and the presence graph alike:
`client.$presence.self.set(metadata)` is self-asserted (≤ 4 KB JSON, eventually consistent,
may lag a peer's first appearance) and is for cosmetics; vouched claims ride the grant,
signed by the issuer, and are the only channel a security decision may read. The telemetry
split is kept too: whether diagnostics are *collected* locally and whether they *sync* are
separate switches.

**Sealing: custody without judgment.** A partition declared `sealed: true` (ch. 6) is
end-to-end encrypted: per-partition content keys ride inside grants, and every carrier
including the server's custody role holds ciphertext. Folding into Postgres, watchdogs and
corrections are *structurally* unavailable for that scope — a judge cannot read — while
`.authority()` calls still work, sealed to the service. Sealing is the stated trade —
operator-proof custody in exchange for server-side judgment — chosen per partition.

---

## Chapter 15. Authorization: the complete surface

What the field converged on, first — because our design should be judged against it. Four
families exist: **relationship engines** (Google Zanzibar's relation tuples + rewrite rules,
served centrally with consistency tokens; open source: `authzed/spicedb`, `openfga/openfga`,
`ory/keto`); **policy languages** (CEL, AWS Cedar — formally verified, default-deny,
forbid-overrides-permit; OPA/Rego; Firebase Rules; Postgres RLS); **in-app TS libraries**
(CASL — rules as JSON data, field-level, compiles to DB queries; Permix — typed closures
that cannot leave the process); and **local-first cousins** (InstantDB — CEL rules with
cross-entity `ref()` traversal, possible only because one server evaluates and rolls
clients back — Zero's star shape, not ours). Every *safe* system independently converged on
the same laws: a non-Turing-complete terminating rule core; rules as pure functions of the
request plus **pre-fetched** state (Cedar's "entity slice"); rules as serializable data;
default-deny; deny-overrides-allow. Our AST has all five, and our answer to the one open
problem — cross-entity checks — is Cedar's slice model with **the grant as the slice,
carried signed**, because a mesh has no central evaluator to walk a graph or meter a
`get()`. This chapter is the complete resulting surface.

### Roles: two builders, the word is the semantics

```ts
import { ladder, flat } from "@syncmesh/schema";

const shop = partition("shop", {
  roles: ladder("owner", "editor", "viewer"),  // seniority, highest first: owner ≥ editor ≥
                                               //   viewer; role("editor") = editor OR HIGHER
});
const org = partition("org", {
  roles: flat("auditor", "billing"),           // no ordering; role("auditor") = exactly that
});
```

Stateless builders producing the literal union that types `role()` per partition kind. The
bare-array form does not exist — position must never be secret semantics.

### The `allow` block: semantics, pinned

- **Default-deny.** An operation with no rule is refused; nothing is implicitly `true`.
  (InstantDB's default-allow is its most-documented footgun; Cedar's default-deny is the
  verified norm.)
- **Deny overrides allow.** Any matching `deny` beats every `allow`, regardless of order or
  which policy version contributed it — the only composition that survives policy merging.
- **Determinism.** A rule is a pure function of `{event, author's grant, prior row, policy}`
  — the four inputs of ch. 6, nothing else, ever.
- One AST, triple duty: evaluated at every fold, compiled to Postgres RLS, synced as the
  `_policy` row.

The helpers arrive on the callback's context — never imported — so `role()` typo-checks
this partition's ladder and `rowIs`/`patchOnly` accept only this table's columns:

| Helper | Reads | Passes when |
| --- | --- | --- |
| `role(name)` | grant | author's role is `name` — *or higher* under `ladder`, *exactly* under `flat` |
| `authority()` | grant | the author is the scope's authority |
| `owner(column)` | grant + prior row | the row's `column` names the author's account |
| `claimHas(path)` / `claimEquals(path, v)` / `claimIncludes(path, v)` | grant | dotted path into issuer-signed claims |
| `rowIs(column, value)` | prior row | lifecycle state — `rowIs("status", "draft")` |
| `compare(column, op, value)` / `isIn(column, values)` | patch/row | value sanity — `compare("qty", "gte", 0)` |
| `patchOnly(columns)` | patch | every touched column ⊆ the list — fences a clause to a slice of the row |
| `any(…)` / `all(…)` / `not(…)` | — | composition |
| `deny(rule, { because })` | — | explicit refusal with a human reason that rides the policy row and surfaces in the typed refusal error |

Reuse is plain TypeScript — rules are values, so named aliases need no feature:

```ts
const isLiveEditor = (c: AllowCtx<typeof docs>) =>
  c.all(c.role("editor"), c.rowIs("archived", false));
```

### The grant: shape and verbs

```ts
interface Grant {
  readonly device: PeerId;
  readonly partitions: readonly PartitionKey[];
  readonly role: RoleOf<Kind>;
  readonly claims: Readonly<Record<string, unknown>>;  // issuer-vouched; never self-asserted
  readonly issuedBy: PeerId;                           // chains to trust.issuer (ch. 14)
  readonly expiresAt: Temporal.Instant | null;
  readonly sig: Uint8Array;
}

client.$grants.request(invite?)      // the ask — works before any grant exists
client.$grants.issue({ device, partitions, role, claims? })  // newest mint supersedes
client.$grants.renew(device, validFor)
client.$grants.revoke(device)        // the real enforcement; propagates as data
client.$grants.expiring(within)
client.$grants.devicesOf(account)    // enumerate enrolled devices — reads the dual-signed
                                     //   account-link records; synced data, not a directory
```

### Checks: try it, or rehearse it

App code speaks procedures and rows — never table objects — so capability checks live
there, and there are exactly two:

```ts
// 1. The default: just write. Refusal is local, synchronous, typed, and carries the
//    rule's `because` — the UI reacts to the truth instead of predicting it.
client.products.update({ id, patch });   // committed → RuleDenied{ because } when refused

// 2. When a screen must know BEFORE showing the affordance — the rehearsal descriptor:
const allowed  = useCan(client.products.create.can({ shopId }));       // gate the New button
const editable = useCan(client.products.update.can({ id: row.id }));   // a row menu, on open
```

`.can(input)` is a **dry-run**: the handler executes in a local transaction against the
replica, the staged writes are checked against the same fold rules, and the transaction
always rolls back. It *is* the real check, rehearsed — it cannot drift from enforcement,
and a denial carries the rule's reason. There is no `$can` surface, no per-row permission
column, and no permission logic ever duplicated in UI code.

### Changing rules at runtime

```ts
server.policies.set(tables.products, allowRules, { grace?: Temporal.Duration });
```

An authority-signed `_policy` event that folds to every peer; `grace` keeps in-flight
events written under the old policy from unfair refusal. Role *assignment* needs none of
this — it is grant issuance.

### Relationships and dynamic roles: flatten at the issuer

There is no graph engine (ch. 29). Relationships are rows; **whoever holds issuance rights
compiles them into grants** — and where that is decides how offline sharing is:

```ts
// BLESSED: delegated issuance (ch. 14) puts the flattener ON THE SHARING DEVICE —
// the owner's grant vouches "may issue for project:X", so share() is one local composite:
share: mutation
  .input(ShareInput)
  .handler(({ input, db, grants }) => {
    db.insert(tables.members).values({ ...input });   // the relationship — app truth, UI
    grants.issue({                                    // the credential — derived NOW, locally,
      account: input.account,                         //   signed by delegated issuance
      partitions: [`project:${input.projectId}`],
      role: input.role,
    });
  }),
// row and grant travel together over the same BLE hop; the invitee is admitted at the
// next cursor exchange. The server never had to be reachable.
```

The handler context's `grants` is available exactly when the device's grant carries
issuance rights — refused typed otherwise. The server keeps a **reconciler watchdog**,
demoted to janitor: a members row with no matching grant (an anti-join — no bookkeeping
column) gets one issued; a deleted row with a live grant gets it revoked. Deployments that
keep issuance centralized use only the reconciler and accept the honest lag: the
relationship row syncs immediately, the credential lands when the authority next folds it.
Dynamic (user-edited) roles are the same recipe one level up: rules written against
permission claims, `roleDefs` as data, the flattener expanding definition ⨯ membership at
issuance — never consulted at check time, same determinism rule.

### The escalation ladder

Start at the top; move down only when a feature forces you. Each step is additive on the
same machinery.

| The rule you need | Reach for |
| --- | --- |
| "editors may update" | `role()` — the ladder; most apps end here |
| "authors may edit their own drafts" | `owner()` + `rowIs()` |
| "only certified staff touch this column" | vouched claim + `patchOnly` |
| "share this project with Bola" | partition + members table + flattener |
| "admins design custom roles" | permission claims + `roleDefs` + flattener |
| "only during shift hours" | **not a rule** — grant expiry, or a gate |
| "unique names / under a private floor" | **not a rule** — gate or watchdog (ch. 20) |
| "this must stay secret" | **not a rule** — private table, module boundary |

### Deliberately absent

| Not in the API | Instead |
| --- | --- |
| field-level *read* rules | **normalize the secret out** — the cost column is its own (private) table with its own `read` rule; partial rows are the NEVER |
| `ref()` / graph walks in rules | flattening — the grant is the pre-fetched slice |
| environment inputs (`time`, IP) | grant expiry; gates |
| a `bind` feature | rules are TS values; compose with `const` |
| default-allow, any-allow-wins | default-deny, deny-overrides |
| `$can` / table references in app code | write and react, or `.can()` rehearsal on the procedure |

---

# Part Five — Movement

## Chapter 16. Transports, adapters, and the peer session

```ts
// the adapters, complete — discovery toggles are separate from transport toggles:
ble({ id })                                  // low power, high reach, few slow connections
lan({ id, mdns?: boolean, multicast?: boolean }) // the fast offline room: same access point
awdl({ id })                                 // Apple Wireless Direct Link: Apple ↔ Apple, no AP
wifiAware({ id })                            // Wi-Fi Aware (NAN standard): Android 8+, iOS 26+
webSocket({ id, bootstrap })                 // dial-out to known addresses (the server)
http({ id })                                 // the thin-client degenerate mode (ch. 19)
webSocketListener()                          // accept — server-side
// an adapter unsupported on this platform fails construction with a typed error naming it
```

**AWDL and Wi-Fi Aware are two adapters because they are two protocols.** AWDL is Apple's
proprietary peer-to-peer Wi-Fi (the AirDrop link); Wi-Fi Aware is the Wi-Fi Alliance's
standardized Neighbor Awareness Networking. They do not interoperate — an iPhone speaking
AWDL and an Android phone speaking Wi-Fi Aware never link, and one umbrella `p2pWifi`
adapter would hide exactly the fact a mixed fleet must know. Since iOS 26 Apple ships a
Wi-Fi Aware framework, so `wifiAware` is the cross-platform fast path on recent devices;
`awdl` is the Apple↔Apple fast path on the rest of Apple hardware; a mixed room's floor
remains `lan` (same access point) and `ble`. Declaring both costs nothing: the peer session
runs them side by side to the same peer, the scorer picks per frame, and `$status` diagnoses
each source honestly instead of a merged "p2p-wifi" lying about which radio failed.

Runtime management exists for the rest — a settings screen toggling BLE, a diagnostic pane:

```ts
const added = await client.$transports.add(webRtc({ id: "p2p" }));
const removed = await client.$transports.remove("nearby", { drain: true });
// Results, both; removing a transport removes a route, never replica data.
const graph = client.$peers.graph();     // snapshot; subscribe for full-graph updates
const routes = client.$routes.to({ service: "authority", scope });
```

The adapter contract stays small, so a medium is a plugin rather than a fork:

```ts
interface TransportAdapter {
  readonly id: string;
  readonly start: (context: {
    readonly identity: NodeIdentity;
    readonly accept: (link: AuthenticatedLink) => void;
    readonly status: (update: TransportStatus) => void;
  }) => Promise<Result<void, TransportError>>;
  readonly dial: (address: Address, signal: AbortSignal) => Promise<Result<AuthenticatedLink, DialError>>;
  readonly stop: () => Promise<Result<void, TransportError>>;
}
```

A link authenticates its peer through a vetted handshake — a `remotePeer` string is not
authentication — and everything above it (session replication, blobs, requests, recovery) is
transport-agnostic. No platform is promised every medium — but the browser is promised the
full client: `sqlite()` resolves to OPFS-backed WASM SQLite there, so a tab holds a real
replica, works offline, and folds like any phone. The no-partition HTTP mode remains what it
is — the right shape for an SSR shell's first paint — a mode, not the browser's ceiling.

**One session per peer.** Two open links to the same peer behave as one connection: a single
logical cursor exchange plans each frame onto exactly one link — bulk prefers bandwidth,
control and recovery prefer latency — so nothing is duplicated by choice (`(author, seq)`
dedup remains the backstop, never the plan), and a transfer interrupted by a link drop
**resumes by cursor** on a surviving link, never restarting. Resume is free because progress
is cursor state, not link state. Fragmentation stays per-transport, below the session; the
exchange sits above it, unaware of mediums. Frames drain through a tag-ordered outbox —
grant before cursors before event before presence before digest before snapshot — so a live
event never waits behind a bulk transfer, and out-of-order arrivals park in a per-author
holdback that drains only contiguous runs (a hole past the gap limit triggers a full resync
rather than a jump).

## Chapter 17. Routing, weathers, and the shaped mesh

**The mesh shapes itself.** On start, aggressive discovery; then an efficiency phase that
declines redundant links (each idle link costs CPU and battery). Islands are prevented two
ways — a density target and periodic random re-peering (`mesh.churn`) — and `mesh.maxLinks`
budgets each medium. `mesh.group` segments fleets that share an app but should not
auto-connect; its doc comment carries the disclaimer it must: **an optimization, not a
security control** — dial-out bypasses it, and data isolation comes only from grants and
`allow` rules.

**Routes span hops.** Peers exchange signed route advertisements — `{ service|scope,
nextHop, hopCount, expiresAt }` — hop-limited, staleness-expired, forwarding-budgeted.
`$routes.to` answers with the chosen path and hop count; a mid-request hop failure re-routes
if any path remains, else fails typed. Deliberately **not** a general DHT: a room, a
building, a convoy — bounded advertisement radius, no global lookup. The presence graph is
the substrate: full-graph snapshots (immediate on subscribe, whole graph per change —
consumers diff), deterministic edge ids, edges labeled by transport, peers carrying both
metadata channels, labeled by provenance.

**Online means routable, not "this device holds an internet connection."** There are three
weathers, not two. (1) *Direct*: the phone has internet; everything is one hop.
(2) *Bridged*: the phone has only BLE, but a peer in range has internet — that peer is a
**live bridge**: authority calls are forwarded through it hop by hop (end-to-end
authenticated and sealed, so the bridge carries opaque envelopes and can neither impersonate
the caller nor read the payload), and events flow through it in the same seconds, because
the bridge's two open links each see the other side's gap and push immediately. A bridged
phone can make authority calls and even reach `caught-up` coverage without ever touching the
internet itself. (3) *Dead zone*: nobody in range has a path; authority calls fail now,
honestly, and durable intent is a request row (ch. 7) while events keep exchanging
peer-to-peer until anyone finds a route. The same peer is a **bridge** when its links are
open simultaneously and a **courier** when they are not — one exchange protocol, two tempos.

## Chapter 18. Status and recovery

**`$status` is diagnosis, not a boolean.** Per-source conditions, actionable and
user-attributable, delivered as an accumulated snapshot plus a change stream:

```ts
type TransportSource = "ble" | "lan" | "awdl" | "wifi-aware" | "websocket" | "mdns"; // discovery ≠ transport
type TransportCondition =
  | "ok" | "connecting-failed" | "listen-failed" | "discovery-failed"
  | "radio-off" | "no-permission-central" | "no-permission-peripheral" | "no-hardware"
  | "backgrounded" | "temporarily-unavailable" | "unknown";

client.$status.get(): {
  readonly health: "local-ready" | "catching-up" | "offline" | "blocked-recovery"
                 | "auth-required" | "storage-degraded";
  readonly transports: ReadonlyMap<TransportSource, TransportCondition>;
};
```

That vocabulary is what lets a UI render "Bluetooth is off — turn it on to sync with nearby
devices" instead of a red dot; central and peripheral BLE permissions are split because
platforms split them. Process lifetime is stated once: active subscriptions and transports
keep a Node process alive; `$close()` is how a process ends deliberately.

**Recovery is a durable subsystem with a small door.** Recovery runs automatically —
persisted jobs, dependency edges, bounded backoff, wake-on-arrival. The `$recovery` surface
exists for the screen an operator opens when something stays stuck:

```ts
const issues = await client.$recovery.list();
const plan = await client.$recovery.explain({ operationId });
// structured causes, dependencies, routes tried, retry schedule, next action

const job = await client.$recovery.run({ operationId });  // idempotent wake, never a discard
const bytes = await client.$recovery.export({ operationId }); // user-controlled: contains app data
const swap = await client.$recovery.rebuild({ source: "authority", preservePending: true });
```

```ts
type RecoveryIssue =
  | { kind: "missing-dependency"; operationId: OperationId; dependencies: readonly DependencyRef[] }
  | { kind: "missing-capability"; operationId: OperationId; issuer: PeerId }
  | { kind: "unsupported-version"; operationId: OperationId; required: string }
  | { kind: "authority-unavailable"; operationId: OperationId; retryAt: Temporal.Instant }
  | { kind: "storage-pressure"; requiredBytes: number }
  | { kind: "history-unavailable"; operationId: OperationId; sourcesTried: readonly SourceId[] }
  | { kind: "snapshot-untrusted"; source: SourceId }
  | { kind: "manual-conflict"; operationId: OperationId; versions: readonly string[] };
```

`rebuild` is a last resort: it stages a verified snapshot and pending operations before
swapping the base, leaves the old replica intact on failure, and never resets storage or
deletes the outbox. When no authorized source retains required history, the answer is a
durable `HistoryUnavailable` with export as the exit — an honest report, not an endless
spinner.

---

# Part Six — The server

## Chapter 19. A node with extra duties, not a different world

A server is a syncmesh node like any device: it folds events, holds partitions, speaks
transports. What makes it *the server* is two duties — run `.authority()` bodies, answer
thin HTTP clients — plus one power no other node has: its writes are authoritative, so it
can correct.

```ts
// server/rooms.server.ts — the *.server.ts suffix: the build never bundles it client-side
import type { AuthorityHandlers } from "@syncmesh/server";

export const handlers = {
  rooms: {
    reserveName: async ({ input, db, principal, errors }) => {
      await requireShopAdmin(db, principal, input.shopId);  // app rule, on top of table policy
      const inserted = await db
        .insert(tables.rooms)
        .values({ shopId: input.shopId, name: input.name })  // id: the column default fires
        .onConflictDoNothing()    // (shopId, name) is unique — the constraint IS the check
        .returning();
      const room = inserted[0];
      if (room === undefined) throw errors.NAME_TAKEN();
      return { roomId: room.id };
    },
  },
} satisfies AuthorityHandlers<typeof router>;

// server/runtime.ts
export const server = await createServer({
  schema,
  procedures: router,
  handlers,                       // the router's .authority() leaves, mirrored — checked by types
  watchdogs: [priceFloor],
  storage: postgres(pool),                        // rls: the database itself is the read filter
  auth: (request) => verifyCapability(request),   // the HTTP door only → a principal, nothing else
  transports: [webSocketListener()],
});

export default server.fetch;    // a standard fetch handler — mount it anywhere
const spec = server.openapi({ title: "Catalog API", version: "1.0.0" });
// from .route() metadata — authority calls are plain request/response, so the spec is too
```

**Two doors, one rule set.** A device arrives through the **mesh door**: its identity is
the authenticated link handshake plus its grants, `auth` is never consulted, and its writes
are events to fold under the schema's rules. A thin client (a browser with no local
partition) arrives through the **HTTP door**: `auth` turns the request into a principal, and
the *same* shared query/mutation handlers run once against Postgres as that principal — RLS
compiled from the schema's `read` rules makes a handler's plain `db.select()` already the
caller's view. Scope stays input at both doors; neither door binds one. An HTTP query runs
once and returns its rows — nothing pretends to be live over a medium that cannot keep the
freshness promise.

**Server bodies are a typed mirror of the router — nothing is registered.** The `handlers`
object has the router's shape filtered to its `.authority()` leaves: plain async functions,
keyed by the same paths, with `input`/`output`/`errors` inferred from each contract.
`satisfies AuthorityHandlers<typeof router>` makes completeness a **compile error** — a
missing body, an extra body, or a drifted signature is a red squiggle at the object literal,
not a boot check and never a deploy surprise. There is no wrapper and no registration value;
the `*.server.ts` suffix is the bundler-enforced boundary: a client import of that module
fails resolution, so the body cannot leak into an app bundle even by accident. At runtime,
one transaction commits handler execution, idempotency record, database change and
replication outbox together. Values the column defaults generate are recorded with the request, so a
retry of the same request id and payload returns the previous result — same room id
included; the
same id with different input is `IdempotencyConflict`; beyond the retry horizon,
`RequestExpired` — old work is never executed as new.

The escape hatch is explicit and server-composed: `systemProcedure({ reason })` grants
`context.systemDb`, which bypasses scope and policy, has no capture or replication promise,
and cannot be requested by a wire argument or route. It exists for operators; an uncaptured
SQL write is not a syncmesh write.

## Chapter 20. Gate or repair — never veto

**What the fold cannot check, the server gates or repairs.** The fold verifies everything
*shared*: signature, grants, the table's `allow` rules, immutable fields, types, merge — a
large, declarative set, and the design pressure is to push every rule you can into it. What
remains are rules needing what no device has: private data (a supplier cost), a global view
(uniqueness, quotas). Those cannot be checked *at* the fold even by the server, because
refusing to fold an event that other peers already folded is divergence — a fold-time veto
is the one option that does not exist, and the cut review pipeline was that veto wearing
process clothes. So each such rule picks one of two places:

- **Gate** — a violation must never be visible: then the write was never local. The column
  is admin-only in `allow`, or the operation is an authority mutation; the check runs before
  an event exists.
- **Repair** — a transient violation is tolerable: the server *observes and corrects*.
  Detection is a query like any other reaction; enforcement is a correction:

  ```ts
  // server/watchdogs.ts — detection is a subscription, enforcement is a correction
  watch(server.api.products.list({}), async ({ data }) => {
    for (const product of data ?? []) {
      const floor = await minimumPrice(privateDb, product.id);
      if (floor !== undefined && product.priceCents < floor)
        server.api.products.update(
          { id: product.id, priceCents: floor },
          { reason: "That price is below the allowed minimum" },
        );
    }
  });
  ```

  This converges: once corrected, the detection stops matching, and re-running corrects
  nothing. A device that keeps re-writing the bad value keeps getting corrected — and a
  device doing that maliciously is a grants problem, revoked at the door, not a data
  problem. A watchdog watches **state**, not the procedure that "defines" the write, because
  a violating state can be born with no procedure to blame: device A sets a price of 500
  while the office concurrently raises that product's floor to 600 — both writes were valid
  where they were made, and the violation exists only after the merge. A check attached to a
  procedure has no invocation to fire on there, and misses every other route to the same
  rows besides (another mutation, a fabricated event). The *file* is yours to organize; what
  the API fixes is the key (a query over data), never the location.

The choice is per rule, made where the schema is designed: shared and mechanical → `allow`;
must-never-be-seen → gate; eventually-true → watchdog and correction, with the violation
window visible and auditable rather than silently pretended away.

**A correction is a write, not a pipeline.** When the office must fix data, it does not
judge a proposal; it writes, and says why:

```ts
server.api.products.update(
  { id: productId, priceCents: floor },
  { reason: "That price is below the allowed minimum" },
);
```

The reason is the only extra argument, and it rides the event. Nobody supplies an operation
id — a maintenance job knows the **row** it is fixing, not which write broke it — and nobody
needs to: the log already knows which operation's values this write overwrites, so the
engine derives the link. The displaced operation reports `correction: { by, reason }` — the
author's device renders the why; everyone else simply folds the new value — and the original
intent stays in history. `server.api` is the same procedure surface bound to the server's
own principal, whose writes authority rules make win. Run it from a maintenance job, an
admin app calling an authority mutation, or by hand — it is ordinary in every way except who
signs it.

**There is no effects registry.** A server that wants to react to data — index into search,
fire a webhook — is a node with queries: subscribe to the query and feed the job queue the
app already has. The one rule worth stating is about the outside world: an external action
retried against a provider needs the provider's idempotency, because no local transaction
can promise exactly-once email.

## Chapter 21. The wake ladder

How a fold's commit reaches connected peers — settled, three rungs, two NEVERs.

**Rung 1 — the in-process post-commit signal (canonical).** The server is a node with many
links: a fold transaction commits into Postgres, and the same in-process signal that
invalidates live queries and wakes watchdogs also wakes the session layer; each open session
pushes its peer's gap. Connected phones see the event milliseconds after commit; absent
phones find it in the log later. There is no Redis and no pub/sub service, because there is
no publish: only sessions answering gaps off one shared log.

**Rung 2 — Postgres `LISTEN/NOTIFY` (the one multi-process topology).** Several
WebSocket-terminating processes over one Postgres need a cross-process wake. The
notification carries no payload beyond "a partition advanced":

```sql
BEGIN;
INSERT INTO event_log (scope, author, seq, ...) VALUES (...);
UPDATE products SET ... ;                       -- materialization, same transaction
SELECT pg_notify('syncmesh_advance', $scope);   -- the wake: a hint, never data
COMMIT;                                         -- delivered here, atomically, deduplicated
```

Each listening process (one dedicated connection, direct to Postgres — `LISTEN` is
session state, incompatible with transaction-pooling) wakes, reads the log it already
shares, and pushes gaps as before. Properties that make it safe: delivery is transactional
(rollback = no wake), identical notifications in one transaction collapse (a 500-event fold
is one wake), and non-durability doesn't matter — a missed notification is healed by the
next cursor exchange, because the log is the truth and the wake is only latency.

**Rung 3 — head-polling (emergency).** NOTIFY takes a global lock on the notification queue
at commit; thousands of small notifying transactions per second serialize on it. If that
ever binds, the escalation is short-interval head-polling of the log — worse latency,
identical correctness.

**The NEVERs.** A second stateful service for signaling (Redis) would duplicate the bus the
database already is. Tapping Postgres **logical replication** (a slot on our own tables,
Zero-style) is equally out: the WAL is Postgres's private event log and ours is the
application's — a slot would deliver, through a singleton consumer with WAL-retention risk,
news of commits the fold itself just made, and could never serve the SQLite side of the mesh
anyway. Zero pays for its replication-manager/change-streamer stack because it has no
app-level log and cannot see arbitrary writers; syncmesh has the log and *is* the only
writer.

## Chapter 22. Relaying is a role, not a tier — and scale is more scopes

There is no `createRelay`, no relay fleet, no third construct. Two facts make one redundant:

**The server is the relay.** The relay role is "an always-on peer that holds everything and
exchanges with everyone" — which is `createServer`, already. When a phone that syncs at 2 AM
and a phone that syncs at 9 AM have "exchanged through the relay", they exchanged through
the server.

**Every peer is a carrier.** The same exchange and custody receipts that put phone A's
events on the server put them on phone B first, when B is the one in BLE range: B verifies
the envelope and A's grant, stores the events, issues the receipt (`remoteCopies: 1`) — and
hands them to the server whenever *B* next connects. A → B → server, with nobody configured
as anything. Forwarding budgets and grants bound it: a peer carries only scopes it is
granted, and custody is never acceptance — a carried write reports `syncOf: "delivered"`,
nothing more.

A pure-custody box — the clinic's LAN relay, an untrusted regional host — is not a future
tier: it is `createServer` given the schema's manifest half and no `handlers`, no
`watchdogs`, no `auth`. Nothing remains to build for it, so nothing is deferred.

**Scale is more scopes, never more writers per scope.** Deciding doesn't commute, so each
scope names exactly one deciding server in `trust` (per-scope entries when scopes live on
different machines), and moving a scope is an operational handoff: snapshot, then a signed
epoch bump in the scope's policy so the old authority's post-handoff signatures are refused
everywhere. No directory service, no leader election, no sharding story — a scope that needs
two writers is two scopes.

---

# Part Seven — The application

## Chapter 23. One app across every tier

A shop catalog: staff edit products offline, room names must be globally unique, and the
office corrects prices that fall below a private supplier floor. Two processes exist in the
whole app: the phones and one server.

```ts
// db/schema.ts — the app's Drizzle; ids default from the app's own generator (ch. 1)
import { v7 } from "uuid";

export const products = pgTable("products", {
  id: uuid().primaryKey().$defaultFn(v7),
  shopId: uuid().notNull(),
  name: text().notNull(),
  priceCents: integer().notNull(),
  createdBy: text().notNull(),
});
export const rooms = pgTable("rooms", {
  id: uuid().primaryKey().$defaultFn(v7),
  shopId: uuid().notNull(),
  name: text().notNull().unique(),   // the global invariant the mesh cannot hold
});
// offline intent toward the server is DATA, not a queued RPC: a client-writable request row
export const nameRequests = pgTable("name_requests", {
  id: uuid().primaryKey().$defaultFn(v7),
  shopId: uuid().notNull(),
  name: text().notNull(),
  status: text().notNull(),          // "pending" | "reserved" | "taken"
  roomId: uuid(),
});
// db/private.ts — server-only; never enters the manifest
export const supplierCosts = pgTable("supplier_costs", {
  productId: uuid().primaryKey(),
  minimumPriceCents: integer().notNull(),
});
```

```ts
// sync/schema.ts — the sync declaration over those tables
export const shop = partition("shop", { roles: ladder("owner", "editor", "viewer") });

export const schema = syncSchema({
  tables: {
    products: drizzleTable(products, {
      partition: shop,
      immutable: ["createdBy"],
      merge: { name: "lww", priceCents: "lww" },
      allow: ({ role }) => ({
        read: role("viewer"), insert: role("editor"),
        update: role("editor"), delete: role("owner"),
      }),
    }),
    // rooms fold too — everyone sees reserved names — but only the authority may create
    // them, because uniqueness is a global invariant: writes are gated, reads replicate.
    rooms: drizzleTable(rooms, {
      partition: shop,
      immutable: ["shopId", "name"],
      allow: ({ role, authority }) => ({
        read: role("viewer"),
        insert: authority(), update: authority(), delete: authority(),
      }),
    }),
    // devices write the ask; only the server writes the answer
    nameRequests: drizzleTable(nameRequests, {
      partition: shop,
      immutable: ["shopId", "name"],
      merge: { status: "lww", roomId: "lww" },
      allow: ({ role, authority }) => ({
        read: role("viewer"), insert: role("editor"),
        update: authority(), delete: role("owner"),
      }),
    }),
  },
});
```

The shared procedures are ch. 7's `router` (products `list`/`create`/`update` as `.handler`
chains; rooms `reserveName` as the `.authority()` gate) plus the offline pair — the same
intent as data:

```ts
// shared/procedures.ts (rooms half)
export const roomProcedures = {
  reserveName: mutation
    .route({ method: "POST", path: "/room-names", tags: ["Rooms"] })
    .input(z.object({ shopId: z.string(), name: z.string().min(1) }))
    .output(z.object({ roomId: z.string() }))
    .errors({ NAME_TAKEN: { message: "That name is already reserved" } })
    .authority(),

  request: mutation
    .input(inputs.nameRequests.pick({ shopId: true, name: true }))
    .handler(({ input, db }) =>
      db.insert(tables.nameRequests)
        .values({ ...input, status: "pending" })    // id: the column default fires
        .returning(),
    ),

  requests: query
    .input(z.object({ shopId: z.string() }))
    .handler(({ input, db }) =>
      db.select().from(tables.nameRequests).where(eq(tables.nameRequests.shopId, input.shopId)),
    ),
};
```

The screens, every read/write pattern in one place:

```tsx
export function ProductsScreen({ shopId }: { shopId: string | undefined }) {
  // conditional query: no shop selected yet → disabled, not crashed
  const { data, status, isReady, isEnabled, coverage, error } = useQuery(
    shopId ? client.products.list({ shopId }) : undefined,
  );
  const mayCreate = useCan(client.products.create.can({ shopId }));  // rehearsal — ch. 15

  if (!isEnabled) return <PickAShop />;
  if (status === "error") return <Failed error={error} />;
  if (!isReady) return <Spinner />;
  if (data.length === 0)
    // isReady ≠ caught up: local store answered instantly; has the server?
    return coverage.kind === "caught-up" ? <NoProducts /> : <StillSyncing />;

  return (
    <>
      {data.map((product) => (
        <Row key={product.id} product={product}>
          {/* the sync fact came in as a column the handler selected — no per-row hooks */}
          <SyncBadge state={product.sync} />
        </Row>
      ))}
      {mayCreate && <NewProduct shopId={shopId} />}
    </>
  );
}

// a write is a statement — the list updates via its own subscription
const create = () => {
  client.products.create({ shopId, name, priceCents: 4900 });
  setName("");
};

// the rare gated flow: create-then-navigate must know the commit happened
export async function createAndOpen(shopId: string, name: string) {
  const saved = await client.products.create({ shopId, name, priceCents: 4900 }).committed;
  if (saved.isErr()) return toast(saved.error.message); // draft kept, no saved indicator
  navigate(`/products/${saved.value.data[0].id}`);
}

// the authority call, both weathers
export async function reserveRoom(shopId: string, name: string) {
  const asked = await client.rooms.reserveName({ shopId, name });
  if (asked.isOk()) return navigate(`/rooms/${asked.value.roomId}`);   // instant, online/bridged
  if (asked.error.kind !== "unreachable") return toast(asked.error.message); // NAME_TAKEN, typed

  // dead zone: the same intent becomes a ROW — it travels like any event, even via phone B,
  // and the server's answer folds back as data
  client.rooms.request({ shopId, name });
  navigate("/rooms/pending");
}

// the detail view that outlives the promise: the operation record, restart-proof
export function WritePanel({ operationId }: { operationId: OperationId }) {
  const op = useOperation(client.$operations.get(operationId));
  return (
    <>
      <Copies met={op.replication.targetMet} receipts={op.replication.receipts.length} />
      {op.correction && <Overruled reason={op.correction.reason} />}
      {op.blockers.map((issue) => <Blocked key={issue.kind} issue={issue} />)}
    </>
  );
}

// grants: how a phone joins at all — the new phone asks, the owner's phone answers
export function JoinShop({ invite }: { invite: string }) {
  client.$grants.request(invite);
  const health = useStatus(client.$status); // "local-ready" → writes work; folded by no one yet
  return <Waiting health={health} />;
}
export function ApproveDevice({ ask }: { ask: GrantRequest }) {
  const approve = () =>
    client.$grants.issue({ device: ask.device, partitions: [ask.partition], role: "editor" });
  return <Approve who={ask} onApprove={approve} />;
}
```

The server side is ch. 19's `createServer` with ch. 20's two watches — `priceFloor` (join
products against the private `supplierCosts`, correct below-floor prices with a reason) and
`answerNameRequests` (see `status: "pending"` rows, try the insert — the unique constraint
decides — and write back `reserved`/`taken` as an authority update that folds to every
phone).

## Chapter 24. The pipelines, traced

**A product is created offline (Tuesday, no signal).**
`client.products.create(...)` → input parsed synchronously → handler runs in one SQLite
transaction → event `(phoneA, 58)` + outbox + operation record commit together → the list's
subscription re-runs, the row appears with `sync: "local"`. Nothing was awaited.

**Phone A meets phone B over BLE (Wednesday — still no internet).**
Link authenticates → cursors exchanged → B lacks `(phoneA, 58)` → A streams it → B verifies
the envelope and A's grant, folds it into its own SQLite (its list updates too), stores the
signed bytes, and issues a custody receipt → on A, the row's `sync` flips to `"delivered"`
and `op.replication.receipts` counts B. B is now a carrier without being configured as
anything.

**B reaches the server (Thursday).**
The same exchange, one hop later: the server lacks `(phoneA, 58)`, B has it → server
verifies signature, grants, `allow`, immutables → folds the cells into Postgres through the
schema's mapping — no handler runs (fold not replay) → the commit wakes every open session
(ch. 21) → acks propagate on each peer's next exchange → the row reads `"remote"` on phone
A, whose author was offline for the entire journey.

**The price was below the floor.**
The fold changed `products` → the watchdog's detection query re-runs → one hit → the server
writes the correction with its reason → that event folds outward like any other → every
phone's row updates to the corrected price like any remote write, and on the **author's**
device the Tuesday operation record shows `correction: { by, reason }` — which is where the
"changed by the office" notice renders. Nobody was rejected; the log kept the original
intent.

**A room name is reserved from a dead zone.**
First, the case that is *not* a dead zone: if phone B is in BLE range **and currently has
internet**, B is a live bridge — `reserveName` simply succeeds, forwarded A → B → server and
answered server → B → A in seconds, sealed end to end so B carries envelopes it can neither
read nor fake. A true dead zone is when no such path exists: `reserveName` fails now, typed
as unreachable — an authority call does not pretend. The app writes the intent instead:
`client.rooms.request(...)` → an ordinary event, `sync: "local"` → carried A → B → server
like every event → the server's `answerNameRequests` watch sees `status: "pending"`, tries
the insert (the unique constraint decides), and writes the answer as an authority update →
the answer folds back along any path → the pending screen's plain `useQuery` shows
`"reserved"` on Thursday, though the phone never met the server. No queued RPC, no second
delivery system — the event pipeline did all of it.

**A new phone joins.**
`$grants.request(invite)` on every link → the owner's phone answers `$grants.issue(...)` →
the grant folds → every peer now admits phoneB's events → phoneB is cursor zero, so its
first exchange streams history (or checkpoint + tail) → `coverage` climbs to `"caught-up"`
and the empty states stop hedging.

**Shutdown, honestly.**

```ts
const drained = await client.$flush();   // names any job that did not make it out
await client.$close({ within: Temporal.Duration.from({ seconds: 5 }) });
```

Not required for durability — every acknowledged write already committed — just polite to
the last batch in the outbox.

---

# Part Eight — Reality: from today's code to this book

## Chapter 25. What exists (audited 2026-09-08)

The v2 codebase runs 630 green tests (371 core, 259 transport) across 16 packages, and
roughly 55–60% of the engine beneath this book already exists in production shape; roughly
25–30% of the API surface does. Production-shaped and carried forward: the kernel's HLC/
stamp/lattice fold; wire's canonical CBOR, Ed25519 envelopes preserving arrival bytes, and
hash-chained feeds; multi-dialect storage with a conformance suite and RLS compiled from the
policy AST; the engine's coverage chains, admission ladder with quarantine, compaction
floors and digest repair; the complete BLE stack over a virtual-air test harness; the
WebSocket relay with paged catch-up, retention floors and grant caching; the live-query
stack (exact invalidation, coalescing, keyed diffs, refcounted sharing) and the React hooks;
`@syncmesh/result` already being a better-result re-export with TaggedErrors throughout.
Multi-hop store-and-forward is already proven end-to-end in tests (A→B→C→D with D verifying
A's signature).

The genuinely missing pieces cluster exactly where the build order starts: no durable
operation records or custody receipts (writes return bare promises), no watchdogs, no
`$recovery` surface, two competing constructors and two competing procedure systems, errors
flattened to `Error` at the one boundary that matters, no `counter` merge (a test pins the
opposite), no LAN/AWDL/Wi-Fi Aware adapters, no per-peer multiplexer, no signed checkpoints, no
sealed partitions.

**Re-audited 2026-09-22.** Already built and not owed: the `syncOf`/`operationOf` columns,
the `.authority()` terminal, `client.$transports.add`/`.remove`. `waitFor` on the `Write`
handle was deleted on purpose by D27, not left unbuilt. Landed since the first audit:
partition kinds as values (`partition(...)`, `ladder(...)`, the reserved `global`/`user`/
`local`; the `partitions:`/`roles:`/`sealed:` blocks are gone from `syncSchema`); one noun
in handlers — `db` only, with the caller's `allow.read` and partition pin applied to every
table source on SQLite and Postgres, and a `query` handler's `db` carrying no write verbs;
`NothingWritten` as the tagged answer to a mutation that stages nothing; and `Coverage` on
reads — `local-only | partial | caught-up`, `checkpoint = { at, cursors }` — beside
`answered` on `useQuery`/`useLiveQuery`.

## Chapter 26. Keep, refine, build, cut

Verdicts by subsystem; the mechanism for each is promotion of existing machinery wherever
one exists.

- **Kernel — KEEP**, plus the `counter` strategy: a cell is `Map<author, contribution>`,
  join is per-author max, read is the sum; wire tags 3–5 are already reserved; the first
  task is flipping the `atomic-cells` test that pins whole-cell-wins.
- **Wire — KEEP**, plus the `CheckpointCertificate` (`{ partition, stateHash, coverage,
  issuedAt, issuer, sig }`) so snapshot installs stop being `provisional` — the tail already
  had certificates; the checkpoint gets the same treatment.
- **Storage — KEEP**, plus two tables (`operations`, `receipts`) and lock-on-open. The
  `Write<T>` handle is *promotion, not invention*: today's `sync-state.ts` already derives
  `local|delivered|remote` from ack cursors and `delivered.ts` already resolves promises
  against them — those computations start writing durable rows, which is what makes
  `status()` survive kill-9 (Phase 1's gate).
- **Policy — KEEP untouched.**
- **Engine — KEEP the core**; interest shrinks to `{ partitions }` (ch. 3), deleting the
  `narrows()`/scoped-cursor complexity rather than porting it; the authority free functions
  (`correct`, `setPolicy`, `revokeDevice`) become methods on `createServer`'s object; sealed
  partitions get their key layer inside the grant wire format.
- **Procedures — REBUILD the shell, keep the spine** (Standard Schema validation,
  `onCommit` capture, the mapped-type router walk). The error seam is the point: tags
  serialize as `{ _tag, ...fields }` and revive at the boundary, deleting `taggedCause()`
  and the `"PolicyDenied"` string-match.
- **Client — REFINE into one `createClient`** (grouped, discriminated options replacing the
  25-field bag) and **BUILD `Write<T>`** over the promoted receipts. The live-query stack
  and hooks carry over verbatim; `mesh.syncOf()`/`useSyncOf` are cut for the selectable
  column.
- **Transports — KEEP the stack; BUILD `PeerSession`, `lan()`, `awdl()`, `wifiAware()`.** The
  multiplexer is `Bridge` re-keyed from per-link to per-peer — the outbox/holdback/coverage
  code moves inside unchanged because it was always keyed by peer/author; mid-transfer
  resume falls out free because progress is cursor state. Admission's budget/hysteresis/
  anti-clique math keeps, demoted to the default policy inside a **fail-closed**
  `AdmissionGate` — fail-closed is the difference between a budget and a door.
- **Relay — KEEP the machinery, reframe the owner**: `startRelay` disappears as a public
  entry; the same code is `createServer` with no `handlers` (the pure-custody
  configuration). The 3-method `Fanout` port stays; `redis-fanout.ts` is replaced by
  `postgresFanout` on the same port (ch. 21); `memoryFanout()` stays the default.
- **CDC — KEEP** unchanged: inbound external-DB→mesh capture with watermarks and
  ack-after-durable-write is the integrations story.

The cut list, complete: `createMesh`+`createApp` → `createClient`; the two procedure systems
→ one grammar; the bodiless `authority.input().returns<T>()` builder → the `.authority()`
terminal; `CallError = Error` + `taggedCause()` → tagged wire errors (done 2026-09-22; `taggedCause`
was already gone, the wire already revived tags — what remained were five bare `new Error`
mint sites, now `InputInvalid`, `SchemaNotSynchronous`, `NothingWritten`,
`AuthorityUnreachable`, `NoBodyBound`); `Interest.tables`/
`Interest.where` → partition-granular interest; `redis-fanout.ts` → `postgresFanout`;
`startRelay` → `createServer`-with-no-handlers; `mesh.syncOf()`+`useSyncOf` → the `syncOf`
column; per-link `Bridge` → `PeerSession`; fail-open budget → fail-closed gate;
`provisional` snapshots → `CheckpointCertificate`; the `@syncmesh/errors` package → classes
in their owning packages.

## Chapter 27. The build order

Each phase has a demonstration, not a date promise; roughly month-scale each, overlapping
where independent. Phases 0–3 are the engine and the API you type against — the worked app
(Part Seven) compiling and running is the midpoint milestone. Phases 4–6 are the radio
pragmatics and scale features the Ditto study priced out; nothing in them changes a
signature from 0–3.

| Phase | Work | Gate |
| --- | --- | --- |
| 0 | The TaggedError catalog on `@syncmesh/result` (declared per owning package); Disposable handles + `$inspect.handles()`; store lock-on-open; failure reproductions preserved | every failure path returns a named TaggedError with `cause`; chaos epilogue asserts zero handles; double-open fails typed; every existing incident has a red test |
| 1 | Durability: operation records, outbox/inbox, custody receipts, `Write` handle, read-your-own-writes | kill -9 at every commit boundary; every acknowledged write reopens intact |
| 2 | Recovery + corrections: fixed-point retry, `$recovery`, authority corrections with reasons, watchdogs | update-before-insert, grant-after-event, route-change scenarios converge or report a stable cause |
| 3 | The typed surface: the `query`/`mutation` builders with `.handler()`/`.authority()` terminals, `createClient`/`createServer`, `AuthorityHandlers`, hooks, TanStack adapter, `syncOf`/`operationOf` columns | the worked app compiles and runs against the real engine |
| 4 | Transports: `lan` + `awdl` + `wifiAware` adapters, peer session, mesh shaping, `$status` diagnosis | thirty simulated peers in one room: no islands, budgets hold, transfers survive link swaps |
| 5 | Presence graph + admission gate + N-hop routing | A→B→C→server round trip survives B leaving mid-request |
| 6 | Partition lifecycle: detach/re-attach + storage budget, `merge: "counter"`, blob progress + streams | a device detaches an idle partition under pressure and re-attaches from checkpoint + tail, converging; detach refuses while unsent intent exists; concurrent +1/+1 folds to 2 |

---

# Part Nine — The codex

## Chapter 28. The rules behind the shapes

1. One noun. The client is the api; machinery is `$`-surface on it; there is no second
   handle.
2. One definition. Tables and procedures are declared once and serve device SQLite, server
   Postgres, HTTP and OpenAPI; the schema value derives its own artifacts — nothing
   generated, never a connection.
3. Scope is input. Construction names no tenant; IDs are data; per-scope storage is
   internal.
4. Adapter machinery rides `~mesh`. A read's public surface is `then`, alone; what lives on
   this device is decided by grants over partitions, never by a descriptor.
5. Writes are statements. Effects are watched reactively; the operation record is orthogonal
   axes that survive restart; nothing conflates delivered with accepted.
6. No string coordinates. Row facts (`syncOf`, `operationOf`) are columns the query selects;
   hooks take one descriptor built from typed references — a procedure call or its `.can`
   rehearsal, an operation ref — never a name the type system already knows.
7. Every read answer carries coverage; empty is never silently authoritative.
8. The caller comes from `auth` — construction on a device, per-request on a server — and no
   call site ever picks one. Server bodies are a typed mirror of the router's `.authority()`
   leaves — a missing body is a compile error; a correction is an ordinary authoritative
   write with a reason, not a review pipeline; a rule that must gate a write is an authority
   mutation, not an engine mode.
9. Reaching a peer is routing, not configuration; recovery is automatic, with a small door
   for operators; every barrier tells the truth about what it drained.
10. Custody is per-partition and whole: grants decide what lives on a device, every holder
    of a partition folds identical state, and rendering pulls nothing. Partial partitions do
    not exist — not for replication, not for storage.
11. Live queries keep four promises: first delivery async, first delivery complete,
    coalesced latest-wins always, unchanged rows keep identity with keyed diffs.
12. Every handle is `Disposable`, idempotent to cancel, never GC-coupled;
    `$inspect.handles()` returns to zero in every chaos epilogue.
13. Every failure is a `TaggedError` with typed fields and its `cause` kept; handling is
    exhaustive by compilation — no code strings.
14. Admission shapes topology, derives from grants by default, and fails closed; grants and
    `allow` rules shape data — the handler is an override, never a second trust system.
15. Cheap descriptors (blob refs, peer metadata) replicate eagerly; payloads move on demand
    with observable progress and one tagged terminal.

## Chapter 29. The NEVERs

Each absence is a principle, recorded where it died:

- **Fold-time veto** — refusing to fold what others folded is divergence (ch. 2, 19).
- **Handler replay on receivers** — re-execution diverges; the fold converges (ch. 2).
- **Query-scoped replication / partial partitions** — a filtered projection of a log no
  longer folds to identical state (ch. 3); the same NEVER wears a storage hat as row
  eviction (ch. 13).
- **Scope bound at construction** — a scope ID is data; data changes without reconstruction
  (ch. 3).
- **A queue mode on authority calls** — events are already the one durable
  park-and-deliver-and-answer system; offline intent is a request row (ch. 7).
- **Server-assigned ids** — a human-facing number is data the authority fills (ch. 1).
- **A framework id generator** — no `ids.next()`, no shipped uuid helper, no `id:` config:
  the app's own column default generates; syncmesh checks only that the id could have been
  born offline (ch. 1).
- **Review/approval machinery in the engine** — gate, mechanical rule, or correction; a
  sign-off flow is an app workflow (ch. 6).
- **A relay tier** — the server is the relay; every peer carries (ch. 22).
- **A broadcast primitive** — pairwise gap-filling is the only send (ch. 4).
- **Redis / any second signaling service** — it duplicates the bus the database already is
  (ch. 21).
- **Logical-replication slots** — subscribing to the shadow of our own log (ch. 21).
- **More writers per scope** — deciding doesn't commute; a scope that needs two writers is
  two scopes; no sharding, no leader election (ch. 22).
- **String coordinates** — `useSyncOf("products", id)` and its kin; typed references exist
  (ch. 10).
- **GC-coupled handles** — silent subscription death; leaks are loud instead (ch. 10).
- **A graph-walk ReBAC engine** — relationships are rows the authority flattens into
  grants; the partition is the relationship boundary (ch. 14).
- **Environment inputs in policy** — a rule reads the event, the grant, the prior row, and
  the policy, nothing else; clocks and lookups make peers disagree (ch. 6).
- **An error-code map** — TaggedErrors with typed fields and `cause` (ch. 5).
- **A separate errors package** — classes live where their failures live (ch. 5).
- **`useMutation`** — there is no in-flight state worth a hook (ch. 10).
- **A general DHT** — routing is a room, a building, a convoy; bounded radius (ch. 17).

## Chapter 30. The surface, complete

Every export of the new version, by package — if it is not on this list, it is not public:

| Package | Exports |
| --- | --- |
| `@syncmesh/schema` | `syncSchema`, `drizzleTable`, `ladder`, `flat`; the shared column/write helpers `columns`, `syncOf`, `operationOf`, `increment` (schema-layer, importable from shared code — never from `@syncmesh/client`); a schema value exposes `tables`, `rows`, `inputs`, `manifest` — derived at construction, nothing generated |
| `@syncmesh/procedures` | `query`, `mutation` — kind first; the terminal decides: `.handler(fn)` runs at the replica, `.output(schema).authority()` declares the authority's half |
| `@syncmesh/result` | the in-repo better-result: `Result`, `Result.try`, `Result.tryPromise`, `TaggedError`, `matchError` — the error catalog (`StoreLocked`, `Unreachable`, `BlobDeleted`, `HistoryUnavailable`, …) is built on it, each class declared in the package that owns the failure |
| `@syncmesh/client` | `createClient` → procedures at the top level (each with the `.can(input)` rehearsal descriptor) plus `$operations`, `$recovery`, `$transports`, `$peers`, `$routes`, `$status`, `$auth`, `$grants`, `$drafts`, `$presence`, `$blobs`, `$inspect`, `$flush`, `$close`; `sqlite()` |
| `@syncmesh/server` | `createServer` → the same surface plus `server.api`, `server.fetch`, `server.openapi`; `AuthorityHandlers<R>`; `watch`; `systemProcedure`; `postgres()` |
| `@syncmesh/react` | `useQuery`, `useOperation`, `useCan` |
| `@syncmesh/tanstack-db` | `syncmeshCollection` |
| `@syncmesh/transports` | `ble`, `lan`, `awdl`, `wifiAware`, `webSocket`, `http`, `webSocketListener`; the `TransportAdapter` SPI |
| `@syncmesh/browser` | one engine per origin, because only one browsing context may hold a durable database: `serveMesh(mesh)` in the elected tab's dedicated worker, `connectMesh({ link, schema })` in every tab, and the `MeshLink` between them. The only adapter an app calls itself — a driver is passed to `createClient`, this one is the worker entry you write |
| shared types | `Query`, `Write`, `OperationStatus`, `CustodyReceipt`, `Coverage`, `RecoveryIssue`, `Milestone`, `BlobRef`, `SessionAsk`, `TransportSource`, `TransportCondition`, `Entropy` |

## Chapter 31. Glossary

- **author** — the device whose key signed an event; each author owns one append-only,
  gapless sequence per partition.
- **authority** — the one peer per scope entitled to decide before an event exists (gates)
  and to correct after the fold; named in `trust`, never elected.
- **bridge / courier** — the same forwarding peer in two tempos: a bridge holds both links
  open at once (seconds), a courier carries between sessions (hours).
- **coverage** — how much of the world a query's answer represents: `local-only`, `partial`,
  or `caught-up` to a named source's checkpoint.
- **correction** — an ordinary authoritative write carrying `{ reason }`; the log derives
  which operation it displaced; nothing is deleted.
- **cursor** — `author → highest contiguous seq I hold`; the entire replication protocol is
  exchanging these and filling the gaps.
- **custody** — what lives on a node: whole partitions, held under grants. A custody receipt
  is a signed acknowledgment of durable holding — never acceptance.
- **event** — one signed, immutable entry `(author, seq)` carrying cell-level changes; the
  only thing that replicates.
- **fold** — verify + merge + materialize; the single pipeline every receiver runs; the
  system's replacement for replay.
- **gate** — imperative code that runs before an event exists (`.authority()` bodies); the
  only place a write can be refused.
- **grant** — a signed statement from the issuer that a device may write named partitions
  with a role; the fold checks it everywhere; revocation is the real enforcement.
- **milestone** — a point on a write's journey worth awaiting: `committed` (local, durable)
  or `replicated` (n custody receipts).
- **operation** — the durable record of one write: id, status, receipts, correction linkage,
  blockers; survives restart; subscribable.
- **partition** — the unit of custody, granting, sealing, detaching, and convergence; scale
  is more of them, never more writers per one.
- **quarantine** — where an event that fails admission parks, holding its author's cursor
  below it rather than being skipped.
- **replica** — one partition's local store: its own file, coverage, and recovery state.
- **watchdog** — a server-side subscription over state whose reaction is corrections; keyed
  by data, not by procedure, because merge-born violations have no call to blame.
- **weather** — a device's current relationship to the authority: direct, bridged, or dead
  zone. Online means routable.

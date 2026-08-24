---
rfc: 0018
title: Incremental View Maintenance & Query Subscription
package: syncmesh (src/react/live-query.ts · src/core/engine.ts) — research + design
layer: 3
status: implemented
standalone: false
deps: ["0002", "0008", "0009", "0010", "0012"]
---

# RFC-0018 — Incremental View Maintenance & Query Subscription

## Purpose

This document reports what Zero and LiveStore actually do, read from their
source, and states which parts SyncMesh should adopt. It covers two problems
that are easy to conflate:

| Problem | Question it answers | Where it pays |
|---|---|---|
| **Incremental view maintenance (IVM)** | When data changes, how do I update a query result without recomputing it? | Local CPU |
| **Query subscription** | Which data does a peer actually need, so I never send the rest? | Bandwidth |

Zero solves both. LiveStore solves neither — deliberately. SyncMesh needs
them in different places, and the mesh changes the answer to the second one.

Sources read: `rocicorp/mono` — `packages/zql/src/ivm`, `packages/zero-cache/src/services/view-syncer`, `packages/zero-protocol/src`; `livestorejs/livestore` — `packages/@livestore/common/src/{leader-thread,schema/state/sqlite/system-tables}`, `packages/@livestore/livestore/src`.

---

## 1 · What IVM is

A view is the result of a query. Maintaining it incrementally means applying
the *delta* of a change to the *delta* of the result, instead of recomputing
the result from the base data.

Consider `SELECT * FROM issue WHERE status = 1 ORDER BY rank LIMIT 50` over
6,000 issues:

- **Re-run** (what SyncMesh and LiveStore do today): scan 6,000 rows, filter,
  sort, slice. Cost is O(n log n) per write, per mounted query.
- **IVM**: one row changed. Decide whether that row enters, leaves, or moves
  within the window, and emit at most one add, one remove, or one edit. Cost
  is O(log n) or O(1), independent of table size.

The measured consequence in SyncMesh today (`bench/linearlite.ts`): 7 mounted
queries over 6,000 issues cost **7.17 ms per write**. The same queries over
1,500 issues cost 1.59 ms. Cost scales with the table, not the change. A
60fps frame is 16.7 ms, so this crosses the budget between 10,000 and 15,000
rows.

---

## 2 · Zero's IVM, in detail

Zero compiles a ZQL query into a **pipeline of stateful operators**. Rows
flow through it in two directions: `fetch()` pulls, `push()` propagates
deltas. Every operator implements both.

### 2.1 The data unit is a tree, not a row

```ts
type Node = {
  row: Row;
  relationships: Record<string, () => Stream<Node | 'yield'>>;
};
```

ZQL returns nested results (`issue.comments[]`), so the unit flowing through
the pipeline is a row *plus lazily-generated children*. Relationships are
functions, not arrays: a child stream is materialized only if someone reads
it, and each stream is single-use.

### 2.2 The change algebra has four cases, not three

```ts
type Change = AddChange | RemoveChange | ChildChange | EditChange;
```

- `add` / `remove` — a node (with all its children) enters or leaves.
- `edit` — the row changed; carries both `node` and `oldNode`.
- `child` — the row is unchanged, but a descendant changed. Carries the
  relationship name and the nested change.

`child` is what makes nested results cheap: a new comment on issue 7 does not
re-emit issue 7's whole subtree, it emits a `child` change addressed to it.

**The subtle rule.** An `edit` is split into `remove` + `add` when either:

1. the row's presence in the result changes (a filter now rejects it), or
2. the edit changes the row's relationships.

If an edit is *not* split, `node` and `oldNode` must carry identical
relationships. Get this wrong and downstream operators corrupt their state —
this is the single most error-prone part of the design.

### 2.3 The operator contract

```ts
interface Input {
  getSchema(): SourceSchema;
  setOutput(output: Output): void;
  fetch(req: FetchRequest): Stream<Node | 'yield'>;
  destroy(): void;
}

interface Output {
  push(change: Change, pusher: InputBase): Stream<'yield'>;
}

interface Operator extends Input, Output {}
```

`FetchRequest` carries a `constraint` (a pushed-down predicate), a `start`
(`{row, basis: 'at' | 'after'}` — a seek, so an operator can resume from a
known position rather than scanning), and `reverse`.

The contract Zero documents on `Output.push` is a correctness precondition,
not advice:

> Only add rows which do not already exist (by deep equality). Only remove
> rows which do exist (by deep equality).

Violating it silently desynchronizes downstream state.

### 2.4 Operator state is external and key-value

```ts
interface Storage {
  set(key: string, value: JSONValue): void;
  get(key: string, def?: JSONValue): JSONValue | undefined;
  scan(options?: {prefix: string}): Stream<[string, JSONValue]>;
  del(key: string): void;
}
```

Operators never hold their state in closures. It lives in an injected
`Storage`, which is why Zero can run the same pipeline against memory on the
client and against SQLite on the server, and why operator state is bounded
and inspectable.

### 2.5 Sources multiplex, and push filters down

```ts
connect(sort: Ordering, filters?: Condition, splitEditKeys?: Set<string>): SourceInput
```

One `Source` per table serves many pipelines. Each `connect()` declares the
sort order it needs and the filters it wants applied *at the source*. The
returned input exposes `fullyAppliedFilters: boolean`, telling downstream
operators whether they must re-check the predicate.

`splitEditKeys` is the mechanism behind §2.2: name the columns whose change
must turn an `edit` into `remove` + `add`.

### 2.6 `take` is the operator that makes windows cheap

```ts
type TakeState = { size: number; bound: Row | undefined };
```

`Take` keeps the count and the **bound** — the last row it accepted. On a
push it compares the incoming row against the bound to decide, in constant
time, whether the row belongs in the window at all. It maintains the
invariant that its output is never larger than the limit, *even mid-push*.

This is the operator that matters most for SyncMesh. A windowed query
(`last 50 messages`) becomes O(1) per write instead of O(rows), and the same
bound is what tells you a remote row is irrelevant.

### 2.7 Responsiveness is inside the dataflow

Every stream is `Stream<Node | 'yield'>`. An operator can yield control
mid-fetch or mid-push, and the contract requires the yield to propagate
immediately to the caller.

SyncMesh solved the same problem *outside* the engine, by slicing ingest
(`Engine.receiveWireStream`). Zero solved it *inside* the query engine,
because a single push through a deep pipeline can itself be long. Both are
needed eventually; ours covers the ingest spike, theirs covers a fan-out
query.

---

## 3 · Zero's query subscription: the CVR

IVM makes the server's queries cheap. The **client view record** decides what
the client is told. It is a per-client-group table set in Postgres
(`packages/zero-cache/src/services/view-syncer/schema/cvr.ts`):

| Table | Holds | Key columns |
|---|---|---|
| `instances` | one row per client group | `version`, `replicaVersion`, `owner`, `ttlClock`, `lastActive` |
| `queries` | queries the group has, and their state | `patchVersion` (NULL = desired but not yet delivered) |
| `desires` | which client wants which query, with TTL | `patchVersion` |
| `rows` | **every row the client currently holds** | `rowVersion`, `patchVersion`, `refCounts` |

The load-bearing column is:

```sql
"refCounts" JSONB,  -- {[queryHash: string]: number}, NULL for tombstone
```

Each row records **which queries reference it, and how many times**. When a
client drops a query, the server decrements; a row is only deleted from the
client's view when its refcount reaches zero. Without this, unsubscribing
from one query would evict rows another query still displays.

### 3.1 The wire protocol syncs rows, not events

Client → server:

```ts
['changeDesiredQueries', { desiredQueriesPatch: [
  { op: 'put', hash, ast, ttl },   // subscribe
  { op: 'del', hash },             // unsubscribe
  { op: 'clear' },
]}]
```

Server → client, as a three-part `poke`:

```ts
['pokeStart', { ... }]
['pokePart',  { gotQueriesPatch, rowsPatch }]
['pokeEnd',   { ... }]
```

where `rowsPatch` ops are `put` (full row), `update` (`{id, merge, constrain}`
— a partial row), `del`, and `clear`.

**This is the central architectural fact: a Zero client never sees the event
log.** It declares queries and receives row patches. The server holds all
data, runs every client's pipelines, diffs the output against that client's
CVR, and sends the difference. Bandwidth is proportional to what the client
can see change.

### 3.2 The precondition SyncMesh does not have

That design requires a node that:

1. holds **all** the data, and
2. can afford to run **every** client's queries.

`zero-cache` is that node. It replicates Postgres into a local SQLite replica
and runs pipelines per client group. In a mesh with no authority, neither
precondition holds: no peer has the whole dataset, and a phone cannot run 30
neighbours' query pipelines. §5 addresses this.

---

## 4 · LiveStore: what it stores and why it is not IVM

### 4.1 Two databases

LiveStore keeps the **eventlog** and the **state** in separate SQLite files.

**Eventlog database** (`schema/state/sqlite/system-tables/eventlog-tables.ts`):

| Table | Purpose |
|---|---|
| `__livestore_eventlog` | every event |
| `__livestore_sync_status` | `head` (remote position), `backendId` |

The eventlog row is worth reading closely:

```ts
seqNumGlobal, seqNumClient, seqNumRebaseGeneration   // composite primary key
parentSeqNumGlobal, parentSeqNumClient, parentSeqNumRebaseGeneration
name              // event definition name, e.g. 'v1.UpdateIssueStatus'
argsJson          // payload
clientId, sessionId
schemaHash        // detects schema drift
syncMetadataJson
```

Two things stand out. The sequence number is a **triple**, not a scalar:
global position, client position, and a rebase generation. And each row names
its **parent** — the eventlog is an explicit chain, which is how LiveStore
detects divergence and rebases.

The file header states the constraint plainly:

> ⚠️ CRITICAL: NEVER modify eventlog schemas without bumping
> `liveStoreStorageFormatVersion`! Eventlog is the source of truth.

**State database** (`state-tables.ts`): your materialized tables, plus
`__livestore_schema`, `__livestore_schema_event_defs`, and:

```ts
__livestore_session_changeset {
  seqNumGlobal, seqNumClient, seqNumRebaseGeneration,
  changeset: BLOB,   // a SQLite session-extension changeset
  debug: JSON
}
```

### 4.2 Materialization, and how rollback works

An event is materialized by running its materializer, which returns SQL
statements executed inside a transaction (`leader-thread/materialize-event.ts`).
While the transaction runs, LiveStore uses the **SQLite session extension** to
capture a changeset blob describing exactly which rows changed, and stores it
against the event's sequence number.

Rollback — needed whenever the server rebases a local event — is then:

```ts
// apply changesets in reverse order
dbState.makeChangeset(changeset).invert().apply()
```

This is a clean and reusable idea: you get exact undo of a materialization
without writing an inverse for every materializer, at the cost of one blob
per event.

Note also `materializeEventsBatch`, which wraps a whole batch in one
transaction, with the comment *"We always start a transaction to ensure
consistency between db and eventlog (even for single-item batches)"*. That is
the same lesson SyncMesh measured as 450× in RFC-0004.

### 4.3 LiveStore's reactivity is re-run, not IVM

`packages/@livestore/livestore/src/SqliteDbWrapper.ts`:

```sql
SELECT tbl_name FROM tables_used(?) AS u
  JOIN sqlite_master ON sqlite_master.name = u.name
 WHERE u.schema = 'main';
```

LiveStore asks SQLite which tables a query reads, caches that per query
string, and invalidates a result cache when a write touches those tables. The
query then **re-runs in full**.

That is the same design as SyncMesh's `QueryRegistry`, with SQL instead of JS
predicates and a smarter way of discovering the dependency. It is not
incremental. The `tables_used` trick is worth stealing regardless — it derives
the dependency automatically instead of trusting the caller to declare it.

---

## 5 · What SyncMesh should do

### 5.1 Separate the two problems, because they have different answers

| | Local IVM | Query subscription |
|---|---|---|
| Buys | CPU: frame budget at 50k+ rows | Bandwidth: the thing BLE actually limits |
| Zero's answer | operator dataflow | CVR on an all-knowing server |
| Viable in a mesh? | Yes, unchanged | No, not as designed |
| Priority for us | Medium | **High** |

Bandwidth is the binding constraint (RFC-0002: 30 B/event chunked, and a
250 kbps radio). CPU is not: steady state measures 0.52 ms per event with six
live queries. **Do query subscription first.**

### 5.2 Query subscription without an authority: three tiers

**Tier 1 — partitions (RFC-0008, exists).** A device syncs the partitions it
belongs to. Coarse, requires no query engine, and eliminates the largest
category of waste: rooms and workspaces you are not in. Do this first because
it is already specified and needs no new machinery.

**Tier 2 — interest predicates (new, recommended).** A peer advertises a
compact, serializable predicate describing what it wants:

```json
{ "partition": "room:general",
  "tables": ["message", "reaction"],
  "since": 1755600000000,
  "where": { "status": { "neq": "archived" } },
  "limit": { "orderBy": "ts", "dir": "desc", "n": 500 } }
```

The sender evaluates the predicate against each candidate event before
shipping it. This reuses the **policy AST** machinery from RFC-0008 — a
serializable predicate tree with no closures — so it costs one evaluator, not
a query engine. It is the mesh-shaped version of `changeDesiredQueries`.

Two properties make this safe:

- Predicates are **advisory for liveness, never for correctness**.
  Anti-entropy (RFC-0012) still converges anything a predicate wrongly
  excluded, because cursors are unaffected.
- Predicate evaluation is per-event and stateless, so a sender does not
  maintain a CVR per neighbour. Cost is O(events × neighbours) predicate
  evaluations, not O(queries × rows).

The `limit` clause is the one that needs care: honouring "last 500" requires
the sender to know the recipient's window bound. Ship it as a **hint** —
the sender applies it best-effort using its own ordering, and the receiver
discards overflow. Exact windowing is Tier 3.

**Tier 3 — CVR on the relay only (RFC-0010).** The relay *is* the node that
holds everything and can afford per-client pipelines. Implement Zero's CVR
there, with refcounted rows, and nowhere else. A phone syncing through a
relay then gets Zero-grade efficiency; a phone in a raw mesh gets Tier 1+2.

### 5.3 Local IVM: three steps, stop when the budget is met

**Step 1 — delta invalidation (small, do now).** `FoldBatch` already carries
`writeKeys` (added in M21). A mounted query currently re-runs whenever its
table is touched. Instead:

- If the query has no filter and no window, re-run (nothing better available).
- If the changed keys are all outside the query's current result **and**
  outside its window bound, skip the re-run entirely.

For a Kanban board — 7 queries, one row edited — this turns 7 full re-runs
into at most 1. Expect roughly an order of magnitude on the measured
7.17 ms/write, for perhaps 150 lines.

**Step 2 — maintain sort order incrementally.** Keep the result as a sorted
array plus a bound (Zero's `Take`). On a change, binary-search the insertion
point instead of re-sorting. Removes the `n log n` term.

**Step 3 — real IVM, and only the operators we need.** Adopt Zero's shape:
`Input`/`Output`/`Change`/`Storage`, sources with pushed-down filters. Build
`source → filter → sort → take`. **Skip joins.** Most of Zero's ~50-file IVM
package exists to make joins and nested results correct (`join.ts`,
`flipped-join.ts`, `fan-out`/`fan-in`, `exists.ts`, and their push/fetch test
matrices). A filter/sort/take pipeline over flat rows is a fraction of that.

Adopt these details verbatim, because they are where the bugs live:

- the four-case change algebra, including `edit` and its split rule
- `splitEditKeys` to decide when an edit becomes remove + add
- operator state in an injected key-value `Storage`, never in closures
- the `take` bound invariant: output ≤ limit *at every point during a push*
- the yield protocol, so a deep push cannot hold a frame

### 5.4 Also worth taking, independent of IVM

| Idea | Source | Why |
|---|---|---|
| `tables_used()` for automatic dependency discovery | LiveStore | Removes a class of "forgot to declare the table" bugs |
| SQLite session-extension changesets for exact undo | LiveStore | Gives us rollback without inverse materializers — useful for authority rejection (RFC-0014) |
| Sequence number as `(global, client, rebaseGeneration)` | LiveStore | If we ever support local-only events, a scalar seq will not survive it |
| Row refcounts per query | Zero | The correct way to evict on unsubscribe; needed by Tier 3 |
| `Start = {row, basis}` seek in fetch | Zero | Lets a windowed query resume without scanning |

---

## Current state — all built

| Piece | Where |
|---|---|
| `writeKeys` on `FoldBatch` | `src/core/engine.ts` |
| Delta invalidation + incremental sort/window | `src/react/live-query.ts` |
| Serializable predicates + column introspection | `src/ivm/predicate.ts` |
| Change algebra, operator contracts, `Storage` | `src/ivm/types.ts` |
| Source with filter push-down and `splitEditKeys` | `src/ivm/source.ts` |
| `Filter`, `Take`, `ArrayView`, pipeline builder | `src/ivm/{filter,take,view,pipeline}.ts` |
| Engine → source bridge, `ivmQuery` | `src/ivm/{engine-source,query}.ts` |
| Interest predicates + scoped catch-up | `src/protocol/interest.ts`, `Engine.eventsSince` |
| CVR with row refcounts | `src/authority/cvr.ts` |
| Relay query subscription (`desire` / `rows` / `rowsOnly`) | `server/relay.ts` |
| Exact undo as a corrective event | `Engine.revert` |
| Local-only events | `Engine.mutate(..., { local: true })` |
| Automatic dependency discovery | `dependenciesOf()` |

### Measured

Delta invalidation, on the Linear-like board (6,000 issues, 7 mounted
queries): **7.17 ms → 0.24 ms per write**, a 30× improvement. Most of it came
from a bug the profiling exposed: the engine's dirty-key set was only cleared
when a state store was configured, so every batch reported every key ever
written and consumers doing delta work silently degraded to O(history).

The operator pipeline is **not faster than delta invalidation** for these
query shapes — it is 1.0–2.3× slower, because it maintains two indexes (the
source connection and the `Take` window) where the delta path maintains one,
and pays generator overhead for the yield protocol:

| rows | delta re-run | IVM pipeline |
|---|---|---|
| 1,000 | 0.0095 ms | 0.0095 ms |
| 10,000 | 0.0083 ms | 0.0097 ms |
| 50,000 | 0.0075 ms | 0.0170 ms |

That is not a reason to delete it. The pipeline's value is **structural**: it
emits change-level deltas (`add` / `remove` / `edit`), which is exactly what
row patches need — the delta path produces a new array and cannot say what
moved. The CVR is built on it. It also composes, and pushes predicates into
the source. Use `useLiveQuery` for UI, `ivmQuery` where something downstream
consumes changes.

### Tests

- `tests/live-query-ivm.test.ts` — incremental ≡ full re-run after *every*
  operation, over randomized sequences, for seven query shapes
- `tests/ivm-pipeline.test.ts` — pipeline ≡ oracle; the edit-split table;
  `Take`'s limit invariant *during* a push; seek and reverse fetch; yields
- `tests/ivm-engine.test.ts` — the same property driven by real fold batches
- `tests/interest.test.ts` — including the data-loss hazard: widening an
  interest must recover events filtered out earlier
- `tests/cvr.test.ts`, `tests/relay-cvr.test.ts` — refcounts, and a row-only
  client that receives no events at all
- `tests/undo-local.test.ts` — revert as a new event that converges; local
  events that never ship and never consume a synced sequence number

### Two bugs the property tests caught

1. **Duplicate rows on a moved edit.** The source mutated its index before
   pushing both halves of a split, so a `Take` back-fill could pull the new
   row in and then receive it again as the `add`. Fixed by mutating the index
   in step with each push — the index must always equal what downstream has
   been told.
2. **A mutating snapshot.** With no limit, `data()` returned the internal
   array, which the delta path then spliced underneath the caller —
   `useSyncExternalStore` requires a stable snapshot. Now always a copy.

## Answers to the open questions

- **Serializable predicates are required for IVM**, confirmed. Closure
  filters cannot say which columns they read, so `splitEditKeys` cannot be
  derived. `useLiveQuery` keeps closures and uses delta invalidation, which
  needs no introspection; `ivmQuery` takes a `Pred`.
- **Interest lives with the cursors, not in the handshake.** A max-based
  cursor cannot represent the holes filtering leaves, so an interest change
  must reset what the receiver asks with. `InterestTracker` owns both.
- **Tier 2 cost:** ~1 µs per event per neighbour (measured over 5,000
  events). Against ~30 B/event on the wire, the predicate pays for itself as
  long as it excludes anything at all.

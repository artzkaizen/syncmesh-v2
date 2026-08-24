---
rfc: 0021
title: Change Data Capture — syncing an existing database
package: syncmesh (src/cdc) — design
layer: 3
status: proposed
standalone: true
deps: ["0002", "0003", "0008", "0010", "0013"]
---

# RFC-0021 — Change Data Capture

## Purpose

An app with an existing Postgres cannot adopt SyncMesh today. Our rule is that a
table is **either** synced (defined in `collections`, living in the event log)
**or** private (defined in your ORM, living in your database) — never both,
because two definitions of one table drift and a mirror between them is the
"two stores, one sync" tax we refuse to pay.

That rule is right, and it locks out the most common case: *"my data is already
in Postgres, and I want devices to hold it offline."*

Change data capture is the bridge. The database stays authoritative; the mesh
carries a **signed, ordered projection** of it. No mirror, no drift, no second
definition — because the direction is fixed.

## The shape, taken from Zero

`zero-cache` subscribes to a Postgres replication slot and turns the WAL into a
stream of row changes, which it stores and serves. Its seam
(`services/change-source/change-source.ts`) is two types and nothing else:

```ts
interface ChangeSource {
  startStream(afterWatermark: string, backfillRequests?: BackfillRequest[]): Promise<ChangeStream>
}
type ChangeStream = { changes: Source<ChangeStreamMessage>; acks: Sink<ChangeSourceUpstream> }
```

A **resumable stream plus an ack channel**. Everything else — Postgres, MySQL,
SQLite, a test double — is an implementation of those two.

Their stream is transaction-framed: `begin` → `insert | update | delete |
truncate | backfill`* → `commit(watermark)`. **That framing is already our event
boundary.** D1 says an event is one committed transaction's captured changes,
applied by a fixed routine. A Postgres transaction becomes exactly one SyncMesh
event. This is the closest fit between our model and anyone else's we have found.

## The port

```ts
export type Watermark = string;   // opaque, lexicographically ordered

export interface ChangeSource {
  readonly name: string;
  /** Resume after this watermark, or from a full backfill when null. */
  start(opts: { after: Watermark | null }): Promise<ChangeStream>;
}

export interface ChangeStream {
  changes: AsyncIterable<ChangeMessage>;
  /** Called only once the derived event is DURABLE. See "Acks", below. */
  ack(watermark: Watermark): void;
  stop(): void;
}

export type ChangeMessage =
  | { t: "begin" }
  | { t: "insert";   table: string; row: Row }
  | { t: "update";   table: string; key: string; after: Row }
  | { t: "delete";   table: string; key: string }
  | { t: "truncate"; table: string }
  | { t: "commit";   watermark: Watermark };
```

Same two-type seam, same reason: a source stays short. A Postgres source is
logical replication. A SQLite source is triggers writing an outbox table. A
"manual" source is a function your app calls when it writes — the escape hatch
for anyone whose database cannot stream.

## The bridge

```ts
new SyncmeshServer({
  identity, collections, store, ops, context,
  changeSources: [
    postgresChangeSource({ connectionString, publication: "syncmesh" }),
  ],
  changeMapping: {
    // which DB table feeds which collection, and how a row finds its partition
    tasks: { collection: "tasks", partition: (row) => `org:${row.org_id}` },
    sites: { collection: "sites", partition: (row) => `org:${row.org_id}` },
  },
})
```

Between `begin` and `commit`, changes accumulate. On `commit`, the authority
folds them into **one signed event per partition touched** (one event is one
partition, M6), commits it, and only then acks the watermark.

## Direction is fixed, and that is the whole design

**DB → mesh only.** A CDC-backed collection is **read-only on devices**, and the
policy says so:

```ts
tasks: { partition: "org", allow: { $default: deny, read: role("viewer") } }
```

A device write is denied locally *and* quarantines at every peer, so there is no
path by which the mesh can contradict the database.

Writes still work — they go the other way round:

```
device ──op(request row)──► authority ──► Postgres ──WAL──► authority ──► mesh ──► devices
```

The write path is an **op** (RFC-0010); the read path is **CDC**. Each direction
has exactly one mechanism, so there is no mirror to reconcile and no conflict
resolution between two stores. This is what reflectdb pays for with its documented
drift ("a crash between the two leaves your database ahead of the mirror") and
what we avoid by refusing two-way.

The cost, stated plainly: **a CDC-backed table is not offline-writable.** That is
a real limitation and it is the correct trade — the database is authoritative, so
an offline write against it is a promise we cannot keep. Tables that must be
offline-writable stay mesh-native, where the local commit is the truth.

## Consequences worth knowing before building

**The authority signs everything.** A WAL row has no author and no key. Events
derived from it are authored by the authority's device key, so on CDC-backed
tables `owner("createdBy")` compares against the authority, not the person — the
column still holds a user id, but the *signature* does not. Ownership policy on
those tables must read the column (`rowIs`), never the author.

**Acks gate durability.** Ack a watermark only after the derived event is durable
in our `EventStore`. Ack early and a crash loses the change with no way to
re-request it — the same class of bug as a transport that resolves `send` on a
dropped frame (RFC-0005). Zero has a `Storer` between the stream and the ack for
exactly this reason.

**The watermark is our state, not theirs.** Persist it in a reserved `_cdc` table
keyed by source name, written in the same commit as the event it describes.
Anything else can skip or replay across a restart.

**Replay is safe but not free.** Re-reading from an older watermark produces new
events with new seqNums carrying the same values. Field-level LWW converges
(same values, later stamps), so correctness holds — but the log grows. Durable
watermarks are what keep replay rare.

**Schema changes must not pass through.** Our schema is a frozen wire artifact
(RFC-0013): a column added in Postgres is not a column in the mesh until you
change `collections` and ship it. A `TableCreate` / `ColumnAdd` in the stream is
therefore an **alarm**, not an instruction. Zero applies them; we cannot, because
our wire is signed and versioned and theirs is a private replica.

**`truncate` is a partition-scoped delete**, and a loud one — it emits a tombstone
per row, which on a large table is a large event. Cap it, and require an explicit
opt-in.

**Backfill is the join problem again.** A new source, or a newly published table,
needs current state before the stream is meaningful. That is RFC-0019's scoped
snapshot with a different producer: read the table, emit inserts, then start the
stream at the watermark captured *before* the read.

**The authority holds a full replica of the synced subset.** For a server that is
fine — it is the archive (RFC-0015 §5). It is worth saying out loud because it is
the thing that makes a phone's partition-scoped replica affordable.

## Current state → work

| Piece | State |
|---|---|
| `ChangeSource` / `ChangeStream` port | **proposed** — this document |
| `postgresChangeSource` (logical replication) | proposed |
| `sqliteChangeSource` (triggers + outbox) | proposed |
| `manualChangeSource` (app calls us) | proposed — smallest useful first step |
| transaction → one signed event per partition | proposed; the fold already exists |
| durable watermark in `_cdc` | proposed |
| backfill via table read | proposed; reuses RFC-0019 |
| schema-change alarm | proposed |

**Tests to pin:** a transaction spanning three rows becomes exactly one event per
partition; a crash between event-commit and ack replays without divergence; a
device write to a CDC-backed table is denied locally and quarantines remotely; a
watermark surviving restart neither skips nor duplicates; `truncate` over the cap
refuses rather than emitting a million tombstones.

## Open questions

- Does `partition(row)` belong in config, or as a generated column the DB owns?
  Config is simpler; a column is auditable and survives a config typo.
- Row deletes give us a key but no row. Policy predicates that read row fields
  (`rowIs`) cannot be evaluated on a delete — do we require `REPLICA IDENTITY
  FULL`, or accept that delete policy is key-only?
- One authority per database, or many? Two authorities on one replication slot
  double-sign every change. A slot is single-consumer, so this is a deployment
  constraint we must state rather than a thing we can prevent.
- Does a CDC-backed collection need a marker in `defineSync` so the policy
  compiler can *enforce* read-only, instead of trusting the author to write
  `$default: deny`?

---
rfc: 0021
title: Change Data Capture — syncing an existing database
package: "@syncmesh/cdc (port, bridge) · @syncmesh/postgres (postgresChangeSource)"
layer: 3
status: implemented
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

As shipped in `packages/cdc/src/source.ts`:

```ts
export type Watermark = Brand<string, "Watermark">;   // opaque, non-empty, lexicographically ordered

export interface ChangeSource {
  readonly name: string;   // the `_cdc` row the watermark is filed under
  /** Resume after this watermark, or from the source's own beginning when null. */
  readonly start: (options: { readonly after: Watermark | null }) => Promise<ChangeStream>;
}

export interface ChangeStream {
  readonly changes: AsyncIterable<ChangeMessage>;
  /** Called only once the derived events are DURABLE. See "Acks", below. */
  readonly ack: (watermark: Watermark) => void;
  readonly stop: () => void;
}

export type ChangeMessage =
  | { t: "begin" }                                   // discards anything since the last commit
  | { t: "insert";   table: string; row: SourceRow }
  | { t: "update";   table: string; key: string; after: SourceRow }
  | { t: "delete";   table: string; key: string }
  | { t: "truncate"; table: string }
  | { t: "schema";   table: string; detail: string } // an alarm, never an instruction
  | { t: "commit";   watermark: Watermark };

export interface TableRead {                         // the backfill reader
  readonly watermark: () => Promise<Watermark>;      // read BEFORE the first row
  readonly rows: (table: string) => AsyncIterable<SourceRow>;
}
```

Same two-type seam, same reason: a source stays short. A Postgres source is
logical replication. A SQLite source is triggers writing an outbox table. A
"manual" source is a function your app calls when it writes — the escape hatch
for anyone whose database cannot stream.

A `begin` discards whatever arrived since the last `commit`. That one rule is what
lets a source that lost its connection mid-transaction resend it from the start
rather than splice two halves together.

## The bridge

```ts
import { startCapture } from "@syncmesh/cdc"
import { postgresChangeSource } from "@syncmesh/postgres"

const source = postgresChangeSource({
  sql,                                   // an ordinary postgres.js client
  connect: () => postgres(url, { max: 1, fetch_types: false, max_lifetime: null,
                                 connection: { replication: "database" } }),
  slot: "syncmesh",
  publication: "syncmesh",
})
;(await source.publish(["tasks", "sites"])).unwrap()

const running = (await startCapture({
  engine,                                // the authority's
  source,
  backfill: source.read,
  // which DB table feeds which collection, and how a row finds its partition
  mappings: {
    tasks: { collection: schema.tables.tasks, partition: (row) => `org:${row.org_id}` },
    sites: { collection: schema.tables.sites, partition: (row) => `org:${row.org_id}` },
  },
})).unwrap()
```

Between `begin` and `commit`, changes accumulate. On `commit`, the authority
folds them into **one signed event per partition touched** (one event is one
partition, M6), commits them, writes the watermark, and only then acks it.

`partition(row)` places a row the engine does not hold yet. An update to a row
it holds goes to the instance the engine holds it in, which is where the kernel
keeps a row whatever a later event names (`cdc/src/plan.ts`). The mapping is
still asked:

- When it cannot place the update (it returns `undefined`, or a name that is not
  `kind:id`), the update goes where the row lives. An update may carry only the
  columns it changed (TOAST, a staged sweep, RFC-0025).
- When it names the held instance, nothing is in question.
- When it names a different instance, capture stops with `RowMoved` (`held`,
  `named`). The database changed the column the mapping reads, so the row
  moved. Following it would send the update to peers that never held the row.
  Filing it where the row lives would keep sending a row the database says is
  another tenant's to the old tenant's peers. Moving a row between instances is
  not something CDC does, so the stop is loud and the watermark stays put.

Added 2026-11-08 (Jace delegated the call) with RFC-0025. In the first version,
a moved row's updates were filed in the old instance without a word; a review
caught that this leaks across tenants, and the stop replaced it.

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
offline-writable stay mesh-native, where the local commit is the truth. A
mesh-native table that another service also writes is RFC-0025's class c: the
outside write is staged by a trigger and swept into an event, not replicated from
the WAL — logical decoding cannot tell the projection's own writes from the outside
writer's, so a table the authority projects into the same database would echo.

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
keyed by source name, on its own unpinned event written **after** the events it
covers (E20 records why not the same commit: a reserved row riding whichever
partition went last gets a partition that depends on fold order). Anything else
can skip or replay across a restart.

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

## The Postgres source, as built

`postgresChangeSource` (`adapters/postgres/src/`) is the port over a logical
replication slot, with nothing above the port changed.

- **Slot and publication.** The slot (`pgoutput`) is created by a `start` from
  `null`, or by `read.watermark()` when a backfill goes first, and resumed after that.
  A slot for another plugin or database is `SlotMismatch`. One whose WAL the server
  dropped (`wal_status = lost`) is `SlotLost`, and so is a `start` from a stored
  watermark that finds no slot (dropped, or lost to a restore or failover): a fresh
  slot begins at the current WAL position, so resuming on one would skip every change
  in between without a word. Recovery is to forget the stored position and backfill. One read by another connection is `SlotBusy`:
  a slot has one reader, and that is how "one authority per slot" is enforced.
  `publish(tables)` creates or sets the publication. `drop()` waits for this source's
  own streams to close, then drops the slot.
- **Decoder.** `pgoutput` protocol version 1: Begin, Relation, Insert, Update,
  Delete, Truncate and Commit, with Origin, Type and Message read past. Every frame
  is parsed into a value, and a short or unknown frame is `MalformedMessage`, never
  a throw. Values come through their text form and the relation's type OIDs: ints,
  floats and bools become numbers and booleans, `timestamp[tz]` becomes epoch ms,
  `bytea` becomes bytes, `json[b]` is parsed, and the rest stays text. So does any
  value that would lose something (an `int8` past 2⁵³, `NaN`, `infinity`), so the
  collection's column check refuses it rather than storing a rounded value. The
  backfill reads `::text` through the same conversion, so a row reads the same
  whichever path brought it.
- **Replica identity.** A row's key is its single identity column: the primary key
  under `DEFAULT`, the index under `USING INDEX`, and the primary key looked up from
  `pg_index` under `FULL`, because `FULL` flags every column. No identity, or a
  composite one, is `UnkeyedChange`. A changed key is a delete of the old row plus an
  insert of the new one. Under `DEFAULT`, an update that leaves a TOASTed column alone
  does not carry it, so `after` leaves that column out (an update is a patch, so the
  mesh keeps its value). `FULL` fills it from the old row. An insert cannot leave a
  column out, and under `DEFAULT` the old row carries only the key, so a key change
  that did not resend a TOASTed value ends the stream with `PartialKeyChange` rather
  than inserting the row without it. A table whose key can change and that holds
  out-of-line values needs `FULL`; one already in that state needs `FULL`, a dropped
  slot and a backfill.
- **Watermark.** The commit's end LSN as sixteen upper-case hex digits.
  Lexicographic order is LSN order; Postgres's own `X/Y` text does not have that
  property (`9/0` sorts after `10/0`). A restart passes it as the
  `START_REPLICATION` point, and the source also skips any transaction whose commit
  record precedes it, rather than relying on the server alone.
- **Acks.** The slot's `confirmed_flush_lsn` moves only through a standby status
  update, and the update carries the newest position that is either (a) the end of a
  transaction delivered whole and acked by the bridge, or (b) a keepalive position
  received while no transaction was open and nothing delivered was unacked. A
  keepalive behind an unacked transaction waits for that ack. An ack past what was
  decoded releases only what was decoded. Status goes out on every ack that moves
  the position, on a keepalive that asks for a reply, and every `status` interval
  (default 10 s), so `wal_sender_timeout` never fires.
- **Reconnect.** A dropped connection is reopened (default 5 attempts, 1 s apart)
  from the end of the last transaction delivered. After a network partition, as
  opposed to a server-side termination, the old walsender holds the slot until
  `wal_sender_timeout` (60 s by default) and every attempt until then is `SlotBusy`,
  so the default policy gives up first; `reconnect` must span that timeout to ride
  one out. Frames not yet decoded are
  discarded, because the server sends them again, and a transaction cut off half-way
  is resent from its `begin`. A slow bridge pauses the socket instead of buffering
  without bound.
- **Schema alarm.** A Relation message for a known relation with different columns
  becomes a `schema` message, and the bridge stops on it without acking. Caveat: the
  comparison is per session. A column added while no stream was open is first seen
  by the next session and raises nothing; `meshCells` drops the extra column, and the
  collection's check refuses a row that lacks a required one.
- **Lag alarm.** With `lag: { bytes, every, alarm }`, the slot is read while a stream
  is open, and the alarm fires when unacked WAL passes `bytes` or `wal_status` is
  `unreserved`.
- **Backfill.** `read.watermark()` returns the slot's position (making the slot if
  needed), and `read.rows(table)` pages the table in key order (the replica identity
  index, else the primary key). An update keeps a row's key wherever on disk it puts
  the row, and a key change is a delete and a whole-row insert in the stream (or the
  stream's `PartialKeyChange` failure when the row cannot be sent whole), so paging
  outside one snapshot loses nothing silently. Paging by `ctid` would not: an update that moves a row to
  a page the read has passed hides it from the read, and the stream's update for it
  leaves out any unchanged TOAST value. The stream replays the overlap, which
  converges.

Tested against a real Postgres 17 (PGlite has no logical replication). CI runs a
`postgres:17` service with `wal_level = logical`; locally, `vp run pg:up` in
`adapters/postgres` starts one. The suite covers transaction framing; nothing acked
before the bridge acks; a consumer dying mid-transaction; a connection cut
mid-transaction and resent from its `begin`; restart from a checkpoint with no skip
and no repeat; `FULL` identity, TOAST and key changes; a `DEFAULT`-identity key
change that could not resend a TOAST value; the schema alarm; type
parity between stream and backfill; a backfill that misses no row an update moves
behind the read; slot create, resume, busy and drop; a resume whose slot is gone; a missing
publication; the lag alarm; and backfill → stream → stop → writes while stopped →
restart through `startCapture`, ending with the mesh equal to the table.

## Current state → work

| Piece | State |
|---|---|
| `ChangeSource` / `ChangeStream` port | **implemented** — `packages/cdc/src/source.ts` |
| `postgresChangeSource` (logical replication) | **implemented** — `adapters/postgres/src/replication.ts` |
| triggers + outbox, SQLite and Postgres | **implemented** — `stagedChangeSource` in `@syncmesh/storage` (RFC-0025): the strict guard's `stage` mode files an outside write, a sweep is one transaction |
| `manualChangeSource` (app calls us) | **implemented** — `packages/cdc/src/manual.ts` |
| transaction → one signed event per partition | **implemented** — `plan.ts`, `apply.ts` |
| durable watermark in `_cdc` | **implemented** — its own unpinned event, last |
| backfill via table read | **implemented** — `backfill.ts`; Postgres reader pages by key |
| schema-change alarm | **implemented** — per session (see caveat above) |
| slot lag alarm | **implemented** — `lag` option |

**Tests to pin:** a transaction spanning three rows becomes exactly one event per
partition; a crash between event-commit and ack replays without divergence; a
device write to a CDC-backed table is denied locally and quarantines remotely; a
watermark surviving restart neither skips nor duplicates; `truncate` over the cap
refuses rather than emitting a million tombstones; nothing is acked to Postgres
before the bridge has applied it.

## Open questions

- Does `partition(row)` belong in config, or as a generated column the DB owns?
  Config is simpler; a column is auditable and survives a config typo.
- Row deletes give us a key but no row. Policy predicates that read row fields
  (`rowIs`) cannot be evaluated on a delete — do we require `REPLICA IDENTITY
  FULL`, or accept that delete policy is key-only? *(As built: the Postgres source
  reads either identity, but the port's `delete` carries only the key, so delete
  policy is key-only today whichever one a table uses.)*
- One authority per database, or many? Two authorities on one replication slot
  double-sign every change. A slot is single-consumer, so this is a deployment
  constraint we must state rather than a thing we can prevent.
- Does a CDC-backed collection need a marker in `defineSync` so the policy
  compiler can *enforce* read-only, instead of trusting the author to write
  `$default: deny`?

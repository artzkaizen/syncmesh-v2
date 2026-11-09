---
rfc: 0025
title: External writers — table classes and the staged-changes sweeper
package: "@syncmesh/storage (strict: { stage }, stagedChangeSource) · @syncmesh/cdc (the bridge) · @syncmesh/postgres (logical replication)"
layer: 3
status: implemented
standalone: false
deps: ["0004", "0013", "0021", "0022"]
---

# RFC-0025 — External writers

> **Decided 2026-11-08 (Jace delegated the call).** Closes gap-audit №31 and `plan/gaps.md` O3.
> Built in #41: the `stage` guard mode and `stagedChangeSource`. What is not built is
> listed under "Left", one line each.

## Purpose

Something other than syncmesh writes the authority's database: another service's `UPDATE`, a
cron job, a migration's backfill, an operator in `psql`. Before this RFC the answer was two
fragments. RFC-0021 covers a table the database owns outright (CDC, read-only on devices). The
strict guard (gaps U5, D49) refuses every other write made outside a captured transaction. What
neither covers is the table both sides write: a mesh-native table, offline-writable on devices,
that a back-office service also updates. The guard refuses that service; turning the guard off
(`strict: false`, `except`) lets its writes change the row with no event, so the authority's
table and every device disagree from then on and nothing says so.

This RFC names the three classes a synced table can be in, says how an outside write reaches
the mesh in each, and adds the missing mechanism for the third: a staged-changes queue the guard
writes to, swept into events by a change source behind the existing CDC bridge.

## The three classes

Every synced table on the authority's database is in exactly one class. The class is chosen
where the stores are opened, by the `strict` option (`StrictCapture`, `storage/src/guard.ts`).

| Class | Who writes it | How an outside write reaches the mesh | `strict` | Device rule |
|---|---|---|---|---|
| **a · mesh-owned** (default) | the mesh: devices, the authority's procedures, the fold | it does not: the guard refuses it. An outside service calls a procedure | `true` | the app's |
| **b · database-owned** | the database: any service, any SQL | CDC (RFC-0021): logical replication, or a manual source | the table is not in `tables` on that database, or is `except`ed | `cdcAllow` (read-only) |
| **c · shared** | both: devices offline, and outside services on the authority's database | the guard files it in the staged-changes queue; `stagedChangeSource` sweeps it | `{ stage: [table] }` | the app's, and the authority's role may write |

**Class a** is D20's rule as the book states it (ch. 19): an uncaptured SQL write is not a
syncmesh write. The guard makes that a refusal rather than a silent divergence (U5). A service
that must change such a table goes through a procedure, which captures and signs like any other.

**Class b** is RFC-0021 unchanged. The database is the truth, devices hold a signed read-only
projection, and writes from devices travel the other way as procedures.

**Class c** is new. A row has two kinds of writer, and both become events: a device's capture
signs its own write, and the authority signs the outside write once the sweeper hands it over.
The two merge per field like any two writers (D04), so an outside `UPDATE` of `status` does not
overwrite a device's concurrent edit of `title`.

A table the authority projects into the same database it captures with logical replication is
the case that must be class c, not class b. The projection's fold writes the table, the WAL
carries that write like any other, and the replication source publishes it back as a new event:
an echo, one event per fold, for ever. Logical decoding is after commit and outside the
transaction (D20 point 3), so it cannot see the guard setting that marks the fold's writes. The
staging trigger runs inside the transaction and can. So logical replication is for a database
the authority does not project into (or a table it keeps out of `tables`), and staging is for
one it does.

## How an outside write enters the mesh

All three sources meet the same bridge, `startCapture` (`packages/cdc/src/capture.ts`). A source
is the RFC-0021 port: a resumable stream of `begin` … `commit(watermark)` transactions and an ack.
The bridge buffers one transaction, plans it (`plan.ts`: each row's net effect, at most one
change per row, grouped into one event per partition), writes each event through
`engine.mutate` so the authority signs it, writes the watermark into the `_cdc` row as a last
event of its own (`apply.ts`), and only then acks.

| Source | Where | Transaction | Watermark | For |
|---|---|---|---|---|
| `postgresChangeSource` | `@syncmesh/postgres` | a Postgres transaction | its commit LSN | class b, a database the authority does not project into |
| `manualChangeSource` | `@syncmesh/cdc` | what the app hands `commit` | a counter | class b, a database that cannot stream |
| `stagedChangeSource` | `@syncmesh/storage` | one sweep of the queue | the sweep's number | class c |

## The staged-changes sweeper

### The guard files instead of refusing

`strict: { stage: ["tasks"] }` installs, for `tasks`, an `AFTER INSERT OR UPDATE OR DELETE` row
trigger in place of the refusing one (`storage/src/dialect-guard.ts`). It fires only with capture
at rest, the state the refusing trigger raises in: `syncmesh.armed = '0'` on Postgres, the
`syncmesh_capture` row's `0` on SQLite. A captured write (`1`) is logged by the capture triggers
as before; the fold's own write (`2`) is neither logged nor filed, which is what keeps the sweep
from echoing. On Postgres the triggers are `ENABLE ALWAYS`, like the guard's, so
`session_replication_role = replica` does not skip them, and a `TRUNCATE` of a staged table is
still refused: no row trigger sees one.

Each filed row holds the table, the operation, the key, the row's `_partition`, and its before
and after images in the capture log's encoding (bytes as hex, timestamps as epoch milliseconds,
JSON as text). The queue is `syncmesh.staged` on Postgres, beside the log in the `syncmesh`
schema, and `syncmesh_staged` in `main` on SQLite, where the table is, because a trigger cannot
write an attached file.

An outside update that changes the row's key is filed as two rows: a delete of the old key and an
insert of the new one, with the whole new row. Filed as an update keyed by the new key, it would
leave the old row in the mesh for good and file a row under the new key holding only the changed
key column.

On Postgres the filing function is `syncmesh."stage_<table>"`. It is `SECURITY DEFINER` with
`search_path = pg_catalog, pg_temp`, owned by the role that opened the stores, and `EXECUTE` on it
is revoked from `PUBLIC`: a trigger fires it whatever the writer may run, so a service whose role
may write only the table files its writes with no grant on the `syncmesh` schema, the queue or its
sequence, and still cannot call the function or read the queue itself. The namespace's `PUBLIC`
grants (RFC-0022) would let such a role in today, but a database that revokes them, as a
hardened deployment should, would otherwise refuse every outside write with a permission error. A table name runs to 64
characters and Postgres cuts an identifier at 63 bytes, so for a name too long to fit the
function is named by a prefix of it and sixteen hex digits of its SHA-256: two long names that
share a prefix keep a function each.

Switching a table between `refuse`, `stage` and `off` replaces its triggers at the next open; the
guard has its own row in `meta`, so the switch is not a change of the tables' shape (U5). The
refusing guard's text now also drops any staging trigger and function, so every existing
install reinstalls its guard once at its next open; on Postgres that reinstall prints a
`NOTICE` per refused table for the `DROP ... IF EXISTS` of a staging trigger that was never
there. The notices are left as they are.

### A sweep

`stagedChangeSource({ name, driver, tables, every })` reads the queue in turns, each in one
transaction on the driver's own turn (`inTransaction`), so it never lands inside another
transaction on the same connection:

1. delete every row of a sweep at or below the last acked one;
2. mark every row no sweep has taken with the next sweep number, one above both the highest in
   the queue and the highest already sent;
3. read every taken row above the last one sent, by sweep then arrival.

Each sweep becomes one transaction on the stream, and its number, zero-padded to twenty digits,
is the watermark. A sweep's rows are netted per row (`netOfWrites` in
`storage/src/sweep-net.ts`, then `netChange`): an insert carries the row, a delete the key, an update the columns that
one of the sweep's filed writes changed, each at its value in the last after-image, and a counter
column the sum of those writes' increments. A capture can net a transaction by its first
before-image and its last after-image because nothing else writes the row in between; a sweep
cannot, since a fold or a captured write may land between two filed writes. Netted that way, the
mesh's own write would ride the sweep under the authority's newer stamp and beat a later device
edit to a column no outside writer touched, and a fold's counter increment would be counted twice.

The row's `_partition` rides along under that name, as the guard saw it when the write was filed: the row's own once the mesh placed it, `null` for a row the
outside writer inserted. It is `null` too for an update that committed after a sweep took the
row's insert and before the fold of that sweep placed it, and that update carries only the
columns it changed, so the mapping cannot be what places it. The bridge does (`cdc/src/plan.ts`,
RFC-0021): an update to a row the engine holds, which the mapping cannot place, is filed in the
instance the engine holds it in, which is where the kernel keeps a row whatever later events say.
One the mapping places in a different instance stops capture with `RowMoved`, since filing it
in either instance would be wrong. With the documented mapping that happens only if an outside
writer sets `_partition` itself. So an outside `UPDATE tasks SET "orgId" = 'globex'` on a row the
mesh placed in `org:acme` does not stop capture and does not move the row: the guard files it with
`_partition = 'org:acme'`, the mapping reads `_partition` first, and the update reaches acme's
peers with the new `orgId`. A staged table's tenant is its `_partition`, not the column the
mapping would read for a new row; moving a row between tenants is a delete and an insert. A
mapping that must refuse such a write compares the tenant column with `_partition` and returns
the column's instance, which stops capture with `RowMoved`. The way out of that stop, or of
`RowUnplaceable`, is RFC-0021's: restart with a mapping that places the row. Given an update to a row the mesh never held, which has neither a `_partition`
nor the columns that would place it, the mapping returns `undefined` and capture stops with
`RowUnplaceable`; a guess such as `` `org:${String(row.orgId)}` `` would read `org:undefined` and
sign the row into an instance no device syncs. Such a row exists only if the table was written
with no guard before it was staged; the backfill under "Left" is what places it.
With nothing new the stream waits `every` (default one second), or until `sweep()` is called.

```ts
const stores = (await openStores(driver, { tables, strict: { stage: ["tasks"] } })).unwrap()
const source = stagedChangeSource({ name: "staged", driver: stores.driver, tables })
const running = (await startCapture({
  engine,
  source,
  mappings: {
    tasks: {
      collection: schema.tables.tasks,
      partition: (row) => {
        const org = scalarText(row.orgId)
        return scalarText(row._partition) ?? (org === undefined ? undefined : `org:${org}`)
      },
    },
  },
})).unwrap()
```

### Why the numbers are safe

**Commit order.** A sweep marks only rows it can see, which are committed rows, so a transaction
still open when a sweep runs is taken by a later sweep with a higher number. Within a sweep rows
go in arrival order. Two transactions that write the same row cannot both be open: the second
waits on the first's row lock and files its image after the first committed. So for any one row
the stream's order is commit order. The queue's own sequence alone would not be: a row filed
early by a transaction that commits late would be skipped by a reader that had moved past it.

**Exactly the replay CDC has.** The bridge stores the watermark after a sweep's events, and the
sweeper deletes a sweep's rows only after the ack that follows. A crash before the watermark is
stored replays that sweep: the same values under later stamps, which field-level LWW joins to the
same rows (RFC-0021, "Replay is safe but not free"). A crash after it and before the delete
replays nothing: the next start deletes every sweep at or below the stored watermark and numbers
new ones above it. A sweep taken but never acked is sent again by the next stream.

**One reader.** The queue has one sweeper per database, as a replication slot has one reader. Two
would number sweeps independently and sign each write twice. This is a deployment rule, stated
rather than enforced.

### What an outside write is, once swept

- **The authority's.** The event is signed by the authority's device key, as every CDC event is.
  `owner()` reads the author, so on a staged table a rule that must admit outside writes names
  the authority's role beside the owner: `update: any(owner("createdBy"), role("system"))`.
- **Judged after it landed.** The database committed the write before anything saw it. The
  authority's event of it goes through `engine.mutate` and its validator; a refusal stops the
  bridge with `EventRefused`, unacked, and the row in the table disagrees with the mesh until
  an operator decides. The same as CDC.
- **Merged per field.** Only the columns the outside writer changed are in the update; a mesh
  write folded between two outside writes keeps its own stamp. The update's stamp is the
  authority's clock at the sweep, so on a column the outside writer changed it wins over any
  earlier-stamped write to that field, including a device's edit that was folded into the table
  between the outside write and the sweep. That inverts real-time order on the one field, and
  every peer converges on the outside value; the storage README says so too. When a later outside
  write to the same row follows that fold in the same sweep, the column carries the folded value
  instead, signed again under the authority's stamp: the device's value survives but loses its
  own stamp. A column a mesh write changed between two outside writes travels even when the last
  of them set it back to its value before the first, since the mesh may still hold the mesh
  write's value while the table holds the outside one (`sweep-net.ts`).
- **Not a document or derived value.** `meshCells` leaves document and derived columns out
  (RFC-0023 §16.4, U28), so an outside write to one is not carried, and the next fold of the row
  writes the mesh's value back.

## Bookkeeping

Gap-audit №31 asked for a `syncmesh` Postgres schema for the mesh's own tables. It exists:
`events`, `state_rows`, `cursors`, `changes`, `meta` and the rest live there (RFC-0022), and
`staged` joins them. The watermark is not a Postgres table: it is the `_cdc` mesh row (RFC-0021),
so it travels with the log, and a restore of the log restores the position with it.

## What this rules out

- **WAL capture for class c.** The audit's "WAL capture as last resort" for a shared table is the
  echo above. Logical replication stays the source for class b.
- **Two-way CDC.** A class b table stays read-only on devices; a table that must be written from
  both sides is class c, where both writers are events.
- **A silent `except`.** `except` stays, for class b tables the authority projects elsewhere and
  for a table under migration, and its documentation now says that its writes reach no peer.

## Left

Not built by this RFC's change, each a follow-on with no decision outstanding:

1. A wake from Postgres (`LISTEN`/`NOTIFY` on the queue) instead of polling every `every`: the
   `SqlDriver` port has no notification channel to carry it.
2. A refusal to start logical replication over a table the same engine projects into the same
   database, which would make the echo a startup error instead of a documented rule.
3. A backfill for a staged table: rows written outside before the stage triggers were installed
   are not in the queue. `runBackfill` takes any `TableRead`, but none is shipped over a staged
   table.
4. A cap on one sweep's size. A bulk outside write is one sweep and so one event per partition,
   the large-event case RFC-0021 caps for `truncate`.
5. Refusing an outside write to a document or derived column at the trigger, rather than
   leaving it out of the event. Until then such a write is dropped from the event without a
   word, and the table holds a value no peer has; a `RAISE WARNING` in the filing function was
   considered and not added, since the refusal is the fix and a warning nobody reads on a
   service's connection is no substitute.

## Tests

- `storage/src/driver-tests/staged.ts`, run by every driver (bun:sqlite, node:sqlite, sqlite-wasm,
  PGlite, a real Postgres under two client setups): an outside write is filed, not refused, and
  a captured, folded or unstaged-table write is not; a `TRUNCATE` is still refused on Postgres;
  switching a table between refused, staged and off replaces its triggers, and a table the
  schema drops loses them; a sweep is one transaction of net effects (only changed columns, an
  insert-then-update as one insert), an unacked sweep is sent again, an acked one never, and a
  resume sends only what came after.
- `storage/src/__tests__/staged.test.ts`, an authority engine over its own SQLite with a staged
  table: a captured write and two outside writes become one authority-signed event carrying only
  the changed column; the fold writes the outside row back with its partition and files nothing,
  so no further event follows; a restart sweeps only what was written while stopped; an outside
  update that commits after a sweep took the row's insert and before its fold placed the row is
  filed in the row's instance, not wherever its changed columns would place it.
- `adapters/postgres/src/__tests__/staged.test.ts`, a real Postgres with the outside writer on a
  connection of its own: twenty updates and a transaction held open across sweeps reach the mesh
  with the last committed value and every event in the row's instance; the same race as above,
  with the update committed from the other connection.
- `cdc/src/__tests__/plan.test.ts`: an update to a held row that the mapping cannot place is
  filed in the instance the engine holds it in; one the mapping places in another instance stops
  capture with `RowMoved`.
- `storage/src/__tests__/staged.test.ts` also: a captured mesh write between two outside writes
  to one row is not in the sweep's patch, and a counter moves by the outside writes' increments
  alone, not by a fold's between them; an outside write that sets a column back to its value
  before a mesh write still reaches the mesh, so the table and the mesh agree. The authority in
  that test opens its engine with the schema's merge spec, so a counter ends the same in the
  table and the mesh.
- `storage/src/driver-tests/staged.ts` also, on every driver: an outside update that changes a
  row's key is filed and swept as a delete of the old key and an insert of the new one.
- `adapters/postgres/src/__tests__/staged.test.ts` also: a service whose role may write only the
  table, on a database where `PUBLIC` has no grant on the `syncmesh` schema, has its writes
  staged, and cannot run the filing function itself.
- `storage/src/__tests__/strict.test.ts`: the Postgres filing function's name fits 63 bytes and
  differs for two long table names that share a prefix.

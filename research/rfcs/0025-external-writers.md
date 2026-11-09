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
> Built in the same change: the `stage` guard mode and `stagedChangeSource`. What is not built is
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

Switching a table between `refuse`, `stage` and `off` replaces its triggers at the next open; the
guard has its own row in `meta`, so the switch is not a change of the tables' shape (U5).

### A sweep

`stagedChangeSource({ name, driver, tables, every })` reads the queue in turns, each in one
transaction on the driver's own turn (`inTransaction`), so it never lands inside another
transaction on the same connection:

1. delete every row of a sweep at or below the last acked one;
2. mark every row no sweep has taken with the next sweep number, one above both the highest in
   the queue and the highest already sent;
3. read every taken row above the last one sent, by sweep then arrival.

Each sweep becomes one transaction on the stream, and its number, zero-padded to twenty digits,
is the watermark. A sweep's rows are netted per row exactly as a capture nets a transaction's log
(`netEffects`, `netChange` in `storage/src/capture.ts`): an insert carries the row, a delete the
key, an update only the columns whose value differs from the row's first before-image, and a
counter column its increment. The row's `_partition` rides along under that name: the row's own
once the mesh placed it, `null` for a row the outside writer inserted, which the mapping places.
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
      partition: (row) => scalarText(row._partition) ?? `org:${String(row.orgId)}`,
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
- **Merged per field.** Only the columns the outside writer changed are in the update. Its stamp
  is the authority's clock at the sweep, so it wins over any earlier-stamped write to the same
  field, including a device's edit that was folded into the table between the outside write and
  the sweep. Every peer converges on that.
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
   leaving it out of the event.

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
  so no further event follows; a restart sweeps only what was written while stopped.

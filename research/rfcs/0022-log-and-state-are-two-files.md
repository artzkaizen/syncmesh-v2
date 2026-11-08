---
rfc: 0022
title: The log and the state are two files
package: syncmesh (packages/storage, packages/engine) — design
layer: 2
status: proposed
standalone: true
deps: ["0013", "0014", "0015", "0019", "0021"]
---

# RFC-0022 — The log and the state are two files

## Purpose

One SQLite file holds seventeen engine tables, the app's own tables, and thirty
triggers. Some of that is the **truth** — the signed log, and the few claims a
peer gave us that nothing can recompute. The rest is **derived**: a pure
function of the log, thrown away and rebuilt by `openEngine` whenever it is
absent or corrupt.

Mixing the two in one file costs three things:

1. **You cannot throw the derived half away**, because the log is next to it. A
   schema change therefore has to be a migration — `ALTER`, in place, on every
   device — instead of a delete.
2. **Backup means "back up everything"**, when it only ever meant the log.
3. **The names are a mess**, because nothing separates ours from yours. SQLite
   has bare `events`, `state_rows`, `operations`, `receipts`, `compaction`;
   Postgres has `_syncmesh_*` for the same tables. An app with its own `events`
   table collides with the engine and finds out through a DDL error.

Splitting them fixes all three, and the namespace falls out for free.

## The line: what a discarded state file can be rebuilt from

The split rests on one claim — that the state half is a pure function of the durable half — and
the first draft of this section overstated it in three places. The corrected line:

| rebuilt by replay | from what |
|---|---|
| `state_rows` | the durable basis below |
| `state_cursors` | `note()` walks each author's chain during replay and reproduces them exactly |
| `row_sync` | a projection of the same folds |
| `changes` | drained and cleared inside every write; holds nothing between them |
| **the app's own tables** | D20's projection — the thing you query, written by the fold |

**And below a compaction floor it is not derived at all — it is the only copy.** This is the
correction that costs the RFC its best idea, so it is worth being exact about.

`compactLog` refuses outright without a state store — *"no state store: the log is the only copy
of state"* — and then clamps the floor to what has actually been persisted:

```ts
/** Never above what is persisted: a device cannot refold what it deleted. */
export const clampToPersisted = (floor: Cursors, persisted: Cursors): Cursors => …
```

So compaction deletes events **because** the rows that stood for them are on disk. Below the
floor, the folded state is the durable half. Snapshot installation (RFC-0019) does the same thing
from the other direction: it imports rows with no event history behind them.

`refoldable(store)` is that question, named and exported, because it is the one a caller has to
ask **before** discarding anything:

```ts
export const refoldable = (store: EventStore): Promise<Result<boolean, StoreFailure>> =>
  Result.gen(async function* () {
    const floor = yield* Result.await(store.compactedBelow());
    return Result.ok(floor.synced.size === 0 && floor.local.size === 0);
  });
```

A device that has never compacted can rebuild everything, which is most devices for most of their
lives. One that has cannot, and its remedy is a peer rather than its own disk.

**`acked` is not derived either, and losing it is now a decision rather than a surprise.** It
moves when a *peer acknowledges*, which touches no row and leaves no event; the map it comes from,
`engine.acks()`, is in memory and does not survive a restart either.

It is discarded with the rest, because the loss only runs one way. `syncOf` reads `delivered` from
a watermark existing above the row's stamp, so with none the `EXISTS` is false and every row reads
`local` — a confirmed write reporting as unconfirmed, never the reverse, and never a claim that an
undelivered write arrived.

It returns on the next **acknowledged write**, not on the next cursor exchange: the ledger prunes a
write once it has been acknowledged, so nothing is left to re-derive from, and what restores the
mark is a later stamp covering every earlier row behind it. A device that is writing pays seconds;
one that only reads carries `local` on its own old writes until it writes again.

That asymmetry was a guess in the first draft — "it heals on the next exchange" — and the test
written to pin it disproved it. It is pinned to what actually happens now.

And what was never derived:

| durable | why replay cannot recover it |
|---|---|
| `events` | the log itself |
| `compaction` | the floor per author |
| `scope` | a claim a peer gave during a filtered catch-up; your own log does not contain it |
| `operations` | the write ledger; its `id` is minted *before* the commit |
| `receipts` | a fact about other devices |
| `grants`, `blobs` | signed bytes, and content-addressed bytes |

### The boot gap this found, which is a live bug

`load()` in `engine/src/boot.ts` asked about the compaction floors on the **corrupt** path and
not on the **empty** one:

```ts
if (yield* Result.await(stateStore.isEmpty())) return Result.ok(undefined);   // ← straight to a full replay
```

For most of this system's life those were the same case — no folded state meant a database nobody
had written, and a fresh log has no floor. They stop being the same case the moment a state file
is discarded on purpose, which is exactly what this RFC proposes, and the difference is a device
that rebuilds whatever sits above the floor, drops the rest, and reports itself healthy.

**Fixed, with a test that fails without the fix.** Both paths now refuse with `StateCorrupt` and
`rejoin from a peer`. It is a bug in today's single-file build too, reachable by anyone who clears
the cache by hand.

## A torn commit is survivable, under a protocol built since (U29)

**The first draft of this section was wrong and the error is worth keeping**, because it is the
one somebody else would make next.

It argued that the engine already writes in a safe order:

```ts
atomically(async (scoped) => {
  await scoped.events.append({ event });   // ① the log
  const folded = fold([{ event }], "local");
  await persist(folded, scoped.state);     // ② the derived state
});
```

— append first, persist second, so a tear can only ever leave *event present, state stale*, which
boot repairs.

**Statement order inside one transaction is not a durability order.** Those two writes are in the
*same* transaction; what SQLite does not guarantee is that the transaction commits atomically
across two attached databases in WAL mode. When it tears, either side may be the one that landed.
The claim that "state ahead of the log is unreachable" does not follow from the code above and is
not true.

What the split actually needs is an explicit protocol, and it is implementation rather than a
comment:

1. Commit the event **and** its operation record in the durable store. That transaction alone.
2. Apply the projection and its applied-cursor in the state store. A second transaction.
3. On boot, replay the committed log above the applied cursor to finish an interrupted step 2.

That changes what `AtomicStores` means — today it hands both stores to one transaction, and the
protocol wants two — so `writes.ts` and every caller of `atomically` move with it. Durability
policy has to be stated too: the Node and Expo adapters run `synchronous = NORMAL`, which is a
deliberate trade and a different one from what a two-phase protocol assumes.

Measured, for scale: killing a writer mid-transaction fifteen times per configuration.

| main | attached | torn |
|---|---|---|
| WAL | delete | **8 / 15** |
| WAL | WAL | **3 / 15** |
| delete | delete | 0 / 15 |

Cross-database commits are atomic only in rollback-journal mode, where SQLite writes a master
journal. Every device here runs WAL, so tearing is the normal case rather than a rare one to
design around.

> Found while writing it, and fixed since (U29, 2026-11-08): `writer.ts` committed the app-table
> write in `captureChanges`' own transaction and the event in a second one. A crash between them
> left a row written, the change log cleared, and no event — a write that is local forever and
> that `strandedWrites` cannot see, because it scans the event store and there is no event. The
> writer now runs the capture inside the engine's own write transaction
> (`Engine.mutateCaptured`), so the app's statements, the event, its ledger row and the state
> commit are one transaction.

### What was built (U29, decided 2026-11-08: Jace delegated the call)

The three steps above are not what shipped, because they cannot hold for the one write that
matters most: a captured write's rows are in `main` and exist *before* its event does, so they
cannot commit second. What shipped keeps one transaction and makes its split recoverable:

1. **Row and event in one transaction, everywhere.** `createWriter` hands `captureWithin` to
   `Engine.mutateCaptured`, which runs it first inside `atomic`, then numbers, appends, records
   and persists. A refusal from the capture or the ladder rolls the app's statements back with
   the rest; statements that changed no synced row still commit, as no event. An engine built
   without `atomic` (a memory log, or stores opened by hand and not joined) has no transaction to
   run the capture in: there the statements still commit first, in the `around` transaction the
   caller hands over, and the event second, as before, so durable stores should always pass
   `atomic` — `createMesh` does. With neither `atomic` nor `around`, nothing could roll a refused
   capture back, and `mutateCaptured` panics rather than commit it. On Postgres, PGlite
   and an inline (Durable Object, Rivet) log that one transaction is the whole answer: one
   database, one commit.
2. **The split inside `COMMIT`, journaled.** On a device's SQLite (`bun:sqlite`, `node:sqlite`,
   `expo-sqlite`, sqlite-wasm on OPFS) `openStores` hands back a driver that journals every
   transaction writing both files: its log statements, copied into `main`'s `syncmesh_journal`
   in the same transaction, under a number the log's `meta` also records. SQLite commits `main`
   first, so the only reachable tear is `main` committed and the log not; `openStores` replays a
   journal entry the log has not reached into the log, before anything reads either file. The
   other direction (log committed, `main` not) is the log ahead of the cursor, which boot already
   replays. A transaction that writes one file is not journaled.
3. **What it does not cover.** A log write made on the bare driver you passed to `openStores`
   rather than `Stores.driver` is not journaled. The app's own statements write `main` and are
   safe on either; what is not is an `OperationStore` built on the bare driver, whose ledger rows
   are the log's — `createMesh` builds it on the stores' driver, and `meshDrizzle`'s `operations`
   says to. A state file swapped for another schema's and swapped back after a crash compares its
   journal number with a log that has moved on, and does not replay. Nor does a tear followed by
   an app update that changes the schema: the state file is per schema (`statePath(log,
   schemaName(tables))`), so the next open refolds into a new file, and the journal entry and the
   app's row stay in the old one; the write is lost, as it was before U29. A replay that fails
   (a statement the upgraded log no longer accepts, below) refuses the open with a `StoreFailure`,
   and every later open the same way; the store opens again only once that state file is deleted
   and refolded, which loses the torn write. Statements are journaled by
   their target (`syncmesh.<table>`), which holds for every statement this repo writes and is
   pinned by `journal.test.ts`. A journal entry is replayed after both ladders climb, so a tear
   whose next open is also an upgrade that moves the log ladder replays statements written for
   the log as it was before the upgrade; a log rung must therefore keep the columns an older
   write names, or say why it may not.
4. **A commit that fails without a crash.** A full disk or an I/O error on the log file can fail
   the `COMMIT` after `main` landed, and the process lives on. The journaling driver then holds
   every later transaction on that connection, refused as a `StoreFailure`, while the journal is
   ahead of the log, so the entry is not overwritten before an open replays it. Every wrapper over
   one connection counts from one number, so two `openStores` on one driver cannot journal under
   the same number and skip a replay; they share the transaction in flight too, so a log
   statement through one inside the other's transaction is journaled with it; and the replay
   runs in the connection's turn, so a second `openStores` never begins it inside another
   store's open transaction.
5. **What it costs.** Every transaction that writes both files writes its log statements twice:
   once into the log and once, CBOR-encoded with their parameters (event bytes included), into
   the one journal row in `main`. A received batch is held twice in memory while it commits. Not
   measured yet on a device; a large catch-up page is where it shows, and splitting a page into
   several transactions bounds it if it matters.

Pinned three ways, each failing without its half of the fix: `client/src/__tests__/crash.test.ts`
kills a mesh write with SIGKILL before each of its statements (13 of 21 boundaries left a row
with no event before); `storage/src/__tests__/journal.test.ts` puts the log file back as it was
before a write — the state SQLite leaves when it dies between the two files' commits — for a
local write and a received batch; and the driver suite's `journal: a log half that never landed
is replayed into the log at the next open` case does the same on an adapter's own driver. That
case exercises the replay only where the log is an attached second file (`bun:sqlite`,
`node:sqlite`, sqlite-wasm over `memdb`, the expo driver over its test fake); on Postgres and
PGlite it returns early, because one database has nothing to journal.

Under load, `client/src/__tests__/crash.test.ts` passed 20 runs of 20 on 2026-11-08 (Apple
silicon, bun 1.4.4: four `bun test` processes at a time beside four busy-loop processes), where
"kill -9 mid-write" had failed about 1 run in 10 before U29.

## The shape

```
<name>.state@<hash>.db   opened as `main`. the derived half. disposable.
  the app's own tables, their capture triggers, and — in the same file,
  because a trigger cannot write across one — syncmesh_changes,
  syncmesh_capture, syncmesh_state_rows, syncmesh_cursors,
  syncmesh_row_sync, syncmesh_acked

<name>.log.db            ATTACHed as `syncmesh`. durable. back this up.
  syncmesh.events, syncmesh.compaction, syncmesh.scope,
  syncmesh.operations, syncmesh.receipts, syncmesh.grants, syncmesh.meta
```

**The derived file is `main`, and the namespace is therefore not uniform.** An earlier draft had
this backwards and could not have worked: attaching a file as `syncmesh` makes *every* table in it
`syncmesh.*`, including the app's own, and they cannot also be `main.*` on that connection. Since
app tables must stay unqualified — every Drizzle query in every procedure names them directly —
the file holding them is `main`, and the engine tables sharing that file take the `syncmesh_`
prefix. Only the log gets a real namespace.

So: `syncmesh.events` in the attached log, `syncmesh_state_rows` beside the app's tables. One word
everywhere, two separators, and the reason is the trigger restriction rather than taste.

**A schema change is a new file — but only on a device that has never compacted.** The idea was
LiveStore's `state${schema.hash}.db`: change a column, orphan the old file, open an empty one, let
the fold rebuild it. No `ALTER`, no migration ladder for anything derived.

It only holds while `refoldable(store)` is true. On a compacted device the old file is the only
copy of everything below the floor, so orphaning it is deleting data, and the honest options are
to migrate it in place or to rejoin from a peer — neither of which is "no migration ladder".

That is a real limit on the borrowed idea rather than a detail. A young replica gets the clean
version; an old one gets a migration or a rejoin, and has to be told which.

This is what makes the fingerprint added in `syncmesh_meta` this week
*mostly* redundant: it compares DDL text and then reinstalls in place, which
works for adding a table and not for anything needing data moved. The filename
sidesteps the question. The fingerprint stays only for the log file, whose
tables genuinely do need migrating when they change.

## Postgres is not symmetric, and should not pretend to be

On Postgres there is one database and one `CREATE SCHEMA syncmesh`, so both
halves live in the same schema and a transaction spanning them is ordinarily
atomic. Nothing above about tearing applies. What carries over is only the
naming, and the fact that the derived tables are still derived — a Postgres
node can `TRUNCATE` them and refold.

The `state@<hash>` trick does not carry over either: a schema is not a file.
There, a changed manifest stays a migration. That asymmetry is honest and worth
writing down rather than papering over with a lowest-common-denominator design.

## Durable Objects have neither of the two mechanisms this rests on

A Durable Object's SQLite is reached through `ctx.storage.sql.exec`, and
Cloudflare permits a restricted statement surface over it. Two of the things
this design is built out of are outside it:

- **`ATTACH` is not allowed.** There is one database per object and no
  filesystem to put a second one on, so the log cannot be a separate file.
- **`PRAGMA` is not allowed either**, which takes the migration ladder with it:
  `PRAGMA <schema>.user_version` is how a device remembers how far it has
  migrated, and an object has no way to answer it.

**Resolved: a third spelling of the same namespace**, chosen by the driver
rather than by the dialect, because a Durable Object is SQLite in every other
respect. `SqlDriver.log` is `"attached"` or `"inline"`; the latter puts both
halves in one database and spells the log `syncmesh_events`, beside
`syncmesh_state_rows`. The ladder's position moves from a pragma to a row in
`syncmesh_meta` — which is how Postgres already does it, for the same reason in
a different form: a schema has no `user_version` either.

So there are three, and one rule underneath them:

| runtime | namespace by | log | ladder position |
|---|---|---|---|
| Postgres | `CREATE SCHEMA` | `syncmesh.events` | a row in `meta` |
| device | `ATTACH` | `syncmesh.events` | `PRAGMA syncmesh.user_version` |
| Durable Object | prefix | `syncmesh_events` | a row in `meta` |

Two dialect instances from one factory, not two files of near-identical SQL: the
difference is one separator plus the two `CREATE INDEX` statements, which differ
in shape rather than in name — an index must live in its table's database, which
SQLite spells by qualifying the *index* and leaving the table bare.

**The test fake is `bun:sqlite` and would take a statement a real object
rejects**, so passing tests could never have been the evidence here. What stands
in for it is an assertion over the statements the inline dialect actually emits:
no `ATTACH`, no `PRAGMA`, no qualified name, and both halves still created.
Restoring the pragma makes it fail, which was checked.

The line itself is unaffected, and that is the point of having written it down
as data. `LOG_TABLES` and `STATE_TABLES` say which tables a backup must include
and which may be discarded and refolded; neither of those was ever a question
about files.

What a relay does *not* get is the rest of the RFC's prize. It holds no folded
state to throw away, so the schema-named state file and `refoldable` are
inert there — correctly, since `openStores` is not what a relay opens.

## Current state → work

1. ✅ **The two-phase protocol** — for an engine whose stores have no `atomic`. It was **not**
   true of `createMesh` over `openStores`, which passes `atomic` across both files: a local write
   tore twice there, between the writer's two transactions and inside SQLite's `COMMIT` between
   the files (U29). Both are closed by the journal described under "What was built" above, not
   by this item. What follows is the protocol as it stands without `atomic`.

   Less work than this said, because the shape was already here:
   `atomic` has always been optional, and its absent case is each store committing on its own
   while the coverage cursor recovers the gap. What was wrong was one thing on the wrong side —
   the operation record was written *after* `persist`, so a tear between them left a write that
   happened with no record that it had started, which is the one thing a ledger row whose id is
   minted before the commit exists to prevent.

   The order is now a stated contract rather than an accident of how the function reads: the half
   that **cannot be recomputed** commits first (event, then ledger row), the half that **can**
   commits second (rows, with the coverage cursor that says how far they go), and a crash between
   them costs a replay rather than a fact. `openEngine` already repairs exactly that shape.

   Pinned by a test that interrupts a write between the halves and asserts the row comes back on
   the next boot — and that the cursor never runs ahead of the log, which is the unrecoverable
   direction. Swapping the two halves makes it fail, which was checked by doing it.
2. ✅ **The recovery basis, and what it costs.** Two answers, both smaller than this asked for and
   one of them unwelcome:

   - `acked` is discarded with the rest. The loss understates delivery and never overstates it,
     and it returns on the next acknowledged write.
   - The folded state is **not** disposable on a device that has compacted, because compaction
     deletes events precisely to the extent that the rows are on disk. `refoldable(store)` is that
     question, and it gates everything below.

   What is *not* done, and is now optional rather than required: a durable snapshot written at
   compaction time would make the state file disposable again on an old device. It duplicates
   every row it covers, which is why it is worth having only if the schema-change story turns out
   to matter more than the disk.
3. ✅ **Split the stores into two files.** `<name>.db` is the **log**, attached as `syncmesh`;
   the app's own tables, their capture triggers and the projection are in a second file that
   hangs off it and is opened as `main`. Each adapter opens the pair, because each knows its own
   paths and its own VFS — and on OPFS the VFS has to be named in the attach URI or the file
   silently opens non-persistent. `openStores` refuses a connection without it rather than
   failing later at the first query that does not resolve.

   Which of the two carries the store's name was decided by item 4 below: the derived half's
   filename changes with the schema, and a name that changes cannot be the thing everything else
   is named after. So the log is the base — `<name>.db` — and "back up `<name>.db`" stays true
   for the life of the store.

   The `user_version` worry was mine and wrong: `PRAGMA syncmesh.user_version` is a property of
   the attached file and persists with it, so each half is versioned by the file it lives in.
   Two ladders, one step each, no history to walk — nothing has shipped.

   `statePathFor`, `lockPathFor` and `storeFilesFor` are the only places that know a store is
   more than one file. A test caught what that is for: leaving an org deleted the state file and
   the **log survived**, so rejoining found every event still there. `StoreScope` exists so that
   forgetting is a file deletion; with two files it is two, and saying so in one function is the
   difference.

4. ✅ **Hash the manifest into the state filename.** `schemaNameFor(tables)` is twelve hex
   characters of the DDL the tables actually produce — the DDL rather than the manifest object,
   because the DDL is what the file contains. The state file is `<name>.db.state@<hash>`, so
   adding a column opens an empty file and refolds into it instead of migrating rows in place,
   and the previous shape's file is an orphan nobody reads.

   The gate is `refoldable`, as this said it would be, and it reads the row the fingerprint was
   already keeping: `syncmesh.meta`'s `schema` lives in the **log**, which is shared by every
   state file, so a changed shape is visible from any of them. When it changed and the log has
   been compacted, the open refuses — below the floor the old file is not an orphan but the only
   copy, and opening the new one would present an empty database with no error. A test pins it,
   and removing the gate makes it fail.
5. ✅ **Blobs say whether losing them costs anything.** Not a separate store in the end — the
   distinction the RFC asked for was already encoded in which *method* stored the bytes, and only
   needed recording: `put` is a local creation and the only copy, `putAt` is bytes that arrived
   under a name from a peer that still holds them.

   `origin` and `irreplaceable()` are what a backup and an eviction sweep read. Our own bytes
   arriving back from a peer stay `mine`, because demoting them on an echo would license dropping
   the only copy — the insert ignores the conflict, and a test fails if it stops doing so.

   The in-memory store keeps no origin and answers `mine` for everything, which is the safe
   direction: a cache that wrongly says "droppable" loses bytes, one that wrongly says "keep"
   costs space, and only one of those is recoverable.

✅ Already done, and independently useful: the `syncmesh` namespace (a `CREATE SCHEMA` on Postgres,
a `syncmesh_` prefix on SQLite, one migration step that renames in place), the boot gap above, the
commit ordering, `refoldable`, and `LOG_TABLES`/`STATE_TABLES` — the line itself, written as data
and checked against a real schema, so whoever does 3 does not have to rediscover where it runs.

## Answered, by measurement

### A trigger cannot write across an attached database — so the layout is forced

```
CREATE TRIGGER main.issue_insert AFTER INSERT ON main.issue BEGIN
  INSERT INTO syncmesh.changes …
```
```
SQLiteError: qualified table names are not allowed on INSERT, UPDATE,
and DELETE statements within triggers
```

SQLite refuses at `CREATE TRIGGER`. The change log therefore **must** live in
the same file as the tables it captures, and since those are the app's tables,
the whole projection is welded into one file. That is not a preference; there is
no arrangement in which it is otherwise.

Which settles which file is `main`. It has to be the **derived** one:

```ts
const db = new Database("issues.state@<hash>.db");   // main: app tables, changes, state_rows
db.run("ATTACH DATABASE 'issues.log.db' AS syncmesh"); // the log, namespaced
```

Verified working end to end: an unqualified trigger on `main.issue` writes
`syncmesh_changes` in `main`, `syncmesh.events` writes the attached log, and the
app's own `SELECT title FROM issue` needs no qualification — so Drizzle, and
every procedure written against it, is untouched.

The cost is that the namespace is no longer uniform, and the RFC should not
pretend otherwise:

| | |
|---|---|
| `syncmesh.events`, `syncmesh.compaction`, … | the **log**, a real namespace in the attached file |
| `syncmesh_state_rows`, `syncmesh_changes`, … | the **derived** engine tables, prefixed, because they share `main` with the app's tables |

Postgres keeps one `CREATE SCHEMA syncmesh` for both halves. So the two dialects
agree on the *word* everywhere and on the *separator* only for the log. That is
better than today — where they disagree on seven table names outright — and it
is as far as SQLite allows.

### One lock owns the log and every state file that belongs to it

A second connection attached the same file and wrote it while the first held
`PRAGMA locking_mode = EXCLUSIVE` on it:

```
A wrote b.db under EXCLUSIVE locking
SECOND PROCESS WROTE IT -> no protection. rows: 3
```

So a state file inherits none of the protection `defaultStore`'s lock gives the log. It does not
need a lock of its own: what it needs is for **the log's lock to cover it** — taken before either
file is opened, rebuilt, migrated or deleted, and released after both are closed. `lock.ts`'s
sidecar already does that job for the log and can hold the pair.

The rule that makes it sound is exclusivity of naming: a state path belongs to exactly one log,
and nothing opens a state file without holding that log's lock. Independent access to a state
file — a tool that inspects one, a sweeper deleting orphans — is a second coordination problem
and not covered by this.

### Compaction gets much cheaper when the log is alone

Twenty thousand events, half deleted, then `VACUUM`:

| file | before → after | vacuum |
|---|---|---|
| log only | 4.62 MB → 2.08 MB | **8 ms** |
| log + state in one file | 9.27 MB → 6.43 MB | **190 ms** |

Twenty-four times faster, because `VACUUM` rewrites the whole file and in the
mixed case that whole file includes every derived row that was not being
compacted at all. On a phone holding a real workspace this is the difference
between retention running unnoticed and retention being something you schedule.

This is a second, independent argument for the split, and it was not the reason for it.

What gets *harder* is logical compaction. `VACUUM main` and `VACUUM syncmesh` each target one
file, so reclaiming space is now two operations with two temporary-space budgets and two WALs to
manage, and neither may run inside a transaction. And deleting events on its own still only frees
pages for reuse — the file does not shrink until something vacuums it, which is as true after the
split as before.

### OPFS can attach, and its journal mode is a default rather than a guarantee

The one thing that could have invalidated this. It works, with a trap:

```js
db.exec(`ATTACH 'file:/log.db?vfs=opfs-sahpool' AS syncmesh`);
```

**`?vfs=` is not optional.** `ATTACH` does not inherit the VFS of the main
database: leave it off and the attached file is opened by the build's default
VFS, which is not persistent. It reads and writes correctly for the life of the
tab and is empty after a reload. That failure has no symptom until somebody
reloads, so the URI must be built by the adapter and never assembled at a call
site.

Three consequences for this design:

**The browser is in rollback-journal mode, which is the mode where
multi-database transactions are atomic — but that is a default nobody has
changed, not a guarantee.** This adapter sets no `journal_mode` at all. And WAL
on OPFS is not merely possible: since **SQLite 3.47 it is supported and
documented**, with one requirement —

> Because the WASM build does not have shared memory APIs, activating WAL
> requires that a client specifically activate exclusive-locking mode for a db
> handle **immediately after opening it, before doing anything else** with it:
> `pragma locking_mode=exclusive`

That requirement is already satisfied here in spirit: `opfs-sahpool` takes
exclusive access handles for a whole directory and this adapter holds a
`navigator.locks` lease on top, so there is exactly one writer by construction.
Nothing stands between this build and WAL but a pragma.

The payoff for taking it is small and the asymmetry is the point:

| VFS | WAL benefit (per SQLite's own docs) |
|---|---|
| `opfs-sahpool` | "a slight performance boost", host-dependent |
| `opfs` | none observed — and exclusive locking removes all its concurrency |

**A slight, uncertain gain that silently costs cross-file atomicity is the worst
possible shape of temptation.** Someone will measure a few percent on a write
benchmark, add one pragma, and have no reason on earth to connect it to a torn
commit in a different file.

| runtime | journal | cross-file commit |
|---|---|---|
| browser (OPFS) | rollback, **by default only** | atomic — while that holds |
| phone, Bun, Node | WAL | **can tear** — 8/15 measured |

So: the append-then-persist ordering is load-bearing **everywhere**, and must
never be written down as a native workaround. Correctness may not rest on a
journal mode, on any runtime. Get that right and the pragma above becomes a free
optimisation somebody can take later; get it wrong and it becomes silent data
loss with a performance improvement attached to it.

**The SAH pool's capacity must grow** — done, and confirmed by running the app.
It holds one access handle per slot, and a store now takes four: the log and its
journal, the derived half and its journal. Eight covered three stores when a
store was one file; it covers two now, so `CAPACITY` is 16. This is what an
origin runs out of rather than disk, and the failure is an open that is refused
rather than anything visible in the data.

Three scoped stores is 3 × 2 = 6 today. Splitting makes each scope two files —
three with blobs — so the same three stores need 12 to 18. `CAPACITY` is a
constant that quietly becomes wrong, and the arithmetic should be written as
`stores × files × 2` rather than left as `8` with a comment that no longer
describes it. `addCapacity()` is the escape hatch when it is exceeded at runtime.

**The `opfs` VFS is the other option and is worse here**: it needs COOP/COEP for
`SharedArrayBuffer`, and every attached file is another file it locks, so
multi-tab contention rises with the split. `opfs-sahpool` is single-connection
and needs no headers, which is what this adapter already chose and what the
split wants.

### Blobs are their own store, and moving them changes nothing about backup

They are durable, content-addressed, and the only thing here whose size is unbounded by the log.
Keeping them in the log file makes "back up the log" mean "back up every attachment" and makes the
`VACUUM` above expensive again.

But the honest framing is not "a third file" — it is that `BlobStore` is already an interface, and
this is a separate implementation behind it. The distinction that matters is **locally created or
upload-pending bytes, which are irreplaceable, against downloaded cache entries, which can be
fetched again**. Only the first must survive, and a complete backup must still include them:
moving them out of the log relocates the obligation rather than removing it.

The write order is its own small protocol — durable bytes before the reference that names them —
so a crash leaves an orphan for a sweeper rather than a reference to nothing.

## Open questions

All four of the original four are answered above. What is left is what the
answers opened:

- **Does `state@<hash>` interact badly with `scopedStores`?** One database per
  partition instance (D07) times one state file per schema hash is a file count
  an OPFS quota or a phone's file-descriptor budget might notice. LiveStore
  sweeps on a bound for exactly this reason; ours needs a number.
- **Does `locking_mode=exclusive` survive an `ATTACH`?** SQLite requires it be
  set *immediately after opening, before anything else*, and we attach after
  opening. Unprefixed, the pragma is documented to apply to every database
  including ones attached later; prefixed, only to one. If the split ever wants
  WAL in the browser, the exact order of open → pragma → attach → per-file
  `journal_mode` has to be established rather than assumed.
- **Where does the `?vfs=` name come from on a custom pool?** `installOpfsSAHPoolVfs`
  is called here with `{ directory, initialCapacity }` and no `name`, so it
  registers under the default `opfs-sahpool`. That is fine while there is one
  pool per thread — which `pools`, keyed by directory, currently guarantees — and
  becomes a name collision the moment two directories are installed in one
  thread. The `ATTACH` URI has to be built from the pool that was actually
  installed, not from a constant.
- **What opens the state file when the log refuses?** `defaultStore` fails with
  `StoreLocked` when a second engine tries to open the log. The state file must
  then not be opened either — but the attach happens on one connection, so the
  ordering is "open log, take lock, then attach" and that is a change to
  `openStores`' shape, not just its contents.
- **Does the schema hash belong to the manifest or the manifest *plus dialect*?**
  The DDL differs per dialect, and a device that somehow changed dialect under a
  single file would read a state file built for the other one. Cheap to include;
  worth being explicit.
- **Is `changes` worth keeping at all once the projection is disposable?** It is
  drained and cleared inside every write, so it holds nothing between them. If
  the state file is rebuilt from the log anyway, a crash mid-write loses the
  change log and the row together, which is the consistent outcome — but that
  should be reasoned through rather than assumed from this sentence.

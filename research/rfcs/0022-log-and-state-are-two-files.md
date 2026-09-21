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

**The basis is not "the log". It is a durable snapshot plus the retained event tail**, and two
existing features are why:

- **Compaction deletes events** once the state that stood for them was persisted (RFC-0015). A
  log with a floor above zero is not a complete history.
- **Snapshot installation imports rows without their event history** (RFC-0019). A device that
  joined from a snapshot has rows no replay can reconstruct.

So a state file may only be discarded when the events above the floor, plus a snapshot covering
everything below it, are both present — and the snapshot's own `coverage` and `scope` travel with
it, because a number without the interest that qualifies it is the lie D23 describes.

**`acked` is not derived either.** It moves when a *peer acknowledges*, which touches no row and
leaves no event; `row-sync.ts` updates it directly. Either the acknowledgement evidence becomes
durable and the watermark is rebuilt from that, or discarding the state file explicitly loses
delivery status — every `delivered` reverting to `local` until the next acknowledgement. The
second is defensible and must be a decision rather than a surprise.

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

## A torn commit is survivable, but only under a protocol we do not have yet

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

> Out of scope here but found while writing it: `writer.ts` already commits the app-table write in
> `captureChanges`' own transaction and the event in a second one. A crash between them leaves a
> row written, the change log cleared, and no event — a write that is local forever and that
> `strandedWrites` cannot see, because it scans the event store and there is no event. That gap
> exists today, in one file, and this RFC neither causes nor fixes it.

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

**A schema change is a new file, not a migration.** The filename carries a hash
of the app manifest, as LiveStore's `state${schema.hash}.db` does. Change a
column and the old state file is orphaned, a new one is opened empty, and the
fold rebuilds it from the log. No `ALTER`, no migration ladder for anything
derived, nothing to get wrong on a device you cannot inspect. Old files are
swept on a bound, the way LiveStore keeps `MAX_ARCHIVED_STATE_DBS_IN_DEV`.

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

## Current state → work

1. ✅ **The two-phase protocol.** Less work than this said, because the shape was already here:
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
2. **A durable recovery basis.** A snapshot with its coverage and scope, so "discard the state
   file" is only offered where the events above the floor plus that snapshot can rebuild it.
   Decide what happens to `acked` — rebuilt from durable acknowledgement evidence, or explicitly
   lost.
3. **Split the stores**, with the log's lock covering both files, and `openStores` opening the log
   and attaching the state file in that order.
4. **Hash the manifest into the state filename**, sweep orphans on a bound, and decide whether the
   hash includes the dialect.
5. **Blobs behind their own `BlobStore`**, with irreplaceable bytes distinguished from cache.

✅ Already done, and independently useful: the `syncmesh` namespace (a `CREATE SCHEMA` on Postgres,
a `syncmesh_` prefix on SQLite, one migration step that renames in place), and the boot gap above.

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

**The SAH pool's capacity must grow.** It holds one access handle per slot, and
every database *and its journal* takes one:

```ts
/** The pool holds a file open per slot, so the default is "three scoped stores and their journals". */
const CAPACITY = 8;
```

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

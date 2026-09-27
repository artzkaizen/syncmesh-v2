---
rfc: 0023
title: Document columns — collaborative data as a merge rule on a column
package: syncmesh (kernel · wire · engine · storage · schema · drizzle · client · new documents + loro packages; Rust syncmesh-core · syncmesh-client · new syncmesh-loro) — design
layer: contract
status: proposed
standalone: false
deps: ["0002", "0004", "0008", "0013", "0014", "0015", "0019", "0021", "0022"]
---

# RFC-0023 — Document columns

> Numbering: 0022 ("The log and the state are two files") lives on branch
> `t3code/identify-devtools-stack`. This RFC takes the next free number, 0023, so the two do not
> collide when the branches meet. Where 0022's file split changes a table name below, 0022 wins.

## Purpose

Syncmesh merges **cells**. A cell holds one value and one stamp, and the row rules — `lww`, `max`,
`min`, `counter` — each pick or sum whole values. That is convergence, not intent preservation:
two people typing into one `text` cell while apart keep one person's paragraph. D04 scheduled the
remedy ("revisit C only for collaborative prose, as a separate column kind") and D25 then deleted
the cell lattices that had no caller. Collaborative content now has a caller, and this RFC is the
remedy.

The decision in one line: **collaborative data is a merge rule on a column, not a second kind of
data.**

```ts
merge: { name: "lww", content: loro }
```

The column is an ordinary binary Drizzle column. It holds the latest compacted snapshot. The
edits live in syncmesh's own event store as signed, action-grouped updates. A versioned adapter
package (`@syncmesh/loro`, id `loro@1`; Rust `syncmesh-loro`) is the only code that understands
the bytes. The app gets the library's own document type back (`LoroDoc`). Syncmesh never wraps
the CRDT's editing API, and there are no merge-function plugins.

## 1 · Motivation: what licnep hand-rolls today

licnep (the owner's native design editor, `crates/sync` in the licnep repo) syncs artboard
content that is a Loro document. Syncmesh has no word for that, so licnep built it out of rows:

| What licnep had to build | Where | What it costs |
|---|---|---|
| a `doc_updates` table: one row per Loro update, keyed `<artboard>/<content hash>`, cells `artboard`, `bytes` or `blob` | `crates/sync/src/model.rs` (`doc_update`, `DOC_UPDATES`) | a row per edit burst, **never deleted**; the row model used as an append-only log it was not designed to be |
| a 256 KiB inline cap, larger updates as D18 blobs, a fetch state machine (pending/fetching, 4 concurrent, 0.5–30 s backoff), and re-offering its own blobs every time the link returns | `model.rs` `INLINE_UPDATE_MAX`, `fetch.rs`, `device.rs` `reoffer` | a second delivery system beside the log, with its own retry rules |
| a **lineage** cell on `artboards` (the Loro id of the root tree node), updates held by `(artboard, lineage)` until the metadata says which history wins, and a rebuild from the room when the local copy has a different lineage | `model.rs`, `crates/app/src/editor/remote.rs` (`HeldUpdates`), `crates/core/src/crdt.rs` (`lineage`) | two devices that import the same HTML get two unrelated histories. The fix is app code that every other app would have to rewrite |
| `sent`/`acked` cursors per artboard in the bridge, re-exporting from `acked` after a restart | `crates/app/src/sync.rs` | a delivery ledger that duplicates the engine's |
| undo of an agent run across frames and tokens (`VariablesDelta`: "puts back the before of every variable that still holds the run's after") | `docs/sync.md` "Agent runs, tokens and undo" | a cross-row, cross-document undo, written once, for one app |
| "Not yet: compaction of `doc_updates` (… a snapshot blob per artboard is the planned answer)" | `docs/sync.md` | the log grows without bound (RFC-0015 §1 calls per-edit logs forbidden by economics) |

Every one of these is generic. Any app with a rich-text field, a canvas or a notes body would
rebuild the same table, the same threshold, the same lineage rule and the same leak. None of it
sits under syncmesh's guarantees either. Postgres cannot answer SQL over the content, the policy
ladder cannot see a document, compaction cannot trim it, and `history()`/`revert()` cannot undo
it.

## 2 · Decisions this builds on (owner-approved, 2026-09-27)

1. The row rules stay (`lww`, `max`, `min`, `counter`). They converge. Collaborative data is
   added as a **merge rule on a column**, not a separate "documents" concept.
2. The Drizzle column is an **ordinary binary column** holding the latest compacted snapshot:
   Postgres `bytea()` (Drizzle 1.0), SQLite `blob({ mode: "buffer" })`. In Drizzle 1.0,
   `blob()` without a mode stores JSON. `research/learnings.md` records the change. **Schema
   construction fails if an adapter-merged column is not binary.** The device SQLite mapping is
   derived from the Drizzle schema, as it is today.
3. Adapters are **versioned packages**: `@syncmesh/loro` has id `loro@1`, Rust `syncmesh-loro`
   the same. `loro-crdt` / `loro` stay the app's own peer dependency. `row.content.open()`
   returns the library's own document type. There are no arbitrary merge-function plugins (D04's
   rejected option D stays rejected).
4. A device **without the adapter** keeps and forwards the column's events but refuses to edit.
5. Edits live in **syncmesh's event store**: a per-(row, column) update log, signed and
   action-grouped. The table column is the materialised snapshot. Every replica does:
   append → apply in memory via the adapter → periodically write the snapshot to the column →
   trim the log behind it. The server keeps the long log for catch-up. Devices trim once
   acknowledged.
6. The authority runs either **materialising** (runs the adapter, writes snapshots, fills
   derived columns like `derive: { title: from("content", d => …) }`) or **opaque** (stores and
   relays bytes; a device writes the snapshots).
7. **Actions span rows and documents** under one action id. Undo is a forward compensating
   action (`undo_of`), and the adapter produces the compensating document updates.
   `history()`/`revert(eventId)` exist in the Rust client too.
8. Rust gets a `DocumentAdapter` trait: open a snapshot, apply an update (did it change
   anything?), snapshot, updates since a version, a compensating update for an action.

A note on `counter`: the TypeScript kernel dropped it in D25 (three rules). `syncmesh-core` and
the v3 surface still carry it. Nothing below depends on which way that settles.

## 3 · Non-goals

- **No merge plugins.** An adapter is a vetted, versioned package that ships beside syncmesh.
  It is never a function an app passes in. D04's argument against custom resolvers still holds.
- **No wrapper over the editing API.** Syncmesh does not re-export text/list/map operations. The
  app edits a `LoroDoc` with Loro's own API and syncmesh watches for local updates.
- **No per-keystroke events.** RFC-0015 §1 forbids them on cost grounds. Edits are paced (§5.4).
- **No partial documents.** A document is held whole wherever its row is held (custody is per
  partition, v3 §4). There is no "fetch the first page of a doc".
- **The fold never runs an adapter.** What folds, parks and digests is adapter-independent (§6,
  §10). Adapters only run in materialisation, which happens after the fold.

## 4 · The developer-facing API

### 4.1 Schema (TypeScript)

```ts
// db/schema.ts — the app's own Drizzle 1.0 tables, unchanged in kind
export const notes = pgTable("notes", {
  id: uuid().primaryKey(),
  title: text().notNull().default(""),
  content: bytea(),                 // the latest compacted snapshot; NULL = empty document
  wordCount: integer().notNull().default(0),
});
// device side derives from the same definition; an explicit SQLite table would be
// sqliteTable("notes", { …, content: blob({ mode: "buffer" }) })

// sync/schema.ts
import { loro } from "@syncmesh/loro";          // a descriptor; the wasm loads on first open
import { derive, from } from "@syncmesh/schema";
import type { LoroDoc } from "loro-crdt";

export const schema = syncSchema({
  partitions: { workspace: {} },
  roles: { workspace: ["owner", "editor", "viewer"] },
  tables: {
    notes: drizzleTable(notes, {
      partition: "workspace",
      merge: { title: "lww", content: loro },    // ← the whole feature, declared
      derive: {
        title: from("content", (d: LoroDoc) => d.getText("title").toString()),
        wordCount: from("content", (d: LoroDoc) => countWords(d.getText("body").toString())),
      },
      allow: ({ role }) => ({
        read: role("viewer"), insert: role("editor"), update: role("editor"), delete: role("owner"),
      }),
    }),
  },
});
```

Construction fails with an actionable error (a boot error on the developer's machine, per v3 §3)
when:

| Mistake | Error |
|---|---|
| adapter on a non-binary column (`text`, `json`, or SQLite `blob()` without `mode: "buffer"`, which Drizzle 1.0 maps to JSON) | `DocColumnNotBinary` — "use `bytea()` / `blob({ mode: \"buffer\" })`" |
| adapter on the primary key, a `unique()` column, a `check`, or an `immutable` column | `DocColumnConstraint` |
| `max`/`min`/`counter` named on a doc column, or an adapter on a non-doc column type | `MergeKindMismatch` (D25's runtime backstop, extended) |
| `derive` target that is the key, a doc column, missing, or also written by `merge` rules the app writes | `InvalidDerive` |
| `derive` source that is not a doc column of the same table | `InvalidDerive` |
| two adapter ids for one column across schema versions | refused by RFC-0013's diff (§12) |

The **manifest** (the shareable half the Rust and Swift ports read) carries only data:
`{ column: "content", doc: "loro@1", derive: ["title", "wordCount"] }`. The derive functions and
the adapter implementation are JavaScript values. The manifest never holds them.

`ColumnDef` gains `doc?: { adapter: string }` beside `merge`. `MergeFor<T>` admits a
`DocumentAdapter` for byte columns only (`Uint8Array`/`Buffer`), so a wrong placement fails in
the editor before it fails at boot.

### 4.2 The rule: a document column is opened, never read like a value

Query-side tables (`schema.tables`, derived at construction per v3 §3) replace every doc column
with a **`DocRef`** expression. It compiles to `(table, key, column)` plus the head version from
`doc_heads`, never the bytes:

```ts
list: query.input(z.object({ workspaceId: z.string() })).handler(({ input, db }) =>
  db.select({ id: tables.notes.id, title: tables.notes.title, content: tables.notes.content })
    .from(tables.notes).where(eq(tables.notes.workspaceId, input.workspaceId)),
);
// row.content : DocRef<LoroDoc>  — not Uint8Array
```

- A `DocRef` is a cheap, stable descriptor (like `BlobRef`, v3 §13). It has `status`
  (`"current" | "behind" | "unsupported"`), `version`, and `open()`. Rows keep object identity
  across live deliveries while the head does not move (v3 §5 invariant 4).
- Nothing in the query path returns snapshot bytes. Live queries never re-run because a document
  changed: a doc edit changes the doc's head, not a queryable cell. Only `derive`d columns (plain
  cells) and `syncOf`-style selections invalidate queries.
- The raw bytes are reachable only through the app's **own** Drizzle table on the authority's
  Postgres (for backups and SQL tooling). They are typed `Buffer` there and documented as "the
  materialised snapshot, possibly behind the log". Writing them through the mesh face is refused
  (`DocColumnWrite`, §6.4).

### 4.3 Open, edit, subscribe (TypeScript)

```ts
const note = data[0];
using doc = (await note.content.open()).unwrap();     // Result<OpenDoc<LoroDoc>, OpenError>; Disposable
doc.value.getText("body").insert(0, "Hello");         // Loro's own API — syncmesh does not wrap it
doc.value.commit();                                   // Loro's commit; syncmesh sees the local update

doc.status;        // "current" | "behind" (bytes/deps missing) | "read-only" | "invalidated"
doc.subscribe(() => …);            // syncmesh-level: remote updates applied, status changes
doc.value.subscribe((e) => …);     // Loro-level fine-grained events, untouched
```

- **`open()`** loads the adapter lazily, then snapshot + tail (the uncovered log entries) into
  one `LoroDoc`. Handles are refcounted per `(table, key, column)` per client. Two `open()`
  calls share one `LoroDoc`, so one process never runs two Loro replicas of one doc.
- **Local edits** are observed through the adapter's `watchLocal` (Loro's
  `subscribeLocalUpdates`) and **flushed** as one event per burst. The pacing policy is in §5.4.
  Each flush is a statement like any write (v3 §6): it returns a `Write`, it is durable once
  committed, and `syncOf` tracks it.
- **Errors are values.** `OpenError = AdapterMissing | DocDeleted | PolicyDenied |
  StoreFailure`. Opening without `update` permission returns a `"read-only"` handle. A local
  edit on such a handle, or a flush the fold refuses, **invalidates** the handle: its
  un-committed local ops must never be exported later. The app reopens. That is the price of not
  wrapping the editing API. Syncmesh cannot stop an edit, only refuse to publish it.
- React: `useDoc(note.content)` returns `{ doc, status }` and disposes on unmount.

**Inside a mutation**, a doc edit joins the transaction's event:

```ts
create: mutation.input(…).handler(async ({ input, db, ids, docs }) => {
  const id = ids.next();
  await db.insert(tables.notes).values({ id, workspaceId: input.workspaceId });
  docs.change(tables.notes.content, id, (d: LoroDoc) => d.getText("body").insert(0, input.body));
}),                                         // ONE event: the insert row + the doc update
```

`docs.replace(ref, snapshotBytes)` starts a new lineage (§5.3). It is used for "import this
file" or "reset to this template". It is the only way two unrelated histories ever meet.

### 4.4 Actions, undo, history (TypeScript)

```ts
const action = client.$actions.begin({ label: "Agent run · Claude Code" });
client.notes.rename({ id, title: "Q3" }, { action });       // a row write in the action
doc.change((d) => d.getText("body").delete(0, 5), { action }); // a doc flush in the action
const run = action.end();                                     // ActionId

client.$actions.undo(run);          // ONE new event: undo_of = run; rows + docs compensated
client.$actions.undo(undoId);       // redo is the undo of the undo
client.$history.row(tables.notes, id);    // revisions: row writes AND doc updates, oldest-first
client.$history.revert(eventId);    // today's mesh.revert(eventId), widened to event | action
```

- Without an explicit action, every procedure call is its own action. Consecutive doc flushes of
  one handle within `actionIdleMs` (default 1 s) share one action, so a typing burst is one undo
  step.
- The local undo stack holds **this principal's** actions only. Remote changes never become
  undo steps. licnep already enforces this rule by hand in `editor/remote.rs`.
- Loro's own `UndoManager` stays usable inside a document. Its undo ops are ordinary local
  updates and flush like any edit. `$actions.undo` is for undo that crosses rows and documents,
  or outlives a session.

### 4.5 Rust

```rust
use syncmesh_client::docs::{Adapters, DocColumn, Target};
use syncmesh_loro::{Loro, loro::LoroDoc};   // re-exports the loro crate, so the types match

#[derive(SyncTable)]                          // syncmesh-derive (P4b); a builder works without it
#[sync(table = "artboards", partition = "project")]
struct Artboard {
    #[sync(key)] id: String,
    name: String,                              // lww
    #[sync(merge = "max")] z: i64,
    #[sync(doc = Loro, derive(name_hint = "title_of"))] content: DocColumn<Loro>,
}

let mesh = Mesh::open(MeshOptions { schema: schema![Artboard], adapters: Adapters::new().with(Loro), ..opts }, &rt)?;

let mut board = mesh.docs().open(&Artboard::CONTENT, &partition, "a1")?;   // DocHandle<Loro>
board.doc().get_text("title").insert(0, "Hello")?;   // &LoroDoc — Loro's API, unwrapped
board.doc().commit();                                 // flushed per the pacing policy

let action = mesh.actions().begin("Agent run · Claude Code");
action.mutate("artboards.move", vec![/* row changes */], Some(partition.clone()))?;
action.change(&mut board, |d: &LoroDoc| { d.get_map("frame").insert("x", 40)?; Ok(()) })?;
let run = action.end()?;                             // ActionId

mesh.revert(Target::Action(run))?;                   // compensating event, undo_of = run
mesh.revert(Target::Event(event_id))?;               // today's TS revert(eventId), in Rust
let revisions = mesh.history("artboards", "a1")?;    // rows + doc entries, stamp order
```

The adapter trait (in `syncmesh-client::docs`, so every host implements against one contract):

```rust
pub trait DocumentAdapter: Send + Sync + 'static {
    /// "loro". With FORMAT it forms the wire id "loro@1".
    const NAME: &'static str;
    /// Format major: every update and snapshot any adapter of this (NAME, FORMAT) writes, every
    /// other one reads. A new major is a new column (§12), never an in-place upgrade.
    const FORMAT: u32;
    type Doc: Send;

    /// A document from a snapshot (None = the empty document), writing as `replica`.
    fn open(&self, snapshot: Option<&[u8]>, replica: ReplicaId) -> Result<Self::Doc, AdapterError>;
    /// Imports updates in any order; `changed` says whether visible state moved, `pending` that
    /// some wait on dependencies not yet held. Total: malformed bytes are an error, never a panic.
    fn apply(&self, doc: &mut Self::Doc, updates: &[&[u8]]) -> Result<Applied, AdapterError>;
    /// Snapshot bytes for the column; `floor` = the causally stable version below which history
    /// may be dropped (shallow), None = keep full history.
    fn snapshot(&self, doc: &Self::Doc, floor: Option<&Version>) -> Result<Vec<u8>, AdapterError>;
    /// The document's version, adapter-encoded (Loro: the oplog version vector).
    fn version(&self, doc: &Self::Doc) -> Version;
    /// Everything since `since`, or None when nothing is new — what a flush exports.
    fn updates_since(&self, doc: &Self::Doc, since: &Version) -> Result<Option<Vec<u8>>, AdapterError>;
    /// One update that undoes exactly the effect of `action`'s updates on the current document,
    /// leaving concurrent and later edits by others in place. None when nothing remains to undo.
    fn compensating_update(&self, doc: &mut Self::Doc, action: &[&[u8]]) -> Result<Option<Vec<u8>>, AdapterError>;
    /// Calls `notify` after every local commit; the handle flushes on the pacing policy.
    fn watch_local(&self, doc: &Self::Doc, notify: Box<dyn Fn() + Send + Sync>) -> Subscription;
}
pub struct Applied { pub changed: bool, pub pending: bool }
```

`DynDocumentAdapter` is the object-safe erasure (`Box<dyn Any + Send>` documents) that the
registry holds. The TypeScript SPI (`@syncmesh/documents`) has the same six operations, with
`Result` returns per D02, plus a `load()` that loads the wasm lazily.

**Loro mapping** (both runtimes; loro 1.16, loro-crdt 1.x):

| Operation | Loro |
|---|---|
| `open` | `LoroDoc::new()`, `set_peer_id(replica)`, `import(snapshot)` |
| `apply` | `import_batch(updates)`; `ImportStatus.pending` → `pending` |
| `snapshot(floor)` | `export(ShallowSnapshot(floor))`, or `export(Snapshot)` when `floor` is None |
| `version` | `oplog_vv().encode()` |
| `updates_since` | `export(Updates { from: vv })` |
| `compensating_update` | fork at the action's dependencies, import only the action's updates, `diff(after, before)`, `apply_diff` onto the live doc, export the resulting local update |
| `watch_local` | `subscribe_local_update` |

**Replica ids.** Loro corrupts history when two concurrent writers share a peer id, or when a
restored backup reuses counters. The replica id is
`u64(H("syncmesh/doc-replica" ‖ device key ‖ writer incarnation))`. The writer incarnation (v3
§1) changes on every restore or new data directory. The exclusive store lock (v3 §14) rules out
two processes on one incarnation.

## 5 · Wire and event format

### 5.1 The `doc` change (tag 6)

The change kinds are `insert` 0, `update` 1 and `delete` 2. Tags 3–5 were the cell lattices
D25 deleted, and they are **never reused**: an old log may still hold them. The doc change takes
**tag 6**. The change map keeps its frozen keys (`kind` 0, `table` 1, `key` 2, `data` 3). The
new part is `data`:

```
data = {
  0: column    tstr               the doc column's name
  1: adapter   tstr               "loro@1" — must equal the schema's declaration (§10)
  2: lineage   bstr(16)           absent = the root lineage (§5.3)
  3: bytes     bstr               the update, inline            ┐ exactly one
  4: blob      [bstr(32), uint]   sha-256 + length, via D18     ┘
  5: genesis   true               only on a replace(): `bytes`/`blob` is the new lineage's snapshot
}
```

A doc change is **order-free** at the fold. Its only effect on kernel state is §5.3's lineage
cell. Everything else is appended to the doc log. Unknown `data` keys are skipped (RFC-0002
invariant 4).

### 5.2 Event-level keys

The event core's keys are `v` 0, `peerId` 1, `seq` 2, `hlc` 3, `procedure` 5, `partition` 6,
`changes` 7 and `sealed` 8. Key 4 was never used and stays retired. RFC-0013 still needs a fresh
key for `schemaVersion`, so 9 is **reserved for it**. This RFC claims:

| Key | Name | Type | Meaning |
|---|---|---|---|
| 10 | `action` | bstr(16) | the action this event belongs to; absent = the event is its own action |
| 11 | `undoOf` | bstr(16) | this event compensates that action (undo; redo = undo of an undo) |

Neither key changes what folds. They drive history and undo only. An old build that skips them
folds identically, so no `v` bump is needed and every frozen v=1 vector stays valid.

### 5.3 Lineage, handled by the fold

licnep's lineage problem, stated generally: two histories built independently for one document
double their content when merged. Syncmesh answers it once:

- **Every doc starts on the root lineage.** The root lineage is the empty document, the same on
  every replica, with no event needed. All ordinary edits on it merge. There is no "who creates
  the doc" race, because nobody creates it.
- **`replace()` starts a new lineage.** Its change carries `genesis: true`, the full snapshot
  (inline or blob), and `lineage = H("syncmesh/doc-lineage" ‖ event id ‖ change index)[..16]`.
  The derivation is deterministic, so a receiver checks it and a forged genesis is refused
  (§10). An import from HTML, "reset to template" and "restore this version wholesale" are all
  replaces.
- **The winning lineage is an LWW cell.** In the kernel's `RowRecord`, the doc column's cell
  holds the current lineage id (absent = root) with the genesis's stamp. Concurrent replaces
  resolve by stamp like any concurrent write (RFC-0014 matrix). Row digests, snapshot pages
  (RFC-0019), tombstones and `insert`×`insert` all come for free. The SQL column still holds
  snapshot bytes. The projection writes the lineage to `doc_heads`, not to the column.
- **Losing lineages are kept, not applied.** Their updates stay in the log. They are marked
  `orphaned` in `doc_log` and listed by `history()`, and an app can read them (`openLineage`)
  to offer "recover the other version". An edit that names a non-winning lineage appends as
  `orphaned`. It never mixes into the winner.

### 5.4 Pacing, size and chunking

- **Flush policy** (per handle): after `idleMs` (default 300) of quiet, or at `maxMs` (default
  1000) during continuous editing, or on `close()`/`$flush()`. One flush exports
  `updates_since(last flushed version)` as one doc change. That puts continuous typing at
  ≤ 1 event/s, inside RFC-0015's "paced/CRDT-delta" tier (~30–75k events per 6 months).
- **Inline ≤ 64 KiB, blob above.** The Rust room caps frames at 1 MiB, BLE reassembly at 128 KiB
  (D18), and licnep uses 256 KiB. 64 KiB keeps a doc event inside one BLE reassembly with
  headroom. Blob-carried updates follow D18: the author holds the bytes until a relay
  acknowledges them, the relay holds them while any retained log entry references the hash, and
  BLE refuses bulk by default. A change whose bytes have not arrived still **folds**. Its log
  entry is `bytes-missing` and the doc's status is `"behind"` until the blob lands.
- **Catch-up** uses RFC-0002's hash-chained chunks unchanged. Doc changes are ordinary events,
  so a 10k-update backlog costs one signature check per author and compresses with the rest.
  Receivers import each doc's backlog with one `apply(&[..])` batch.
- **Snapshots are always blobs on the wire** (below). They are never inline.

### 5.5 Doc checkpoints: the snapshot record

The column's snapshot is local state and never travels as a cell. Two things need a snapshot on
the wire: a **joiner** below someone's compaction floor (RFC-0015 §3, RFC-0019), and an **opaque
authority** that wants a column value it cannot compute (§7.2). Both use one signed record,
`DocCheckpoint`, which rides snapshot pages beside `RowRecord`s:

```
DocCheckpoint core = {
  0: table  tstr    1: key  tstr    2: column  tstr    3: adapter  tstr
  4: lineage  bstr(16) | absent          the lineage this snapshot is of
  5: covers   { peerId → seq }           every doc change of this doc at or below these is folded in
  6: version  bstr                        adapter-encoded version of the snapshot
  7: snapshot [bstr(32), uint]            blob ref (D18) to the adapter snapshot bytes
  8: derived  { column → cell }           derive values at this version (for opaque hosts)
  9: at       [ms, logical]               HLC of production
}
envelope = [core, sig]                    signed by the producer's device key
```

A joiner installs it as follows. It fetches the blob, writes it to the column, and adopts
`covers` as the doc's floor. Every doc change above `covers` arrives as ordinary catch-up and
lands in the tail. §7.3 covers who is trusted to sign one.

## 6 · Storage

### 6.1 The app's column

- Postgres `bytea` / SQLite `BLOB`, created by the same `tableDdl` as today (the column kind is
  `blob`, with a `doc` annotation). `NULL` means the empty document.
- **Content:** adapter snapshot bytes of the winning lineage at `doc_heads.covers`. Devices write
  shallow snapshots at the stable floor (§8.3). The authority writes full snapshots, or shallow
  ones at its retention horizon.
- **Never captured, never a cell on the wire.** Capture (D20/RFC-0021) omits doc and derived
  columns from the logged image. A guard trigger refuses any statement that changes them while
  capture is armed (`DocColumnWrite`). The materialiser writes them with capture disarmed,
  through the dialect's existing `arm`/`disarm` switch.

### 6.2 Engine tables, declared once in Drizzle 1.0

Two new tables per dialect, declared as Drizzle 1.0 table objects in `packages/storage`
(`doc-tables.ts`: `pgTable` + `sqliteTable`, used for typed statements). They are created by one
new step in each dialect's migration list. A test compares the migration DDL with the Drizzle
declarations, so the two cannot drift. Names follow today's convention (`_syncmesh_*` on
Postgres, bare on the device, `sm_*` in the Rust device) until RFC-0022's namespace lands.

```ts
export const docLog = pgTable("_syncmesh_doc_log", {          // the LOG half (RFC-0022)
  author: text().notNull(), seq: bigint({ mode: "number" }).notNull(), idx: integer().notNull(),
  tbl: text().notNull(), key: text().notNull(), col: text().notNull(),
  lineage: bytea(),                                  // NULL = root
  hlcMs: bigint({ mode: "number" }).notNull(), hlcLogical: integer().notNull(),
  action: bytea(), undoOf: bytea(),
  blob: text(),                                      // sha-256 hex when the update is blob-carried
  size: integer().notNull(),
  state: text().notNull(),  // 'tail' | 'covered' | 'bytes-missing' | 'orphaned' | 'failed' | 'adapter-missing'
}, (t) => [primaryKey({ columns: [t.author, t.seq, t.idx] }),
           index().on(t.tbl, t.key, t.col, t.state)]);

export const docHeads = pgTable("_syncmesh_doc_heads", {      // the STATE half
  tbl: text().notNull(), key: text().notNull(), col: text().notNull(),
  adapter: text().notNull(), lineage: bytea(),
  covers: text().notNull(),         // cursor map JSON: the snapshot's floor
  version: bytea(),                 // adapter version of the column's snapshot
  tailCount: integer().notNull(), tailBytes: bigint({ mode: "number" }).notNull(),
  mode: text().notNull(),           // 'materialised' | 'checkpoint' (opaque) | 'none'
  materialisedAt: bigint({ mode: "number" }),
}, (t) => [primaryKey({ columns: [t.tbl, t.key, t.col] })]);
// SQLite: the same shape via sqliteTable, blob({ mode: "buffer" }) for byte columns.
```

`doc_log` indexes the log, **by reference**. The update bytes stay in the signed event core
(RFC-0004: payloads are opaque and byte-identical). Reading a tail means decoding those few
cores, and snapshots keep tails short. So inline updates are never stored twice.

### 6.3 Transactions

| Step | Transaction | Adapter? |
|---|---|---|
| a local write (row changes + doc flush) or a received batch | **one**: append event(s) → `doc_log` rows → fold rows + lineage cell → persist state → (local only) derived columns of the open doc | no — derived values come from the in-memory doc that produced the flush |
| materialise | **one**: column snapshot bytes + derived columns + `doc_heads` (`covers`, `version`) + `doc_log.state = covered` | yes, before the transaction |
| trim | inside compaction (RFC-0015), clamped by §8.3 | no |

A crash between steps loses nothing. On reopen, a doc is the column snapshot plus the log entries
above `covers`. The column never claims more than it holds, because `covers` and the bytes commit
together.

### 6.4 What the fold does with a doc change

Validate it (§10, §11). Set the lineage cell if it is a genesis. Insert the `doc_log` row. That is
all. The fold is identical with or without the adapter. D22's rule "two peers with the same
events park the same set" holds by construction, and so does RFC-0014's digest agreement. Row
digests include the lineage cell and exclude the snapshot and derived columns. A per-doc digest
is the sum of `H(doc change id)` over the log (adapter-independent), and compaction folds it into
`doc_heads`.

## 7 · Authority behaviour

### 7.1 Materialising (the default when the server has the adapter)

`createServer({ …, documents: { adapters: [loro], mode: "materialise" } })`. The authority folds
like every node, then runs the materialiser. For each doc touched it imports the new tail into a
cached in-memory doc (LRU-bounded) and, on the snapshot policy (§8.2), writes snapshot + derived
columns + `doc_heads` into Postgres in one transaction. After that:

- SQL, RLS (read rules) and watchdogs see real `title`/`wordCount` values. A watchdog on derived
  columns is the server-side reaction to document content.
- It **produces `DocCheckpoint`s** for joiners, signed by the authority key. Those are the
  trusted ones (RFC-0019's "authority present" row).
- It keeps the **long log** (`documents.keepHistory`, default: forever). It is the catch-up source
  for devices that trimmed, and the deep archive (RFC-0015 §5).

### 7.2 Opaque (no adapter, sealed partitions, pure custody)

A Cloudflare Durable Object relay, a custody-only `createServer`, or any **sealed** partition
(v3 §11: a judge that cannot read) is opaque. Opaque is chosen automatically, with a boot notice,
when no adapter is configured, and it is forced for sealed partitions.

- It stores and relays doc changes and blobs exactly like any event. The long log applies here
  too.
- Its column holds the **latest device-produced `DocCheckpoint`**. Devices with the adapter
  publish one after materialising, rate-limited per doc (`checkpointEvery`, default 5 min of
  change). The authority stores the snapshot blob, writes it to the column and the derived values
  to their columns, and records `doc_heads.mode = 'checkpoint'` with the checkpoint's `covers`.
- SQL over an opaque column is **honestly behind**. `doc_heads.covers` versus the log head says by
  how much, and a query that selects `docStateOf(tables.notes.content)` gets
  `{ mode, behindBy }`, the column sibling of `syncOf`.
- A checkpoint is accepted only from a device whose grant allows `update` on the row (§11). Its
  `covers` must not exceed what the authority holds, so a device cannot claim changes the
  authority has not seen.

### 7.3 Who vouches for a snapshot

This is RFC-0019's question, per topology:

| Producer | Trust | Receiver |
|---|---|---|
| authority (materialising) | trusted, like its checkpoints and corrections | installs |
| device checkpoint via an opaque authority | provisional | installs, marks `provisional`; a device with the adapter that later holds the covered log re-derives `version` and compares — a mismatch drops the snapshot and refetches the tail |
| peer in a pure mesh | provisional | same |

The long log on the authority is what makes provisional snapshots auditable. That is one more
reason it stays long.

## 8 · Device behaviour

### 8.1 Offline and online are the same path

A device edits, flushes and appends locally. The events wait in the outbox like any write and
leave when a link appears (v3 §9: direct, bridged or courier). Received doc changes fold into
`doc_log` whether or not the doc is open.

### 8.2 Materialising on a device

- **Open docs** apply remote tails immediately (`apply` → `changed` → `doc.subscribe` fires).
- **Closed docs** cost nothing on receipt. The tail accumulates. A background tick materialises a
  closed doc once its tail passes `snapshotEvery` (default 200 updates or 256 KiB), or on open.
- **Snapshot policy**, per doc: tail ≥ 200 updates, or tail ≥ 256 KiB, or 5 s idle after a
  change, or `close()`. Derived columns of an open doc update with every flush (§6.3), so
  read-your-own-writes holds for `title` in the same tick.

### 8.3 Trimming

Doc changes live in events, so trimming **is** RFC-0015 compaction with one more clamp. An event
is compactable only when all of these hold:

1. RFC-0015's ack floor and `keepAtLeastDays` hold for it.
2. Every doc change in it is `covered` by a **persisted** column snapshot (extends
   `clampToPersisted`).
3. It is not among this principal's last `undoDepth` actions. Undo needs those updates (§9).

Snapshots on a device are **shallow at the stable floor**: the doc version that every known
writer of the partition has acknowledged, computed from the same ack maps compaction uses. Below
it, no concurrent update can still arrive from a known peer. A **forgotten** peer (D15) that
returns with updates concurrent to trimmed history cannot import them on a shallow replica. It
is treated exactly as RFC-0015 §2a treats a forgotten peer: its updates still fold and forward,
and the doc marks them `failed`. The authority (full history) materialises them, and the device
installs the authority's next checkpoint. `snapshotMode: "full"` is available for apps that
prefer bytes over this edge.

### 8.4 Catch-up and cold join

Catch-up is the ordinary exchange. A doc's backlog is imported in one batch. A cold joiner takes
RFC-0019 snapshot pages, where each doc column arrives as a `DocCheckpoint` (the snapshot blob is
fetched on the bulk profile, preferring Wi-Fi/relay), then the tail above `covers`.
`DocRef.status` is `"behind"` until the blob lands. A hot tier may leave cold docs' blobs unfetched
until first `open()`, which is RFC-0019 §3's window rule applied to documents.

## 9 · Undo and history across rows and documents

- **An action** is a 16-byte id carried on every event it produced (key 10). One action can span
  several events (a typing burst, an agent run) and any mix of rows and docs.
- **`undo(action)`** writes **one** event in a new action, with `undoOf` = the action:
  - **Rows:** compensate only the cells that still hold the action's write, that is, where the
    cell's stamp is the action's stamp. Restore each such cell's value from before the action.
    A cell someone changed since stays as they left it, and the result reports it as
    `skipped: superseded`. This is licnep's `VariablesDelta` rule, made general, and it replaces
    today's whole-row `invert` (`engine/src/undo.ts`), which would clobber concurrent edits.
    Rows the action inserted are deleted. Rows it deleted are re-inserted from their pre-action
    record.
  - **Docs:** `compensating_update(doc, action's updates)` for each doc the action touched, on
    the winning lineage. A `replace()` in the action is undone by a new genesis carrying the
    previous lineage's snapshot. That is a forward write, with no history surgery.
- **Redo** is `undo(undoAction)`. The undo stack is local and per principal. The history is
  shared.
- **`history(table, key)`** extends today's `rowHistory` (`client/src/history.ts`). Doc updates
  appear as revisions `{ kind: "doc", column, lineage, action, undoOf, at, by, size }`.
  `openAt(revision)` gives a read-only doc at that version (Loro `fork_at`) when the log still
  covers it. Otherwise it returns `HistoryUnavailable` with the sources tried (v3 §2).
- **Rust parity** ships in the same phase: `Mesh::history`, `Mesh::revert(Target::{Event, Action})`,
  `Mesh::actions()`. D37 left the Rust device without either.

## 10 · Unknown adapters, old builds, bad bytes

| Situation | What happens | Why it is safe |
|---|---|---|
| build predates this RFC (tag 6 unknown) | D22-A: the whole event parks as `unknown-kind`, row changes in it included; the cursor stops below it, delivery continues; upgrade replays | retained whole, never half-applied (RFC-0013) |
| build knows tag 6 but has no adapter for `loro@1` | folds (§6.4), appends `doc_log` with state `adapter-missing`, forwards, issues custody receipts; `open()` → `AdapterMissing { adapter }`; no local edits possible; column holds whatever checkpoint it installed | the fold is adapter-independent, so digests and parked sets agree with adapter-holding peers |
| `adapter` in the change ≠ the schema's declaration for that column | admission refuses → quarantine `refused` | decided from the schema alone: identical on every peer at one schema version |
| genesis whose lineage ≠ the derivation (§5.3) | refused → quarantine | the check needs only the event |
| adapter cannot parse an update | materialisation marks that `doc_log` row `failed`; the doc stays usable at its last good version; loud in `$inspect` | the fold already happened identically; this only affects materialisation, which is local |
| minor version skew (`loro-crdt` 1.4 vs 1.16) | allowed: the id's major (`@1`) is the compatibility contract; the adapter package pins a floor and runs the adapter conformance suite (§13) | Loro's own 1.x encoding stability |

A hostile update from a valid author (for example "delete everything") is taxonomy B10: undo it,
revoke the grant. Adapters must be **total** and bounded. There is a max update size, a
decompression cap and a time budget, and exceeding them is a `failed` update, never a crash.

## 11 · Access control

- **A doc inherits its row's partition and policy.** A doc change is an `update` of that row for
  the `allow` ladder, with a patch naming the column. It is evaluated at the fold with the row
  state, on every peer, exactly like a cell update (RFC-0008). A doc change on a row being
  inserted in the same event is judged as part of the `insert`.
- **Read** follows custody: doc changes travel only inside the row's partition, like its row
  events. There is no separate document ACL, and nothing narrower than a partition (v3 §4).
- A doc change on a row that does not exist (and is not inserted in the same event) is parked
  `missing-dependency`, as any update of an unknown row is today.
- `DocCheckpoint`s are accepted only from the authority or from a device whose grant allows
  `update` on the row. Blob fetches of doc bytes require custody of the partition (D30's blob
  capability).
- **Sealed partitions:** doc bytes are inside the sealed core, the authority is structurally
  opaque (§7.2), and checkpoints are sealed to the partition key.
- An **open question** (§16) is whether `replace()` deserves its own rule
  (`allow: { replace: role("owner") }`). It is the one doc operation that can discard others'
  work.

## 12 · Schema evolution (RFC-0013)

| Change | Verdict |
|---|---|
| add a doc column | fine — existing rows are the empty root lineage; the SQL column is nullable |
| add or change a `derive` | fine — derived values never travel; the materialiser recomputes on the next tick |
| turn an `lww` column into a doc column | **refused** (repurposing). Add a new doc column; the authority fills it once with `replace()` from the old value (upcasters are pure over changes and cannot mint adapter bytes deterministically) |
| move a column to another adapter or major (`loro@1` → `loro@2`, `automerge@3`) | **refused**: a new column + authority `replace()` job, same as above |
| drop a doc column | park like any column: stop writing, keep the log until the compaction floor passes it |
| rename a doc column | only with an upcaster rewriting `data.0` (column) — pure, allowed |

Tag 6 and keys 10/11 are additive and need no `v` bump. `schemaVersion` (key 9) gates doc
columns like any column. `fromDrizzle` already maps pg `bytea` → `blob` and Drizzle 1.0 SQLite
`blob()` without a mode → `json`. The binary check reads those same frozen kinds.

## 13 · Conformance and cross-runtime tests

- **Frozen vectors** `conformance/doc-vectors.json`, generated in TypeScript and reproduced byte
  for byte in `syncmesh-core`:
  - doc changes (inline, blob ref, genesis)
  - the lineage derivation
  - events carrying `action`/`undoOf`
  - a `DocCheckpoint` core + signature
  - a v=1 vector re-verified to prove the new keys did not disturb it
- **Adapter conformance suite**: `@syncmesh/documents/testing` and
  `syncmesh_client::docs::testing`, run by every adapter in both runtimes:
  - every permutation and batching of an update set → one `version` and identical derived values
  - `snapshot + tail ≡ all updates`, with shallow and full snapshots
  - `compensating_update` undoes exactly its action while a concurrent edit by another replica
    survives (the risky one for Loro's `diff`/`apply_diff`, so it gets property tests)
  - `apply` is total on fuzzed bytes
  - replica ids never collide across incarnations
- **Engine properties**: two engines, one with the adapter and one without, fold the same events
  → equal row digests, equal doc digests, equal parked sets (D22's rule). Compaction stays
  unobservable (RFC-0015 T5) with docs present.
- **Cross-runtime**: extend `tests/interop.rs`. A TypeScript client (`loro-crdt` wasm) and a Rust
  device (`loro`) edit one document through the TypeScript relay and the Rust room, offline and
  online, and converge on identical text.
- **Authority**: materialising Postgres (pglite in tests) vs opaque DO relay. SQL over derived
  columns is right and fresh in one, and honestly behind (`docStateOf`) in the other.
- **Chaos**: two weeks offline plus trim plus rejoin; blob bytes missing; an adapter-missing
  device in the middle of a chain forwarding everything; an old build parking tag 6; a forgotten
  peer returning below a shallow floor.
- **Budgets** (bench): flush ≤ 2 ms p95 for a 100 KB doc; 10k-update catch-up of one doc ≤ 500 ms
  on a laptop; column snapshot ≤ 2× the Loro snapshot of the same doc.

## 14 · Implementation plan

Each phase ends green on `vp check`, `vp test`, `cargo test` and `cargo clippy`. The phase does
not count as done until its listed tests exist.

| Phase | Scope | Packages / crates | Tests that close it |
|---|---|---|---|
| **P0 · Ground** | fix the presence overflow (§15); owner answers §16; reserve tag 6 and keys 9/10/11 in RFC-0002's tables | `syncmesh-client` (`presence.rs`, `mesh.rs`) | the regression test in §15; licnep drops its workaround |
| **P1 · Wire** | `Change` gains `doc` (TS kernel + Rust `event.rs`); codecs for `data`, keys 10/11, lineage derivation, `DocCheckpoint` | `@syncmesh/kernel`, `@syncmesh/wire`, `syncmesh-core` (`event_codec.rs`, new `doc.rs`, `checkpoint.rs`) | `doc-vectors.json` in both runtimes; fuzz (500 garbage, 300 bit-flips) with doc changes; old-build simulation parks tag 6 |
| **P2 · Fold and log, no adapter** | lineage LWW cell; `doc_log`/`doc_heads` (Drizzle 1.0 declarations + migrations, SQLite and Postgres; Rust `sqlite.rs`); validation (§10/§11); digest split; compaction clamp (§8.3) — the `adapter-missing` mode is the first working mode | `@syncmesh/engine`, `@syncmesh/storage` (+ `driver-tests/docs.ts`), `@syncmesh/schema` (`ColumnDef.doc`, binary check), `syncmesh-client` (`engine.rs`, `store.rs`, `sqlite.rs`) | driver tests on both dialects; DDL ≡ Drizzle declaration; compaction unobservable with docs; digests equal across two engines; construction-error table of §4.1 |
| **P3 · Adapters** | the SPI (TS + Rust), registry, lazy load, replica ids; `@syncmesh/loro` and `syncmesh-loro`; the conformance suite | new `@syncmesh/documents`, `@syncmesh/loro` (peer: `loro-crdt@^1`), `syncmesh-client::docs`, new crate `syncmesh-loro` (`loro = "1"`, re-exported) | the adapter suite green in both runtimes, including the compensating-update property |
| **P4 · API** | `drizzleTable` `merge` adapter values + `derive`; `DocRef` in query-side tables; `open`/flush pacing/`subscribe`/invalidation; `ctx.docs` inside mutations; capture exclusion + guard triggers; `useDoc`; Rust `DocColumn`, `Mesh::docs()`; P4b `syncmesh-derive` | `@syncmesh/schema`, `@syncmesh/drizzle`, `@syncmesh/client`, `@syncmesh/react`, `syncmesh-client`, new `syncmesh-derive` | read-your-own-writes on derived columns; a raw write to a doc column refused on both dialects; an invalidated handle never exports; live queries do not re-run on doc-only edits |
| **P5 · Materialise** | device materialiser + snapshot policy + shallow floor; authority `materialise`/`opaque`; device checkpoints; RFC-0019 pages carry `DocCheckpoint`; `docStateOf` | `@syncmesh/documents`, server package, `@syncmesh/relay`, `adapters/cloudflare-do`, `syncmesh-client` (`room.rs` stores checkpoints) | crash between snapshot and heads; rejoin after trim; opaque SQL honestly behind; provisional snapshot mismatch detected and repaired |
| **P6 · Actions** | `$actions`, row compensation by stamp, doc compensation, `history()` with doc revisions, `openAt`; Rust parity | `@syncmesh/engine` (`undo.ts` rewritten), `@syncmesh/client`, `syncmesh-client` | undo after a concurrent remote edit keeps the remote edit (rows and docs); undo across two rows + one doc = one event; redo; history identical in TS and Rust for one log |
| **P7 · Interop and chaos** | cross-runtime doc convergence; chaos scenarios of §13; bench budgets | `tests/interop.rs`, `chaos/`, `bench/` | all §13 items |
| **P8 · licnep** | §14.1 | licnep `crates/sync`, `crates/app`, `crates/core` | licnep's `two_devices`, `delivery` and `live_tests` on the new path |

P2 before P3 is deliberate. The `adapter-missing` path is the one every relay and every
not-yet-upgraded device runs, so it is proven first, without any CRDT code in the loop.

### 14.1 · licnep's migration path

licnep consumes the Rust device (`syncmesh-client` pinned by git rev in `crates/sync/Cargo.toml`).
After P1–P6:

**Moves behind `syncmesh-loro` and the doc log (deleted from licnep):**

- the `doc_updates` table, `model::doc_update`, `INLINE_UPDATE_MAX`, and the `UpdateRef` inline/blob split
- `fetch.rs` (the blob fetch states and backoff) and `device.rs`'s grouping by `(artboard, lineage)`
  and `reoffer` of its own blobs (D18's author obligation now lives in syncmesh)
- the `lineage` cell on `artboards`, `HeldUpdates` and the rebuild-on-other-lineage logic in
  `editor/remote.rs`: syncmesh's lineage cell (§5.3) decides, and an HTML import becomes
  `replace()`
- `SyncBridge`'s per-artboard `sent`/`acked` cursors and "re-export from acked after restart"
  (`app/src/sync.rs`): the doc handle's flush ledger and `syncOf`-equivalent status replace them
- `VariablesDelta`-based "Undo this run" for the synced part: an agent run becomes one syncmesh
  action and `revert(Target::Action)` undoes frames and tokens together

**Stays in licnep:** `CrdtDocument` (its tree semantics over `LoroDoc`), in-doc ⌘Z through Loro's
`UndoManager`, all metadata tables as rows (pages, placement, tokens, variables, comments,
versions), presence, and `history/<id>.loro` on disk (written from the column snapshot, so the
project folder stays self-contained).

**Schema:** `artboards` gains `content: DocColumn<Loro>`, and the partition stays
`project:<sync_id>`. Loro's peer id must come from syncmesh's replica id (§4.5). `CrdtDocument`
takes it at open instead of choosing its own.

**Order of the switch:**

1. Ship the new build reading and writing both. It writes doc changes. It still **reads**
   legacy `doc_updates` rows and imports them into the doc (re-authored by the reading device as
   root-lineage doc changes, flagged `procedure: "licnep.migrate"`).
2. Migration per artboard, once per device on first open. Export the room-winning lineage's full
   history (`export_all_updates`) as root-lineage doc changes. Two devices migrating the same
   artboard is harmless: Loro import is idempotent by op id, so duplicates merge to nothing. A
   device holding a *different* lineage first rebuilds from the room (today's behaviour), then
   migrates.
3. When `$status` shows every device on the new build (or after an owner-chosen window), one
   device tombstones the legacy `doc_updates` rows and the `lineage` cells. Compaction reclaims
   them.
4. Remove the legacy readers and delete the modules listed above. licnep's tests
   (`tests/two_devices.rs` "documents both ways", `tests/delivery.rs` blob cases, `sync::live_tests`)
   are re-pointed at doc columns and must pass unchanged in intent.

## 15 · Known issue: presence re-announce overflows on link return

**Found by** licnep's sync agent (`crates/sync/src/device.rs` documents the workaround).

**Where:** `syncmesh-client/src/mesh.rs`, `pump`, on `LinkEvent::Online(true)`:

```rust
let wires: Vec<Vec<u8>> = { let mut tier = lock(&presence); tier.heartbeats_due(i64::MAX) };
```

`PresenceTier::heartbeats_due(now_ms)` treats its argument as the clock. It sets
`held.last_ms = now_ms` and `publish` computes `expires_ms: now_ms + ttl_ms`
(`presence.rs:464`). With `i64::MAX` that addition **overflows**:

- **Debug builds** panic inside the pump task, and the device ends. This is why licnep holds no
  presence while offline.
- **Release builds** wrap. The re-announced value has a negative expiry, so it is dead on arrival
  locally and at every peer. `last_ms = i64::MAX` also makes `due_ms()` (`last_ms + interval`)
  wrap, so the next tick heartbeats again. Presence silently vanishes until the next regular
  heartbeat.

**Fix (P0):**

1. Add `PresenceTier::announce_all(now_ms) -> Vec<Vec<u8>>`. It re-signs every held value at
   the **real** clock and resets `last_ms = now_ms`, independent of whether a heartbeat is due.
   `pump` calls `tier.announce_all(now_ms())`. The intent was "everything, now", and a sentinel
   clock was the wrong way to say it.
2. Make `due_ms` and `expires_ms` use `saturating_add`, so no caller-supplied instant can
   overflow again.
3. Tests:
   - `announce_on_link_return_uses_the_clock`: set a value while offline, bring the link up, and
     the frame's expiry is `now + ttl`. This test panics on today's code in debug.
   - a `tests/mesh.rs` case where the peer sees a presence value set before the link came up.
   - a unit test that `heartbeats_due(i64::MAX)` no longer panics.
4. Then licnep removes its "publish only while online" workaround and bumps the pinned rev.

## 16 · Open decisions for the owner

1. **Lineage rule.** Root lineage by default, `replace()` = new lineage, winner by greatest
   genesis stamp (LWW, as proposed). The alternative is first-genesis-wins for imports, which
   stops a late `replace()` from discarding a colleague's edits.
2. **`replace()` permission.** A separate `allow.replace` rule, or the row's `update` rule (as
   proposed)?
3. **Row undo semantics.** Compensate only cells still holding the action's stamp (proposed,
   licnep's `VariablesDelta` rule), replacing today's whole-row `invert`. Is that acceptable as a
   behaviour change to `revert(eventId)`?
4. **Derived columns never travel** (proposed; each replica computes, opaque hosts take them from
   checkpoints). The alternative is authority-signed row updates, which work for adapter-less
   devices but put materialisation into the log.
5. **Device snapshots shallow at the stable floor** (smaller, with the forgotten-peer edge of
   §8.3), or full history always (simpler, larger)?
6. **Opaque-mode trust.** Accept device checkpoints provisionally with later audit (proposed), or
   require a materialising authority for any partition with doc columns?
7. **Numbers.** Tag 6, event keys 10/11 (9 reserved for `schemaVersion`), 64 KiB inline threshold
   (licnep uses 256 KiB), 300/1000 ms flush pacing.
8. **Package shape.** A new `@syncmesh/documents` + `syncmesh-client::docs` (proposed) versus
   folding the SPI into `client`. Is a `syncmesh-derive` macro wanted, or is a builder enough?
9. **`counter`** exists in Rust and the v3 surface but not in the TypeScript kernel since D25. It
   is not blocking, but the "row rules" list in this RFC should match one truth.

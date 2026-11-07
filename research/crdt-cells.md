# A CRDT inside a cell: what the extension would be, and what it is not

Status: **research, with a proposed API.** Nothing here is built. The decision it feeds is D38
(draft). Read 2026-09-29 against the kernel at `5cb3b13` and the four libraries named below.

## 1 · Where the repo stands

D04 chose field-level last-writer-wins and left one door open: *revisit full CRDTs only for
collaborative prose, as a separate column kind.* D25 then deleted the two cell lattices that had
been built ahead of a caller (`counter`, `set`), made `merge` an option on every column, and said
the thing that still holds: lists, tags and memberships are tables. The counter came back later
because inventory asked for it (book ch. 2), and it came back **without a wire tag**: an increment
travels as `{"+": n}` inside an ordinary `update`, a snapshot carries per-author totals, and the
kernel's `strategies.counter` joins them.

So the kernel today has four lattice joins and one change model:

| Seam | Where | What the counter does there |
|---|---|---|
| Declare | `packages/schema/src/column.ts` | `t.integer({ merge: "counter" })`; `MergeFor<T>` limits `max`/`min` to numbers |
| Capture | `packages/storage/src/capture.ts` `cells()` | the app wrote `SET stock = stock - 2`; OLD/NEW is the delta; the event carries `{"+": -2}` |
| Check | `packages/schema/src/check.ts` `acceptsCounter` | the two wire shapes, increment and totals, checked on every peer before the fold |
| Fold | `packages/kernel/src/strategy.ts` | per-author totals, join by per-author max; a lattice |
| Read | `packages/storage/src/projection.ts` | the app's table holds `counterValue(cell)`, the sum |

Those five seams are the whole shape of a merge kind. A text CRDT is the same five with the
library doing the arithmetic. That is the extension, and it is why this document is short on
kernel design and long on which library and which normal form.

Two constraints from later decisions bound the choice:

- **D35.** The Rust core owns "the four lattice joins" and is measured against frozen vectors. A
  fifth join that exists only in JavaScript breaks the promise that a Rust device folds the same
  bytes to the same state. Whatever merges a text cell needs one implementation that both the
  TypeScript and the Rust device can bind, or the kind is TypeScript-only and the Rust device
  must refuse the column.
- **RFC-0015.** Per-keystroke events are forbidden by economics. A text cell is written at a
  pace the app chooses; keystrokes between commits live in `$drafts`, which is local and
  unpromised (book ch. 8). One transaction is one event is one delta.

## 2 · What the field does

Every sync engine that stores a text CRDT beside relational rows does one of two things.

**Rows of updates.** PowerSync's Yjs demo and Electric's `y-electric` keep one table,
`document_updates(id, document_id, op bytea)`, one row per Yjs update, and rebuild the document on
the client by applying every row in any order. Compaction is "merge periodically" and left to a
scheduled function. The table converges because it is insert-only. Nothing in the engine knows
what an update is. This is the pattern D04 already recommends for everything that is not a
register: an append-only child table. **It works in syncmesh today with zero kernel change:**
`note_update { id: t.uuid().primaryKey(), note: t.uuid(), op: t.blob() }`, a client that folds
its rows into a doc, and a compaction that inserts one merged row and deletes the ones it
subsumes. Its costs are the ones the field reports: the body cannot be read by SQL, every reader
reconstructs, and row count grows until someone compacts.

**A typed cell.** Ditto's DQL has `REGISTER` (default, last-writer-wins), `COUNTER`, `MAP` and
`ATTACHMENT`, declared per field; strict mode requires the declaration, non-strict infers a
counter from the operation used. There is no text type. Automerge and Loro are the other
direction entirely: the document *is* the CRDT and there is no relational row. Nobody ships a
relational engine with a text CRDT as a column type that a plain `UPDATE` can write. That gap
is where syncmesh's capture is unusual: it already turns a plain SQL write into a typed delta for
`counter`, so a text column that does the same is one more branch in `cells()`, not a new write
path.

## 3 · The candidate libraries

Read from each project's current docs and release pages, 2026-09-29.

| | Yjs 13.6 / v14 rc | Automerge 3.4 | Loro 1.16 | Diamond types |
|---|---|---|---|---|
| Implementation | JavaScript reference; Yrs and y-octo are independent Rust renderings | Rust core; wasm for JS; UniFFI for Swift and Kotlin; `react-native-automerge` binds through JSI, no wasm under Hermes | Rust core; wasm for JS; Swift, Kotlin and Python bindings | Rust; `diamond-js` wasm wrapper; reference TypeScript port |
| One implementation everywhere | No. `cert-yjs` tracks three-way differences between Yjs, Yrs and y-octo | Yes | Yes | Yes, but a research library |
| Bundle, gzipped | ~18 KB | wasm, hundreds of KB | wasm, ~1 MB | wasm, small |
| Update = state | Yes. `mergeUpdates([a, b])` is a pure function on bytes; updates are commutative, associative, idempotent; deps are not required to merge | Changes carry deps; `applyChanges` holds a change with missing deps until they arrive | Ops carry deps; `import` reports pending ops; `export` does not emit what is pending | Ops carry deps |
| Compaction | `mergeUpdates` dedups but does not garbage-collect deleted content; a `Y.Doc` load does | `save()` is a compacted snapshot | `shallow-snapshot` drops history before a frontier | Eg-walker keeps the graph small by design |
| Rich text | `Y.Text` attributes, Quill delta shaped | Marks | Peritext plus Fugue | Plain text |
| Editor bindings | ProseMirror, CodeMirror, Tiptap, Lexical, Quill: the ecosystem | ProseMirror, CodeMirror | ProseMirror, CodeMirror, ProseKit | none maintained |
| Peer identity | 53-bit `clientID` | actor id, hex string of any length | 64-bit `PeerID` | 64-bit agent |
| Recent convergence bugs | — | — | #1163 (2026-09-28): an insert concurrent with a delete baked into an imported snapshot lands at the wrong position in loro.js | — |

Three things fall out.

**Yjs is the wrong core for D35 and the right update format.** Its update is the only one that
merges as pure bytes with no doc and no dependency check. That is exactly the normal form a
kernel wants. But the reference is JavaScript, the Rust ports are ports, and a project exists
because they disagree. A Rust device folding a Yjs cell folds a different implementation from the
phone beside it.

**Automerge and Loro are one Rust implementation everywhere**, which is what D35 asks for, and
both bind to Swift and Kotlin the way syncmesh's own core will. Both need a doc to merge, both
hold ops with missing deps *outside* what they export, and Loro's peer id is 64 bits where
syncmesh's is an Ed25519 key. The first two are the kernel's problem and the third is a hash.

**Automerge 3 removed its memory problem** (Moby Dick 700 MB to 1.3 MB) and made strings
collaborative by default; the file format is unchanged from 2. Loro has the richer text model and
the shallow snapshot, and a fresh, open convergence bug in the exact case a relational engine
produces (a peer joins from a snapshot, then folds an older concurrent delta).

## 4 · The normal form, which is the actual design

A counter cell's normal form is `{p, n}` and a lattice because each author's totals only grow.
A text cell needs the same property: a value that any two peers can join by a pure function on
what they hold, with no library state outside the cell.

The engine delivers each author's events in order (holdback plus dedup), and across authors in
any order. A delta from A may depend on ops from B that this device has not seen. Yjs does not
care. Automerge and Loro hold such an op as pending and will not export it, so a join that is
"import both, export snapshot" **loses the pending op** the moment the cell is re-encoded, and the
device converges on a state missing a write it acknowledged. The normal form has to carry the
hole:

```
state = { snapshot: bytes, pending: readonly bytes[] }
```

`join(a, b)`: import `a.snapshot`, `b.snapshot`, every pending op of both; whatever the library
reports as still pending stays in `pending`; export the rest as `snapshot`. Idempotent because
importing a known op is a no-op; commutative and associative because the library's own merge is;
bounded because `pending` only holds ops whose author has a hole, and the engine's own quarantine
already bounds that. For Yjs the same shape degenerates to `pending = []` always.

The **increment** shape is a delta: the bytes one transaction added, exported from the author's
own version before the write. The **totals** shape is the normal form. Same two shapes the counter
has, same `check` structure: a peer accepts a delta or a normal form and refuses anything else.

## 5 · The proposed API

One rule first: **the kernel imports no library.** `@syncmesh/kernel` depends on `result` and
`temporal` and nothing else, and D35 wants its joins vectored. A kind is *injected* through the
schema, from an adapter package that is the only place the library is imported, exactly as a
SQLite binding is (`adapters/`, one runtime binding each).

### Kernel: a merge kind is a named lattice over bytes

```ts
// @syncmesh/kernel
export interface MergeKind<App> {
  /** Names the lattice in the manifest and in error text; never on the wire. `"loro-text"`. */
  readonly name: string;
  /** The cell nobody has written. */
  readonly empty: Uint8Array;
  /** The lattice join over normal forms and deltas alike. Pure, total, never throws. */
  readonly join: (incoming: Uint8Array, current: Uint8Array) => Uint8Array;
  /** What the app reads: the projection of a normal form. */
  readonly read: (state: Uint8Array) => App;
  /** The delta one write is: `next` diffed against `state`, authored by `peer`. */
  readonly edit: (state: Uint8Array, next: App, peer: PeerId) => Uint8Array;
  /** Whether foreign bytes are a delta or a normal form this kind can fold; the `check` seam. */
  readonly accepts: (value: Uint8Array) => boolean;
}

export type MergeSpec = ReadonlyMap<TableName, ReadonlyMap<ColumnName, StrategyName | MergeKind<unknown>>>;
```

`applyChange` looks the strategy up as it does today; a `MergeKind` is used as `(incoming,
current) => ({ value: kind.join(incoming.value, current?.value ?? kind.empty), stamp })` with the
stamp joined by max as every strategy does. The stamp is still needed: `writeStamp` and the
row's visibility do not change.

### Schema: the kind is the `merge` option, and the value type is the kind's

```ts
// @syncmesh/schema
export interface ColumnOptions<T> {
  readonly merge?: MergeFor<T> | MergeKind<T>;
}

// the app
import { loroText } from "@syncmesh/crdt-loro";
body: t.text({ merge: loroText }),
```

`MergeFor<T>` keeps `max`/`min` on numbers. A `MergeKind<T>` is accepted on a column whose app
type is `T`, so `loroText` (`MergeKind<string>`) goes on `t.text()` and a future `loroJson`
would go on `t.json()`. `table()` panics on a kind whose `name` two columns spell differently
with different objects, and `defineSchema` panics on a kind object that lacks any of the five
members: a fleet is consistent by construction, because the manifest that ships names the kind.

### Capture: one more branch in `cells()`

The counter branch reads OLD/NEW from the trigger image. A text kind needs the *state*, which is
not in the app's table (the table holds the projection, a string). The writer already has
`before: StateLookup` over the engine's state; capture takes the state cell for the column,
calls `kind.edit(state, newText, peerId)`, and the event carries the delta as a `blob` cell inside
an ordinary `update`. No new change kind, no wire tag, no D22 involvement. A row inserted with a
body carries `kind.edit(kind.empty, body, peer)`.

### Check: the kind says what it accepts

`checkValue` gains the same branch `counter` has: when `column.def.merge` is a kind, the value
must be bytes and `kind.accepts(value)` must hold. Everything else about the column stays
`text`.

### Read: the projection calls `read`

`projection.ts` already special-cases counter to `counterValue(held)`. A kind projects with
`kind.read(held)`. `useLiveQuery(api.notes.get(id))` sees a string and never learns there was a
CRDT. The one thing this does not give is an editor binding: ProseMirror wants the live doc, not
a string. That is a later `mesh.$doc(table, key, column)` and is out of scope here on purpose;
the pace of commits and the draft in between are the app's.

### The adapter package

```
adapters/crdt-loro/          @syncmesh/crdt-loro   exports loroText, later loroJson
adapters/crdt-automerge/     if Loro's open bug stands
```

Each exports kinds and nothing else, holds the one library import, maps `PeerId` to the
library's peer identity by a fixed hash, and ships frozen vectors under `conformance/` for its
join so the Rust device (D35) can bind the same crate and prove the same bytes.

## 6 · What this costs, honestly

- **A wasm library in every folding peer.** Loro is about 1 MB gzipped; Automerge is smaller but
  not small. The relay does not fold and needs neither. Every device and the authority do.
- **D04-D is still rejected.** This is not "custom resolver functions". A kind is named,
  versioned by the manifest, vectored, and one implementation everywhere. A function the app
  writes is not admitted, for the reason D04 gave: an impurity that is stable here and different
  there fails silently.
- **Library version skew is the real D04 risk.** Loro #1163 is a convergence bug between two
  correct-looking builds. A kind's `join` must be vectored (`conformance/crdt-<name>.json`) and
  the library pinned by the adapter, and a bug like that one is a vector regression before it is
  a field report.
- **Key rotation.** `stranded.ts` explains why per-author lattices cannot be re-signed under a
  new key. A text cell is per-author by construction; a stranded run of text deltas is stranded
  for the same reason the counter's is.
- **Compaction is the kind's.** The normal form can be re-exported as a shallow snapshot by any
  peer at any time, because a snapshot that contains an op joins with that op to itself. No
  causal stability frontier is needed, which is what D25 said the `set` cell could not do.

## 7 · Recommendation

- **Now, for any app that needs prose today:** the append-only update table (§2). It is
  D04's own answer, it converges, and it needs no code in this repo.
- **The extension, if a use case in `plan/use-cases.md` asks for collaborative prose:** the
  `MergeKind` API above, with **Automerge 3** as the first adapter unless Loro #1163 is closed
  and vectored, because both are one Rust implementation everywhere and Automerge has no open
  bug in the snapshot-then-older-delta case that a relational fold produces constantly. Yjs is
  ruled out as a *kernel* kind by D35 and stays the right answer for the update-table pattern,
  where nothing folds it but the app.
- **Not now:** an editor binding, rich text marks, a JSON kind. Each is a kind or a method on
  one, and none has a caller.

## Sources

- Loro: [API reference](https://loro.dev/docs/api/js), [Export modes](https://www.loro.dev/docs/tutorial/encoding), [Import status](https://loro.dev/docs/concepts/import_status), [releases](https://github.com/loro-dev/loro/releases), [issue #1163](https://github.com/loro-dev/loro/issues/1163), [issue #1155](https://github.com/loro-dev/loro/issues/1155), [bundle size](https://bundlephobia.com/package/loro-wasm)
- Automerge: [Automerge 3.0](https://automerge.org/blog/automerge-3/), [getChanges](https://automerge.org/automerge/api-docs/js/functions/getChanges.html), [applyChanges](https://automerge.org/automerge/api-docs/js/functions/applyChanges.html), [automerge-swift](https://github.com/automerge/automerge-swift), [react-native-automerge](https://github.com/automerge/react-native-automerge)
- Yjs: [Document updates](https://docs.yjs.dev/api/document-updates), [npm](https://www.npmjs.com/package/yjs), [cert-yjs three-way differences](https://github.com/iasakura/cert-yjs/issues/208)
- Eg-walker: [paper](https://arxiv.org/abs/2409.14252), [diamond-types](https://github.com/josephg/diamond-types), [diamond-js](https://github.com/josephg/diamond-js)
- Rows of updates: [PowerSync and Yjs](https://powersync.com/blog/postgres-and-yjs-crdt-collaborative-text-editing-using-powersync), [PowerSync CRDT docs](https://docs.powersync.com/client-sdks/advanced/crdts), [y-electric](https://github.com/electric-sql/electric/tree/main/packages/y-electric)
- Ditto: [DQL types](https://docs.ditto.live/dql/types-and-definitions), [strict mode](https://docs.ditto.live/dql/strict-mode)
- cr-sqlite: [crsql_changes](https://vlcn.io/docs/cr-sqlite/api-methods/crsql_changes)

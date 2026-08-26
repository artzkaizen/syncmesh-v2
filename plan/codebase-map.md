# syncmesh — codebase map

_As of 2026-08-26, commit `29dac35` (+ uncommitted: `packages/drizzle/` untracked; edits in `engine.ts`, `client/write.ts`)._
_All tests green: `vp run -r test` passes across every package (1 todo in `@syncmesh/drizzle`)._

## 0 · The one-paragraph picture

A local-first sync engine, built by hand as a bun workspace. Pure runtime-neutral packages under `packages/` (lint-enforced: no `bun:`/`node:`/DOM), one runtime binding each under `adapters/`. The core loop: an app write is **captured** (either through the recording `Tx` of a collection/`tx()`, or D20-style from real SQL via triggers) → validated (schema → partition → policy ladder) → stamped with an HLC + per-peer sequence number → appended to the **event log** (the log *is* the outbox) → **folded** into materialized state (kernel `applyChange`, a commutative/associative/idempotent join) → one `FoldBatch` notification drives live queries. Peers converge by cursor exchange (`generateSyncMessage`/`receiveSyncMessage` — pure function pairs) over any `Transport`; events travel as signed CBOR envelopes `[core, sig]` (Ed25519, canonical encoding frozen by conformance vectors). Grants (server-signed device→account statements) are the identity layer; policy is a JSON AST evaluated identically on every peer.

## 1 · Layout & status

```
packages/   result ✓  temporal ✓  kernel ✓  wire ✓  policy ✓  schema ✓
            engine ✓  storage ✓  transport ✓  client ✓  orpc ✓  drizzle (untracked, WIP)
adapters/   sqlite-bun ✓  sqlite-node ✓
tooling/    config ✓  create-package ✓  verify-node-consumer ✓
plan/       epics E00–E26, decisions D01–D20, serve.ts (port 4400)
research/   API.md, 21 RFCs, prior-art reads — reference, not the plan
conformance/  bench/  — present (contents mapped in §12)
```

LOC (src, excl. tests): storage 2044 · client 1711 · engine 1553 · schema 1119 · wire 840 · transport 740 · kernel 516 · policy 333 · orpc 72 · adapters 66 each. Tests: ~50 files, all passing.

### Dependency graph (workspace deps, arrows = depends on)

```
result ← temporal            (leaves; result = better-result re-export, temporal = polyfill pin)
kernel ← result, temporal
policy ← kernel, result
wire   ← kernel, result, temporal        (+ @noble/ed25519, @noble/hashes)
schema ← kernel, policy, result, temporal (drizzle-orm optional peer)
engine ← kernel, policy, schema, temporal, wire, result
storage ← engine, kernel, policy, schema, temporal, wire
transport ← engine, kernel, schema, temporal, wire
client ← engine, kernel, policy, schema, storage, temporal, transport, wire, sqlite-bun, sqlite-node
orpc  ← client, kernel, schema           (+ @orpc/server peer)
drizzle ← client, engine, kernel, policy, schema, storage  (+ drizzle-orm peer)
adapters/sqlite-{bun,node} ← engine, storage
```

Client dynamically imports the sqlite adapters per-platform for its durable-by-default store.

---

## 2 · kernel — the pure conflict-free core

Types: `Brand<T,Tag>`, `Ordering`. All identifiers are brands with parse fns:
- `PeerId` — 64 lowercase hex chars (the Ed25519 public key). `parsePeerId`, `PEER_ID_HEX`.
- `PartitionKey` — `kind:id` (`/^[a-z][a-z0-9_]{0,63}:[^\s:]{1,255}$/`). `parsePartitionKey`.
- `EventId` — `${peerId}-${seq}` or `${peerId}-L${seq}` (local scope). `eventId()`, `parseEventId` → `{peerId, seqNum, local}`.
- `SeqNum` (positive safe int), `TableName`, `RowKey`, `ColumnName`, `Procedure`, `Logical`.

**HLC** (`hlc.ts`): `Hlc = [Temporal.Instant, Logical]`. `createHlcClock({now, maxDrift?})` → `{tick, receive, last}`. tick never regresses (logical bump when wall clock goes back); receive clamps remote to `now+maxDrift`, adopts only if greater. `compareHlc`, `Stamp = {hlc, peer}`, `compareStamp` (hlc then peer lexicographic — global total order).

**Data model**:
```ts
SyncEvent { v:1, id, peerId, seqNum, hlc, procedure, partition?, changes: Change[], local?: true }
Change = insert{table,key,row} | update{table,key,patch} | delete{table,key}   // Row = Map<ColumnName, CellValue>
CellValue = JsonValue | Uint8Array
RowRecord { cells: Map<ColumnName, {value, stamp}>, writeStamp?, deleteStamp?, partition? }
State = Map<TableName, Map<RowKey, RowRecord>>
```

**Merge** (`apply.ts`, `strategy.ts`): `applyChange(state, change, stamp, merge?, partition?)` — insert and update are both column-wise merges (insert doesn't clear absent columns); delete is a pure tombstone (`deleteStamp`), never removed; row visible iff `writeStamp > deleteStamp` strictly (`isVisible`). Every field is a max-join ⇒ commutative/associative/idempotent (fast-check verified). **A row's partition is fixed by its first write, forever.** Strategies per column via `MergeSpec = Map<table, Map<column, "lww"|"max"|"min">>`; `max`/`min` pick by value with lww fallback on tie; `compareValue` panics on json/blob (definition error). Reads: `readRow`/`readRows`/`readRowsIn(partition)` hide tombstones; `getRecord` is raw.

No listeners anywhere — kernel/temporal/result are pure. Injection seams: `now`, `maxDrift`, `MergeSpec`.

**temporal**: re-exports `Temporal` from `temporal-polyfill/implementation` (never the runtime global — identical arithmetic everywhere) + `addToInstant` (UTC-day-aware). **result**: better-result re-export (`Result`, `TaggedError`, `panic`…) + `unreachable`.

---

## 3 · wire — canonical bytes, identity, grants

- `hex.ts`: `hexToBytes` (lowercase, even length) / `bytesToHex` / `bytesEqual`.
- `cbor.ts` + `cbor-decode.ts`: canonical writer (shortest heads, sorted keys) and strict reader (no tags/indefinite/trailing; returns `Result`, never throws). `CborValue`, guards in `cbor-guards.ts`.
- `identity.ts`: `createIdentity(seed32)` → `Identity {peerId, publicKey, sign}` — **peerId is the hex public key**. `verify()` never throws.
- `event-codec.ts`: `encodeEventCore`/`decodeEventCore`. Core = CBOR map, int keys: 0 v, 1 peerId(bytes), 2 seq, 3 hlc `[ms, logical]`, 5 procedure, 6 partition (omitted if absent), 7 changes (change map: 0 kind 0/1/2, 1 table, 2 key, 3 row-or-null). Unknown keys ignored; v≠1 refused.
- `envelope.ts`: `[core, sig]` CBOR array. `signEvent(event, identity)` → `VerifiedEvent {event, wire, core, sig}`; `decodeAndVerify(wire)` verifies against the *received* core bytes and keeps them, so relays forward exact bytes. `WireError = MalformedCbor|MalformedEnvelope|MalformedEvent|BadSignature`.
- `grant.ts`: `Grant {v, account, device: PeerId, role?, partitions, issuedAt, expiresAt, claims}`. `issueGrant(issuer, request)` → wire bytes; `verifyGrant(wire, issuer, now)`. Same envelope shape.
- `grant-registry.ts`: `createGrantRegistry({issuer, now})` → `{register, grantFor, wireFor, allWires, onRegistered(listener)→unsub, revoke}`. Newest `issuedAt` wins; expiry filtered at read; revoke local-only (E21 pending). **`onRegistered` is a devtools-relevant seam.**

---

## 4 · schema — the manifest

- `column.ts`: builder `t` (`text/integer/float/boolean/timestamp/blob/uuid/json`), modifiers `nullable/primaryKey/unique/check(StandardSchemaV1)/onConflict(strategy)` — all data (`ColumnDef`), type-level erasure of illegal combos (pk can't be nullable; max/min only on numbers).
- `table.ts`: `table(name, columns)` → `Table {name, columns, primaryKey, columnNames}`; panics at module load on bad defs (≠1 pk, pk not text/uuid/integer…). `checkRow(table, row, "insert"|"update")`, `rowKeyText`. `Row<T>`, `InsertRow<T>` (nullable → optional).
- `convert.ts`: app ↔ wire (`Temporal.Instant` ↔ epoch ms is the only real conversion); `fromWireRow` reads a missing column as `null` (D19); `withNulls`.
- `manifest.ts`: **`defineSchema({partitions: tree, roles: {kind: ladder}, tables: {name: {columns, partition, allow} | {columns, partition?: reserved} | {columns, visibility:"authority"}}})`** → `Schema {tables, entries: SchemaEntry[] (table+partition+visibility+evaluated AllowBlock), reserved, merge: MergeSpec, kinds (parents-first), parentOf, rolesFor}`. Reserved kinds `global|user|local`. Declared-kind tables **require** `allow`. `visibility:"authority"` forces global.
- `bind.ts`: typed combinators (`allow/deny/role/owner/claim().has/.equals/can/rowIs/patchOnly/anyOf/allOf/not`) — same runtime fns for every table, only types bind; reduced to a `PolicyNode` AST at define time.
- `reserved.ts`: `_policy {id, rules: json, version}`, `_corrections`.
- `from-drizzle.ts`: imports Drizzle columns via runtime symbols (drizzle-orm never a runtime dep); pinned kind mapping; panics on serial/numeric/generated; warns (`onWarn`) on unique/Date/defaults.
- `standard-schema.ts`: structural StandardSchemaV1 (zod etc. fit with no dep).

---

## 5 · policy — permissions as data

11 `PolicyNode` kinds: `allow, deny, role, owner, claimHas, claimEquals, claimIncludes, rowIs, patchOnly, any, all, not`. `AllowBlock {$default, read?, write?, insert?, update?, delete?, [custom]}`; `resolveAllow(block, op)` = `block[op] ?? block.write (for i/u/d) ?? block.$default`. `evaluate(node, ctx)` pure boolean — `ctx = {grant: {account, role?, claims}, roles: ladder senior-first, row?, patch?}`; patch wins over row for column lookups; bytes/arrays/objects never match. `parsePolicyDoc(json)` reverses (the `_policy` row format = `Record<table, AllowBlock>`). **No "why" seam — a verdict is a bare boolean.**

---

## 6 · engine — the fold, the log, the ladder

**Engine** (`createEngine(options)`, options `{peerId, clock, store, merge?, undoDepth?=0, validate?, stateStore?, boot?}`):

| API | Meaning |
|---|---|
| `mutate(procedure, tx=>…, {partition?, local?})` | record → validate → invert (undo) → tick → seq (re-reads store `lastSeq` — sibling tabs) → append → fold → persist → outbound. `Result<SyncEvent, MutateError>` |
| `receiveBatch/receive(entries)` | admit (own/dup/store-dup skip, validation → quarantine) → clock.receive → appendBatch → fold("remote") → `ReceiveReport {folded, skipped, quarantined}` |
| `state() / rowsIn(table, partition)` | current State / visible rows of one instance |
| `revert(id) / canRevert` | compensating event in the original's partition, from the undo window |
| `cursors() / coverage() / eventsSince(theirs)` | what we hold; what they lack |
| `acknowledge(peer, cursors, at) / acks() / onAcknowledge` | what peers were last known to hold (feeds delivered + compaction) |
| `compact(options)` | remove events every counted peer acked and state persisted |

**Observation seams (the devtools surface):**
- `onFoldBatch((batch: FoldBatch)=>…)` — exactly one per fold; `{source: local|remote|boot, eventCount, writeTables, writeKeys}` (writeKeys exact — live queries trust it)
- `onOutbound((event: SyncEvent)=>…)` — every synced own write (the outbox tap transports subscribe to)
- `onError((e: ListenerFailure|StoreFailure)=>…)` — a hook threw / state cache refused
- `onQuarantine(({event, reason: ValidationError})=>…)`
- `onTelemetry((e: TelemetryEvent)=>…)` — currently only `engine.mutate {changes}` and `engine.fold {events, keys}` with `Temporal.Duration`; **D17 (open) decides the full seam**; `timed()` helper
- `onAcknowledge((peer)=>…)`
- Hub mechanics: `createHub(onThrow?)` — a throwing listener is reported, never stops others.

**Uncommitted change in `engine.ts`:** `persist()` now emits `folds` *after* the state store commit (so D20 live queries re-reading SQL tables see the rows); boot folds emit directly.

**Ports:**
- `EventStore` — `append, appendBatch, has, all, allSince(cursors, scope), lastSeq(peer, scope), maxHlc, compactBelow(floor, scope, olderThan), compactedBelow`. `StoredEvent {event, sig?}` — relayed events keep their author's signature. `SeqScope = "synced"|"local"` (local events number in their own namespace). `createMemoryEventStore`.
- `StateStore` — `isEmpty, loadAll, loadCursors, commit(rows, coverage), clear`. `writeKeysOf/rowsFor/allRows` helpers. `StateCorrupt` → cleared + refolded, unless the log is compacted below it → boot fails ("rejoin from a peer").

**Boot** (`openEngine`): load cache (or clear-if-corrupt-and-uncompacted) → replay log tail since coverage (both scopes) → `clock.receive(maxHlc)` **before** any write can be numbered → construct → write back rows.

**Sync** (`sync.ts`, pure): `generateSyncMessage(state, doc) → [state, msg?]` and `receiveSyncMessage(state, msg) → [state, events]`. Cursors first; `inFlight` blocks a second batch until any reply; empty-diff sends a bare cursors ack (so a receive-only peer becomes ack-able) unless `lastSent` already covers. `coversCursors(have, want)`.

**Validation ladder** (`validate.ts`, first failure is the verdict): NoGrant → GrantDeviceMismatch → per change: UnknownTable → partition rules (LocalOnly / ReadOnlyPartition — global is authority-authorship, never a flag / WrongPartition / PartitionNotGranted) → row-keeps-birth-partition (WrongPartition) → SchemaViolation (checkRow; runs even ungranted) → PolicyDenied (evaluate; skipped ungranted or authority-visibility on a non-authority). `can(schema, principal, "table.op", row?, patch?)` — the same rule for UIs; no-allow tables: read free, user/local kinds writable.

**Compaction** (`compaction.ts`): refused without a state store; floor = min over live acks (∩ authors all acks know), clamped to persisted cursors, `keepAtLeast` age guard, `forgetPeersAfter` unpins silent peers.

**Undo** (`undo.ts`): `invert` per touched row (delete new rows, re-insert deleted, patch back exactly the touched columns, missing→null); `REVERT` procedure; revert-of-revert = redo.

**Link** (`link.ts`): in-process two-engine link — live forwarding via `onOutbound`, `catchUp()` loops the pure sync pair both ways until quiet, acknowledges on each message; `setOnline`, `flush`, `close`, `onError`.

**Suite** (`suite.ts`): `SuiteCase {name, run}`, `check`, `equal` — runner-agnostic; storage `driverTests(openDriver)` and transport `transportTests(connect)` are built on it (shipped acceptance suites).

---

## 7 · storage — SQLite behind a driver port

`SqliteDriver` port: `{run(sql, params?), all(sql, params?) → SqlRow[] (positional), transaction?, close?}` — every SQL statement lives above the port; a driver never has SQL of its own (RFC-0004).

- `schema.ts`: 3 migrations via `PRAGMA user_version`: `events (peer, seq, local, hlc_ms, hlc_logical, partition, core BLOB, sig BLOB, PK(peer,seq,local)) WITHOUT ROWID` + hlc index; `state_rows (tbl, key, record BLOB)`; `state_cursors (peer, local, seq)`; `compaction (peer, local, seq, hlc_ms, hlc_logical)`.
- `sqlite-event-store.ts`: the `EventStore` over that; events stored as encoded core blobs + columns for the query axes; `allSince` via `json_each` of a cursor JSON; compaction floors upserted with hlc-max logic.
- `sqlite-state-store.ts` + `record-codec.ts`: sidecar `state_rows` of encoded `RowRecord`s (+ optional projection).
- `capture.ts` (**D20 — change capture**): `tableDdl` creates real app tables (one col/schema col + `_partition`); `captureDdl` = `_syncmesh_changes` log + `_syncmesh_capture` guard row + 3 triggers per table logging before/after JSON images (blob as lowercase hex). `captureChanges(driver, tables, fn, {check?, partition?})` — one transaction, guard armed, app's own SQL runs, log → net-effect per row → kernel `Change[]`, `check` (validator) runs **before COMMIT** (refusal rolls back, carried out as itself via a `Refused` wrapper), inserted rows get `_partition` stamped post-guard.
- `projection.ts`: `tablesProjection` — the fold writes the app's real tables (so SQL reads see synced state).
- `read-filter.ts`: `compileRead(table, ladder, allow, principal)` → `Compiled {sql, params}` — a read rule as a SQL WHERE (the filter under every source).
- `open-stores.ts`: `openStores(driver, {tables?})` → `{events, state, close}` — installs capture + projection when tables given.
- `sql.ts`: `attempt`, `inTransaction` (one transaction at a time **per driver** via a WeakMap promise queue), cursor/hlc row decoding.
- `driver-tests/`: shipped acceptance suite (events, state, tables, compaction, read-filter, capture cases).

## 8 · transport

- `link.ts`: `FrameLink {send (MUST throw if the frame didn't leave), onFrame, close?}`; `loopbackPair()` with offline switch + injectable loss + flush.
- `frame.ts`: frame kinds — cursors, event, grant, grantRequest (CBOR).
- `bridge.ts`: one session over one link: grants first, then cursors, then events; per-author **holdback** buffer with gap rule (contiguous drain; overflow > gapLimit=512 → resync); `behind()` answers with cursors to request the diff; own events signed at egress, relayed events need their stored sig (`Unsendable` otherwise); `resync/requestGrant/sendGrant/onError/flush/close`.
- `transport.ts`: `Transport {name, start(ctx), whenReady (force-ready timeout — a dead network never wedges the mesh), stop, resync?, requestGrant?, onStatus?}`; `createFrameTransport({open(ctx, attach)})`; `linkTransport(name, pipe)` — the 20-line transport. `TransportContext = {engine, identity, grants, now?, onGrantRequest?}`.
- `transport-tests/`: shipped three-peer acceptance suite.

## 9 · client — the mesh

`createMesh({schema, identity, issuer?, store?, stateStore?, dataDir?=".syncmesh", undoDepth?, transports?, onGrantRequest?, authority?, issuerKey?, now?})` → `Result<Mesh, MeshOpenError>`. Durable by default (platform SQLite per identity under dataDir, dynamic import of sqlite-bun/-node); memory only ever explicit.

`Mesh` = one `Collection` per table (spread onto the mesh; name collisions panic) + base:
- **Collection**: `create/update/delete` (async, Result; update takes patch or draft-mutator; only changed cells written), `get/list/can/query` (sync; `query` returns a pure `QueryDescriptor`), `history(key)` → `Revision[]` (log replay in stamp order: `{at, by (account via grants), peerId, eventId, procedure, kind, changed, row}`). Plus internal `writes` (recording half for tx) and `visible` (the read-gate map).
- **`tx(fn, {label?})`** — records writes across collections, refuses `CrossPartitionTx` before anything is written, label defaults to deduped `"jobs.update+notes.insert"`, one `engine.mutate` → `TxReceipt {eventId}`.
- **Partitions**: `activate("kind:id")` (ambient, re-points collections + `rescanAll`), `active(kind)` (explicit or implied by a single-instance grant), `scoped(pins, {as?: Actor})` — views pinned to instances, cached by (pins, actor); `as` swaps `can` to the actor and sets `gated` (read-rule filters `visible`, writes pre-checked `PolicyDenied`).
- **Live queries**: `liveQuery(descriptor)` → `LiveHandle {data(), subscribe}` (limit is a window on the handle); registry shares identical descriptors (specKey; predicate `where` never shares), maintained incrementally from `FoldBatch.writeKeys` (binary-search insert/remove/move; invariant: equals a full re-run), at most one notification per query per batch; `releaseQuery`, `openQueries()`; `activate` → `rescanAll`.
- **`delivered({event?, to?})`** — resolves when a cursor exchange shows a peer holds the write (via `acks` + `onAcknowledge`); **`received({event})`** — inbound mirror (via `coverage` + `onFoldBatch`).
- **Grants**: `mesh.grants = GrantRegistry + issue(request)` (panics without `issuerKey`); `requestGrant(invite?)` over transports; `onGrantRequest` handler.
- **`can("table.op", row?)`**, `revert/canRevert`, `ready/running/stop`.
- **D20 writer** (`write.ts` + uncommitted diff): `createWriter({engine, validate, driver, tables, actor?, schema?})` → `write(label, fn, {partition?, local?})` — captureChanges around the app's own SQL; actor's `can` verdict per change (new) then validator, inside the transaction; replayed into `engine.mutate` as one event.

Errors: `NoActivePartition, UnknownPartitionKind, NoSuchRow, NoDefaultStore, CrossPartitionTx` + unions `WriteError/TxError/HistoryError/MeshRevertError`.

## 10 · orpc + drizzle (server side)

- **orpc** (72 lines): `withMesh(mesh)` — oRPC middleware: `{caller: {account, role?, claims?, pins}}` in → `{mesh: Scoped}` out (`mesh.scoped(pins, {as: caller})`); BAD_REQUEST on unresolvable pin; FORBIDDEN for handlers. The schema is the only permission model.
- **drizzle** (untracked WIP, 202 lines, test is a todo): `meshDrizzle({engine, validate, driver, schema, partition?, as?})` → `{db (drizzle sqlite-proxy over the mesh driver; single-statement writes auto-captured with `table.op` labels), read(table) (subquery with compiled read rule + partition pin), write(label, fn) (multi-statement capture), live(query) (re-runs on FoldBatch touching its tables, diffed by JSON)}`.

## 11 · Observability today (what devtools can hook)

| Seam | Where | Emits |
|---|---|---|
| `engine.onTelemetry` | engine | `engine.mutate {changes, duration}`, `engine.fold {events, keys, duration}` — only 2 variants so far |
| `engine.onFoldBatch` | engine | source, eventCount, writeTables, exact writeKeys |
| `engine.onOutbound` | engine | every synced own SyncEvent |
| `engine.onQuarantine` | engine | `{event, reason: ValidationError}` |
| `engine.onError` | engine | ListenerFailure / StoreFailure |
| `engine.onAcknowledge` + `acks()` | engine | peer ack'd cursors |
| `engine.coverage() / cursors() / state()` | engine | poll: what we hold |
| `bridge.onError` | transport | Unsendable / SendFailed / WireError |
| `transport.onStatus` | transport | online/offline (optional per medium) |
| `grants.onRegistered` | wire | grant accepted `(grant, wire)` |
| `mesh.openQueries()/running()/active()` | client | poll |
| SQLite tables | storage | `events`, `state_rows`, `state_cursors`, `compaction`, `_syncmesh_changes`, app tables |

**Gaps** (per D17 open, E24, RFC-0011): telemetry union has 2 variants and no consumer; mesh/relay don't re-emit; no inspector exists in this repo (the old repo's fed on a JSONL line format from the legacy engine); transport frames/sessions/holdback and validator "why" (policy verdict is a bare boolean) have no taps; storage has no telemetry (bench measures externally).

## 12 · adapters, tooling, conformance, bench, plan

_(filled in from the last reader — see sections A–I below)_

<!-- PENDING: reader A–I output -->

---
id: api-gaps
title: The API coherence plan — what the comparison found, and what to build
status: plan
touches: [schema, orpc, client, react, storage, transport]
---

> Written 2026-09-22, out of a Zero / Ditto / syncmesh API comparison and the questions it
> raised. Every claim below was checked against the code on `t3code/identify-devtools-stack`,
> not against the book — `research/syncmesh-book.md`'s own audit (ch. 25, dated 2026-09-08) is
> stale in both directions, and §4 records where.

## 0 · What the comparison actually found

Zero and Ditto sit either side of us, and each one's API follows from what it believes:

| | Believes | So its API is |
| --- | --- | --- |
| Zero | Postgres is the truth; the client is a cache of server-computed query results | server-defined queries + mutators, replayed twice, rolled back on ack |
| Ditto | The mesh is the truth; there is no schema and no authority | DQL strings against a document store, subscriptions as the replication knob |
| syncmesh | The local **log** is the truth; every receiver re-verifies | typed procedures over a schema; writes become events; reads never pull |

The finding that matters: **every differentiator we have against both of them is the part
not yet built.** `coverage` is the word Zero cannot have and Ditto never thought of — it is
three states with no source id. Per-row sync state is something neither offers — the SQL is
built, the read surface is not. A write record that survives `kill -9` is what Zero replaces
with rollback and Ditto has nothing for — it is Phase 1 and unfinished.

What they have that we should want is short, and none of it is architecture:

- **Runtime transport control.** Ditto's `updateTransportConfig` applies mid-sync. Ours exists
  (`transports.add/remove/force`, `client/src/transports.ts:486-510`) — gap-audit №23's
  E24/E09 contradiction is resolved in code's favour and the audit is stale.
- **Deploy-order migration.** Zero has expand/contract plus `onUpdateNeeded`. We have no
  deploy order at all — a phone six versions behind is still a valid signer. §3.2.
- **A hot/cold knob.** Zero has `preload` + `ttl`. Ours is partition detach under a storage
  budget, and the sweep has no answer for what to shed. §1.3.

## 1 · What we settled about the model (the reasoning the plan rests on)

**A partition is the unit of custody** — "which slice of the world does this device hold?".
A filtered projection of a log does not fold to identical state, so holding a subset of a
partition you claim is a NEVER (book ch. 3). Every sizing question is answered with *finer
partitions, granted precisely* — never with a query filter. That is why Ditto needs query
subscriptions and we do not: Ditto has no partitions, so the query is their only knife.

**A grant is a signed relationship tuple** — `(device, partitions, role, claims)`, issued by
`trust.issuer`, expiring, revocable. It grants: *this device may author events in these named
instances, as this role, with these vouched claims, until this instant.* Not a login
(`$auth` is that); not row-level (it names `shop:lagos-01`, never rows).

**The authority never vetoes, because a fold-time veto is divergence.** Refusing an event
other peers already folded cannot be undone across a mesh — some of those peers are offline
for weeks. So authority gets three seats and no veto:

| Seat | When | Mechanism |
| --- | --- | --- |
| Gate | before an event exists | `.authority()` — nothing was written, so nothing is rolled back |
| Fold checks | as everyone folds | ladder `grant → device → revocation → grace → partition → schema → policy` (`engine/src/validate.ts:94`) — not a veto, because every peer computes the same verdict |
| Correct | after the fold | a new signed write carrying `reason`; wins by lww, original intent stays in history |

A **deterministic** refusal every peer makes identically is fine. A **judgment** refusal only
one node could make (it needs private data or a global view) applied after others folded is
the impossible one. Hence: *if the server must be able to say no, that operation is an
`.authority()` procedure.* Anything else gets a gate beforehand or a correction afterwards.

**A refusal at the fold is a failure state, not a feature.** It means the world changed
between write and fold — expiry, revocation, a policy change — and it fails badly: the
quarantining peer's cursor never rises past the parked event (`transport/src/holdback.ts`),
so the author's write reads `local` forever and is never told why (D26 watch-out). §3.4.

**`sealed` is end-to-end encrypted content.** A per-partition content key rides in the grant;
every carrier holds ciphertext. Buys operator-proof custody; costs *all* server-side
judgment for that scope — no Postgres fold, no watchdogs, **no corrections**. `.authority()`
calls still work, sealed to the service. Enforced at `client/src/handles.ts:69`.

**ABAC is the `allow` AST; ReBAC is grant issuance.** The AST is a full attribute evaluator
over exactly four inputs — event, grant, prior row, policy — which is why environment
attributes (time, IP) are excluded: a rule must evaluate identically on a phone Tuesday and
the server Thursday. "Only during shift hours" is grant expiry. Relationships are rows, and
whoever holds issuance rights flattens them into grants — the graph walk happens once, at
issuance, never at check time. Per-thing sharing: the thing becomes its own partition.

## 2 · Build these — decided, evidence in hand

### 2.1 Flat partitions: a kind is a value, not a position in a tree

**Why.** One kind's facts are spread across three top-level blocks today — it nests in
`partitions:`, its ladder is in `roles:`, its sealing is in `sealed: [...]` — and the place
named after it is `{}`. `apps/issues/src/schema.ts:82-98` is the proof.

**What nesting was for, and what it does.** D07-A decided *"a top-level kind gets its own
store per instance, a nested kind lives in its parent's"* — storage co-location, with D07's
own watch-out naming the axis: *partition (what the event belongs to) vs storage scope (which
file it lives in)*. **It was never implemented.** `storeNameFor` builds the filename straight
from `kind:id` with no parent lookup (`storage/src/open-stores.ts:247-251`), so every kind
gets its own store, nested or not. `parentOf` drifted to exactly one consumer — `rolesFor`.
So `within:` today means "inherit the parent's role ladder" and nothing else, which no
decision ever asked for.

**Decision: kinds are flat.** The schema describes the data model; it must not describe file
layout. Role sharing is a value reference, which is what the tree was faking.

```ts
const workspace = partition("workspace", { roles: ladder("owner", "admin", "member", "guest") });
const embargo   = partition("embargo",   { sealed: true, roles: workspace.roles });
const billing   = partition("billing",   { roles: flat("auditor", "billing") });

syncSchema({
  tables: {
    issues:     drizzleTable(issues,     { partition: workspace, allow: ({ role }) => … }),
    disclosure: drizzleTable(disclosure, { partition: embargo,   allow: ({ owner }) => … }),
    rates:      drizzleTable(rates,      { partition: global }),   // reserved kinds ship as values
  },
});
```

```ts
interface Partition<N extends string = string, R extends string = never> {
  readonly name: N;
  readonly sealed: boolean;
  readonly roles: RoleSet<R>;        // ladder(...) | flat(...) — never a bare array
}
```

**Deletes:** `PartitionTree`, `Kinds<P>` with `Level2/3/4` and its **four-level depth cap**,
`Roles<P>`, `RoleNames<R>`, `parentOf`, `flatten`, `within`, `Manifest.partitions`,
`Manifest.roles`, `Manifest.sealed`, `sealedIn`, and both "unknown partition kind" panics.

**Keeps, derived, so downstream is untouched:** `Schema.kinds`, `.sealedKinds`, `.rolesFor` —
read by `engine/can.ts:49`, `engine/validate.ts:278`, `storage/rls.ts:236`,
`drizzle/read.ts:49`, `client/handles.ts:69`.

**Correctness win.** `allow` is typed `AllowFn<C, RoleNames<R>>` today, and `RoleNames` is the
union of *every role named anywhere in the manifest* (`schema/src/manifest.ts:41`) — so an
`embargo` table can write `role("guest")`, a workspace role, and it compiles, then silently
denies at runtime. With the partition as a value, `role()` types against that kind's own set.

**Add `flat()`.** The book requires two shapes — `ladder(...)` ordered, `flat(...)` unordered
— and *"the bare-array form does not exist: position must never be secret semantics."* Today
only `ladder` exists and it returns a bare `readonly string[]`, so nothing stops a raw array
whose order silently means seniority.

**New failure mode to guard.** Object keys made duplicate kind names impossible
(`manifest.ts:301`). Values do not: two modules can each declare `partition("ward")`.
`syncSchema` must panic on a duplicate name, and on two distinct values sharing one name.

**Call sites to migrate:** `apps/issues/src/schema.ts`, `apps/rounds-web`, `packages/cdc/src/__tests__/fixtures.ts`,
`packages/transport/src/transport-tests/peers.ts`, book ch. 6.

### 2.2 `ladder`'s doc comment is inverted, and it is security-relevant

`schema/src/manifest.ts:333-340` says **"weakest first"**. The implementation is the opposite:
`roleAtLeast` does `mine <= needed` against a ladder documented *"senior first"* in
`policy/src/evaluate.ts:14`, and `apps/issues` writes `ladder("owner", "admin", "member", "guest")`.
A developer trusting that comment inverts their ladder and hands `guest` everything.
One-line fix, no dependencies, do it first.

### 2.3 The store sweep is grant-driven — nesting's real job, done properly

**The live bug.** `detachScope` takes one scope, checks one ledger, forgets one file
(`storage/src/detach.ts:27-51`). Detach `org:acme` and every related scope survives as an
independent file with **nothing anywhere recording it belonged to that org** — not the key,
not the grant, not storage. Unreachable and unsweepable.

**The fix needs no tree.** The grant already lists exactly the partitions a device is entitled
to hold, is signed, replicated, and revocable. So:

```
candidates = open stores
           − reserved kinds (user, local — never granted, never swept)
           − scopes covered by a live grant
           − scopes with a grant request in flight
then per candidate: detachScope() already refuses while it holds unsent intent
```

Revocation propagates as data, so this works offline and needs no protocol change, no
`scopeOf` change, and no decision about whether a parent grant implies a child's.

**Gate it on §2.5.** The refusal must read *held* (signed receipt), not *delivered* (cursor
claim) — D28's whole point is that a false claim licenses deleting the only copy.

**The cost, accepted.** A device granted 500 scopes holds 500 files where nesting would have
merged them. That belongs to storage, not to the app's schema: `scopedStores` already opens
lazily and caches by scope (`open-stores.ts:290-297`), so capping open handles with an LRU is
one module's business and no app sees it.

### 2.4 A `query` handler must not be able to write

`context()` hands **the same `db`** to query and mutation handlers alike
(`orpc/src/api.ts:235`): `db: writing?.db ?? open.db`. So a `.query` handler has
`insert`/`update`/`delete` on it right now. D26's own watch-out called it and nothing was
done: *"a lazy descriptor that a hook may run, re-run, or never run is the worst possible
place for a side effect."*

The consequence is worse than a stray write: a query descriptor is re-run on every
invalidation, so a write inside one mints a **new event per re-run**.

**Both fences, because either alone is escapable.**

- **Type:** a query context's `db` is the read-only subset — `select`, `with`, joins — with the
  write verbs absent, so `db.insert` does not compile.
- **Runtime:** the object handed to a query handler has no write verbs; reaching one panics as
  a definition-time defect (D02), not a runtime error on a user's device.

`read` stays as it is — already the caller-scoped read surface.

### 2.5 Signed custody into the ledger (D28's client half)

D28 decided two tiers: a cursor ack makes a write **delivered**, a signed receipt with a live
incarnation makes it **held**, and only *held* licenses anything destructive. The signed path
is built and inert: `custody.vouch()` signs, `verifyReceipt` checks, `onReceipt` is plumbed
through `transport/src/transport.ts:414` — and **the client passes it nowhere**. The ledger is
fed from `engine.acks()`, i.e. cursor frames, i.e. claims (`client/src/operations.ts:161`).

Work: pass `onReceipt` from the client's transport context into `operationStore`, write the
held tier, and make `unsettled()`'s copy say the weaker true thing — *"nobody has told me they
have this"* — until a quarantine report exists on the wire. `incarnation` is already a
`ReceiptRow` column (`storage/src/operation-store.ts:53`), so that half is done.

### 2.6 Coverage on reads

The book's read answer carries `local-only | partial | caught-up` with a **source** and a
**checkpoint**. The code has `Answered = "none" | "local" | "settled"`
(`react/src/answered.ts`) — no source, no checkpoint, and no `partial` at all.

The machinery exists: `transports.settled()` already awaits each source's `caughtUp()`
sequentially, nearest-first (`client/src/transports.ts:462-470`), and throws the per-source
result away into one `void` promise.

Work: record each source's completion and the engine's cursors at that moment; surface
`coverage()` + `onCoverage()` on the mesh and on `QueryCall`; add `coverage` to the hook's
result. **Additive** — `answered` stays exactly as D26 §6 specified, and `coverage` is the
richer fact beside it.

One deliberate behaviour change to note: with **no transports at all**, `caught-up` cannot
name a source, so coverage stays `local-only` forever. That is honest — nothing can ever fill
that query — and it is why `answered` must not be deleted: an offline-only app draws empty
states from `answered`, not from coverage.

### 2.7 Tagged errors at the wire boundary

`CallError = Error` (`orpc/src/api.ts:51`) flattens every tagged error at the one boundary
that matters, and the book names the disease by its owner: *"a stringly code map is Ditto's
design"*. Tags serialize as `{ _tag, ...fields }` and revive at the boundary, which deletes
`taggedCause()` and the `"PolicyDenied"` string match.

### 2.8 One noun: `db` is the caller's view, and `read` is deleted

`read(table)` is not a second database — it is a table source carrying a `WHERE`: the actor's
compiled `allow.read` rule plus the `_partition` pin (`drizzle/src/read.ts:43-59`). The
handler context offers both (`orpc/src/index.ts:62`, `api.ts:235`), and which one is safe
depends on the dialect:

| Where | `db.select().from(products)` returns |
| --- | --- |
| Server, Postgres, `rls: true` | the caller's view — the **database** enforces it, so `read()` is redundant |
| **Every device** (SQLite, no RLS) | **everything in the replica, unfiltered** |

`rls: true` is Postgres-only and opt-in (`client/src/boot.ts:126`,
`apps/issues/src/server/authority.ts:89`). So on a phone the read rules apply **only if the
developer remembers to call `read()`** — and the identical handler is safe on the server, so
no server-side test will ever catch the omission. Two nouns where one is silently unsafe is
not a surface, it is a footgun with a spare.

**Decision: `db` applies the caller's read scope on both dialects; `read` is deleted.** The
predicate already exists and is already compiled — `readPredicate` moves from something the
developer wraps a table in to something the handler's `db` does for them, which is what
Postgres already does via RLS. One noun, one meaning, same on every tier.

Three things that make this work rather than a deletion:

- **Every table reference, not just the first.** `read()` composes because each mention is
  wrapped by hand. Automatic substitution must cover `.from`, every join, subqueries and CTEs
  — this is where correctness slips, and it wants a test per shape.
- **`live()` reads the query's SQL text** to learn which tables invalidate it and whether a
  `syncOf` column was selected (`drizzle/src/live.ts:103,226`). Substitution rewrites that
  text; both detections must survive it.
- **The escape must be named.** A watchdog or a `systemProcedure` legitimately reads
  unfiltered. Today unfiltered is what you get by *forgetting*; after this it is something you
  have to write down — the correct direction, and the only one that survives review.

Composes with §2.4 rather than replacing it: §2.4 subtracts the **write** verbs from a query
handler's `db`, §2.8 makes the **read** side honest on every dialect. After both, a query
handler holds exactly one object that can only read, and only what the caller may read.

## 3 · Decide before building

### 3.1 One constructor
`createMesh` (`client/src/index.ts:38`) and `createClient` (`orpc/src/client.ts`) both exist and
both have callers — `apps/issues/src/app/devtools.tsx`, `bench/src/browser-mesh.ts`,
`packages/devtools`. The book's cut list says one. Mechanical but wide; needs a sequencing call.

### 3.2 Schema evolution across a mixed-version fleet
Zero's answer is deploy order; ours cannot be, because there is no order — a phone six versions
behind is a valid signer. D13's additive rule and the `unknown-table` park are the floor we
already have (`engine/src/quarantine.ts`); gap-audit №20 says correction mismatch across
versions has no mitigation. This is the axis where we are behind the weaker system.

**Drafted as `plan/decisions/D31.md` (2026-09-22, `status: draft`) — awaiting a decision.**
Recommends C: expand/contract as an operator rule with three pieces of tooling (the additive
lint D13 asked for and nobody built; a monotone `schemaVersion` in the manifest stamped on
events under a new core key and trailing on the cursors frame, additive like `ahead`; a fleet
reading "oldest schema still writing" off `engine.acksAt` via `$inspect`), plus a `retired`
table/column state — declared, write-refused locally, still folded — so contraction never sends
old writers' events into quarantine. Rejects an admission floor (B) as a refusal of legitimate
offline work and per-partition epochs (D) because the build, not the partition, is what varies.
Two "now" fixes fall out: split `unknown-table` from the retired-table case that today shares its
128-slot bucket, and pin D15's compaction floor for every peer.

**A doc-rot finding on the way (other agent's file, not touched):** `engine/src/authority.ts:96-98`
says an older build's schema check *refuses* a row carrying an undeclared column;
`engine/src/columns.ts:28-35` implements D13's additive rule as *dropping* the cell from the
check. `columns.ts` is the implementation, so the `authority.ts` comment is the stale one.

### 3.3 Sealing has no interaction with anything, now that kinds are flat — **resolved**
Sealing is per kind, full stop: `partition(name, { sealed: true })`, read as `Schema.sealedKinds`
and enforced at `client/handles.ts:69`. There is no parent for it to inherit from or leak into,
so the question §2.1 raised no longer has an object.

### 3.4 A quarantine report on the wire
The hole behind §1's "failure state": a refused write is indistinguishable from an unsynced one,
forever, to its author. Closing it is protocol work and wants its own decision. Until then every
surface that reports custody must say the weaker true thing (§2.5).

**Drafted as `plan/decisions/D32.md` (2026-09-22, `status: draft`) — awaiting a decision.**
Recommends C: a signed `RefusalReceipt { v, refuser, author, seq, reason, verdict, issuedAt }`
mirroring `CustodyReceipt` — `[core, sig]`, verified against the named refuser, kept only for the
author's own writes — on additive frame kind 9, sent where `custody.vouch` runs and re-sent on
each cursor exchange while parked, landing in a fourth ledger table `refusals`, superseded by a
later `CustodyReceipt` from the same holder covering the seq (no retraction frame). Surfaces as a
`refusals?` field beside `correction?` — a separate axis, no fourth `SyncState` — under
`$operations`. Information only: it cannot un-fold anything and nothing may gate on it; tag only,
no free text; weighted by refuser identity, never by count. Rejects an unsigned frame (B) because
relays forward unread bytes, and authority-only correction (D) as the whole answer because a
refused event never folded on the refuser and sealed partitions have no corrections.

### 3.5 Delete-resurrection, proven
Ditto's nastiest class — a device offline past the tombstone TTL resurrects a deleted row. Our
event log plus coverage chains plus compaction floors should make it impossible. **No test pins
it.** Add the chaos scenario: a device offline past the retention floor rejoins and must not
resurrect.

## 4 · Verified *not* gaps — do not re-do these

The book's ch. 25 audit is two weeks stale in this direction:

| Claimed missing | Actually |
| --- | --- |
| `syncOf` / `operationOf` | **Built** — `storage/src/{syncOfSql,operationOfSql}`, row-sync table kept in step by the projection, exported from `drizzle/src/sync-of.ts:26` |
| `Write.waitFor` / milestones | **Deliberately deleted** by D27; `write.test.ts:123` pins `"waitFor" in write === false`. Not a gap — a decision |
| `incarnation` on receipts | **Built** — `storage/src/operation-store.ts:53` |
| `.authority()` terminal | **Built** — `orpc/src/procedures.ts:112-120`, with a real body in `apps/issues/src/authority.ts` |
| `transports.add/remove` | **Built**, plus `force`/`release` for diagnostics — resolves gap-audit №23 |

## 5 · Order

1. **§2.2** — the inverted `ladder` comment. One line, security-relevant, no dependencies.
2. **§2.4** — read-only `db` in query handlers. Small, closes a documented hole, no protocol.
2b. **§2.8** — `db` becomes the caller's view, `read` deleted. Same seam as §2.4, and it closes
   a silent read leak on every device; do the two together so the context changes once.
3. **§2.1** — flat partitions + all call sites. The big coherent one; everything else is easier after.
4. **§2.6** — coverage on reads. The differentiator, and the machinery is already there.
5. **§2.5** — signed custody, then **§2.3** the grant-driven sweep, which depends on it.
6. **§2.7** — tagged wire errors.
7. **§3** decisions, then §3.5's chaos scenario.

## 6 · Status — 2026-09-22

Another agent is working the same tree (D28 signed custody: `client/operations.ts`,
`storage/operation-store.ts`, `adapters/browser/ledger.ts`, plus the `lan()` adapter). Items
below are marked against that.

| Item | State |
| --- | --- |
| §2.2 `ladder` direction | **done** — comment corrected to *senior first*, and `roleAtLeast`'s direction pinned by three tests in `policy/src/__tests__/evaluate.test.ts` so it cannot rot again |
| §2.4 read-only query `db` | **done** — `QueryContext` / `MutationContext` split in `orpc/src/procedures.ts`; `reading()` in `api.ts` hands a query body a `db` with no write verbs, in the type *and* on the object |
| §2.8 one noun | **done** — `scopeReads` (`drizzle/src/scoped.ts`) substitutes every table in `from`/joins with the caller's scoped source; `read` is gone from the handler context and all `apps/issues` handlers |
| §2.1 flat partitions | **core done; `flat()` done; every call site we own migrated** — what remains is `manifest.test.ts`'s deliberate tree-form tests, one devtools stub typed against the other agent's `MeshSchema`, and 5 files the other agent holds; per-kind `role()` narrowing on `drizzleTable` done — see below |
| §2.5 signed custody | **owned by the other agent** (D28); not touched |
| §2.3 grant-driven sweep | not started — gated on §2.5 |
| §2.6 coverage on reads | **done** — `local-only \| partial \| caught-up` with source + checkpoint, mesh → `QueryCall` → `useLiveQuery` |
| §2.7 tagged wire errors | **done** — smaller than written: the wire half already existed |

**§2.1, precisely.** `partition()`, `isPartition`, `RolesOf` and the `global`/`user`/`local`
values live in the new `schema/src/partition.ts`; `syncSchema` derives kinds, `sealedKinds` and
`rolesFor` from what the tables and presence topics reference, panics on a duplicate kind name
(the failure object keys made impossible), and holds the two `allow` guards — a declared kind
needs a rule, a reserved kind refuses one. `presence.ts` came out of `manifest.ts` in the same
pass to stay under the line cap.

Migrated to the value form: `apps/issues/src/schema.ts` (including the sealed `embargo`, which
now states the ladder it used to inherit invisibly), `examples/src/notes.ts`,
`examples/src/rounds/schema.ts`, `chaos/src/schema.ts`.

**Second pass, 2026-09-22 (four parallel sub-agents, each verified by me afterwards).**
Fixtures migrated to the value form in `engine`, `drizzle`, `storage`, `orpc`, `react`, `relay`,
`transport`, `cdc`, `devtools`, `adapters/cloudflare-do` — 27 files, no assertion on a tree
shape existed anywhere, so none needed rewriting. **`flat()` shipped**: `RoleSet =
{ names, ordered }` lives in `@syncmesh/policy` (the lowest package that needs it — `roleAtLeast`
and `PolicyContext` branch on `ordered`; a flat set passes only on exact match), `ladder()` and
`flat()` are the two builders in `schema/src/partition.ts` and panic on a duplicate name,
`Schema.rolesFor` returns the set with its ordering, and every consumer follows —
`engine/validate.ts` (`policyContext`), `storage/rls.ts` (flat compiles to `COALESCE(role =
'name', FALSE)`, a ladder to the existing `array_position`), `storage/read-filter.ts`
(`compileRead`), `drizzle/read.ts`; a bare array under the tree form reads as an ordered ladder.
New `storage/src/__tests__/rls.test.ts` pins the three DDL shapes. Docs: book ch. 6 and 23
examples, the ch. 15 role-set example, a dated re-audit in ch. 25, the cut-list note in ch. 26,
`plan/use-cases.md`, `api-friction.md` №6 closed.

**Deliberately staged, not forgotten:**

- The tree form still works, and after the third pass nothing we own uses it: 20 more fixtures
  (`client/__tests__` ×18, `schema/__tests__/{bind,from-drizzle}`) migrated, verified against the
  client suite's failure set rather than its counts — the suite flaps run to run (149–158 pass)
  because the same `stateOf` tests flip between a counted failure and "unhandled error between
  tests"; what is stable is that **every** error message is `stateOf is not a function` and the
  failing names stay inside one 13-name set, before and after. Still on the tree form:
  `schema/__tests__/manifest.test.ts` (deliberate — it pins the tree behaviour until the deletion
  pass), `devtools/__tests__/readable-mesh.ts` (a stub typed against `MeshSchema.partitions:
  PartitionTree` in `client/surface.ts`, which the other agent holds and which is now always `{}`
  under the value form — `kinds` is the natural replacement, for the deletion pass), and five
  files the other agent holds (`bench/browser-mesh.ts`, `adapters/browser/__tests__/origin-mesh.ts`,
  `orpc/__tests__/write.test.ts`, `client/__tests__/operations.test.ts`,
  `react/__tests__/api-live.test.ts`). Originally ~60 test fixtures used it.
- Two assertion rewrites worth knowing: `client/__tests__/surface.test.ts` gained a `memos` table
  on the sealed `team` kind, because under the value form a kind exists only by reference, and its
  `Object.keys(mesh.schema.partitions)` check now derives kinds from `entries`;
  `schema/__tests__/bind.test.ts` lost its `@ts-expect-error role("nope")` check because the
  raw-object form widened `role()` to `string` — the guarantee is being re-homed on `drizzleTable`,
  where a function can infer the referenced kind's ladder (in flight). That is a deviation from the
  "all call sites, one spelling" call — taken because five of the files the removal touches are
  in the other agent's working set right now, and a 70-file generic-signature change racing
  another agent produces a tree neither of us can untangle. The removal is one mechanical pass
  once `client/*` is quiet.
- **Per-kind role narrowing — done, on `drizzleTable`.** A mapped type cannot see one entry's
  partition (a second `TableEntry` arm was tried and withdrawn: every `allow: ({ role }) => …`
  went `any`), but a function can infer. `drizzleTable` is now three overloads
  (`schema/src/from-drizzle.ts`, types in `drizzle-options.ts`): a reserved kind takes no
  `allow`; `partition: Partition<N, R>` types `allow` as `AllowFn<C, R>`, so `role()` accepts
  exactly that kind's names and a kind with no roles has no `role()` to call; the plain form is
  unchanged. `R` is inferred from `roles: RoleSet<R>` in the context-insensitive pass, before the
  arrow is typed — and **overload order is load-bearing**: the all-optional plain form must come
  after the kind form or TS fixes `({ role })` to `any` before rejecting the literal (recorded in
  the source). Six `@ts-expect-error` directives in `from-drizzle.test.ts` pin the negatives,
  including the `role("nope")` check the raw-object form lost. The tree-form string does not get
  an overload: inside `drizzleTable` the manifest's `roles` block is invisible, so the spread form
  is the only sound spelling there, and it still compiles.

**§2.7, precisely.** Two of the three things the book's cut list asks for were already true:
`taggedCause()` no longer exists anywhere, and the wire already carries `{ _tag, message,
...fields }` and revives declared classes with `ForeignTagged` for a tag outside the catalog
(`wireError` / `createTaggedCatalog` in `http.ts`). What was still flattened was *nearer than the
wire* — five places minting a bare `new Error(message)`. Those are now tagged, in the new
`orpc/src/errors.ts`: `InputInvalid`, `SchemaNotSynchronous`, `NothingWritten`,
`AuthorityUnreachable`, `NoBodyBound`. `validate` moved to its own module in the same pass (line
cap).

`NothingWritten` is `research/api-friction.md`'s **sixth finding**, closed: an idempotent
mutation's second tap used to return `Err("mutation wrote nothing: no event to report")`, so a
caller could not tell *already done* from *failed*. It is now a tag carrying the procedure's
path, pinned by a test that taps an `onConflictDoNothing` mutation twice.

`CallError` stays `Error` at the top, deliberately — a handler may throw a class this package has
never heard of, and narrowing the channel would be a lie about what can arrive.

**§2.6, precisely.** `createReadCoverage` (`client/src/read-coverage.ts`) arms every medium
once — `whenReady().then(caughtUp)` — and keeps the moment and this device's cursors under its
name when it completes. The reading is derived, never stored: `local-only` while nothing has
answered, `caught-up` once every medium in the *current* set has, `partial` between, naming the
**furthest** completed source because its checkpoint is the one the rows are good to. A medium
added mid-life drops the reading to `partial` until it speaks; one that never comes up is one
that has not answered, not a crash. With no transports it is `local-only` forever — `caught-up`
cannot name a source that does not exist — which is why `answered` stays beside it for the
offline-only empty state. Plumbed as `Mesh.coverage`, `ApiMesh.coverage`,
`QueryCall.coverage()`/`onCoverage()` (deferred until the mesh opens, like `settled`), and
`coverage` on both hooks — `useLiveQuery` through a second `useSyncExternalStore`, `useQuery`
forwarding it beside `answered`. `useQuery`'s own doc had rejected a coverage union *as a fourth
readiness state*; that argument stands and `answered` remains the only progression a screen
walks. This is the other fact beside it, with a source's name on it. Pinned at the hook boundary:
a fake call walks `local-only → partial@nearby → caught-up@internet`, an unchanged reading is not
a render, and a call carrying no coverage reads `local-only`.

Two lessons from landing it. The first cut returned a fresh object from `get()` on every call
and React looped with *Maximum update depth exceeded* — `useSyncExternalStore` compares
snapshots by reference; the reading now keeps its identity until the fact moves. And making
`coverage` a **required** member of `ApiMesh` broke `adapters/browser/src/client.ts:299`, the
port-backed mesh that satisfies `ApiMesh` structurally and had nothing to forward yet — a
regression of mine in a file the other agent holds, caught by a sub-agent's typecheck. It is
optional now: a surface that cannot say reads `local-only`, and the adapter compiles. And the
same identity bug bit a second time, in the one place tests could not reach: that port-backed
mesh has no `coverage`, so `QueryCall.coverage()` fell into `?? { kind: "local-only" }` — a
fresh object per `getSnapshot` — and the browser app looped ("Maximum update depth exceeded")
while every test mesh, which *has* coverage, stayed green. `LOCAL_ONLY` is now declared once in
`@syncmesh/client` and used by the tracker, orpc's fallback and the react hook; an orpc test pins
`call.coverage()` to the same reference on a mesh without coverage; `adapters/browser` 43/43;
`apps/issues` verified rendering in the browser (`document.readyState` complete, no error
overlay, 120 seeded issues on screen).

**Verified after the second pass:** 688 green across `policy` 16, `schema` 55, `storage` 72,
`drizzle` 48, `orpc` 36, `react` 25, `relay` 133, `devtools` 159, `adapters/cloudflare-do` 29,
`adapters/postgres` 36, `apps/issues` 75, `examples` 4. `engine` 60 / `transport` 42 / `cdc` 1
red — all of them `stateOf is not a function` (60/60, 42/42, 1/1), the other agent's
`engine.ts:298` passing `{ getState, mergeInto, persist, notify }` where `digest.ts:141`,
`writes.ts:102` and `snapshot.ts:135` still destructure `stateOf`. Boundary check: every file
modified outside the sub-agents' allowed sets is on the other agent's known list.

**Verified, first pass:** 496 tests green across `schema` (53), `policy` (14), `drizzle` (48), `engine`
(240), `orpc` (36), `react` (25), `apps/issues` (75) and the coverage unit (5); `vp lint` clean
on every file touched. `packages/client`'s full suite currently shows 11 failures, every one
`TypeError: stateOf is not a function` inside `engine/dist` `digest` — the other agent's engine
refactor (`InstallDeps.stateOf`, `engine.ts:296-313` does not typecheck at the moment), reached
through a stale dist; none touch coverage.
The only type errors in the tree are in `adapters/lan-node/src/index.ts` and
`packages/relay/src/blob-cap.ts` — both the other agent's, both pre-existing to this work.

**The `chaos` smoke — fixed, and the earlier attribution was wrong.** It spawns
`run.ts --devices 4 --ticks 8` and timed out; I had named `relay/src/blob-cap.ts` as the prime
suspect. The other agent's stalled engine refactor was real but unrelated — it was finished here
(`stateOf` → `getState` in `digest.ts`, `snapshot.ts`, `writes.ts`, matching what `engine.ts`
already passed; engine 240/240, client 170/0, transport 146/0, cdc 17/0), `blob-cap.ts` now
forwards the `origin`/`irreplaceable` members its `BlobStore` grew, and the stale
`authority.ts:96-98` comment now says what `columns.ts` does — and the smoke *still* hung.

The real cause, bisected with throwaway probes (each instrumented file restored byte-for-byte
from `HEAD`): `createWorld` returns in 0.1 s; the hang begins the instant a **third BLE radio**
is on the air, relay or not; it is **microtask starvation**, not a spin — promise continuations
run, no timer ever fires; `air.setLoss(1)` ends it in half a second, so it is a frame ping-pong
over the air; the air tally showed ~600 identical 137-byte packets a second, all from the one
device linked to both others; the bridge's outbound `deliver` was never reached; and a stack at
the 500th send read `link.send ← supersede ← accept`. `transport/src/session.ts`'s `supersede`
answered a proven peer's fresh hello by minting a fresh secret and **sending a fresh hello back**
— right when the far side has restarted and its new session takes ours as the opening hello,
but when the far side is *also* established the answer is indistinguishable from a new offer,
and it answers that too, forever, with no timer in the path. Two radios never reach it (only a
central dials); with three, two devices dial each other and the BLE transport folds both
connections into one link by hint, so the second connection's hello lands on a proven session.

The fix is one discriminator the session lacked — *has the peer ever used the hello I currently
offer?* A frame unsealed under the current keys sets `confirmed`; minting clears it. `confirmed`
→ a fresh hello is a restart: mint and send, as before. Not confirmed → our hello is still in
flight and theirs is the **answer** to it: agree under what we already offered and send nothing,
so the exchange ends. Two tests on the stub harness pin both branches (`session.test.ts`, "two
live sessions that re-key each other converge"); the smoke passes; this bug predates today — the
4-device smoke was simply the first thing to put three radios on one air.

Still red anywhere: nothing. The 11 type errors `apps/issues`'s tsconfig reported in
`adapters/lan-node/src/index.ts` were `node:net` **unresolved** from that program — `@types/node`
is not hoisted at the root and the app did not declare it, so `net.createServer()` fell back to
bun-types' ambient `Server`, which has no `.on`. Under the `@syncmesh/source` condition an app
compiles lan-node's *source*, so it needs lan-node's type dependency exactly as lan-node declares
it: `@types/node` (catalog) added to `apps/issues` devDependencies. Present since the session's
first typecheck; fixed 2026-09-22.

The last 55 type errors in the tree (`adapters/cloudflare-do` 7, `apps/rounds-web` 19,
`examples` 29) were one cause: `drizzle-orm` was not in the catalog. Eleven packages pinned
`"latest"`, `packages/schema` pinned `0.45.2` exactly, `rounds-web` `^0.45.2`, so 0.45.2 and
0.45.3 coexisted in the store and a table typed by one copy was not assignable to the other's
`SQLiteTable` — the private `shouldInlineParams` declared twice — with every "property does not
exist on `{ [x: string]: never } | …`" error downstream of the same mismatch. Fixed the way the
repo already handles shared pins: `"drizzle-orm": "^0.45.3"` in the root catalog, every
dependency and devDependency at `"catalog:"`, peer ranges untouched. One resolved version, **0
type errors across all 33 projects**, and the suites most exposed to the bump green: `schema`
59, `drizzle` 48, `orpc` 36, `issues` 75, `examples` 4, `cloudflare-do` 29.

The last red suite, `adapters/sqlite-expo` (10 pass / 26 fail), was its **test fake**, not the
adapter. Since `6719eaf` a store opens only over a connection with the log attached as
`syncmesh` (or a driver declaring `log: "inline"`, `5f793c4`); the adapter does
`attachLog(driver, logPath)` at `index.ts:75`, but the test's `openDriver` handed the shared
contract a bare `expoSqliteDriverOver(fakeExpo(":memory:"))` — hence 5× "the log is not attached
as `syncmesh`" and 19× "open failed" from migrations against a namespace that resolved to nothing.
`attachLog(driver, ":memory:")` once per fake database (`attachLog`'s own doc names `:memory:`
as what a test wants; the fake connection outlives every `close`): 36/36.

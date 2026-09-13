# Building the book — progress ledger

> Running record of the ch. 27 build order as it lands on this branch. Updated 2026-09-11.
> Tree state at last update: `vp check` 0 errors, every package suite green, chaos runs
> (fresh seeds) converged with zero leaked handles. Commits are pending on the 1Password
> signer being unlocked; the work is in the tree.

## Phase 0 — DONE

- Store lock-on-open: `StoreLocked` + `acquireStoreLock` (`storage/lock.ts`), held via
  `BEGIN EXCLUSIVE` on a `<store>.lock` sidecar; both sqlite adapters' `defaultStore`;
  `MeshOpenError` widened. Double-open fails typed; close admits the next opener.
- Handles leak loudly: `createHandleTally`/`meterHandles`/`meterBlobs` (`client/inspect.ts`),
  `mesh.inspect.handles()` counting observers/subscriptions/operations/fetches/links;
  teardowns Disposable + idempotent; chaos epilogue fails a run ending with seats held.
- Error catalog crosses the wire: `serializeTagged`/`createTaggedCatalog`/`ForeignTagged`
  (`result/wire.ts`); orpc `createHandler` serializes `{ _tag, ...fields }`, `httpLink`
  revives into the caller's declared classes.

## Phase 1 — core DONE, two deferrals

- Operation records: `operationStore` (`storage/operation-store.ts`) over per-dialect SQL
  (`storage/dialect-operations.ts`; short names on device, `_syncmesh_` on Postgres);
  `MutateOptions.record` runs inside the engine's atomic boundary — record and event land
  together or neither (proven by the rolled-back-transaction case); the writer allocates the
  id before commit and returns it on `TxReceipt.operationId`; local-only writes get no record.
- Receipts: `openOperations` (`client/operations.ts`) turns acknowledged cursors into
  idempotent receipt rows; `_corrections` folds mark displaced records superseded with the
  reason; `mesh.operations` reads the ledger back (proven across restart from disk).
- Deferred: the `Write<T>` statement tracker (its ergonomic home is the Phase 3 call
  surface); **signed** custody receipts (a transport frame — belongs with the peer session).

## Phase 2 — surface DONE, jobs deferred

- `mesh.recovery`: quarantine read back as stable causes (`missing-capability` for the grant
  verdict family, `refused` otherwise), `run()` = idempotent re-admission. Proven: ungranted
  author parks as NoGrant, grant + run folds it.
- `watch()` (orpc): detection over state, latest-wins coalescing, converging reactions —
  the price-floor watchdog test reaches its fixed point.
- Deferred: persisted retry jobs with dependency edges; `explain`/`export`/`rebuild`.

## Phase 3 — grammar and server DONE, surface rename pending

- The terminals: `query`/`mutation` gained `.route()` (metadata only), `.input()`,
  `.output()` (parsed at the trust boundary on both ends), `.errors()` (declared tags over
  the wire), `.authority()` — typestate leaves no `.handler` after `.output()`. The legacy
  `authority.input().returns<T>()` builder is cut (book's cut list).
- `AuthorityHandlers<R>`: the router filtered to its gates as a mapped type; `satisfies`
  makes a missing/extra/drifted body a compile error. `createHandler({ gate })` dispatches
  with parsed input, lazily opened handle, and per-declared-error throwers.
- `createServer` (orpc/server.ts): createApp + gate binding + watchdogs with teardowns +
  `openapi()` from `.route()` metadata. Proven end to end over a real socket (reserve,
  refuse by tag, read back, spec shape).
- `useOperation` (react) over `mesh.operations.onChange`.
- Pending: `createClient` regroup (procedures at top level + `$`-spellings), `useQuery`
  dialect with `coverage`, TanStack collection adapter, `syncOf`/`operationOf` as selectable
  columns (needs a joinable row-sync table maintained by fold/ack — design before code).

## Phase 6 — counter and detach DONE

- `merge: "counter"` end to end: the kernel cell is a PN pair (per-author totals up and
  down, both monotone — a single non-monotone map is not a lattice under max, whatever the
  shorthand said), increments `{"+": n}` accumulate on the in-order fold path, normal forms
  join per-author max, `counterValue` reads the difference. **No increment API**: capture
  holds OLD and NEW, so `SET stock = stock - 2` becomes the delta; the projection writes the
  sum into the app's table; validation accepts exactly the two wire shapes; the old test
  pinning counter's absence is flipped (ch. 26's named first task). Proven at the kernel
  (both orders, 24−2−1=21, idempotent snapshot joins) and through two real meshes.
- `detachScope` (storage): refuses with the unsent operation ids while the ledger holds
  unreceipted intent, else closes the scope and hands file deletion to the caller (ch. 13).
  The guard is the Phase 1 ledger paying rent.

## Gap-audit P1 items closed this pass

- Relay connection cap (№5): `limits.maxConnections` (default 10 000), refused at upgrade
  with 503 before any handshake spend; a close frees the seat.
- Byte-bounded backlog (№6): `limits.maxBacklogBytes` (default 64 MiB) alongside the frame
  count; a stalled socket is closed before it retains gigabytes.
- Chaos in CI (№10): `chaos` now has a `test` task running a fixed-seed smoke through the
  real harness — the convergence oracle and zero-handles epilogue guard every `vp run test`.

## Phase 6 continued — budget and the blob surface

- `sweepBudget` (storage): pressure sheds whole idle partitions, least-recently-opened
  first, through `detachScope` — so the unsent-intent guard outranks disk pressure by
  construction; `"suggest"` reports without touching anything. Platform facts (file sizes,
  idleness, deletion) stay the caller's.
- Blob surface (client): `stream()` (the seam chunked frames will fill; metered like any
  fetch, seat freed on close/error/cancel), `retain`/`release`/`retained` refcounts for the
  eviction sweep to consult, and `onProgress` with the two honest ticks a whole-buffer
  transfer can give — documented as such until the peer session's blob frames land.

## Phase 3 continued — the read dialect

- `useQuery` (react): the book's ch. 9 hook — conditional queries disable instead of
  crashing, `data` is `undefined` until local stabilization, and `isReady` and `coverage`
  are two facts that settle apart (proven: rows ready while coverage still `local-only`,
  then `caught-up` when settled resolves). `Coverage` ships as the honest two-kind union;
  per-source checkpoints grow onto it without a shape change. `useLiveQuery` now tolerates
  `undefined` underneath it.

## Runtime transports — DONE (reconciles gap-audit №23)

`mesh.transports.add/remove/list` (book ch. 8, 16): the runner now holds a live set instead
of the constructor's frozen array — `add` starts a medium mid-life and returns a typed
`TransportAddFailed` rather than throwing (a failed start is rolled out of the set), `remove`
takes the route away by name with optional drain, and routing, flush, `settled`, `withBlobs`
and the link count all read the live set. The admission watch stays lazy — subscribed only
once something boundable is present, re-checked on `add` — so a transport driven with no mesh
behind it still never touches the engine.

This settles the E24/E09 contradiction the audit flagged (№23) in E24's and the book's favour.
Proven by removing the original radio and watching the mesh keep converging over the late one:
a route left, the rows stayed.

## Status diagnosis — DONE

`mesh.status` (book ch. 18): per-source conditions plus one overall health, so a settings
screen can say "Bluetooth is off — turn it on to sync with nearby devices" rather than draw a
red dot. Two optional facts joined the transport port — `kind` (the medium, so AWDL and
Wi-Fi Aware are never merged into a lying "p2p-wifi") and `condition` (what the platform says
about its own radio); a medium that declares neither is still diagnosed from `onStatus` as
`ok`/`temporarily-unavailable`. Sources are keyed by the transport's own name rather than by
medium, because a fleet runs two radios of one kind and `remove` takes that name.

`auth-required` and `storage-degraded` are in the book's vocabulary and deliberately left out:
nothing reports either yet, and a health a UI cannot trust is worse than one word fewer.

## One noun — `createClient` DONE

`createClient` (orpc/client.ts, book ch. 8 and rule 1): the client **is** the api. Procedures
sit at the top level and the machinery sits beside them as `$operations`, `$recovery`,
`$status`, `$transports`, `$blobs`, `$grants`, `$presence`, `$inspect`, `$accounts`,
`$flush()`, `$close()`, plus `$mesh` for the handful of facts that are neither a procedure nor
a `$`-surface. Three tiers, three spellings, and the collision is impossible by construction
rather than by a reserved-word list. `createApp` stays as the construction step both doors
share — `createServer` is the other one.

## The `.can()` rehearsal — DONE

`api.products.create.can(input)` (book ch. 15): the handler runs against the replica, the
staged changes face the same ladder every receiver runs, and the transaction always rolls
back. It cannot drift from enforcement, because it **is** enforcement, rehearsed — proven by
a viewer's rehearsal refusing with `PolicyDenied` and the real write refusing identically,
and by an editor's rehearsal passing while the table stays empty.

Built bottom-up: `writer.rehearse` forces the rollback *after* the verdict is in hand (a
sentinel refusal from the check itself — throwing earlier would skip the very check the
rehearsal is for); the Drizzle proxy gained a rehearsal mode that suppresses the commit
receipt; both faces expose `rehearse`; the api attaches `.can` to every mutation leaf as an
inert, identity-keyed descriptor. `useCan` now takes either shape — the rehearsal (async, the
real check) or a mesh and a rule name (synchronous, what a per-row affordance wants).

`api.ts` passed the line cap on the way, so the grammar moved to `procedures.ts` and api.ts
re-exports it: every existing import path still resolves.

## The admission gate — DONE (the decision half)

`createAdmissionGate` (transport/gate.ts, book ch. 14): whether a link forms at all, as opposed
to the budget, which decides which of the links that did form are worth keeping. It needs no
configuration, because the grant is this door too — a peer proving a grant that overlaps our
partitions is worth a handshake, a peer *asking* for one has to be able to ask, and everyone
else is a stranger whose slot, battery and handshake we keep. That default answers the lobby
with no code.

Three properties, each pinned: it **fails closed** (a thrower or a handler past its deadline
denies — a gate that admitted a peer because its policy code was slow is not a gate), a deny is
**retry-after-backoff** rather than a verdict, and a handler may only ever **tighten** — it
overrides an allow and can never manufacture one, so it is an override of the grant-derived
default and not a second trust system.

Not yet wired into each medium's link-accept path; that lands with the peer session, which is
where a link is accepted in one place instead of per radio.

## Checkpoint certificates — DONE (ch. 26's named gap)

`provisional: true` used to be a constant. Now it is a fact: `CheckpointCertificate` (wire,
book ch. 4) is the authority's signature over *which state* a snapshot is — `{ partition,
stateHash, coverage, issuedAt, issuer }` in the same `[core, sig]` envelope events and grants
use — and the join exchange relays it on the manifest (appended, so a reader predating it
ignores the position) and verifies it against the rows before reporting.

Both halves have to hold: the signature is the pinned issuer's, **and** the rows hash to what
it covers. That is what stops a relaying peer altering a page — it can forward a certificate
it could never have minted, but it cannot re-sign what it changed. The hash sorts its rows
(two senders may page the same state in different orders and both are correct) and uses JSON
triples rather than a delimiter, because table names and row keys are app-chosen strings and
any separator picked here is one an app could contain.

Proven at the wire (order independence, an altered row, a dropped row, a forged signature,
garbage as a value) and through a real join: verified → `provisional: false`; an impostor's
certificate over the very same rows → still provisional; none at all → provisional, exactly
as before.

## Row state as a column — DONE (ch. 10's named cut)

`syncOf(self, table)` is now a column a handler selects, not a lookup an app correlates by
hand. `useSyncOf("products", row.id)` could never work — queries are the app's own Drizzle,
with joins and renames, so the framework does not know which table a row "is", and asking the
developer to restate it as a string was the bug rather than the fix. The place that already
names the table, typed, is the query.

Two tables, because the two facts move at different times: `_syncmesh_row_sync` (the winning
write's author and stamp) is maintained by the projection inside the fold's own commit, and
`_syncmesh_acked` is one watermark row moved once per acknowledgement however many rows it
settles. `syncOf` compiles to a correlated `CASE` reading both — the watermark from its table
rather than bound, because an acknowledgement has to change the answer of a query built
minutes ago.

The opt-in is real: a query that selects `syncOf` mentions the row-sync table in its SQL, so
the live layer also subscribes to acknowledgements for that query alone. A report or a picker
never re-runs on an ack at all.

`operationOf(table)` is the sibling: the row's pending operation id, the join key into
`$operations` where the receipts, blockers and any correction's reason live. It joins on the
stamp both tables already carry — the ledger now stores the write's own HLC beside its
sequence — so nothing new is written to make the join possible. There is deliberately no
`correctionOf`: a correction's *why* matters to the author of the displaced write and renders
on their record; to a reader who never wrote the old value, the corrected value is the value.

Proven end to end: a fresh write reads `local`, the peer reads `remote`, the acknowledgement
turns the author's own row `delivered`, `operationOf` opens the record it names — and a plain
`select()` carries neither column.

## Signed custody receipts — DONE (Phase 1's deferral)

A receipt was derived from a cursor, which means it was a claim a peer made about itself and a
count of copies was a count of claims. Now the holder **signs** it: `CustodyReceipt` (wire) says
"I hold everything of this author through this sequence, as of this storage lineage", in the
same `[core, sig]` envelope as events, grants and checkpoints, verified against the holder the
receipt names itself — so a peer can neither hand over somebody else's receipt with its own
signature nor its own with somebody else's name.

Issued **after** the batch is durably stored, never on arrival: a receipt for bytes a failed
commit could still lose is the one thing a receipt must not be. A holder that cannot name its
storage lineage signs nothing, because vouching for custody without saying which store held it
proves less than nothing — and the lineage is what lets an author tell "still holding" from
"holding again, having lost what it had".

The frame tag is additive (7), so a peer that predates receipts ignores them. `custody.ts` also
took the control-frame dispatch out of `bridge.ts`, which had outgrown its caps.

## The peer graph — DONE (the local half)

`mesh.peers.graph()` / `$peers` (book ch. 17): this device's own edges, each medium that can
enumerate its links asked, each that cannot listed as **silent** rather than reported as
reaching nobody — a relay socket multiplexing a room reaches whoever is in the room, and that
is the room's business. Whole snapshots, so consumers diff. A peer's *own* neighbours need
route advertisements, which is a protocol addition rather than a view over what is here.

## Writes are statements — DONE (ch. 10's headline)

A mutation returned a promise, so the one thing a caller could do with a write was await its
outcome. But a write's interesting states **outlive any call site** — one made offline on
Tuesday replicates on Thursday and may be corrected next month — and a promise that resolved
once cannot say any of that.

`client.notes.add({…})` now returns a `Write`: deliberately **not thenable**, so the bare
statement is the blessed form rather than a floating-promise lint hit. `id` is allocated before
the commit and handed back synchronously, because an id the commit returned is one an
interrupted caller never saw; `committed` is the durable local commit as a `Result` that never
rejects; `waitFor({ milestone })` bounds one wait and nothing else — an expiry says `WaitExpired`
and delivery carries on; `status()` is the last-read record and `subscribe` follows it.

The ledger subscription behind the handle is refcounted, not held for its life: one subscription
per write kept forever is exactly the leak `$inspect.handles()` exists to make loud.

Every call site moved to `.committed`, including the worked rounds example.

## The session and drafts — DONE (ch. 14, ch. 8)

`mesh.auth` / `$auth`: who the *user* is, as distinct from the grant, which is whose *events*
peers admit — a device needs both and confusing them is how "acting as" bugs ship. One callback
covers initial, refresh and expired, so none can be forgotten, and it is required at
construction when `auth` is used at all rather than optional-until-sync-start. `status()` is one
source of truth for both session logic and the "expires in 4 min" a screen renders; an **expired**
credential stops being a caller while the status still says whose it was, because the rules must
not read a role nobody holds. `signOut` stops sync, then runs the caller's purge, then drops the
credential — in that order, so a purge cannot interleave with new writes.

Every handle now acts as the session's principal by default, which is what makes "application
calls never name a principal" true rather than aspirational; a server still names one per
request.

`mesh.drafts` / `$drafts`: local-only rows with no replication promise, on the app's own
connection. Not a synced table — replicating a draft means merging two half-finished sentences,
which is the one thing the lattice cannot make sensible — and not the outbox either, because a
draft is not a write anyone promised. Proven to survive a restart, and to leave no event.

`mesh.ts` passed its line cap on the way; `MeshOptions` moved to `options.ts`.

## Recovery explains itself, and the TanStack adapter — DONE (ch. 18, ch. 11)

`mesh.recovery.explain(event)` turns a stuck event into a plan: the issue, the one sentence that
would move it, and whether a retry could plausibly change anything yet — a refusal by the rules
will refuse again, a missing capability may have arrived since. A cause with no action beside it
is a spinner with more words. `export(event)` hands back the author's own envelope byte for
byte, because anything re-encoded would no longer verify; it carries application data, which is
why it is a call an operator makes rather than a file the engine writes somewhere.

`@syncmesh/tanstack-db` (new package, so the dependency is not forced on every consumer):
`syncmeshCollection(query, options)` feeds TanStack DB's sync protocol from a mesh query — the
descriptor's key is the collection identity, the live layer's preserved row identity *is* the
diff decision, and readiness waits on **coverage** rather than on the local store answering,
because an empty local store answers instantly and drawing "nothing here" before the relay has
spoken is the lie the whole `coverage` idea exists to prevent. Mutation handlers stay explicit,
non-optimistic bindings returning `.committed`: the local commit is already the fast path, and
layering an optimistic overlay on it is where phantom rollbacks come from.

## Fleet grouping — DONE (ch. 17)

`group` on the admission gate: a depot's vans and a warehouse's scanners run the same build and
should not spend radio slots on each other. Carried on the gate rather than anywhere else
because the doc comment has to sit where the decision is — **an optimization, not a security
control**: a dial-out bypasses it, and anything that does reach a link still faces the grant and
the `allow` rules. A medium that carries no group says nothing, and the grant decides as before.

## The session, moved out of BLE — DONE

`handshake.ts` and `session.ts` now live in `@syncmesh/transport`, with `shouldDial` and a
generalised `createDiscovery<T>` beside them. Nothing in any of them was ever about a radio: they
take a `FrameLink`, an `Identity` and noble's primitives, and a device that speaks BLE to the
phone beside it and Wi-Fi to the laptop across the room is not two security stories. The domain
strings moved with them (`syncmesh/ble/hello/v1` → `syncmesh/link/hello/v1`), which is a wire
change nothing has deployed. `@syncmesh/ble` re-exports what it used to own; its 58 tests and the
transport's 105 pass unchanged.

`framed()` and `ByteStream` followed, for the same reason: a length prefix over a stream is one
implementation or it is three chances to be wrong.

## `lan()` — DONE (ch. 16)

`packages/lan`, over an injected `LanNetwork`. Two halves because a LAN has two: announcements go
to a multicast group, where they are cheap and lossy and nobody minds; frames go over a stream.
**A datagram carrying frames would lose one silently, and a silently lost frame is divergence
rather than a resync** — so the port asks for both rather than pretending UDP is a link.

The whole peer id travels in an announcement, which is the difference from BLE's hint: a datagram
has room, so there is no prefix collision to reason about. It is still only an address worth
dialling and never a peer worth believing — the handshake proves that, as everywhere.

Left out: mDNS. The book's `mdns`/`multicast` toggles are the network's business, not the
transport's — a platform that finds peers by Bonjour hands the same stream over, so they belong
to whatever satisfies the port.

`adapters/lan-node` is the first thing that satisfies it: `dgram` for the group, `net` for the
links. An adapter rather than part of the package because `packages/*` are runtime-neutral
(D01-B) — the lint rule caught the first draft, and it was right. Proven on the loopback: two
devices find each other by datagram, dial over TCP and complete the handshake. Multicast itself
is not tested, deliberately — whether an access point carries it is a fact about the room, and a
test that depended on it would fail on exactly the networks where the `seeds` path exists.

One real bug came out of the virtual network and would have been a real one on a real socket: a
stream can deliver bytes **before the reader is attached**, and the bytes in that gap are the
peer's hello. A Node socket starts paused for precisely this reason. The port now says so, and
the stand-in holds what arrives until somebody is listening.

## `awdl()` and `wifiAware()` — DONE (ch. 16)

`packages/p2p-wifi`, over an injected `P2pFabric`. There is no access point here and no address
to dial: the platform publishes a service, reports who else is running it, and opens a data path
to an opaque handle. That is the whole port.

**Two adapters, one body.** The code is shared because the shape is shared; what is not shared is
which radio is on the wire, and that is the fact a mixed fleet reads off `$status`. Each keeps
its own `kind`, its own service name and its own fabric — and a fabric handed to the wrong
adapter fails where it is wired rather than looking configured and finding nobody, which is
exactly the failure a merged `p2pWifi` would hide. Both run the full transport contract over a
three-device chain, and an AWDL device and a Wi-Fi Aware device in one room are proven not to
see each other.

Left out: any real fabric. AWDL and Wi-Fi Aware need platform frameworks this machine does not
have, and the port is the honest boundary — what is missing is a native module, not a design.

## `PeerSession` — DONE (ch. 16)

`createPeerSessions()` in `@syncmesh/transport`, and the mesh now holds one. A link whose peer
the handshake has **proved** joins that peer's session instead of building a bridge of its own;
the session multiplexes its links behind one `FrameLink`, and `pickRoutes` chooses per frame —
so a snapshot page takes the access point and a 40-byte presence value stays off an expensive
radio, with the class read off the wire (`classOf`) rather than decoded.

Two changes fell out of it and both are improvements on their own:

- **A link is attached when it is named, not when it is opened.** Every adapter now calls
  `attach(frames, peer)` inside `onEstablished`. A hint, a service-information blob and an
  announcement are all claims anyone can make, and attaching on one names a conversation nobody
  checked.
- **Mid-transfer resume is not built.** Progress is cursor state and the cursors belong to the
  session, so a link dying during a transfer is a link and not a transfer.

Two real defects came out of writing the tests, and both would have been real on real hardware:

1. **A duplicate dial.** Platforms report a peer for as long as it is there, not once, so the
   second report arrived while the first `connect` was still awaiting and opened a second path.
   The far end accepted only one; everything written to the other was lost. Both `lan()` and the
   Wi-Fi adapters now hold an in-flight set.
2. **Reordered delivery in the virtual networks.** Bytes buffered before a reader attached could
   be handed over *after* bytes that arrived later — which delivers a peer's sealed frames ahead
   of the hello that makes them readable. A real socket never does this, and neither do the
   stand-ins now.

Left out: the admission gate still counts links per transport rather than taking its seat per
session. The gate's inputs are already peer-keyed, so this is a rewiring rather than a design.

## Sealed partitions — DONE (ch. 14)

A partition's content travels as an opaque payload. Every carrier — another device, a relay, the
server's custody role — verifies the author's signature, stores the envelope, relays it, counts it
towards coverage, **and folds nothing out of it**, because there is nothing it can read.

The seam turned out to be one line of the fold path, not a rewrite of it: *an event whose changes
could not be opened decodes to an empty change list, and an empty change list already folds to
nothing.* Coverage advances, the cursor moves, the bytes relay verbatim. `event.sealed` exists
only so a device can **say** why it folded nothing; nothing in the engine branches on it.

- **Keys ride inside grants and nowhere else** (`KEY.keys`, additive). The grant is already the
  thing that says which device may see which partition, and a second channel would be a second
  answer to that question. Each key is wrapped to the device's own X25519 — derived from the
  Ed25519 key that *is* its peer id, so anyone who can address a device can seal to it without a
  second key to publish, revoke or get wrong. `Identity` gained one method, `agree`.
- **The payload is bound to its place.** The AAD is author, sequence and partition, so a sealed
  payload cannot be lifted out of one event and into another — a belt-and-braces check, since the
  signature covers the whole core anyway, but one that needs no argument about ordering.
- **A device with no key is refused the handle, not the write.** `mesh.on("clinic:ward-3")`
  answers `PartitionSealed`. Both directions are affected: a read would answer "empty" for data
  that exists, and a write would have to either leave in the clear — defeating the seal for
  everyone — or fail somewhere a person cannot see.
- **The trade is stated in the doc comments, not buried**: sealing buys operator-proof custody
  and costs server-side judgment.

Two deliberate departures from the book's sketch:

1. `sealed` is a **list of kinds on the manifest**, not `sealed: true` inside the partition tree.
   The tree is a tree of kinds, and a boolean in it would be a node that is not one. The list is
   also the only place the whole set is visible at once, which is what a person deciding what a
   server may judge wants to read.
2. **What stays in the clear is stated.** Author, sequence, clock stamp and partition travel
   readable, because routing, admission and ordering are done by devices that hold no key. A
   sealed partition hides content — tables, rows, columns, values — and not the fact that
   somebody wrote something. There is a test asserting the table and row names are absent from
   the bytes, and that the partition is present.

Proven at both ends: the codec's own tests, and an A—B—C chain where the middle holds no key,
carries the event whole with the author's signature, quarantines nothing, and folds no row — while
the far end reads the plaintext.

Left out: `.authority()` calls sealed to the service (ch. 14 says they still work; the handler
side of that is a separate piece), and key rotation — a content key today is minted once and
travels in every grant that admits the partition.

## `$recovery.rebuild` — DONE (ch. 18)

The last resort, and mostly a set of refusals — which is the right shape for one.

It asks every source that can hand over state (`Transport.requestSnapshot`, new, built the same
way `resync` is) and adopts the first answer **something vouched for**: a checkpoint certificate
this device could verify. Three things it never does, each for a stated reason:

- **It never resets storage.** The rows merge through the same field-level merge every other
  source goes through, so a tombstone newer than the snapshot's write still wins and nothing is
  resurrected. That was already true of `installSnapshot`; `rebuild` adds no second path.
- **It never deletes the outbox.** This device's own unacknowledged writes are exactly what
  nobody else can give back, so they are counted (`unacknowledged`) and reported, and by default
  their presence *refuses* the rebuild — `preservePending: false` says the person understands.
- **It never adopts a snapshot nobody signed for**, unless asked in as many words. A provisional
  install still happens (the rows merged, as any source's would); what is refused is calling it a
  rebuild.

Silence ends in `HistoryUnavailable` naming the sources tried, with export as the exit — a
durable report and not a spinner, which is the book's exact requirement. A room where nothing can
hand over state says so immediately rather than waiting out the deadline.

Left out: the book's `{ operationId }` addressing on `list`/`explain`/`export` — this surface is
event-addressed, and operation records already carry the event id, so the mapping exists but the
signature change does not. And `source: "authority"` — sources are asked all at once rather than
named, because a device that can reach the authority reaches it through a transport it cannot
name from the outside.

## The smaller leftovers — DONE

**`mesh.churn`** (ch. 17). The budget keeps each radio's *best* links, which is right per device
and wrong for the room: six phones that admitted each other first stay admitted, and the seventh
never gets in — a clique, indistinguishable from a working mesh from the inside. Churn drops one
link now and then so a slot opens. Two rules keep it safe: it acts **only on a medium at its
budget** (a radio with a free slot can already admit a newcomer, so a drop there buys a reconnect
and nothing else), and it never drops a device's only link, which is the island it exists to
prevent. On by default at five minutes, which in a small room costs exactly nothing.

`mesh.maxLinks` from the book's sketch is deliberately **not** exposed: it is a property of the
radio, declared by the medium, and an app handed a way to raise it has been handed a way to break
the links it already has.

**Fan-out metering** (gap audit №7). Ingress rate limiting prices a flood at what it costs to
*receive*, which is the cheap half — one event in a room of five hundred is five hundred sends.
The sender now pays for the sends its event caused: `receivers` tokens on a `fanout` bucket,
charged **after** the fact, because how many clients an event reaches is not known until it has
reached them. The next frame from that socket is what pays. Two details that matter: the debt may
go negative (owing is what makes the next frame wait rather than the debt vanishing), and a frame
is *asked* about fan-out rather than taxed for it — an event in a room of one amplifies nothing
and costs nothing.

**Retention defaults** (gap audit №8). The two halves got different answers, and the asymmetry is
the point. Blobs are content-addressed: a room that drops one answers `blob-missing` and whoever
still holds the bytes puts them back — so they get a **default ceiling** of 1 GiB. A trimmed
event is gone from this hop for good, and trimming stops the room being somewhere a *new* device
can bootstrap from history, so it gets a **named preset** (`DURABLE_RETENTION`, thirty days)
rather than a default that picks itself. What closes the gap is that a room keeping its log
forever now says so — one `relay.retention.unbounded` at open. An operator should learn which of
their rooms grow forever from a dashboard, not from a disk alert.

**The telemetry inspector** (gap audit №24). All three layers emitted; nothing read — which is
the blank panel D17 rejected a string-keyed map to avoid, arrived at from the other side.
`createInspector()` is one reader over the whole union, handed to a device and a relay alike: it
counts, sums every `sizes` field under its own name, and times. Percentiles are over the last
`keep` samples and say so — a running process cannot hold every duration it ever measured, and a
relay that was slow an hour ago and recovered is not slow. `report()` is a few lines a person can
paste into an issue.

## Phase 4's gate, demonstrated

The book asks for *thirty simulated peers in one room: no islands, budgets hold, transfers
survive link swaps*. What is now in `packages/lan` is thirty real `lan()` transports over thirty
real engines, wired as a **ring**.

A ring rather than a crowd, deliberately. Thirty devices that can all see each other form a full
mesh, and a full mesh has no islands the way a single room has no corridors — it proves nothing
about the thing that actually fails. In a ring each device hears only its two neighbours, so a
write reaches the far side only by being carried fifteen times, by fifteen devices with no
interest of their own in it. Three writers spread around the circle, every device holding all
three at the end, and zero quarantines anywhere on the way round.

The second case cuts the ring — one device stops entirely — and a write still reaches both ends
the long way, which is the "transfers survive link swaps" half.

What it does **not** show is budgets holding: LAN declares no `maxLinks` (an access point is not
a controller), so there is nothing to hold. That half is proven where the budget lives, in the
admission tests and in the Wi-Fi adapters' `maxLinks` of four.

## The door, opened — and content-key rotation

Two things the earlier passes left stated rather than built.

**The admission gate was wired to nothing.** It existed, it was tested, and no code path asked
it — a door nobody opens. It is now consulted when a link's handshake proves a peer, and
consulted **once per peer session** rather than once per link: a device reachable over the access
point and over peer-to-peer Wi-Fi is one conversation, and asking twice would let two answers
disagree about the same peer with the later one winning by accident. A denial closes the
conversation on every medium at once.

It asks *after* attaching, deliberately. The gate shapes topology only — an allowed connection
grants no data access, and anything arriving in the moment before a denial lands still faces the
grant and the `allow` rules exactly as it would have. What that order buys is that nothing is
lost while the answer is outstanding: a link held open with no bridge behind it drops whatever
the far side says into it. `mesh.group` and a `mesh.admit` handler are now reachable from
`createMesh`.

**Content keys rotate.** A device that once held a sealed partition's key holds it forever —
nothing can reach into it and take it back. What an issuer *can* do is mint the next epoch and
leave that device out of it, and that is what makes revoking a device mean anything for a sealed
partition. So: every sealed payload names its epoch, a grant carries a **list** of
`(partition, epoch, wrapped)` rather than one key per partition, and a key ring holds every epoch
it was given — the newest to write under, the older ones to read its own history with. A device
cut out at the turn keeps what it carried and reads nothing written since, which is proven both
ways.

## The packaging bugs the full build found

`vp run -r build` failed on `packages/tanstack-db`, and the failure was mine rather than the
dependency's. The package names `Live<T>` in its **public** signature but declared
`@syncmesh/drizzle` as a *devDependency* — and tsdown externalizes `dependencies` and
`peerDependencies` only, so a devDependency gets **inlined into the emitted types**. Inlining
`@syncmesh/drizzle`'s types dragged in drizzle-orm 0.45.2's whole `.d.ts` graph, whose internal
re-exports (`NeonAuthToken`, `RequireAtLeastOne`) are broken. The build order was wrong for the
same reason — `build` depends on `dependencies`, and this package had none.

The rule the failure states: **a package whose public types name another package depends on it.**
Two more had the same shape and would have shipped broken:

- `@syncmesh/lan` imported `parsePeerId` from `@syncmesh/kernel` **at runtime** with kernel as a
  devDependency. It packed cleanly and would have failed to resolve on install.
- `@syncmesh/p2p-wifi` reached into `@syncmesh/engine` for the `Unsubscribe` type in its public
  fabric. Fixed by removing a dependency rather than adding one: `@syncmesh/transport` owns
  `ByteStream`, whose shape returns an `Unsubscribe`, so it now exports the type and every
  adapter over a stream names it from the package it already depends on.

`vp run -r build`, `-r typecheck`, `run test` and `run ci` are all clean.

## The transport API, rebuilt against libp2p's — DONE

`research/libp2p-study.md` has the reading; this is what changed.

**The adapters were doing four jobs.** `lan()` announced and listened (discovery), decided who
dials, opened a socket (transport), and then framed + encrypted + attached (upgrade). libp2p keeps
those four apart, and the reason showed up on inspection: **the only thing making every link
encrypted was that the same three lines had been written out four times.**

- **`createUpgrader`** now owns everything between a channel and the bridge. An adapter hands over
  `upgrade.bytes(stream)` or `upgrade.frames(link)` — two doors because a socket streams bytes and
  a radio that fragments below this line already has boundaries — and gets back an `Upgraded`. It
  also closed a real gap: frames arriving between the handshake and the door's answer are **held
  and replayed** rather than dropped, so a link no longer costs a wasted round trip.
- **The door is a ladder.** `stage: "dial"` refuses on what an announcement *claimed*, before a
  socket and a handshake are spent; `stage: "proven"` has the signature. The single seat moved to
  `oneSeatPerPeer`, which dedupes in flight as well as across an open conversation — two media
  finishing their handshakes a millisecond apart used to ask twice.
- **`channelTests`** asserts the pipe is a pipe: many writes, a megabyte, both ends at once, the
  gap before a reader attaches, writes after close. Run by both virtual mediums *and* by real
  sockets on the loopback. Both defects found while building the adapters live below this line,
  and neither was visible in a convergence test.
- **Churn gives up the cheapest link, not a random one**, ranked on the facts the budget already
  uses. Random is the obvious implementation and the wrong one: it eventually drops the peer
  holding everything this device still needs.
- **`mesh.maxConnections`** — a ceiling across every medium, beside each medium's own budget. A
  radio's limit is about the radio; the ceiling is about the process holding all of them.
- **`webSocket({ id, bootstrap? })`** is one export. `webSocketListener()` and `http()` are cut —
  the second because ch. 19 already says the HTTP door is `server.fetch`, which has no handshake,
  no grants and no cursors.

Declined, with reasons in the study: multiaddr, a universal discovery/transport split, and
conditional exports in place of injected ports.

## The browser, made durable — and the claim that said it already was

`research/browser-durability.md` has the full argument; this is what changed and why it had to.

**The adapter's doc comment was wrong, and it was wrong in the direction that hides the bug.** It
said `opfs-sahpool` is "synchronous on the page's own thread, no COOP/COEP needed". The second half
is true and the first half is unattainable in a window in any browser: `createSyncAccessHandle` is
`[Exposed=DedicatedWorker]` — TypeScript's own libraries declare it in `lib.webworker.d.ts` and not
in `lib.dom.d.ts` — and both OPFS backends gate on that one method. Serving COOP/COEP to get a
`SharedArrayBuffer` does not help: the `opfs` VFS clears that gate and then fails the same probe.
So `apps/issues` fell back to a memory database and showed a red badge, honestly, and lost
everything on reload. E04 had recorded the correct reading first, then withdrawn it; both E04 and
the adapter now say the rule, and `wasmSqliteDriver` called from a window now *says it in the
error* rather than leaving somebody to find a blog post.

**The premise that kept this unfixed was also wrong.** "A `SqlDriver` is synchronous, so you cannot
just run it in a worker" — but `run`, `all`, `transaction` and `close` have always returned
promises. Only the *binding* is synchronous, and `bindSqlite` was exported years ago with the doc
line "for a binding whose calls are async". So the fix is a use of the port, not a change to it:
`asyncSqliteDriver` beside `sqliteDriver` in `packages/storage` (sharing its `BEGIN IMMEDIATE`
statements, declared once), and in the adapter a host, a page-side client and a worker entry.
`wasmSqliteDriver` starts the worker itself, so `apps/issues` became durable **without a line
changing in the app** — its `openDriver()` ladder had been written for exactly that.

The wire is certified by the suite that already existed rather than a parallel one: `driverTests`
runs over a `MessageChannel` with the host in-process, 35/35 — transactions, a body that throws and
rolls back, blobs, read filters — because `serveSqlite` takes a port and cannot tell a worker from
a channel. Measured cost: **0.0142 ms per round trip** over 2000 page↔worker calls, which settles
the "too chatty" objection at four decimal places.

**What the second tab taught.** SQLite's pool takes exclusive access handles for a whole origin
*directory*, not per database, so the second tab of an origin is refused even for a name nobody has
opened. That refusal is now `OpfsPoolHeld`, its own tag, decided by an exclusive Web Lock taken
*before* SQLite is touched — a yes/no instead of a `DOMException` about writable streams from
halfway through an install — and the app's badge says "another tab owns the database" instead of
implying the browser cannot save.

**What it does not do, and the trap in the obvious fix.** Two tabs still do not share a database,
and the two ways that look easy are both unsound: a `SharedWorker` cannot own an OPFS database at
all (measured: `createSyncAccessHandle` is `undefined` there too), and a Web Locks leader owning
merely the *file* would give two engines one log under one device identity — this epic's own
"Watch out", where both boots read the same `lastSeq` and stamp events peers then discard as stale,
invisibly. The answer is one engine per origin: the mesh in the leader's dedicated worker, a
`SharedWorker` as rendezvous only, and followers as thin clients sharing the leader's identity and
log — **not** as peers, because a peer owns a log and only one context of an origin can persist
one, so per-tab peers are per-tab *memory* peers. Specified, not built.

**Stage 2, the half that speaks: `Mesh` and `Api` over a `WirePort`.** `serveMesh(mesh)` in the
elected worker and `connectMesh({ link, schema })` in every tab, over a `MeshLink` that the
election hands across. Two shapes on one port, which is the whole difference from the SQLite wire
beside it: the host **speaks first**, broadcasting each `FoldBatch` to every tab that subscribed,
and that is what re-renders a `useLiveQuery` in tab B because tab A wrote.

The seam that made it small is Drizzle's own: a proxy callback is handed `(statement, params,
method)` and told nothing about who asked, so a tab's `db.transaction()` posts `begin`, its
statements and `commit`, and the *host* feeds them into its handle's capture — one signed event of
the origin's one device, written from a window that holds no engine. The same trick read backwards
is how a follower reads. Two tabs on one `Handle` is the hazard `createProxy` already warns about
("never fire statements at a handle from a task running beside its transaction"), so the host takes
a **turn** on the handle for a tab's whole span and a tab that dies mid-span has its transaction
rolled back rather than wedging the others.

**Mirror or read over the port, measured rather than argued.** `bun run --cwd bench browser`, same
query, same database: +0.0018 ms at one row, **+0.035 ms at a hundred**, +0.23 ms at a thousand, on
a 0.0023 ms message floor. A statement and its whole result set are one round trip, so it does not
scale per row. No mirror: what it would buy back is 0.035 ms, and what it charges is a second
materialised copy of every table in every tab plus a second fold pipeline to keep it current —
which is the second engine over one log this design exists to prevent, arriving as a "cache".

`@syncmesh/orpc`'s `meshApi` binds to a follower unchanged, because it was narrowed to `ApiMesh` —
the six members it actually reads — rather than taking `Mesh` whole. So the app's own api in a tab
with no engine is one implementation, not two, and that is the acceptance test: two clients on two
`MessageChannel`s, a write through one re-renders a live query on the other, and a tab closing
leaves `host.census()` at zero.

## Still open (the honest remainder)

Nothing below is blocked on a decision; each is either large, or needs something this machine
does not have.

**Needs hardware or a native module.** A real `P2pFabric` for AWDL and for Wi-Fi Aware: both
adapters are built and proven against a virtual fabric, and what is missing is a platform module.
The BLE device checklist (gap audit №9) likewise: the stack is proven against a virtual radio,
and two donor mechanisms are recorded as wrong until a real controller says otherwise.

**Smaller leftovers.** Sealed `.authority()` calls — ch. 14 says they still work, sealed to the
service; the client half is built (a handler's mesh is a mesh like any other) and what is missing
is the server side choosing to hold a partition's key. And the admission *budget* still counts
links per transport while the *door* now counts peers; both are correct for what they do, but a
radio's `maxLinks` and a session's seat will eventually want to be the same number.

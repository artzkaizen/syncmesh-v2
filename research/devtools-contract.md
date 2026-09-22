# What a devtool can read out of a running syncmesh client, and what it cannot

Read from the source on `t3code/8d5681ce`, not from `dist/` and not from `research/API.md`, because
the `$`-surfaces were re-spelled in `b598b8d` and that doc predates it. Every citation below is
`file:line` in `packages/`.

## The finding, in one line

**Everything about *links, peers, grants, writes and health* is already readable; the *log itself*
is not.** A devtool can show you why a device is stuck, who it can reach, what it has not delivered
and how long a fold took — but the one panel a developer opens first, "show me the events", has
exactly one API behind it: `engine.eventsSince(new Map())`, which decodes the entire synced log into
memory on every call and returns it ordered by author rather than by time (`interest.ts:198-206`,
`dialect-sqlite.ts:163-166`).

The second finding is the shape of the seam. Three of the four cheap facts a devtool wants per panel
are **derived from the same two hubs** — `engine.onFoldBatch` and `engine.onAcknowledge`
(`engine.ts:333`, `engine.ts:328`). A panel-per-subscription design pays the fold tax once per panel,
on every write. The contract below therefore has **one** coalesced feed and N pull-shaped readers,
and that is the single most important thing in this document.

## 1. The survey

### 1.1 The `$`-surfaces

`Client<R, PC>` (`orpc/client.ts:30-70`) is `Api<R>` plus fifteen `$` members assigned at
`client.ts:84-101`. Every one is a property of `Mesh` (`client/src/mesh.ts:60-164`) re-exported
unchanged — no wrapper, no serialisation, no filtering.

| Surface | Yields | Kind | Cost |
| --- | --- | --- | --- |
| `$operations` | `get`, `byEvent`, `unsettled`, `receiptsOf`, `onChange` | mixed | **Async SQL.** `unsettled()` is a `LEFT JOIN` with no `LIMIT` (`dialect-operations.ts:38-40`). `undefined` over a bare event store (`mesh.ts:335`). |
| `$recovery` | `list`, `explain`, `export`, `run`, `rebuild` | snapshot + mutators | `list()` is `engine.quarantine().map(issueOf)` — an array walk, bound 128 (`quarantine.ts:105-108`). |
| `$status` | `get()`, `subscribe(cb)` | snapshot + subscription | `get()` calls `condition?.()` per source and `recovery.list()` every time (`status.ts:72-89`). |
| `$transports` | `list()` | snapshot | Hands back **live `Transport` objects with methods**, not data. `add`/`remove` mutate. |
| `$peers` | `graph()`, `reaching(peer)` | snapshot only | O(transports × `reaches().size`); `reaching()` rebuilds the whole graph per call (`peers.ts:70`). **No subscription.** |
| `$routes` | `to`, `all`, `advertise`, `onChange` | snapshot + subscription | `all()` prunes expired entries as it reads (`routes.ts:132-138`). `serve`/`learn`/`lost` mutate. |
| `$blobs` | `has(hash)`, `retained(hash)` | snapshot | **No `list()`.** Everything else spends the network. |
| `$grants` | `all`, `grantFor`, `expiring`, `onRegistered`, `onForgotten` | snapshot + subscriptions | Free. `wireFor`/`allWires` return **signed bearer bytes**. |
| `$auth` | `status()`, `principal()`, `subscribe` | snapshot + subscription | `signOut` **stops the mesh** (`auth.ts:89`). |
| `$drafts` | `get(key)` | async | One indexed SELECT. **No key enumeration.** |
| `$presence` | per topic `peers()`, `subscribe` | snapshot + subscription | `peers()` memoised through a `WeakMap` (`presence.ts:76-90`). Needs instance *and* topic. |
| `$inspect` | `handles()` | snapshot | `links` recomputed live from the radios (`inspect.ts:143-145`). Cheap. |
| `$accounts` | `disputes()` | snapshot | `link`/`unlink` **author events**. |
| `$mesh` | the whole object | mixed | The escape hatch every interesting panel goes through. |

Two things a devtool needs that are **not** on this list: the **schema** (to enumerate tables,
partition kinds, sealed kinds, presence topics) and a **read-only driver**. `Booted.driver` exists at
`client/src/boot.ts:60`, is consumed by `openHandles` and `createDrafts`, and is then dropped.

### 1.2 The engine

- **`onFoldBatch`** (`engine.ts:150`, emitted `fold.ts:104`) — the hottest hook in the system. It
  runs inside the write path; the hub is a synchronous `Set` walk (`listeners.ts:16-23`).
- **`onTelemetry`** (`engine.ts:164`) — fires *twice* per write path: `writes.ts:105` and
  `fold.ts:85`.
- **`onAcknowledge`** (`engine.ts:138`) — every cursor exchange on every link. Carries only a peer
  id; the caller must re-read `acks()` to learn anything.
- **`onQuarantine`** (`engine.ts:163`) — cold by construction. A healthy mesh never fires it.
- **`acks()`** (`engine.ts:327`) — builds a **fresh Map per call**, and silently discards the
  timestamp: the internal `Ack` is `{ cursors, at }` (`engine.ts:230`) and `at` never escapes.
- **`quarantine()`** (`engine.ts:156`) — each `Parked` carries `entry.core`, the **raw signed bytes
  of somebody's event** (`quarantine.ts:58-75`).
- **`state()`** (`engine.ts:92`) — the *entire* folded state by reference. Free to call, ruinous to
  render.
- **`eventsSince()`** (`engine.ts:146-149`) — see the headline. No limit, ordered `peer, seq`,
  local-only events invisible by construction.

**Mutators a devtool must never call**: `mutate`, `receive`, `receiveBatch`, `receiveChunk`,
`revert`, `adoptCoverage`, `acknowledge`, `compact`, `installSnapshot`, `repairRows`,
`retryQuarantined`, `rememberCertificate`.

### 1.3 Telemetry and the inspector

`TelemetryEvent` (`telemetry.ts:125`) is thirteen variants across three layers; every one carries
`sizes` and `duration`, deliberately, so a reader need not narrow (`telemetry.ts:114-124`).

**The relay half never reaches a client.** `followTelemetry` re-emits only `engine.*`
(`client/telemetry.ts:195-201`) and `MeshTelemetry` is typed to exclude `relay.*`
(`client/telemetry.ts:13-16`) — D17 left "may relay telemetry name peers" open. A device-side devtool
sees seven of thirteen, and the six it cannot see are the only ones that count **event bytes**.

`createInspector` (`inspector.ts:75`) already does the counting, with percentiles over the last 256
samples in a ring (`inspector.ts:111-114`). **The devtool must use it rather than re-counting** — not
for elegance, but because `note` is the one listener that can be attached once and shared, and a
second counter doubles the work done inside `fold`.

### 1.4 Storage — what a devtool could query

Two dialects, two sets of names: SQLite (on-device) uses bare names, Postgres prefixes `_syncmesh_`
because it is the app's own database (`dialect-operations.ts:3-7`). The tables are `events`,
`state_rows`, `state_cursors`, `compaction`, `state_scope`, `operations`, `receipts`,
`_syncmesh_row_sync`, `_syncmesh_acked`, `_syncmesh_changes`, `_syncmesh_capture`,
`_syncmesh_drafts`, plus the app's own with a `"_partition"` column.

Safe and useful reads:

```sql
SELECT peer, COUNT(*), MAX(seq) FROM events WHERE local = 0 GROUP BY peer;
SELECT tbl, COUNT(*) FROM state_rows GROUP BY tbl;
SELECT status, COUNT(*) FROM operations GROUP BY status;
SELECT SUM(length(core)) FROM events;
PRAGMA user_version;
```

Note `length(core)`, never `core`: that column holds the exact bytes the author signed
(`event-store.ts:12-21`).

**Three writes that are not obviously dangerous and are.**

1. `UPDATE _syncmesh_capture SET armed = …` (`dialect-sqlite.ts:79-80`). Arming capture outside the
   writer's transaction makes the next fold's own UPSERTs get re-captured into events. One line, and
   the replica is corrupt.
2. `DELETE FROM _syncmesh_changes` (`dialect-sqlite.ts:82`). Loses a write that has not become an
   event yet.
3. **Any `INSERT`/`UPDATE`/`DELETE` through `mesh.on().db`.** The Drizzle proxy classifies statements
   by regex — `/^\s*(insert|update|delete)\b/i` at `drizzle/proxy.ts:42` — and a match **authors a
   signed event**. A devtool "just fixing a row" through the handle has written to every peer.

There is no `dbstat` reader anywhere; storage *size* is a platform fact the caller supplies
(`budget.ts:39-45`), so a Storage panel can show row counts and cannot show bytes on disk.

### 1.5 Transports, peers, routes, the door

`Transport` (`transport.ts:137-238`) is a two-tier port and **an absent capability is a fact about
the medium, not a bug**. `reaches?()` absent means "cannot say", never "no peers".

`PeerSessions` (`peer-session.ts:49-67`) has `peers()` and `get().carriers()` — the latter documented
as existing "for `$status` and for a person reading a log". **It is wired to neither.** The instance
is created in `transportContextFor` (`client/transports.ts:170`) and nothing on `Mesh` holds a
reference, so `$peers.graph()` rebuilds a weaker version of the same fact.

`Bridge.onError` exists (`bridge.ts:116`, implemented `bridge.ts:349`) and **nothing outside tests
subscribes to it**. `Transport` declares no `onError` at all. `UpgradeOptions.onRefused`
(`upgrade.ts:57`) and `FrameTransportOptions.onDropped` are adapter-facing constructor callbacks, not
readable from a running mesh. The admission gate computes a verdict and discards it
(`gate.ts:119-132`).

### 1.6 The handle tally

`HandleCounts` (`client/inspect.ts:14-25`) is five refcounts. The chaos epilogue asserts they are
zero after teardown, which makes this the one existing surface with a **correctness** use: a non-zero
`observers` after a screen unmounts has found a leak, not a statistic.

## 2. The panel plan

Four changes to the obvious seven, each with a reason.

**Cut Queries.** There is no seam. `createLive` keeps a shared refcounted map keyed by the query's
chunk-tree identity (`drizzle/live.ts:82`, `live.ts:186-199`) and nothing exposes it;
`$inspect.handles().observers` is a *number*. A Queries panel today renders "6" and nothing else.
Fold the number into Overview; the real panel is gap 5.

**Merge Events and Recovery into one Sync panel.** `$recovery.list()` is literally
`engine.quarantine().map(issueOf)` (`recovery.ts:179`) — the same array, presented. Two tabs over one
structure teaches a reader they are different things. They are the two halves of one question: where
has this device got to, and what is stuck below that.

**Promote Grants to its own panel.** It is the answer to the commonest support question in a
permissioned mesh — *why will this device's writes not appear anywhere* — and it has the most already
built behind it.

**Demote Telemetry to Timings, aggregate-only.** It is not a stream a person reads; it is
`createInspector().stats()` sorted busiest-first. A raw feed here is how you build a panel that costs
more than the fold it measures.

### The seven

1. **Overview** — health, identity, settle state, handle counts, four glance numbers. All snapshots;
   refresh on status/auth/link plus a 1 s floor for `settled`, which is a promise nothing
   re-announces (`status.ts:59-63`).
2. **Sync & Recovery** — coverage per author, acks, holding, parked events with their one-sentence
   next step. Coalesced to 4 Hz: `acks()` allocates per call and `ack` fires per exchange per link.
   *Deliberately no event list.* See gap 1.
3. **Transports & Peers** — one row per medium, one per peer, plus the route table. `$routes.onChange`
   is exact and free; peers must be **polled** at 1 Hz because `Peers` has no subscription.
4. **Storage** — migration, per-author counts, compaction floors, row counts, log bytes. Manual plus
   an optional 5 s poll. **Never on `fold`** — a catch-up would run `COUNT(*)` per batch.
5. **Writes** — unsettled ledger, receipts, corrections. On `$operations.onChange`, which already
   fires only after a receipt lands. Renders "this mesh has no write ledger" when the surface is
   `undefined`, not an empty table.
6. **Grants & Identity** — this device's grant, all held grants including expired, what expires
   soonest, revocations, links, disputes. **Never render `wireFor`/`allWires`.**
7. **Timings** — `createInspector().stats()` as a table, polled at 1 Hz. Do **not** re-render on
   `note`. The panel must say in words that the relay's variants never arrive here, or a reader will
   conclude the relay is idle.

## 3. The read-only contract

The rules it encodes:

- **Snapshots return plain data.** No `Transport`, no `Engine`, nothing with a method on it. A panel
  that can serialise its input can run in another window, another process, or a test.
- **One coalesced feed.** `onChange` is the only subscription a panel may hold, so
  `engine.onFoldBatch` is subscribed exactly once for the whole devtool.
- **Every async read says so in its type.** A `Promise` means SQL or the log.
- **Nothing here mutates.** No `run()`, no `rebuild()`, no `add`/`remove`. An operator action is a
  separate surface a host app opts into.

```ts
export type DevtoolsChannel =
  | "fold" | "ack" | "link" | "route" | "grant" | "auth" | "quarantine";

export interface DevtoolsSource {
  readonly identity: () => DevtoolsIdentity;
  readonly overview: () => DevtoolsOverview;
  readonly sync: () => DevtoolsSync;
  readonly links: () => DevtoolsLinks;
  /** Async: SQL. Never call this from a `fold` handler. */
  readonly storage: () => Promise<DevtoolsStorage>;
  /** `undefined` when this mesh keeps no write ledger. */
  readonly writes: ((limit: number) => Promise<DevtoolsWrites>) | undefined;
  readonly grants: () => DevtoolsGrants;
  /** The shared inspector's aggregates, busiest first. Poll; do not subscribe. */
  readonly timings: () => readonly TelemetryStats[];
  readonly syncOf: (table: string, key: string) => SyncState | undefined;
  /** Read-only SQL, or `undefined` where the host supplied no driver. */
  readonly sql: DevtoolsSql | undefined;
  /** The one subscription a panel may hold; coalesced on a microtask. */
  readonly onChange: (listener: (moved: ReadonlySet<DevtoolsChannel>) => void) => Unsubscribe;
  readonly close: () => void;
}
```

The full member types — `DevtoolsIdentity`, `DevtoolsOverview`, `DevtoolsSync`, `DevtoolsLink`,
`DevtoolsPeer`, `DevtoolsRoute`, `DevtoolsStorage`, `DevtoolsWrite`, `DevtoolsGrant` — live in
`packages/devtools/src/contract.ts`, which is the implementation of this document.

Three things deliberately absent, so nobody adds them back by accident.

**No `events()`.** A field a panel cannot fill honestly is worse than a missing one. See gap 1.

**No `state()`.** `engine.state()` hands back the device's entire folded state by reference. A panel
wanting rows goes through `sql.query` or the app's own handle, both bounded.

**No `export()`.** `$recovery.export(id)` returns the author's signed envelope — a deliberate
operator gesture, not something a panel offers behind a copy icon.

None of the three has moved, and the controls below are not the back door for them. `events()` is
still absent because gap 1 is still open, not because nobody wanted it; `state()` and `export()` are
still absent because they hand over data rather than change behaviour, and a surface that can switch
a radio off is no argument for a surface that can print somebody's rows.

### 3.1 The operator surface, and why it is a second argument

`DevtoolsSource` stays read-only. The controls are a **separate, optional object the host passes
in**, `DevtoolsControls` in `packages/devtools/src/controls.ts`, built by `createMeshControls(mesh)`
and handed to `<SyncmeshDevtools controls={…} />`, which passes it to every panel as
`DevtoolsTabProps.controls`. A host that passes nothing gets an inspector with no path to a mutator
at all, and that is what a production build does — one prop fewer, rather than a flag it has to
remember to unset.

**Why separate rather than three more members.** The read-only property of `DevtoolsSource` is not
a style preference, it is what pays for the other three rules. Snapshots are plain serialisable
data *because* nothing on the interface is a live object with a method; `onChange` can be the only
subscription a panel holds *because* nothing a panel does can invalidate a reading out of band; the
whole devtool costs three engine subscriptions *because* the source is a reader and readers can be
shared. Adding `force` to that interface would have made every implementation of it — the fixture,
a source over a worker, a source in another process — responsible for a mutation it has no business
performing, and would have deleted the one sentence a reviewer can check: *a panel cannot change
the mesh*. Now the sentence is still checkable, and the exception is a named type that is
`undefined` by default. A panel renders its absence the way it renders an absent `storage` or
`sql`: as a sentence, never as a disabled control, because a disabled control reads as broken and a
sentence reads as a fact about this build.

**Why it exists at all.** Not convenience. The Transports panel renders four distinct states for a
medium — carrying, *cannot say*, offline, refusing — and on a laptop there was no way to reach
three of them. You cannot turn off a real Bluetooth radio from JavaScript, put a LAN peer out of
range, or make a relay flap, and Chrome's own offline toggle only knows about HTTP. A panel whose
states cannot be produced on the machine it is written on is a panel nobody has seen work.
(LiveStore's devtools ship no sync controls at all; their state-changing features are export/import
and a SQLite playground. This goes further on purpose, for that reason.)

**Decision 1 — "off" is parking, not removing.** `remove(name, { drain })` drops the transport and
loses the instance, so re-enabling would need the devtool to construct a replacement — and a
transport the devtool built is one the app never configured, which is exactly the half-configured
state that must not be reachable. So `RunningTransports.force(name, as)` **stops the real medium
and keeps it**, and seats a stand-in at the same index (`packages/client/src/forced.ts`).
`release(name)` puts the original object back and calls `start` through the same path `add` uses,
so what comes back is a medium in a state the device could have reached on its own. The index
matters: attach order is the order `$peers` reports a peer's mediums in, and a radio that came back
at the end of the list would silently re-order somebody's diagnosis.

The stand-in **copies the capability shape** rather than inventing one. A stand-in for a medium
that could enumerate its links enumerates none; a stand-in for one that never could still cannot,
and is still reported in `DevtoolsLinks.silent` as *cannot say*. It declares no `blobs`, no
`sendPresence`, no `caughtUp` — all of which are true of a radio that is off — and its `onStatus`
answers `false` **on subscribe**, because `undefined` from a status hub means *has not said* and a
medium somebody just switched off has said, and said no.

**Decision 2 — one knob, not two.** "Pause sync" is not a second control. A paused device *is* a
device with every medium off, and offline→catch-up is behaviour the engine already implements: the
events a held device does not send are still in its log, and the peer it was not talking to learns
about them from the cursor exchange the next session opens with. Nothing queues because nothing is
intercepted.

The case for separating them was *links proven but no events flowing* — presence without data. That
is not a state this mesh can be put into from outside without manufacturing a divergence. The only
suppression point is `offerEvent` (`bridge.ts:134-146`), which consults `ctx.carries` per frame and
is the **single push** there is; there is no re-push primitive. `Transport.resync` re-requests from
*our* last contiguous position — it asks, it does not send — so a device that suppressed its own
`offerEvent` and then resumed would leave the far side silently behind until that peer independently
resynced or a new session opened. That is a gap no real network produces, and it is the one thing
the brief for this work forbade. So: one verb, at two scopes.

The device-level gesture is **one tri-state toggle, which is also the indicator** — the control
carries its own state in the same amber as the `held here` tag on each row and the mark on the
bubble, rather than a pair of buttons where you press one thing to engage and a different thing to
disengage while the fact that you are offline is reported somewhere else. Tri-state and not binary,
because forcing is per medium: *one of three radios held* is not *off*, and rendering it as *off*
would be the same lie as reporting a medium that cannot enumerate its links as zero peers. The half
state gets an indeterminate mark, `aria-checked="mixed"` — the checkbox role is the only one with a
word for it — and a label that carries the count. Clicking from the half state **holds the rest**
rather than releasing: the gesture reads *go offline*, so moving toward offline is the unsurprising
reading, and releasing radios somebody deliberately put into `radio-off` would be the destructive
surprise. The rule is monotone — click until it says offline, click once more to come back.

Underneath, it still holds each medium by name through the same verb the per-medium pickers use, so
afterwards every row says what it is being held in and a condition somebody chose deliberately
survives the aggregate gesture. A single hidden flag would have been fewer clicks and one more
thing that can be true without anything on screen saying which radios it applies to.

**Decision 3 — named conditions, not a boolean.** This is the part with the most value per line.
`TransportCondition` already enumerates `radio-off`, `discovery-failed`, `connecting-failed`,
`no-permission-central` and the rest, `CONDITION_SEVERITY` already colours them differently, and
those are precisely the states a laptop cannot produce. "Off" is not one state: a radio that is
switched off, one whose discovery failed, and one the user never granted permission to are three
rows with three severities and three sentences, and a boolean would have collapsed them into the
least informative of the three — leaving most of the panel's own vocabulary permanently unreachable
and therefore permanently untested.

The vocabulary is constrained per medium (`FORCEABLE`, keyed by `TransportKind`): a websocket has
no radio to switch off and no Bluetooth permission to be refused by, and offering it those would
teach a reader something untrue about the medium they were holding. `ok` is in no row — holding a
medium in `ok` is not a forced state, it is releasing it, which has its own verb. This is the same
discipline as `storage`/`writes`/`sql` being `| undefined`, applied to a vocabulary rather than to
a member.

**A forced state is visible outside the panel, in three places.** First and most importantly it is
visible to the *mesh*: a held medium genuinely reports its condition through `$status`, so
`status.get().sources` names it and `health` goes `offline` when nothing is left carrying — an app
with its own status UI says so without importing anything from the devtools.
`mesh.transports.forced()` is the reading that separates *this radio is off* from *somebody turned
this radio off*. Second, the bubble carries a mark and the sentence naming every held medium, which
covers the predictable failure: a developer who sets a toggle, closes the panel and files a bug
against "sync is broken". That mark costs nothing where the bubble's "closed is free" rule applies,
because an app that passed no controls has nothing to subscribe to. The shell header carries the
same mark for the remaining hole — panel open, looking at another tab. Third, `ForcedBadge` is the
same fact as a pill a host can put in its own header beside the storage badge `apps/issues` already
draws there (`apps/issues/src/app/chrome.tsx`), which is the precedent this follows.

**What earns a permanent seat in the header, and the one bar everything had to clear.** Anything in
that strip is read for as long as the panel is open, so its cost is whatever it costs **on a
fold** — and `fold` runs synchronously inside the write path (§4). Measured against that bar every
*mesh counter* fails. *Links held* and *peers* come from `overview()` and `links()`, and
`overviewOf` reaches `mediums.list()` — which reconciles the watch list and calls
`mesh.status.get()`, which calls `condition?.()` per source **and** `recovery.list()` on every call
— while `links()` is `peers.graph()`, O(transports × `reaches().size`). Those are fine at 1 Hz on
one panel and wrong behind a hub that fires per batch during a catch-up. *Unsettled writes* is
`Promise`-shaped by construction, so a permanent seat for it is a SQL query per fold. *Parked* is
cheap and is zero on every healthy mesh forever, and a figure that is always zero teaches people to
stop looking at the strip that holds it. There is also a structural objection: each of those
numbers already has a home in one panel's `StatBand`, and a second drawing of it in the chrome is
the duplication `link-kit.tsx` exists to prevent.

Two things pass, and they pass for the same reason: **neither reads the mesh**.

The **forced mark** is a map the controls already hold, repainted only when a person clicks. It is
the one state in the panel somebody created and can forget, and the hole the bubble's mark leaves
is exactly *panel open, looking at another tab*. It is a mark and not a control because the toggle
belongs with the rows it acts on, and because the shell cannot offer one without learning which tab
those rows are on, which would end tabs being data.

The **frames meter** is the inverse of the counters, and it is the number this document was wrong
to dismiss as a browser concern. `onFoldBatch` and `onTelemetry` run synchronously inside the write
path and every live query re-runs on a fold, so a catch-up folding a large batch — or one live
query re-reading a thousand rows — takes the main thread away from the compositor. Nobody
experiences that as a slow fold; they experience it as *the app freezes whenever it syncs*. Chrome's
own meter can tell you a frame was dropped and cannot tell you a **fold** dropped it, and that
attribution is the product: a bare rate is the part the browser already does better. It is fed by
`requestAnimationFrame` and reads nothing from the mesh, so its cost is independent of how busy the
mesh is — which is the property you want from the instrument that measures how busy the mesh is
making the main thread. It is present whether or not the host passed controls, because it measures
the app and not the operator surface, and it exists only while the panel is open, which is what
keeps a shut devtool free.

Four rules it is built to, in `packages/devtools/src/frames.ts` and `src/react/frames.tsx`:

- **Sample in `rAF`, repaint at 4 Hz.** Sixty renders a second to display a number *about*
  rendering cost would be self-defeating. The per-frame callback does two additions and a
  comparison and allocates nothing; the repaint period equals the bucket period, so one render
  draws exactly one new bar.
- **Derive the display's rate, never assume 60.** High-refresh screens are ordinary, and a meter
  that treats 60 as the target paints a 120Hz display as permanently over budget and a 120Hz
  display that has fallen to 60 as perfect. The estimator is the **shortest interval observed**,
  because jank only ever lengthens an interval — the fastest frame this screen managed is the
  closest thing to its period a script can see. Dropped frames are then counted against that
  period, so the same 16.7ms gap is zero drops on one machine and one on another.
- **Attribute, and say what the attribution is worth.** The source is the Long Animation Frames
  API, whose per-script `sourceURL` and `sourceFunctionName` survive a dev build. A bar is red when
  a bucket lost frames **and** a script matching the `@syncmesh/` module scope or one of the
  engine's fold emitters ran in the long frame overlapping it. That proves a fold was on the main
  thread while frames were being lost; it does **not** prove the fold was alone there or that it
  alone caused the drop. Where the browser offers only `longtask` there is no script attribution at
  all, and a minified bundle carries neither signal — in both cases the bar is amber and reads
  *unattributed*, which is the truth rather than a cleared syncmesh. The word for a long frame that
  cost nobody a frame is *nothing*: it takes no colour, because spending the loud colour on a
  non-event is how a loud colour stops meaning anything.
- **Say when it cannot measure.** A backgrounded tab gets no `requestAnimationFrame` at all, and a
  tab whose timers have been clamped can look alive while painting nothing — a state already found
  in the wild in this app. Both read as *not measuring* rather than as a plausible `0` or a frozen
  last figure, and a runtime with no `requestAnimationFrame` at all draws no meter, because "this
  runtime does not paint" and "this tab has stopped painting" are different facts and only the
  second is a finding.

**Nothing survives a reload, and that is deliberate.** The held set lives in `runTransports`'
closure and is written nowhere. A toggle that outlived the page is a toggle somebody spends an
afternoon hunting; a refresh is the escape route every developer already knows, and it is the one
documented on the badge's own tooltip.

## 4. Cost and safety

**The hot hooks, ranked.** `onTelemetry` fires twice per write path, `onFoldBatch` once per fold,
both synchronously inside the write. A listener that allocates, formats a string or calls `setState`
pays that on every write the app makes and every batch it receives. `onAcknowledge` is one tier
cooler and still fires per exchange per link.

The contract's answer: the source holds **exactly three** engine subscriptions for the whole devtool
— `onFoldBatch`, `onAcknowledge`, `onQuarantine` — plus one `onTelemetry` feeding a single
`createInspector`. Each handler sets a bit in a channel set and schedules a microtask. Nothing reads,
nothing allocates, nothing formats.

**What leaks application data.**

1. `$recovery.export(event)` — the author's raw signed envelope.
2. `Parked.entry.core` — the same bytes by another route.
3. The `events.core` column. Query `length(core)`.
4. `$grants.wireFor` / `allWires` — signed bearer bytes. A grant rendered as fields is diagnosis; a
   grant rendered as bytes is a credential on a screen.
5. `mesh.internal.rows(table)` — live reserved-table rows.

**Sealed partitions must never be presented as readable.** Two consequences, and the second is not
obvious. `mesh.on(instance)` on a sealed partition with no key returns `PartitionSealed`
(`handles.ts:88-94`) — render that as *sealed*, not *error* and not *empty*. And the `events` table
still holds rows for that partition, so a Storage panel counting `events GROUP BY peer` will count
them. Counting sealed events is fine. Decoding one is not.

**One sharp edge that is neither a read nor a write.** `$status.subscribe` does not follow the
transport set: it captures `deps.transports()` at subscribe time (`status.ts:93`), so a medium added
later through `$transports.add` never reaches an existing subscription. A devtool holding one
long-lived status subscription silently stops hearing about a radio the user just enabled. Poll
`get()` alongside it until gap 8 is closed.

## 5. The gap list

Ranked by what a developer notices in the first minute.

**1 — There is no event-log reader, so the Events panel cannot exist.** `Mesh` carries no
`EventStore`; `mesh.history` calls `store.all()` per invocation (`history-view.ts:47`); the only
reachable path is `engine.eventsSince(new Map())` — unbounded, ordered `peer, seq`, local events
excluded. *Fix:* `Engine.recentEvents({ limit, before })` returning **headers, never cores**, over the
`events_hlc` index that already exists (`dialect-sqlite.ts:103`). One statement per dialect.

**2 — Link-level failure is entirely invisible.** `Bridge.onError` is subscribed by nothing;
`Transport` has no `onError`; `onRefused`/`onDropped` are constructor callbacks; the gate discards its
verdict. So *"peer X keeps connecting and dropping"* and *"why was this device refused"* have no
answer on the device. *Fix:* one optional `Transport.onLinkEvent` emitting
`proven | refused | closed | dropped | error`. `createFrameTransport` already holds every one of
these. **Highest value per line in the list.**

**3 — `acks()` computes freshness and throws it away.** `Ack` is `{ cursors, at }` (`engine.ts:230`);
the getter maps `at` away (`engine.ts:327`). The difference between "that peer is behind" and "that
peer has been gone for an hour". *Fix:* `acksAt()`, three lines, nothing new stored.

**4 — `Mesh` carries neither its schema nor a read-only driver.** So a devtool cannot enumerate
tables or sealed kinds, and has no door to the database that cannot write. Three implementations will
each invent a different injection. *Fix:* `mesh.schema` (a `Pick` of the manifest) and `mesh.query`
(`driver.all` with no `run` beside it — the point is the door cannot write). **Wants deciding before
the panels are written, not after.**

**5 — Live queries are counted and not named.** Everything a Queries panel needs but `runs` and
`lastRunMs` already exists in `createLive`'s closure. *Fix:* one getter surfaced through `$inspect`.

**6 — Nothing counts event bytes on a device.** The only variant that does is `relay.event`, and the
relay half is deliberately not carried to a client. `offerEvent` weighs the frame to decide whether a
link carries it (`bridge.ts:134-146`) and discards the number. *Fix:* two anonymous mesh variants —
counts and bytes, never a peer id.

**7 — `PeerSessions` is built and then orphaned.** *Fix:* `$peers.sessions()` over the object the mesh
already builds.

**8 — `$peers` cannot be subscribed and `$status.subscribe` does not follow the set.** *Fix:*
`runTransports` already owns the `online` map and the `active` array; give it `onChange`.

**9 — The write ledger cannot be listed.** A settled operation is unreachable unless the caller
already knows its id, so a Writes panel shows what is stuck and never what worked. *Fix:*
`recent(limit)` over the `operations_event` index that exists.

**10 — Blobs cannot be enumerated.** `BlobStore` has no iterator. *Fix:* `list()`, one line on the
memory store.

**11 — Storage size is a platform fact nobody surfaces.** Not an API — a convention. `logBytes` is
`SUM(length(core))`, which is honest, cheap, and the number that actually grows.

**12 — Presence cannot be enumerated across instances.** *Fix:* `mesh.presence.all()` with values
omitted, because a presence value is application data.

## Order

Gaps 1 and 2 are what a developer notices first and neither is large. Gap 3 is three lines. Gap 4 is
what stops three implementations inventing three injection schemes, so it wants deciding before the
panels are written. Everything from 5 down can land panel by panel.

Until 1–4 land the contract is honest about all four: no `events()`, `atMs: number | undefined` with
the reason in its doc comment, `tables`/`sealedKinds` that may be empty, and an `sql` member that may
be `undefined`. A panel written against it degrades where the mesh is silent, which is the whole
reason the seam exists.

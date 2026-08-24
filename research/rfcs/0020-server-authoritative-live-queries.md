---
rfc: 0020
title: Server-Authoritative Live Queries — what Iris does, what we take
package: syncmesh/server · server/relay.ts · syncmesh/client
layer: 3
status: proposed
standalone: true
deps: ["0009", "0010", "0018"]
---

# RFC-0020 — Server-Authoritative Live Queries (Iris)

## Purpose

RFC-0018 read Zero and LiveStore. This one reads **Iris**, the live-query layer
the ElysiaJS author is building, because it occupies exactly the install RFC-0010
calls the standalone story: *a normal backend, with real live queries, and a
client that updates instantly.* It is the closest thing shipped to what SyncMesh
offers when you delete the mesh.

Sources: Iris is unpublished (no repo, no npm package, no export in
`elysia@2.0.0-exp.64`). Its client runtime was recovered from the production
bundle of the public demo and the wire was captured live; both are checked in at
`../../syncmesh/internal/exisiting/iris/`, with the reconstructed API and full
protocol notes in that directory's README. The server is inferred from the
client's contract and the author's teaser, not recovered.

---

## 1 · The two models, stated precisely

| | **Iris** | **SyncMesh** |
|---|---|---|
| Truth lives | on the server | in each peer's signed event log |
| Client holds | a projection: server base + optimistic drafts | a full replica it can write to |
| Wire unit | JSON Patch of a **query result** | signed events, or refcounted **row** patches (RFC-0018 tier 3) |
| Offline | none — cold start is always a snapshot | first-class; writes commit locally and ship later |
| Conflict resolution | none needed; server serialises | HLC + field-level LWW, verify-before-apply |
| Invalidation | **declared** — `touch: { route }` | derived — the fold's `writeKeys` invalidate mounted queries |
| Transport | SSE, with a multiplexed fallback | WebSocket / BLE / Wi-Fi Aware framed link |
| Trust | server is trusted; identity is a header | end-to-end signatures; a relay can drop but never forge |

These are not competing implementations of one idea. Iris solves *"my Postgres
app should feel live"*. SyncMesh solves *"these devices should agree without a
server"*. **Nothing in Iris threatens the mesh design, and nothing in the mesh
design makes Iris's ideas inapplicable** — because the pieces worth taking are
all in the layer where SyncMesh also has an authority: the relay, `mountRest`,
and the client's read path.

The one strategic read worth stating plainly: Iris is evidence that the
RFC-0010 standalone install is a **product on its own**, and that the bar for it
is lower than we assumed. Iris ships no CRDT, no log, no offline — and it is
still the thing people want. Everything we have beyond that is upside, provided
the thin path is as easy to adopt as `useLive`.

---

## 2 · What Iris does, in one page

A route declares its liveness inline:

```ts
.get('/board', { live: { share: true } }, async () => ({ issues: await listTasks(), team }))
.get('/board/presence', { channel: { of: viewerSchema, share: true } }, ({ channel }) => …)
.patch('/api/issues/:id', { body: schema, touch: { route: '/api/board' } }, handler)
```

The server materialises the handler's result, and on `touch` re-runs it and diffs
the two values into a JSON Patch. Subscribers of the same key (`share: true`)
share one materialisation. Frames go out over SSE:

```
bus: 9df8558d-…        id: 377        epoch: DxOmv7sEjXBu6pLR_IJYy
offset: 120053         event: snapshot|patch|ok|error|expired
data: …
```

Two counters, doing two different jobs — this is the part worth internalising:

- **`epoch` + `id`** identify a *materialisation lineage and its version*. A
  `patch` applies only when `id === version + 1`; a gap or an epoch change is not
  repaired, it triggers a resubscribe that returns a fresh `snapshot` under a new
  epoch. Reconnect offers `last-event-id` + `iris-epoch` and the server decides
  whether it can still serve patches.
- **`bus` + `offset`** identify a position in the *durable log*. Every mutation
  response carries `iris-offset: <busEpoch>:<offset>`. That is the client's
  read-your-writes token.

Optimistic writes use it directly. `patch(target, draft)` pushes a draft onto a
per-query overlay stack; the rendered value is `fold(drafts)(serverBase)`. The
overlay is released when a frame arrives **on the same bus lineage** with
`offset >= echoed`. A different lineage, or ten seconds of silence, drops the
overlay and emits a named diagnostic. There is no rollback logic, no rebase, and
no client-side conflict resolution — the overlay is a lens, and the server's next
frame is always the answer.

The rest is operational discipline, and it is unusually good: one SSE connection
per query until the browser's budget (80 on h2/h3, 4 on http/1.1, detected from
`nextHopProtocol`), then a multiplexed stream with `POST /_iris/sub`; a `hello`
frame whose `keepalive` sets the client's liveness timeout to 2.5×, so a
half-open stream is cancelled rather than trusted; full-jitter backoff; a 64 MiB
frame-buffer ceiling that fails loudly; refcounted query handles with a 300 ms
linger so a navigation does not tear down a stream; and diagnostics that name the
fix (`overlay-offset-missing` tells you to add the header to
`Access-Control-Expose-Headers`).

---

## 3 · Four things it has that we do not

### 3.1 An ephemeral tier — and we have *nothing* here `[gap]`

Iris splits state in two. `live:` is durable and offset-bearing. `channel:` is
in-memory, snapshot-only, carries no offset, and never enters the log; its writes
arrive over `.ws()` with `publish: { route }`, never over HTTP. The demo's
presence stream is cursor positions at pointer-move rates — captured live, it
emits full snapshots several times per second.

SyncMesh has no concept of this. `grep -rn "presence\|ephemeral" src server` is
empty. Every write in our system is a signed, stored, replicated, compacted,
anti-entropied event. Putting a cursor position through that pipeline is not slow
— it is **wrong**: it is unbounded write amplification into a durable log that
BLE then has to carry, and compaction has to clean up.

This is the single largest gap this review found, and it is not an optimisation:
presence is table stakes for the collaborative apps both systems target, and our
architecture currently has no place to put it.

**Take it.** An ephemeral tier: signed (so authorship still holds), never
persisted, never in catch-up, never in anti-entropy, TTL'd, dropped under
backpressure by the route scorer (RFC-0015 already argues small/urgent traffic
prefers direct BLE — ephemeral frames are exactly that traffic, and they are the
first thing that should be dropped when a radio is full).

### 3.2 A write-visibility token `[gap]`

`client.request()` (RFC-0010) returns `{ committed, result() }`, and `synced()`
counts relay acks. Neither answers the question a UI actually asks: *is my change
in the data I am rendering yet?* Iris answers it with one header and one
comparison.

We have the ingredients — the relay assigns durable order, `ack` already flows
back — but no monotone position is exposed to the client, so nothing can be
compared. **Take it**: stamp acks and REST responses with the room log position,
and expose `client.visibleAt(token)` / a `pending` flag on live queries. The
epoch half matters as much as the offset: a relay restart or a room re-materialisation
must invalidate outstanding tokens rather than let a stale offset confirm falsely.

### 3.3 Optimistic overlays — for the *request* path only `[scope correction]`

RFC-0009 says: **"No optimistic overlay. The local commit IS the truth."** That is
correct and stays. For a mesh write there is nothing to be optimistic *about*: the
write is committed, locally, in the log, immediately.

But that reasoning does not cover `client.request()`. A server op commits a row in
`_requests` and the *data* does not change until the authority settles it. In that
window the app has to render the request row's lifecycle by hand — which is
precisely the problem overlays solve. The RFC's rejection was written about
collection writes and has been over-applied to ops ever since.

**Take it, narrowly**: `client.request(name, input, { optimistic: draft })`,
projecting over materialised rows until the settlement event lands, released by
the visibility token from §3.2, dropped on rejection or timeout with a named
diagnostic. Two details from Iris are worth copying exactly — the draft runs
*synchronously* during the call (Iris throws if `patch()` escapes), and a failing
draft is contained: drop that one overlay, reproject, emit a diagnostic, never
poison the query.

One thing **not** to copy: Iris freezes a draft's *result* at mint time, so an
unconfirmed overlay shadows concurrent server updates. Our drafts should be
re-run against the current base on every reprojection.

### 3.4 A liveness timeout on the transport `[bug class]`

`relay-transport.ts:146` has correctly jittered backoff. It has no liveness
timeout. A half-open WebSocket — mobile handoff, NAT rebind, a proxy that drops
silently — never fires `onclose`, so the client sits "connected" forever with no
data and no reconnect. Iris treats this as a first-class failure: the server
advertises its keepalive interval in `hello`, the client force-cancels the reader
at 2.5× it, and the ordinary backoff path takes over.

**Take it.** Server advertises its interval; client arms a timer on every frame.

### 3.5 Also worth taking, cheaply

| Idea | Why |
|---|---|
| Diagnostics that name the fix | `overlay-offset-missing` explains the CORS change. Our typed errors carry tags and data; a `hint` costs nothing and is what makes a sync bug debuggable by someone who did not write the sync layer. |
| Handle refcount + linger | We refcount live queries; a short linger before teardown makes route changes free. |
| Canonical-JSON query key | We already canonicalise for signing; the same function should key subscriptions, as Iris keys them by `{pattern, params, query}`. |
| Frame-buffer ceiling | We page catch-up (RFC-0010); a hard ceiling that errors loudly is the complementary guard. |

---

## 4 · What we do not take

- **SSE and the mux.** Iris pays for the browser's per-origin connection limit
  because SSE is one stream per query. Our transport is one WebSocket carrying
  every subscription; the mux is a solution to a problem the design does not have.
  Worth keeping in view only if an HTTP-only read path is ever wanted.
- **JSON Patch of a query result.** It is the right wire format when the server
  ships *views*. We ship **rows**: `ClientView` (`src/authority/cvr.ts`) emits
  refcounted `put`/`del` addressed by table and key, so one row shared by six
  queries is sent once and evicted only at zero references. Iris would send it
  inside six patches. Keep rows.
- **Declared invalidation (`touch: { route }`).** Our fold already knows which
  keys changed; deriving invalidation is strictly better than asking the developer
  to maintain a route graph. But note what Iris proves: a production live-query
  system with **no dependency tracking and no IVM at all** — re-run the handler,
  diff the result — is good enough for a real app. That is direct support for
  RFC-0018 §5.3's "stop when the budget is met", and an argument against ever
  building step 3.
- **A trusted server.** Iris's identity is `headers['x-viewer']`. Our threat model
  (RFC-0017) does not permit that, and the relay's inability to forge is the
  property that lets it be rewritten in any language.
- **Frozen optimistic drafts** — see §3.3.

---

## 5 · Consequences for the plan

New work, in the order it should land. Nothing here changes the kernel, the wire
format, or the conformance vectors.

- **N1a — liveness timeout on `RelayTransport` `[done]`.** The relay announces
  `{t:"hello", keepalive}` on join and emits `{t:"ka"}` on that cadence; the
  client arms a deadline at 2.5× and re-arms on *every* frame. A relay that
  never sends `hello` arms nothing — an older relay must not be killed on a
  cadence it never agreed to. `tests/liveness.test.ts`: a mute-but-open socket
  is dropped and retried (twice, so it proves retry, not just death); a
  hello-less relay is left alone; a genuinely idle room survives 13 keepalive
  periods untouched.
- **N1b — visibility tokens `[done]`.** Rooms carry an `epoch`; `ack`,
  live fan-out and catch-up pages carry the room-log `offset`.
  `client.visibilityToken()` reads the current position and
  `client.visibleAt(token)` resolves `Ok` once this peer has seen the log at or
  past it — `Err(VisibilityLost)` if the lineage changed, `Err(VisibilityTimeout)`
  if the caller stopped waiting (the write is unaffected either way).
  `tests/visibility.test.ts`, including the case the design exists for: a relay
  that changes lineage **while a waiter is pending** settles it Lost rather than
  confirming a write into a log that never held it.
  Still open: `mountRest` should return the token as a response header, which is
  what makes it useful to a plain HTTP caller.
- **N2a — the ephemeral tier.** Designed in §6 below; the wire kind lands in
  RFC-0002, the send policy in RFC-0005, the traffic class in RFC-0012, the
  non-obligation in RFC-0015, the developer surface in RFC-0009.
  *Verify:* a 60 Hz presence burst leaves the event log, the snapshot and the
  compaction floor byte-identical; a peer that joins late sees current presence
  and no history; a stalled socket receives the *latest* cursor position, never
  a backlog of stale ones.
- **N2b — optimistic overlays on `client.request` (§3.3).** Drafts re-run against
  the current base; released by N1b's token; typed diagnostics on drop.
  *Verify:* an op that the authority rejects leaves no trace in the rendered rows.
- **N3a — promote the thin client to a supported install.** The relay already
  speaks `desire` / `undesire` / `rows`; there is no client-side counterpart, so
  the row path is reachable only by hand-writing frames. A `createThinClient` that
  renders `ClientView` patches with no engine and no store is the whole Iris
  proposition, on a substrate that also does the mesh.
  *Verify:* the demo runs against the relay with no local engine.
- **N3b — versioned row patches.** `ClientView` emits diffs with no version and no
  epoch, so a reconnect can only `clear()` and re-`desire` everything. Give the
  patch stream Iris's `epoch` + monotone `id`, and the same resnapshot-on-gap rule.

**One bug found on the way, now fixed `[done]`.** `server/relay.ts` sent row
patches with a raw `ws.send()` instead of `sendOrQueue()` — the only remaining raw
send in the file. RFC-0010 documents this exact bug class ("a relay must never
assume it can outrun a client") and records it as fixed on every path; this one
was missed. Its failure mode is worse than the one that was found: a dropped
*event* is recoverable by cursor catch-up, whereas a dropped *row patch* is a
permanently divergent client view, because a CVR only ever sends differences and
the client has nothing to re-request. Regression test in `tests/relay-cvr.test.ts`
— 100 disjoint queries over 16 KB rows push ~32 MB at the socket in one burst;
before the fix the client stalls at the buffer's worth of patches and never
completes.

---

## 6 · The ephemeral tier, designed

§3.1 said we have no place to put presence. This is the place. The shape comes
from Iris's `channel:` split, but the delivery policy comes from market data
distribution, which has been solving "millions of subscribers, unbounded update
rate" since before WebSockets existed.

### 6.1 The two lessons worth taking from market data

**Conflate, don't queue.** An exchange feed does not send every tick to a retail
client; it sends the *current* value on a fixed cadence (`@depth@100ms`), because
a price from 400 ms ago is not partially useful, it is worthless. Conflation is
what converts an unbounded *event* rate into a bounded *frame* rate, and it is the
only reason the cost of a subscriber is predictable.

**Drop with gap detection, don't deliver reliably.** If a market data client falls
behind, it does not want the backlog — it wants the current state, and a signal
that it missed something. Reliable delivery of stale ephemeral data is a bug
wearing a feature's clothes.

Both are the *inverse* of the policy the durable log needs, and the reason is
precise: a dropped event is unrecoverable-but-repairable (cursor catch-up and
anti-entropy will fetch it), whereas a dropped presence frame is
unrecoverable-and-irrelevant (a newer one is already on its way). The relay's
`sendOrQueue` — correct for events, the subject of the bug fixed in §5 — is
actively wrong here.

### 6.2 Naming: presence, not channel

Iris calls this a `channel`. We cannot: RFC-0006 and RFC-0005 already use
"channel" for a radio (`@syncmesh/ble-channel`, "a channel may not import
syncmesh"). The concept is **presence**, carrying named **topics**.

### 6.3 The frame

A new message kind in RFC-0002, deliberately **not** a `SyncEvent`:

```
PresenceFrame {
  peerId      Ed25519 public key — signed, so a cursor cannot be spoofed
  partition   "kind:id" — presence is partition-scoped like every other read
  topic       declared name ("cursor", "typing")
  at          [physicalMs, counter] — publisher-local ordering ONLY
  ttlMs       when this frame stops being true
  value       matches the topic's declared shape
  sig         detached Ed25519 over the canonical-CBOR core
}
```

Three absences carry the design:

- **No `seqNum`.** A presence frame must never touch the per-device monotonic
  counter — that counter is what cursors, catch-up and compaction floors are
  computed from. A 60 Hz cursor would advance it past every useful floor.
- **`at` is not an HLC.** It orders a peer's own frames against each other and
  nothing else, and it **must not advance the receiving engine's HLC**. Otherwise
  a pointer moving for a minute inflates the logical clock of the entire mesh.
- **No changes[].** It is not a write. It never reaches the kernel.

### 6.4 Conflation, at all three hops

Exactly one current value per `(peerId, topic)`. That invariant is enforced
independently at each hop, which is what bounds cost end to end:

| Hop | Mechanism | Bounds |
|---|---|---|
| publisher | pending-value slot, flushed on a cadence | sign rate — one Ed25519 per tick, not per pointer move |
| link / relay | per-socket **latest-value slot** keyed `peerId/topic`; a new frame **overwrites** a backed-up one | bandwidth to a slow client |
| receiver | a `Map<peerId, frame>`, not a list | memory, at O(peers) |

The publisher-side slot is what makes signing affordable: the input rate is the
pointer, the send rate is the cadence, and only the send rate costs a signature.

### 6.5 Departure: two mechanisms, because one is never enough

`ttlMs` (default 30 s, republished at ttl/3) covers the crash — nobody sends a
goodbye when their battery dies. An explicit `presence-gone` on disconnect covers
the ordinary case, because waiting 30 s to remove an avatar looks broken. Neither
alone is sufficient; both are cheap.

### 6.6 What it is never in

The log, catch-up, anti-entropy, snapshots, compaction, blobs. A relay holds a
room-level live map, in memory, swept on expiry; a joining peer receives that map
as one snapshot and there is no history behind it, because none was ever kept.
This is the property that makes the tier safe to add to a system whose whole
economics (RFC-0015 §1) depend on the log staying small.

### 6.7 Trust

The publisher must hold a grant for the partition; a receiver drops presence from
peers that do not (RFC-0008, the same admission check events get). Values are
validated against the topic's declared shape and dropped on mismatch. Signature
checks are not optional here — unsigned presence means anyone in the room can
move your cursor.

### 6.8 The one thing we do not take

Market data conflates on a *fixed cadence* set by the publisher. We conflate on a
cadence the **route scorer** picks (RFC-0012), because our links differ by three
orders of magnitude in bandwidth: 100 ms on a relay or Wi-Fi Aware, far slower or
entirely suppressed on a 24 kbps BLE link. Presence is the first traffic class to
be dropped when a radio is full, and it must never wake a dormant one.

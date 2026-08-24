---
rfc: 0010
title: Authority Server, Relay & REST
package: syncmesh/server · server/relay.ts
layer: 3
status: implemented
standalone: true
deps: ["0002", "0008"]
---

# RFC-0010 — Authority Server, Relay & REST

## Purpose

The optional server story: a traditional server with proper HTTP verbs that
is ALSO a real-time sync authority. Three separable pieces — you can run any
subset, which is exactly the point.

## Standalone story

"I want an authoritative server with realtime sync and REST, and I could not
care less about BLE" is a fully supported install: `syncmesh` core +
`/server` + the relay. **No radio package appears anywhere in this stack** —
the leak test is `grep -r "ble\|channel\|rn-" src/authority server/` = empty.

## Piece 1 — the relay (dumb on purpose)

`server/relay.ts`: WebSocket **store-and-forward of signed bytes**. Rooms,
per-author cursors for catch-up, grant wires stored opaquely per room
(cannot forge — it never interprets them), durability acks (`{t:"ack"}` —
what write handles' `synced()` counts), blob store (verify-on-put by sha-256,
junk can't squat a hash). It executes nothing and validates nothing beyond
byte shapes — a compromised relay can drop traffic but cannot forge it
(signatures are end-to-end, RFC-0002).

Runs standalone: a serverless-authority mesh can use just the relay for
store-and-forward between devices that never meet.

## Piece 2 — the authority (a privileged peer, not a different animal)

`attachAuthority(engine, handlers)` — the authority IS a syncmesh peer whose
grant carries role "authority". A client "server op" is **a row in the
caller's user partition** (reserved `_requests` table): it commits locally,
works offline, replicates like any data. The authority executes the handler
**once** (in-flight guard + durable status; `ctx.requestId` is the
idempotency key) and settles the row with an authority-signed update.
Rejections are typed values (`RequestRejected` tag + data); offline requests
queue as data and run on reconnect; the whole lifecycle is renderable with a
live query on `_requests`. Handler defects are contained as typed `INTERNAL`
rejections — the authority keeps serving.

Validator privileges: `isAuthority` bypasses policy/user-privacy/partition-
grant checks but NEVER signature or schema checks.

## Piece 3 — REST (`mountRest`)

Plain HTTP callers run the SAME OpHandlers: every REST write becomes a
request row + settlement — **one write path**, so REST writes replicate to
every sync client with no webhooks and no second pipeline. Proper verbs:
GET serves materialized rows; POST/PATCH/DELETE become ops; HTTP status
codes exist only on the HTTP surface (`statusFor` per error tag — sync
clients see tags, never numbers). Unmatched routes return null so the host
app's router continues — syncmesh never owns the port.

## Serving a cold join: what load testing changed `[implemented]`

A relay's hardest moment is a device arriving with nothing. The obvious
implementation — reply with every event the client lacks — is wrong in two
ways that only appear under load (`bench/load/`, 100k–300k events):

**1. One frame is not a transfer, it is a cliff.** At 300k events the reply
was ~90 MB of JSON in a single WebSocket message. The client decoded,
verified, folded and committed all of it as one unit: **2.1 GB resident, 18
minutes pinned at 100% CPU, and zero events durable the whole time.** A crash
at minute 17 lost everything and restarted from nothing.

Catch-up is therefore **paged** (2,000 events per frame). The first page
carries the grants — a client needs them before events from unknown authors
arrive, or those events quarantine on `NoGrant`. The last page is what
releases the client's push-outstanding, because only then does the client
know what it still holds that the relay does not.

The client applies pages through `receiveWireStream` (RFC-0018): each page is
sliced, yields the thread, and **commits as it goes**, so a join is progress
a device can keep. Pages are serialized through a promise chain, since they
must apply in arrival order.

**2. `ws.send()` can refuse.** Bun returns `0` when the socket buffer is full
and the message was **not** sent. The relay ignored that on every send path.
Under a paged join the effect was precise and fatal: the joiner received
exactly thirty pages — one buffer's worth — and hung forever, because a relay
has no protocol for re-requesting what it never knew it dropped.

Every server→client send now goes through a queue that falls back to a
per-socket backlog flushed from the socket's `drain` callback, preserving
order. This was never a catch-up-specific bug: live fan-out, acks, blobs and
row patches all had it, and a busy room would have hit it eventually.

> The general rule: **a relay must never assume it can outrun a client.**
> Anything it sends in a loop needs paging, backpressure, or both.

One path escaped that sweep and was fixed later (RFC-0020): CVR **row patches**
still used a raw `ws.send()`. That failure mode is worse than the one above — a
dropped event is recoverable by cursor catch-up, a dropped row patch is a
permanently divergent client view.

Still open: the relay verifies nothing and serves per-event frames, so a
joining client pays one Ed25519 check per event. Serving chunk-signed ranges
(RFC-0002) would make it one check per author — the authors would have to
ship their signed feed heads to the relay first.

## Forbidden leaks

- Depends on core's protocol + policy + engine only — never on `/react`,
  never on a channel or radio.
- The relay must never gain interpretation powers (no policy evaluation, no
  handler execution) — that's what keeps it trustless and rewritable in any
  language.

## Remaining work

- Durable relay storage (today in-memory) — reuse the EventStore port (N4).
- OpenAPI generation from op contracts (`fn.route` metadata → spec) — the
  sm-builder WIP heads there; land it (N0 commit first).
- Authority horizontal scale (single-writer per room is fine for v1).

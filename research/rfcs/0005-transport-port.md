---
rfc: 0005
title: Transport Port & Routing
package: syncmesh (src/transport)
layer: 2
status: partial
standalone: false
deps: ["0002", "0006", "0007", "0010"]
---

# RFC-0005 — Transport Port & Routing

## Purpose

The seam that makes "BLE or Wi-Fi Aware or whatever protocol" a plumbing
question instead of an architecture question. The engine speaks to *links*;
what carries the bytes is invisible to it.

## The port

A radio/channel owes the sync layer exactly two functions:

```
FramedLink {
  send(frame: Uint8Array)      deliver one frame to the peer, whole
  onFrame(cb)                  frames from the peer, whole, in order
}
```

`framed-link.ts` builds the sync session on top of ANY such pair: grant
exchange first (RFC-0008 — events from unknown authors would quarantine),
cursor catch-up, live gossip, `resync()` on reconnect. Proven over a loopback
double; the relay client (`relay-transport.ts`) and future BLE/Wi-Fi Aware
channels all terminate in the same code path.

## Two send policies, not one `[N2a]`

A link carries two kinds of traffic that want opposite treatment under
backpressure, and conflating them has already cost us one bug (RFC-0010, and
again on the row-patch path in RFC-0020 §5):

| | Durable traffic | Presence (RFC-0020 §6) |
|---|---|---|
| events, grants, acks, catch-up, blobs | cursor positions, typing, selections |
| **Queue.** A dropped frame is unrecoverable at the sender — the receiver has no way to re-request what nobody knows was lost. | **Replace.** A dropped frame is irrelevant: a newer one is already coming, and delivering the old one late is worse than not delivering it. |
| `sendOrQueue` — append to a per-socket backlog, flush on drain, preserve order | `sendLatest` — a per-socket **slot** keyed `peerId/topic`; a new frame *overwrites* a pending one |
| unbounded backlog (bounded instead by paging upstream) | O(peers × topics) memory, by construction |

The backlog drains before the slots. Presence starved during a cold join is
correct: nothing about a cursor is useful to a client that has no rows yet.

Built for BLE as `FrameLink.sendLatest`, and for the relay (gaps U19) as `Sender.sendLatest`
on the room's side — a slot keyed `(topic, instance, peer)`, held while the socket has a backlog
or buffered since its last drain — and, on the device's side, a hold keyed the same way while
the dial's `buffered()` (a WebSocket's `bufferedAmount`) is above zero. The room's hold needs a
socket that reports backpressure, which the Bun and Node hosts do; the Durable Object and Rivet
sockets never answer `buffered` (the platform owns the outgoing queue and has no drain event),
so on those hosts presence to a stalled client still queues in the platform's socket and the
bound is the platform's own close of a client that cannot keep up.

**A liveness timeout belongs at this seam too** `[built for the relay link]`. A
link that stops delivering without closing is indistinguishable from a quiet one
unless the port says otherwise: the peer advertises its keepalive interval and
the reader is cancelled at 2.5× it. Built in `relay.ts` + `relay-transport.ts`;
a radio channel implementing `FramedLink` owes the same contract, and a peer
that advertises nothing is left alone rather than killed on a cadence it never
agreed to.

## Adapters — the only place a channel is named

`syncmesh/transports` exports factory functions the app passes to
`createClient({ transports: [...] })`:

| Adapter | Wraps | Status |
|---|---|---|
| `relay(url, room)` | WebSocket to the relay (RFC-0010) | implemented (M11) |
| `ble()` | `@syncmesh/ble-channel` (RFC-0006) | N2 |
| `wifiAware()` | `@syncmesh/wifi-aware-channel` (RFC-0007) | future |

Each adapter is ~10–50 lines: construct the channel, hand its FramedLink to
the engine. **This file is the entire blast radius of adding a transport.**

## Route scoring

`route-scorer.ts` — pure, deterministic `pickRoutes(candidates, message)`:
small/urgent traffic prefers direct low-latency links, bulk payloads route
off 24 kbps radios toward Wi-Fi Aware/relay, offline candidates are never
picked, redundancy fans out best-first.

**Honest status: built and tested, wired nowhere.** The engine currently
sends on every link. Threading `pickRoutes` into the send path is task N1 —
it only becomes observable once a second transport exists (N2).

## Forbidden leaks

- `src/core` and `src/client` may not import any channel or radio package.
- A channel may not import `syncmesh` — it sees `Uint8Array`s, nothing else.
- Capability hints (bandwidth class, energy class) cross the port as plain
  data on the adapter, never as channel types.

## Remaining work

- Wire `pickRoutes` into the send path + a two-transport test where a bulk
  payload provably routes off the slow link (N1).
- `ble()` adapter (N2), `wifiAware()` adapter (N4/future).

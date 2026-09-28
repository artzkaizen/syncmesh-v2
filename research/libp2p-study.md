# What libp2p does, what we took, and what we did not

Read from the source of `js-libp2p` (cloned at `main`, 2026-09) rather than from its docs, because
the package list is the argument and the interfaces are the detail.

## The finding, in one line

**libp2p separates four things we had fused into each adapter**: dial/listen, discovery,
encryption + muxing, and admission. We fused all four into `lan()`, `ble()`, `awdl()` and
`wifiAware()` — and the only thing making every link encrypted was that the same three lines had
been written out four times.

## What the source actually says

The package list is the architecture:

```
transport-tcp  transport-websockets  transport-webrtc  transport-webtransport  transport-circuit-relay-v2
peer-discovery-mdns  peer-discovery-bootstrap
connection-encrypter-noise  connection-encrypter-tls  connection-encrypter-plaintext
stream-multiplexer-yamux  stream-multiplexer-mplex
interface  interface-compliance-tests
```

**`Transport` is dial and listen, and nothing else.**

```ts
interface Transport {
  dial(ma: Multiaddr, options): Promise<Connection>
  createListener(options): Listener
  listenFilter: MultiaddrFilter
  dialFilter: MultiaddrFilter
}
```

**`PeerDiscovery` is an event emitter.** That is the entire interface:

```ts
interface PeerDiscovery extends TypedEventTarget<{ peer: CustomEvent<PeerInfo> }> {}
interface PeerInfo { id: PeerId; multiaddrs: Multiaddr[] }
```

mDNS never dials — `grep -c dial peer-discovery-mdns/src/*` is zero outside a doc comment.

**The `Upgrader` belongs to the framework.** A transport returns a raw `MultiaddrConnection`
(bytes + address); `upgradeOutbound` / `upgradeInbound` negotiate encryption and muxing. A
transport *cannot* forget to encrypt, because encrypting is not its job.

**The gater is a ladder, not a door** — eight points, each with only what is known at that
instant: `denyDialPeer`, `denyDialMultiaddr`, `denyInbound/OutboundConnection` (peer not yet
known), `denyInbound/OutboundEncryptedConnection` (peer now proven), `denyInbound/Outbound
UpgradedConnection`, plus the relay pair.

**Dial and listen are one transport.** `@libp2p/websockets` has both; the browser build swaps
`listener.browser.ts` in, which is:

```ts
export function createListener (): Listener {
  throw new Error('WebSocket Servers can not be created in the browser!')
}
```

`transport-tcp` does the same with `tcp.browser.ts`, throwing on construction — which is exactly
the book's *"an adapter unsupported on this platform fails construction with a typed error naming
it"*. The book was describing libp2p's pattern.

**There is no random churn.** `connection-pruner` sorts by peer *value* (a tag sum protocols
contribute to), then connection age newest-first, then direction inbound-first, then stream count,
and prunes the bottom `n`. Topology refresh is kad-dht's `RandomWalk`, a separate thing.

## What we took

1. **The `Upgrader` seam** — `packages/transport/src/upgrade.ts`. Adapters hand over a channel and
   get back an `Upgraded`; framing, the handshake, the door and the attach happen once, in one
   place. Two doors in, because there are two kinds of medium: `upgrade.bytes(stream)` for a
   socket or a Wi-Fi data path, `upgrade.frames(link)` for a radio that fragments below this line
   and would otherwise pay for boundaries twice.

2. **The gate ladder** — `AdmissionStage` is `"dial" | "proven"`. The cheap rung refuses before a
   socket and a handshake are spent, on what an announcement *claimed*; the `proven` rung has the
   handshake's signature and is where a policy that matters belongs. We collapsed libp2p's eight
   to two because two is where this system has facts.

3. **The channel conformance suite** — `transport-tests/channel.ts`, modelled on
   `interface-compliance-tests/transport`. Small writes, many writes, a megabyte, both ends at
   once, the gap before a reader attaches, writes after close. Run by both virtual mediums and by
   real sockets on the loopback. **Both real defects found while building the adapters live below
   this line**, and neither was visible in a convergence test.

4. **Value-sorted pruning.** `mesh.churn` gives up its *least valuable* link, ranked on the facts
   the budget already uses. Dropping uniformly at random is the obvious implementation and the
   wrong one: sooner or later it takes the peer holding everything this device still needs.

5. **A global ceiling as well as per-medium budgets.** libp2p has only the global one (300 on a
   server, 100 in a browser). A mesh on radios needs both: a BLE controller degrades past six
   whatever the process can afford, and a device inside every medium's budget can still be out of
   file descriptors.

6. **One `webSocket({ id, bootstrap? })`.** `bootstrap` present dials, absent is the accepting
   side — which is a server, and says so by construction. `webSocketListener()` is cut.

## What we did not take, and why

- **Multiaddr.** libp2p needs a universal address scheme because anyone can add a transport. We
  ship five and our peer id plus a per-medium reach is enough; adopting it buys a parsing layer.
- **A universal discovery/transport split.** Only LAN separates cleanly (multicast → TCP). BLE
  discovery *is* BLE advertising and Wi-Fi Aware discovery *is* the service publish — you cannot
  mDNS-discover a peer and then reach it over BLE. A `PeerDiscovery` interface only one of three
  adapters could satisfy honestly is worse than the fusion.
- **Conditional exports instead of injected ports.** libp2p puts `node:net` in the transport and
  swaps the file per platform. That works for node builtins and not for a React Native native
  module, which is what BLE, AWDL and Wi-Fi Aware are — you cannot `browser`-field your way to a
  module the app installs. D01-B (lint-enforced) stands, and injection is also what lets thirty
  devices run deterministically in one process.
- **`http` as a transport.** Ch. 30 lists it; ch. 19 describes the same thing as *not* a
  transport — the HTTP door is `server.fetch`, with `auth` turning a request into a principal and
  handlers running once against Postgres. It has no handshake, no grants, no cursors. Cut.

## The BLE hole, and what closed it

The gate ladder's cheap rung takes a peer id. BLE has no peer id when it decides to dial: an
advertisement is 31 bytes, flags take 3 and a 128-bit service UUID 18, and a local name costs 2
more for its header — so what travels is `HINT_CHARS = 8`, the **first four bytes** of a 64-hex-
character id. Every other medium refuses a stranger before opening anything; BLE was connecting,
discovering services, subscribing, negotiating MTU and completing an X25519 handshake first.

Matching the hint against grants we hold gives a cheap *yes* and cannot give a cheap *no*: a
device with no grant yet must stay dialable (`requesting === true` forces allow — the join
corridor), and four bytes cannot tell "another company's phone" from "one of ours, about to ask
for a grant".

Two things fixed it, and neither needed a peer id:

1. **A four-byte fleet tag in the scan response.** The scan response is a *second* 31-byte
   payload, and the service data was spending 22 of it — nine to spare. A group can be refused on
   where a peer prefix cannot, because a device of ours carries its group from **config**, before
   it carries any credential. Absent is abstain: an older build advertises no group and some
   platforms drop service data, so a missing tag dials as before rather than making a fleet
   invisible to itself. Not a digest and it does not need to be — `group` is already an
   optimization and not a security control, and a collision costs one dial.

2. **A refusal is remembered.** `UpgradeOptions.onRefused` feeds the same backoff a failed dial
   feeds, on every medium. The first connection to a stranger is the price of not knowing; a
   lobby phone announcing every second for an hour used to charge it a thousand times.

What remains genuinely unavailable on BLE is quarantining one *named* device before a connection
is spent. That is a property of 31-byte advertisements. libp2p has the same hole, which is why
its ladder separates `denyDialMultiaddr` from `denyDialPeer`.

## One place libp2p is better and we have not followed

Its transports are **one package each**, so an app installs only the mediums it uses. Ours are one
`@syncmesh/transports`, per ch. 30. With `sideEffects: false` an unused adapter tree-shakes, so
the cost is bundler-dependent rather than certain — but on a platform with a weak bundler, a
browser app pulls BLE code it can never run. Revisit if that shows up in a real build.

---
rfc: 0006
title: BLE Channel
package: "@syncmesh/ble-channel  (over @syncmesh/rn-ble)"
layer: 1
status: port-pending
standalone: true
deps: ["@syncmesh/rn-ble"]
---

# RFC-0006 — BLE Channel

## Purpose

Authenticated, encrypted, reliable **message delivery between nearby phones
over BLE**. Radios move ~140-byte notifications; apps want to send whole
messages to a verified peer. This package closes that gap — and knows
*nothing* about sync.

## Standalone story (first-class, not incidental)

Anyone building nearby p2p in React Native — chat, file drop, game lobby,
contact exchange — wants exactly this and does not want a sync engine:

```
const ch = createBleChannel({ identity })   // Ed25519 keypair
ch.onPeer((peer) => peer.onFrame(handle))   // discovered + authenticated
peer.send(bytes)                            // encrypted, fragmented, acked
```

That surface is the product. SyncMesh is merely one customer (via the
`ble()` adapter, RFC-0005).

## The stack inside

```
@syncmesh/rn-ble        LAYER 0 — raw radio: advertise, scan, connect, write/notify
                        (published to npm; zero crypto, zero session concepts)
        ↓
discovery               advertise/parse peer identity, TTL sightings table
handshake               3 frames: hello → auth → proof
                        Ed25519 identity + X25519 ephemeral → shared session key
encryption              XChaCha20-Poly1305 per frame payload — ON by default
fragmentation           MTU-sized fragments, reassembly by (sender, messageId)
reliability             acks, retries with backoff, session staleness, reconnect
        ↓
FramedLink              send(frame) + onFrame(cb)   ← the ONLY thing exported up
```

## Where the code is today

The donor is `../syncmesh/packages/transport-ble` — discovery, the 3-frame
handshake, fragmentation/acks/backoff are **proven on real phones**. Two
defects must die in the port:

1. The session key is derived and then **never used** — payloads are
   plaintext. Encryption is on by default in this package.
2. `handleInboundFrame` falls back to decoding **unauthenticated bare
   frames** (`transport.ts:398–401`). Deleted; post-handshake, only
   authenticated session frames are accepted.

Also deleted: the deterministic-identity fallback (keys derived from public
peerId — trivially impersonable).

## Forbidden leaks

- Must never import `syncmesh` or mention `SyncEvent` — the leak test is
  `grep -r "syncmesh\|SyncEvent" src/` returning nothing.
- `@syncmesh/rn-ble` stays even lower: no handshake, no crypto, no channel
  concepts. Its consumers include people who want raw BLE only.

## Remaining work (task N2)

- Extract the donor into this package shape, encryption on, fallbacks out.
- Contract-test against `framed-link.ts`'s loopback suite — the same suite
  every channel must pass (transport equivalence, RFC-0002 invariant 6).
- Acceptance: two phones converge on the syncmesh-next engine over BLE only —
  and separately, a 30-line demo app exchanges chat messages with **no
  syncmesh import**, proving the standalone story.

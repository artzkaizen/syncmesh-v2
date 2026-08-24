---
rfc: 0007
title: Wi-Fi Aware Channel
package: "@syncmesh/wifi-aware-channel  (over @syncmesh/rn-wifi-aware)"
layer: 1
status: future
standalone: true
deps: ["@syncmesh/rn-wifi-aware (future)"]
---

# RFC-0007 — Wi-Fi Aware Channel

## Purpose

The **bulk pipe**: ~10 MB/s nearby transfer where BLE gives kilobytes. In the
mesh it carries catch-up bursts, snapshots, and blobs while BLE stays the
always-on, low-energy discovery plane. The route scorer (RFC-0005) steers
traffic between them without the engine noticing.

## Standalone story

Same rule as RFC-0006: high-bandwidth nearby transfer for ANY React Native
app — photo hand-off, local backup, LAN-less file share. No sync imports,
ever. The package is worth publishing on that story alone.

## Shape (mirrors the BLE channel, minus what a socket makes unnecessary)

```
@syncmesh/rn-wifi-aware   LAYER 0 — native module: publish/subscribe on a
                          service name, token = peerId; on match the platform
                          hands you a real duplex socket (both iOS + Android)
        ↓
handshake                 SAME 3-frame hello → auth → proof as BLE —
                          identity and encryption are transport-independent;
                          the platform's own link security is untrusted
                          belt-and-braces
framing                   uint32 length-prefix per message — a socket is a
                          stream, so no fragmentation layer at all
lifecycle                 sessions are expensive: bring the radio up on demand
                          (pending bulk transfer), tear down after idle;
                          BLE remains the discovery plane
        ↓
FramedLink                send(frame) + onFrame(cb) — identical port, so
                          framed-link.ts and its whole test suite apply as-is
```

## Why this package can wait

The FramedLink port means adding it later costs no rework: the sync session,
grant exchange, and catch-up logic are already transport-independent and
contract-tested over loopback. What it unlocks when it lands: snapshot
bootstrap in seconds instead of minutes, and blobs between phones without a
relay.

## Forbidden leaks

Identical to RFC-0006: no `syncmesh` import, no event knowledge. The native
module stays raw (no handshake/crypto in Layer 0).

## Work plan (N4, when reached)

1. Native module spike: NearbyConnections/Wi-Fi Aware APIs on Android,
   NetworkFramework peer-to-peer on iOS — confirm the socket hand-off.
2. Channel: handshake + length-prefix framing + lifecycle; pass the shared
   channel contract suite.
3. `wifiAware()` adapter (~20 lines, RFC-0005) + route-scorer profile
   (high bandwidth, high energy) — at which point bulk traffic moves itself.

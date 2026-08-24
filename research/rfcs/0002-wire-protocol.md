---
rfc: 0002
title: Wire Protocol & Conformance
package: syncmesh (src/protocol)
layer: contract
status: implemented
standalone: false
deps: []
---

# RFC-0002 — Wire Protocol & Conformance

## Purpose

The one contract every implementation shares — TypeScript engine, relay,
authority, and future Swift/Rust ports. If two programs both produce the
frozen bytes in `conformance/vectors.json`, they can sync. Prose can drift;
these bytes cannot.

## The record

An **event** carries *captured changes* — facts, not code to re-run:

```
SyncEvent {
  peerId      Ed25519 public key of the authoring device (the key IS the id)
  seqNum      per-device monotonic counter        → id = "{peerId}-{seqNum}"
  hlc         [physicalMs, logical]               → total order with peerId tiebreak
  partition   "kind:id"  (optional, canonical key — pre-partition vectors stay valid)
  changes[]   insert | update | delete  — table, key, row/patch
  sig         detached Ed25519 over the canonical-CBOR core
}
```

Wire shape: CBOR array `[core: bstr, sig: bstr]`. Receivers verify against
the **received core bytes as-is** — never re-encode. Stored bytes are
re-forwarded byte-identical (store-and-forward gossip cannot invalidate a
signature).

## Encoding rules

- Canonical CBOR: integer map keys, shortest-form heads, ascending key order.
- Hand-rolled codec (`src/protocol/codec.ts`), zero deps — the schema is
  fixed, so a general CBOR library is not worth its canonicalization risk.
- Unknown map keys and unknown message kinds MUST be skipped, never errored —
  this is the entire forward-compatibility story.

## Message kinds

| Kind | Purpose | Where |
|---|---|---|
| event | live gossip of one signed event | link + relay |
| catch-up (cursors) | "newest I hold per author — send what I'm missing" | link + relay |
| grants | signed grant envelopes, travel FIRST in every session | link + relay (RFC-0008) |
| ack | relay durability receipt (feeds write handles) | relay |
| snapshot | staged rows + floor cursors for below-floor joiners | engine (RFC-0003) |
| blob | content-addressed bytes by sha-256, verify on put and fetch | relay blob store |
| presence | signed ephemeral topic value — **no seqNum**, never stored, never folded | link + relay (RFC-0020 §6) |

## Invariants (pinned by tests)

1. Signature before state — nothing unverified touches log or rows.
2. Idempotent everything — any message may arrive twice; dedup by id/hash.
3. Order-free apply — any interleaving of the same events → identical state
   (fast-check property, thousands of schedules per run).
4. Ignore-unknown — junk and future kinds never throw, never mutate
   (fuzz suite: 500 garbage frames, 300 bit-flips, zero state changes).
5. decode ∘ encode ≡ identity, byte-stable (signatures depend on it).

## Bulk framing: the catch-up chunk `[proposed]`

Per-event framing is right for live gossip and **wrong for catch-up**. A real
group-chat event measures **250 B** signed on the wire, of which 96 B is
identity overhead repeated on every event:

| part | bytes | share |
|---|---|---|
| Ed25519 signature | 64 | 26% |
| peerId (raw 32-byte pubkey) | 32 | 13% |
| payload + framing | 154 | 61% |

Shipping 10,000 of those is 2.4 MB — minutes over BLE. A **catch-up chunk**
carries the same events for **~18 B each**, measured (2,000 messages, 20
authors, one room):

| framing | B/event | vs today |
|---|---|---|
| today, per-event frames | 250 | — |
| batch, gzip only | 93 | 2.7× |
| chunk (dictionary + chunk sigs), no compression | 151 | 1.7× |
| chunk + per-event sigs kept, zstd | 82 | 3.1× |
| **chunk + gzip** | **17.5** | **14.3×** |
| chunk + zstd | 18.3 | 13.7× |

Three mechanisms, none of which change the event record itself:

1. **Session dictionaries.** peerIds, table names, column names and procedure
   names are negotiated once per session and referenced by 1-byte index.
   Kills the 32 B peerId and most repeated strings.
2. **Hash-chained author feeds + signed heads** `[implemented]`
   (`src/protocol/feed.ts`, `Engine.chunkSince` / `Engine.receiveChunk`).
   Each author maintains `h(n) = H(h(n-1) ‖ core(n))` over its own events.
   Signing `h(n)` authenticates *every* event up to `n`, so a contiguous
   range costs **one** 64 B signature instead of one per event — and **one**
   verification instead of N. The chain is the SSB/hypercore construction,
   and it is **derived, never embedded**: the event record and its canonical
   CBOR are untouched, so the conformance vectors stay valid and per-event
   signatures keep working for live singletons and non-contiguous forwards.
   The two interoperate in both directions (tested): every ingest path
   advances the chain, so a chunk can continue after singletons and back.

   Measured on the Linear-like workspace (27,891 events, 25 authors,
   `bench/linearlite.ts`): cold join **19.3 s → 215 ms**, because it is 25
   signature checks instead of 27,891. Wire: 7.00 MB → 0.60 MB gzipped
   (263 → 23 B/event).

   What a chunk cannot do is authenticate a **gapped** range: the receiver
   must already hold a verified `h(start-1)`, which it does when catching up
   from its own cursor (and `h(0)` on a cold join). After compaction the
   prefix is unprovable and that author falls back to per-event signatures.
   The chain binds the run together, so one tampered, reordered or dropped
   event invalidates the whole chunk — nothing in it is applied.
3. **Compress the chunk, not the event.** gzip matches zstd here (17.5 vs
   18.3 B) and is available everywhere (`CompressionStream`), so gzip is the
   baseline and zstd an optional negotiated upgrade.

**Compression is a bulk-only win** — it needs volume to amortize:

| chunk size | B/event |
|---|---|
| 1 | 193 |
| 10 | 76 |
| 100 | 31 |
| 1,000 | 17.9 |

So the rule is: **live gossip stays per-event framed; anything ≥ ~100 events
goes as a chunk.** Below that the dictionary still helps and compression
barely does.

### What this does to the radio

Time to ship 10,000 events (measured bytes ÷ link rate):

| link | today | chunked |
|---|---|---|
| BLE 4.0, 24 kbps | 14 min | 61 s |
| BLE 4.2 + DLE, ~250 kbps | 80 s | **5.9 s** |
| BLE 5 2M PHY, ~700 kbps | 29 s | **2.1 s** |

Two things follow. First, the pessimistic 24 kbps figure is a BLE 4.0-era
number; the channel (RFC-0006) must negotiate DLE and 2M PHY and **report its
real throughput**, because the routing scorer's decisions (RFC-0012) are only
as good as that number. Second, even at 18 B/event, replaying a million-event
history is 18 MB — so **cold join must never replay the log**. It takes a
scoped snapshot plus on-demand backfill (RFC-0015), and the log ships only the
delta since a cursor.

## Consumers

Engine (RFC-0003), relay + authority (RFC-0010), channels carry these bytes
opaquely (RFC-0006/0007), Swift ports (`syncmesh-ios/-macos`) must reproduce
the vectors byte-for-byte before they count as ports.

## Remaining work

- Freeze a vector for every message kind (events + grants are frozen; add
  snapshot/blob/ack frames).
- Spec doc for the Swift port task (N4) — the vectors are the acceptance test.
- Chunk framing above: dictionary negotiation, hash-chained heads, gzip
  envelope — plus vectors for each, and a test that a chunk and its
  equivalent per-event frames fold to identical state.

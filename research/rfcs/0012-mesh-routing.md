---
rfc: 0012
title: Mesh Management & Routing
package: syncmesh (src/core/link.ts · src/transport) — design
layer: 2
status: partial
standalone: false
deps: ["0005", "0006", "0007", "0010"]
---

# RFC-0012 — Mesh Management & Routing

## Purpose

Who decides which links exist, which transport carries which message, and how
events reach peers you are not directly connected to. Today the route scorer
is a pure function wired to nothing, and link lifecycle is implicit (every
transport talks to everything it finds). This RFC names the missing component
— the **mesh manager** — and specifies its policies. The `flow` view in this
site animates every policy below.

## "Routing" is three separate problems

| # | Problem | Owner | Status |
|---|---|---|---|
| 1 | **Link admission** — which physical links to open, keep, drop | mesh manager (this RFC) | proposed |
| 2 | **Route selection** — which open link carries THIS message | `pickRoutes()` (route-scorer.ts) | built, unwired (N1) |
| 3 | **Dissemination** — reaching peers with no direct link | anti-entropy (link.ts catch-up) | built |

Keeping them separate is what keeps each one simple. Conflating them is how
mesh projects drown.

## Who is the mesh manager?

**Nobody — and everybody.** There is no elected leader, no coordinator, no
special node. Every device runs its own manager loop over purely local
knowledge (discovered peers, open sessions, cursor freshness, link quality).
Global behavior *emerges*. The only cross-device coordination is
deterministic tie-breaking: the lexicographically smaller peerId dials, the
other listens — so two managers never duel over who connects to whom. This
is the same principle as the rest of the system (HLC ordering, LWW): agree
by computation, never by negotiation.

## 1 · Link admission

Per discovered peer, a small state machine:

```
discovered → scored → (dial | hold) → session (grants → catch-up → live)
                                    → stale → backoff (400ms → 15s) → re-dial
```

**Budgets are per transport, per device** — declared by the adapter, enforced
by the manager:

| Transport | Default budget | Why |
|---|---|---|
| BLE | `maxLinks: 6` | the radio sustains ~4–8 concurrent links before everything degrades |
| Wi-Fi Aware | 1–2 | expensive radio, on-demand only (RFC-0007) |
| relay (ws) | 1 socket | rooms are multiplexed on it, no reason for more |

**Neighbor selection when over budget** — keep the links that maximize
*coverage*, not signal strength. Score each candidate:

```
score(peer) = w1 · cursorFreshness(peer)      // do they give me events I lack?
            + w2 · partitionOverlap(peer)      // how many of my partitions do they share?
            + w3 · linkQuality(peer)           // RSSI / throughput EMA
   + one slot reserved for RANDOM rotation     // keeps the graph connected —
                                               // pure greedy scoring forms cliques
```

**Churn dampening:** hysteresis — never drop a live session until the better
candidate has been stable for T seconds. Backoff on failures (exists in the
donor BLE stack, RFC-0006).

## 2 · Route selection — "which of my three networks?"

There is **no global transport ranking**. Priority is per *traffic class*,
computed by `pickRoutes(candidates, message)` from declared link properties
(`bandwidthBps`, latency, energy class):

| Traffic | Size | Wants | Typical winner |
|---|---|---|---|
| live event | ~200 B | latency, low energy | BLE direct |
| grants / acks | tiny | reliability | cheapest open link |
| catch-up chunk | ~14 KB | bandwidth | Wi-Fi Aware → relay → BLE |
| snapshot / blob | MBs | bandwidth, resumable | Wi-Fi Aware → relay; **BLE refuses bulk by default** |
| presence (RFC-0020 §6) | ~100 B | freshness only | cheapest OPEN link; **first dropped when congested, never wakes a dormant radio** |

Rules the scorer already encodes (route-scorer.ts, tested): offline
candidates never picked; big payloads route off 24 kbps radios; redundancy
fans out best-first. Rules this RFC adds:

- **Never wake a dormant expensive radio for small traffic.** Wi-Fi Aware
  comes up when ≥ N KB is pending for a peer, idles back down after.
- **Classes are independent:** a 2 MB snapshot on Wi-Fi Aware does not move
  live events off BLE — they were never competing.
- **Presence conflates instead of queueing.** The scorer sets its cadence from
  the winning link's bandwidth (~100 ms on relay/Wi-Fi Aware, slower or
  suppressed on a 24 kbps radio). A frame that cannot go now is *replaced* by
  the next one, never queued behind it — stale presence has no value to deliver.
- The relay, when configured, is a permanent low-priority candidate for
  everything — the floor that makes "no nearby path" a latency problem
  instead of a correctness problem.

## 3 · Overlapping groups — one peer, many partitions

Peer P shares workspace W1 with you (six devices) and also W2 (four devices).

- **Links are per-peer. Sessions are per-(peer, store scope).** One physical
  BLE link to P multiplexes frames for both stores — exactly as relay rooms
  already do (`room/org:acme`, RFC-0010). Budgets count **physical links**,
  never groups.
- Catch-up cursors are per store scope — the logs never mix (RFC-0004
  `storeFor`), so W1 traffic cannot leak into a W2-only device.
- Admission scoring *rewards* overlap: P sharing two partitions with you
  makes P a more valuable neighbor than a single-overlap peer — one link
  serves two syncs.

## 4 · Dissemination — reaching peers beyond one hop

Three layers, cheapest-first. Correctness only ever depends on the last one.

| Layer | Fires when | Per-hop latency | Radio cost |
|---|---|---|---|
| direct gossip | author commits → its session peers | one frame (~tens of ms) | minimal |
| **eager forward** `[proposed]` | receiver of a NEW event pushes it to sessions whose last-known cursor lacks it | one frame | duplicates bounded by degree, deduped on arrival |
| anti-entropy round | periodic tick + every session start/reconnect | up to one interval | one batch per round — also the repair layer |

**Eager forward is not flooding.** Blind TTL re-broadcast (BitChat's relay:
probability 0.45–1.0 by peer degree, TTL clamped 3–7 — right for ephemeral
crowd chat) re-sends regardless of need. Eager forward is *targeted*: C
already holds D's cursors from their last exchange, so C pushes only events D
provably lacks, and D's dedup makes any race with another neighbor cost one
frame. No TTL, no storm; worst-case duplicate factor is the link degree.
This is the Plumtree / Epidemic-Broadcast-Trees shape: **eager push for
latency, lazy anti-entropy for reliability** — the eager layer may miss
(churn, loss, budget); the round repairs it. T1 convergence never depends on
the eager layer existing at all.

### The crowd test — 200 people, no internet

Latency is **linear in hops** (worst ≈ hops × layer latency); *coverage* is
exponential (each round multiplies the reached set by ~fanout → ~3–4 rounds
for 200 peers). BLE through bodies reaches ~15–30 m; a 100 m festival field
is ~4–6 hops across; degree-6 graphs have diameter ~3–4:

| Mode | 5-hop crossing | Fit for crowd messaging? |
|---|---|---|
| anti-entropy only (4 s round) | ~10–20 s | no — this is the repair cadence, not the live path |
| eager forward | **~0.2–0.5 s** | yes — sub-second across the field |

> Direct links are a **latency optimization**. Convergence never depends on
> topology — that is what the T1 property test actually proves. Eager
> forward is the knob that makes multi-hop *feel* live; anti-entropy is what
> makes it *true*.

## Current state → work

| Piece | State | Task |
|---|---|---|
| `pickRoutes` scorer | built + tested, wired to nothing | **N1**: thread into the engine send path; tag messages with a traffic class |
| sessions (grants-first, catch-up, resync) | built (`link.ts`, M19 framed-link) | — |
| deterministic dialer, backoff | proven in donor BLE stack | **N2**: port with the channel (RFC-0006) |
| budgets + admission scoring + hysteresis | **does not exist** | **N2**: manager v1 = budget + dialer + backoff; scoring v1 = partition overlap + cursor freshness |
| eager forward to behind-cursors | **does not exist** — today multi-hop waits for the round | **N2**: push new events to sessions whose cursors lack them; dedup already makes it safe |
| random rotation slot | — | later; measure clique formation first |
| Wi-Fi Aware on-demand lifecycle | — | with RFC-0007 |

**Tests to pin:** budget never exceeded under discovery storms; no dial duels
(both sides agree who dials, property test over random peerId pairs);
over-budget peer converges via a neighbor within K catch-up rounds; a bulk
payload never selects BLE while a faster link is open; live-event latency
unaffected during a concurrent snapshot transfer; with eager forward on, an
N-hop line topology delivers in O(N) frame-times (not N rounds) and the
duplicate factor per event never exceeds the link degree.

---
rfc: 0015
title: Retention — Compaction, Snapshots & Blob Lifecycle
package: syncmesh (src/core/engine.ts · src/blob)
layer: 2
status: partial
standalone: false
deps: ["0002", "0003", "0004", "0010"]
---

# RFC-0015 — Retention — Compaction, Snapshots & Blob Lifecycle

## Purpose

The event log exists for two jobs: catch up peers you've met, bootstrap
peers you haven't. Neither needs infinite history — change-carrying events
make current state self-sufficient (RFC-0003). This RFC bounds all three
growth axes: the log, the join cost, and media (never in the log at all).

A fourth kind of data is bounded by construction rather than by policy:
**presence** (RFC-0020 §6) never enters the log, a snapshot, a catch-up or a
compaction floor. It is TTL'd live state held in memory, and this RFC owes it
nothing. That exemption is load-bearing — a 60 Hz cursor stream inside the log
would breach §1's economics on its own, before any real data was written.

## 1 · Why the log must be bounded — the economics

Calibration: Kleppmann's editing trace — the canonical CRDT benchmark — is
ONE 17-page paper: **259,778 single-character events** for a 104,852-char
document. Enveloped as signed events (~300–500 B each) that is ~80–130 MB
of log for a 100 KB document — **1000× amplification** (CRDT encodings
compress the same trace to ~100–300 KB).

Tiers — 5-person mesh, 6 months, ~400 B/event:

| Tier | Events | Log | Live state |
|---|---|---|---|
| Team tool (issues, comments) | ~180k | ~72 MB | 10–50 MB |
| Chat, text only | ~90k | ~36 MB | ~30 MB + media OUTSIDE the log |
| Collab text, per-keystroke | 1M+ | 400+ MB | ~1 MB — **forbidden** |
| Collab text, paced/CRDT-delta | ~30–75k | ~15–30 MB | ~1 MB |

Join cost, team tier: full-log replay of 72 MB ≈ 6.7 h at the BLE floor
(3 KB/s), ~24 min at a realistic 50 KB/s; a staged hot-subset snapshot
(~2 MB) ≈ 11 min / 40 s / sub-second on Wi-Fi Aware. CPU agrees: fold ≈
5–10k events/s on a phone, snapshot bulk-insert ≈ 50k rows/s. Two rules
fall out: **per-keystroke events are forbidden by economics** (pace edits,
or CRDT field deltas), and **snapshot is the default join path** (§3).

## 2 · Compaction

An event is **compactable** when both hold [proposed policy]:

1. `event.seqNum ≤ ackFloor(event.peerId)` — every known peer has acked at
   or past it (acks = the cursor maps anti-entropy already exchanges; the
   floor is the minimum across known peers).
2. `age > retention.keepAtLeastDays` — grace for peers that were offline
   but will return; inside the window they still delta-sync.

Compaction deletes those events, drops tombstones below the floor, and
writes a **checkpoint** `{ floorCursors, stateHash }` — a durable record of
"state as of these cursors" [proposed].

### 2a · Dead peers [decided, D15]

A known peer that never returns would pin `ackFloor` forever. `forgetPeersAfter` bounds it: a peer
whose last ack is older than the window is no longer counted. The teeth: a forgotten peer that
returns below the floor cannot delta-sync — the events are gone — and rejoins from state (§3).
Acks are held in memory, so a restarted device counts nobody until peers talk again; that errs
towards keeping. The store persists the floor it compacted below, and a corrupt state cache over a
compacted log refuses to boot rather than rebuild a partial state from half a log.

**The invariant (tested): compaction is unobservable.** For every device D
and peer P: fold(snapshot + remaining events) ≡ fold(full history), and P
ends in the same state whether it synced before or after D compacted.
`tests/compaction.test.ts` (T5) pins it: state identical across `compact()`,
delta-sync works both ways afterward, the engine still advertises its own
high-water seq (peers never re-send compacted history), snapshot tombstones
don't resurrect on latecomers, log bounded (<120) under 500 events of churn.

## 3 · Snapshots — the default join path

A peer below someone's compaction floor cannot delta-sync — the events are
gone. It bootstraps, and per §1 every fresh joiner should too:

```
joiner    → snapshot-request { have?: { stateHash, floorCursors } }
responder → chunk 0 = manifest { totalBytes, totalRows, floorCursors,
            stateHash, tables: [{ table, rows, bytes, tier: hot|cold }] }
          → HOT tier first — rows the first screen needs; isReady fires here
          → cold tail streams behind; chunks acked, resume at last acked
joiner    → installs rows, adopts floorCursors as its own cursors
          → ordinary catch-up covers everything after the floor
```

Every snapshot row carries `lastWriterHlc` so later events LWW correctly
against snapshot state. Bulk chunks take the route scorer's bulk profile
(RFC-0012): Wi-Fi Aware / relay preferred, BLE last resort and hot-subset
only. Bootstrap cost must track *what the UI shows*, not *what the mesh
holds* — that is the policy this RFC owns; wire shapes belong to RFC-0002.

## 4 · Blob lifecycle

Blobs never enter the event log — a row carries a content hash; bytes move
lazily on a side channel. The laws, built in M17:

| Law | Where |
|---|---|
| content-addressed: sha-256 of the bytes IS the identity | `src/blob/blob-store.ts` `hashOf` |
| verify on put — junk can't squat a hash | relay (`server/relay.ts` blob-put) |
| verify on fetch — a reference is a PROOF, not a promise | `verifyBlob` → `BlobCorrupt` |
| failures are typed values, never throws | `BlobCorrupt / BlobNotFound / BlobTimeout` |
| route policy: bulk class only — BLE refuses by default | RFC-0012 traffic table |

Proposed: range requests (resumable fetch). GC, quotas, and storage
obligations are genuinely open — see below.

## 5 · The server as deep archive

Retention is per device. The relay (RFC-0010) already stores signed bytes
it cannot forge; it is the natural deepest tier: phones compact
aggressively, the server keeps months (or everything), and stragglers below
every phone's floor bootstrap from it — the peer with the deepest log.

## Current state

| Piece | State |
|---|---|
| `engine.compact(ackedCursors)` — floor = min over caller-supplied cursor maps; T5 (unobservable, bounded churn, latecomer snapshot + tail) | built (M3, `tests/compaction.test.ts`) |
| `snapshotEvery: N` through the EventStore's optional tier (RFC-0004); boot = snapshot + tail, never a full-log refold; tier-less stores full-refold | built (M16, `tests/staged-snapshots.test.ts`) |
| compaction clamped to the PERSISTED snapshot's coverage — a restart can never lose the tail | built (engine `snapshotCursors` ceiling) |
| blob store, relay verify-on-put, client verify-on-fetch | built (M17) |
| ack-floor policy: automatic floors from link acks + `keepAtLeast` + `forgetPeersAfter` | built (v2, `engine.compact`, `compaction.test`) |
| checkpoint record `{ floorCursors, stateHash }` | proposed |
| per-partition retention overrides; zero-arg developer `engine.compact()` | proposed |
| chunked snapshot wire messages (manifest, hot tier, resume) | proposed — today `installSnapshot(snapshot())` is in-process |

## Remaining work

- Track peer ack floors (Link cursor exchanges); derive the compaction
  floor automatically; gate on `keepAtLeastDays`.
- Checkpoint record on compact; cross-peer `stateHash` comparison in T5.
- Chunked snapshot-request/response — manifest, hot tier, resume (extends
  RFC-0002); joiner adopts `floorCursors` then ordinary catch-up.
- Per-partition retention in `defineSync`, routed per store scope (RFC-0004).
- Blob range fetch + a persistent local blob store (today: memory only).

## Open questions

- ~~Blob GC~~ **answered (D18)**: neither refcount-to-zero nor TTL alone. The relay sweeps a
  blob only after no visible row has referenced it for a retention window; an offline device
  that reconnects with a stale reference gets `BlobNotFound`, a value, and any peer still
  holding the bytes can put them back under the same hash. Refcounting to zero the instant a
  row dies would break the offline device this engine exists for. The sweep itself is still to
  build.
- ~~Blob obligation~~ **answered (D18)**: the author holds it until a relay acknowledges it —
  the only window where the bytes exist in one place and only the author can reproduce them.
  The relay holds it while any row it can see references the hash. Every other device treats
  what it fetched as a cache it may evict at will.
- ~~Blob quotas~~ **answered in shape (D18)**: per-partition byte budgets refused at the put as
  a typed value, so an app can tell someone their upload did not fit. Deferred with the sweep;
  neither should be sized before a real workload.
- Checkpoint trust: is `stateHash` signed, and may a joiner treat a matching hash as verification of a received snapshot?

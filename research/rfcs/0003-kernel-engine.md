---
rfc: 0003
title: Kernel & Engine
package: syncmesh (src/core)
layer: 2
status: implemented
standalone: true
deps: ["0002", "0004", "0005", "0008"]
---

# RFC-0003 — Kernel & Engine

## Purpose

The sync engine itself: turn local writes into signed events, fold local and
remote events into converged state, and keep the log bounded. This is the
product; everything else exists to feed it or sit on top of it.

## Standalone story

An app that wants local-first data with **no server, no radio, no React**
uses the engine + one storage backend, full stop. Offline capability is not a
feature of this package — it is the architecture: reads and writes hit local
state; replication is a background concern that may never happen.

## The pieces

| File | Job |
|---|---|
| `core/hlc.ts` | hybrid logical clock — strictly monotonic even under backward wall clocks |
| `core/kernel.ts` | pure fold: field-level LWW, tombstones, dedup — no I/O, portable |
| `core/engine.ts` | mutate → validate → capture changes → HLC stamp → sign → append → notify |
| `core/link.ts` | sync session: grants first, cursor catch-up, live gossip, resync on reconnect |
| `core/router.ts` | typed api router (`bindApi` → `api.ns.name(input)`) |

## Contract with the outside

- **In:** `engine.mutate(...)` → `Result<SyncEvent, ValidationError | EmptyMutation>`
  — a denied write is a typed **value** at the call site, never a throw.
  Inbound: signed bytes from any link → verify → grant → policy → dedup →
  HLC/LWW apply. Receivers **never run app code**.
- **Out:** fold notifications (one per batch, tagged with touched tables — the
  reactive layer's only hook), materialized rows, per-peer cursors, acks.
- **Down:** `EventStore` port (RFC-0004), `FramedLink`/transport port
  (RFC-0005), policy evaluator (RFC-0008). The engine never names a backend,
  a radio, or a UI framework.

## Retention

`snapshotEvery: N` persists snapshots through the store's tier; boot =
snapshot + tail (never a full-log refold); compaction is clamped to the
persisted snapshot's coverage so restarts cannot lose the tail. Latecomers
below the floor bootstrap via snapshot, then ordinary catch-up.

## Guarantees (all tested today)

- Convergence: 3-engine random-gossip property tests; commutative +
  idempotent under any delivery order and duplication.
- 10k-event cold boot < 2s (snapshot tier, O(tail)); 5k-event catch-up in
  one fold notification; 10-peer full mesh converges.
- A throwing/hostile input quarantines with a typed reason; the engine never
  stops on one bad event.

## Remaining work

- `engine.start()` / `stop()` lifecycle symmetry (config consolidation, N1).
- Wire the route scorer into the send path (RFC-0005, N1).
- Conflict surface (losing-write records + restore-as-new-event) — N4.

---
rfc: 0001
title: Architecture & the Dependency Rule
package: (governing document)
layer: meta
status: governing
standalone: false
deps: []
---

# RFC-0001 — Architecture & the Dependency Rule

## The problem this solves

SyncMesh is many things at once: a local-first sync engine, an optional
authoritative server with real-time push, a REST surface with proper HTTP
verbs, and a family of radios (BLE today, Wi-Fi Aware next). Each of those
pieces is useful to someone who wants **none of the others**. Without a rule,
the pieces leak into each other and nothing is reusable.

## The rule

> **A package may only depend on packages in lower layers, and only through a
> named port. A package must never know the name of anything above it.**

```
LAYER 4  your app
LAYER 3  syncmesh/react · syncmesh/client        syncmesh/server (authority + REST + relay)
LAYER 2  syncmesh core  — kernel · engine · policy · schema · storage seam · transport seam
LAYER 1  channels       — @syncmesh/ble-channel · @syncmesh/wifi-aware-channel
LAYER 0  radios         — @syncmesh/rn-ble · @syncmesh/rn-wifi-aware
CONTRACT the wire       — canonical CBOR SyncEvent + conformance vectors (RFC-0002)
SIDECAR  inspector      — consumes a JSONL telemetry format, imports nothing
```

The **ports** are the only doors between layers:

| Port | Boundary | Shape | RFC |
|---|---|---|---|
| `FramedLink` | channel → engine | `send(frame: Uint8Array)` + `onFrame(cb)` | 0005 |
| `EventStore` | storage → engine | append / scan / snapshot tier | 0004 |
| Wire protocol | any implementation ↔ any other | frozen CBOR bytes (`conformance/vectors.json`) | 0002 |
| Policy AST | rules ↔ every evaluator | serializable JSON tree, no closures | 0008 |

## Who uses what (the whole point)

| You are building… | You install… | You never touch… |
|---|---|---|
| A BLE chat/file-drop app, no sync | `@syncmesh/rn-ble` (+ `ble-channel` for auth/encryption) | the engine, the server |
| A local-first app, single device or relay-synced | `syncmesh` + `/client` + `/react` | radios, the server |
| Local-first + nearby p2p | + `syncmesh/transports` `ble()` → `ble-channel` → `rn-ble` | the server |
| A traditional server with realtime sync + REST | `syncmesh` + `/server` (+ relay) | every radio |
| All of it (the flagship app) | everything above | — |

## Leak tests (run these, literally)

A boundary holds when these greps return nothing:

```
grep -r "SyncEvent\|syncmesh" packages/ble-channel/src      # channel knows no sync
grep -r "ble\|Ble\|wifi"      syncmesh/src/core             # engine knows no radio
grep -r "react"               syncmesh/src/core src/client   # core is framework-free
grep -r "rn-ble\|channel"     syncmesh/src/server            # server knows no radio
```

The only files allowed to name a channel package are the thin adapters in
`syncmesh/transports` (RFC-0005) — each ~10–50 lines mapping a channel's
`FramedLink` onto the engine.

## Repo mapping today

- `syncmesh-next` = layers 2–3 + the wire contract, implemented (M0–M19).
- Old repo `../syncmesh` = layer 0 (`@syncmesh/rn-ble`, published), the layer-1
  donor code (`packages/transport-ble` — to be ported as `ble-channel`,
  RFC-0006), the inspector, and a legacy engine being retired.

## RFC index

**Blocks:** 0002 wire · 0003 kernel/engine · 0004 storage · 0005 transport
port & routing · 0006 BLE channel · 0007 Wi-Fi Aware channel · 0008 policy,
grants, partitions · 0009 client & reactive · 0010 server, relay & REST ·
0011 tooling · 0012 mesh management & routing.

**Cross-cutting design:** 0013 schema evolution & version skew · 0014
conflict surface, integrity & repair · 0015 retention (compaction, snapshots,
blobs) · 0016 identity, accounts & revocation · 0017 threat model · 0018
incremental view maintenance & query subscription · 0019 join, snapshots &
backfill.

## RFC process

Statuses: `proposed` (design, not yet in code) → `partial` (some of it built)
→ `implemented` (code + tests are the truth) — plus `port-pending` (proven
elsewhere, being ported), `future`, `governing` (this doc). An RFC is amended
by editing it, not by writing a competing doc — when reality diverges from an
RFC, the RFC gets the correction and a line in its "Open questions" or
"Current state". The site rebuild is `bun rfcs/build.ts`.

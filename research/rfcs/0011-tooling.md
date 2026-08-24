---
rfc: 0011
title: Tooling — Inspector, Conformance, Demo
package: "@syncmesh/inspector · conformance/ · src/demo"
layer: sidecar
status: partial
standalone: true
deps: []
---

# RFC-0011 — Tooling

## Inspector (standalone by construction)

Lives in the old repo (`packages/inspector`) and is already the model
citizen of the dependency rule: it imports **zero** `@syncmesh/*` packages.
Its entire contract is a JSONL telemetry line format — tail a log file,
stream over SSE to a React timeline UI (filters, correlation ids, pause/
buffer). Anyone with a structured log can use it.

**Gap:** syncmesh-next emits no telemetry yet. Task (N4): a `telemetry`
hook on engine/link/channels that writes the inspector's line format —
frames, sessions, events, quarantines. The old BLE stack already writes it;
the Swift probes do too (`BLEFileLogger`), so mesh debugging across three
implementations lands in one timeline.

## Conformance (the cross-language contract)

`conformance/vectors.json` — frozen wire bytes (events, grants; extend per
RFC-0002). The rule: **an implementation is a SyncMesh implementation iff it
reproduces the vectors byte-for-byte.** This is how `syncmesh-ios` /
`syncmesh-macos` graduate from frozen probes to real ports (N4), and how a
future Rust kernel would land. `tests/conformance.test.ts` runs them in CI;
ports get the same file, not a prose spec.

## Demo & e2e

`src/demo` — the two-peer browser demo (offline toggle, field-merge
visible); `e2e/` — 6 playwright scenarios (relay sync, offline divergence +
merge, multi-tab single peer, reload persistence). The demo doubles as the
manual test bench for every new capability; keep it honest (it runs the real
engine, not a mock).

## Remaining work

- Telemetry hook in next + inspector adapter (N4).
- OPFS e2e lane (crossOriginIsolated worker) — N1.
- Extend vectors: snapshot/blob/ack frames (RFC-0002).

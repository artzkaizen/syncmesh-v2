---
rfc: 0008
title: Policy, Grants & Partitions
package: syncmesh (src/policy, src/protocol/grants, src/schema)
layer: 2
status: implemented
standalone: false
deps: ["0002"]
---

# RFC-0008 — Policy, Grants & Partitions

## Purpose

Answer "may this write happen?" and "does this data reach this device?"
**identically on every device, offline**, without SyncMesh ever modeling
users, members, roles, or invites — auth stays the app's.

## The three pieces

**Policy — rules as DATA.** `defineSync` compiles `allow` rules into a
serializable **policy AST** (`role / owner / any / all / not / rowIs /
patchOnly`) — JSON round-trip tested, no closures. A pure `evaluate()`
interpreter runs the same computation in three places: local write
validation, every receiving peer, and `client.can()` for UI state. Since
M13, policy is itself a synced row (reserved `_policy` table, one row per
partition instance, authority-published) — **permission changes deploy by
sync, not by app release**. Planting a policy row for another instance is
rejected even from a hacked authority device.

**Grants — who you are, verifiable offline.** A signed envelope
(canonical-CBOR `GrantCore`: account ↔ device-pubkey binding, role,
partitions, validity window) issued by the ISSUER key, shipped as
`[core, sig]` exactly like events. `verifyGrant` needs only the issuer
pubkey — no network. `GrantRegistry`: newest-issued wins (stale replay
cannot downgrade), expiry reads as absent. Grants travel FIRST in every sync
session — events from never-met authors would otherwise quarantine on
NoGrant.

**Partitions — replication scope as a first-class tag.** Events carry
`partition: "kind:id"` inside the signed payload; rows are stamped by the
author and re-verified by receivers (row-stamp ≡ event-stamp). Kinds are
**app-defined** (`partitions: { org: { isolation: "database" }, workspace:
{ parent: "org" } }`) — SyncMesh ships no tenancy nouns. Admission is checked
against the author's grant at the sender AND every receiver
(`PartitionNotGranted`). Top-level kinds map to separate stores
(file-per-org, RFC-0004); `user` partitions are account-private.

## Enforcement ladder (all typed values, never throws at runtime)

```
local write   schema → policy → partition-grant   → Result.err at the call site
inbound       signature → grant → policy → dedup  → quarantine with typed reason
UI            client.can("tasks.update", row)     → same AST, same answer
```

A hacked client whose forged event passes signature still quarantines on
policy at every honest receiver — the disabled button is courtesy, the
receiver validation is the security.

## Forbidden leaks

- No closures in policy — rules must serialize (that's what makes every
  device agree across app versions).
- `evaluate()` reads row + patch + grant only — no network, no clock, no
  foreign tables. Two devices, same inputs, same answer, always.
- SyncMesh never stores app membership; that's the app's own synced table.

## Remaining work

- Stale-grant policy: how long a cached-verified grant stays trusted through
  long offline periods (grace window per partition; the server's verdict
  propagates as ordinary settlement events).
- Optional per-partition payload encryption (keys distributed by the app).

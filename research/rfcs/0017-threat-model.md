---
rfc: 0017
title: Threat Model
package: "(design)"
layer: meta
status: proposed
standalone: false
deps: ["0002", "0006", "0008", "0010", "0016"]
---

# RFC-0017 — Threat Model

## Purpose

Name every attacker the mesh faces, what each one can and cannot do, and
which mechanism draws that line. One honest table instead of scattered
security claims. Two stacks are in play and the table says which: the
**donor BLE stack** (`../syncmesh/packages/transport-ble`, running on phones
today, with known holes) and **syncmesh-next** (signatures, grants, policy,
quarantine — implemented and fuzz-tested).

## Attacker capabilities

| Attacker | Can do | Cannot do | Mechanism |
|---|---|---|---|
| Passive radio eavesdropper — **donor stack, today** | Read every payload: the session key is derived and never used, frames are plaintext | — | None. This is a hole (`identity.ts` derives `nacl.box.before` shared keys nothing consumes); deleted in the RFC-0006 port |
| Passive radio eavesdropper — **after RFC-0006 port** | Observe traffic patterns: who is near whom, when, how much | Read payloads | XChaCha20-Poly1305 per frame, on by default (RFC-0006) |
| Active radio attacker (inject / replay) | Inject garbage frames; replay captured valid frames | Forge an event without a device key; make a replay apply twice | Ed25519 verify-before-apply over received core bytes (RFC-0002); dedup by `event.id` makes replay a no-op; garbage → typed error, never a throw (fuzz suite) |
| Compromised relay | Drop, delay, reorder, partition — an **availability attack, acknowledged**; read the content of **unsealed** partitions | Forge events or grants; read a **sealed** partition's content | End-to-end signatures (RFC-0002, RFC-0010): the relay forwards bytes it cannot mint. Content secrecy is per partition: a kind declared `sealed: true` travels under keys only its members hold (D40) |
| Hacked client with a valid key (Byzantine, B10) | Write garbage **within its grant scope** — blast radius = its granted partitions | Write outside its partitions (`PartitionNotGranted` at every receiver); escalate role; plant a `_policy` row for another instance | Strict-mode policy checks at every honest receiver + quarantine + authority corrective events **bound** it — not eliminate it. Recovery = revocation (RFC-0016) |
| Stolen device | Act as that device until the grant lapses | Outlast the validity window; replay a stale broader grant (newest-issued wins) | Grant validity window (RFC-0008) + revocation (RFC-0016). The offline gap is weakest link #2 below |
| Malicious authority | Reject or rewrite anything within its role via corrective events; settle requests dishonestly; read every sealed partition, since the issuer mints its keys | Plant `_policy` for a foreign partition instance (rejected even from a hacked authority device) | The authority is the **trust anchor** — acknowledged, not solved. Its power is scoped, not checked |
| Device without a grant for a partition (D40) | Join a gated room under its own grant; read the partitions that grant names | Be sent an event of any other partition — by a gated relay, in catch-up or live, or by a peer over a handshaken link; keep being sent one after a narrower grant arrives | Grant-gated rooms (`posture.trust`) and the read gate on every peer link; a narrowing or lapsed grant closes the socket |
| Removed member (D40) | Keep what it already read | Read a sealed partition's writes made after it was removed | `grants.rekey`: a new key epoch, re-issued only to the members who remain |

The recurring shape: crypto eliminates forgery and replay; policy and
partitions **bound** what a valid key can do; availability and the authority
are trusted-component risks we name instead of hand-waving.

## Confidentiality posture (D40)

Two sentences, and which deployment each describes.

**`verifyJoin` + per-partition encryption.** A hosted relay is grant-gated: it holds the issuer's
public keys (`posture.trust`) and nothing private, seats a device only under a grant one of
those keys signed, and serves each socket only the partitions that grant names — catch-up and
live fan-out alike, with the scoped coverage naming the entitlement. It reads the partition every
event core carries in the clear, never a payload. `verifyJoin` stays the app's own HTTP gate in
front of that (a cookie, a rate limit); the grant, checked in band after the link handshake, is
the ticket. Peer to peer, a sender in a granted mesh sends a proven peer only what its verified
grant covers. What the relay operator must not read as well — DMs, HR records — is declared
`sealed: true` and travels under per-partition keys that ride inside grants; removing a member
rotates the key (`grants.rekey`), so the removed device reads nothing written after.

**"A room name is a bearer secret."** That is exactly what an open relay is, in those words:
one with no `trust`, where whoever knows a room's name reads all of it, including a member who
was removed. `@syncmesh/relay`'s in-process `startRelay` is open by default, for tests and local
development. The hosted presets (`@syncmesh/relay-node`, `@syncmesh/cloudflare-do`) refuse to
start unless the operator either gives `trust` or writes `open: true` — and an open preset says
the sentence above at start. They default `announce` to off.

What the posture does not cover:

- **Field-level secrecy from a partition's own members.** A column cannot be cut out of a
  signed event, so `fields: { column: rule }` holds only where an authority serves rows (a
  query answered on the server over the caller's grant); on a device that syncs the partition it
  is cosmetic. A column its members must not read belongs in a narrower or sealed partition.
- **What a device already read.** No scheme takes back a read; revocation stops what comes next.
- **Unsealed content across a stranger.** A device that may not read an unsealed partition does
  not carry it either, so that partition's events reach far devices only through ones that may
  read it. Sealing is how content crosses a carrier.
- **Metadata.** Grants, presence and cursors frames still reach every socket in a room; grant
  scopes reveal partition ids (RFC-0024 §4.10).
- **A pipe with no handshake.** `linkTransport` names no peer, so the read gate carries it whole:
  it is a pipe the app already trusts (a worker port, a tab). Every radio proves its peer.

## What the fuzz campaign already proves

From `tests/fuzz-and-load.test.ts`, green today:

- 500 arbitrary garbage frames into `receiveWire`: never a throw, never a
  state mutation, event log stays empty, errors surface as typed values.
- 300 bit-flips + truncations of a **valid** signed event: none apply — and
  the pristine bytes still apply afterward. Hostile bytes cannot poison
  dedup state (a forged near-duplicate cannot squat a real event's id).
- Grant-envelope garbage: `verifyGrant` and `GrantRegistry.register` always
  return typed Results; the registry stays unpolluted.

So the malformed-input rows of the table (B1–B2 in the integrity taxonomy)
are not aspiration — they are pinned by tests.

## Denial-of-service posture

- **Cheap rejection.** A hostile frame costs one decode + one signature
  check, then it is a value. No allocation of durable state for garbage.
- **Quarantine is bounded — proposed.** Signed-but-invalid events park in
  quarantine with typed reasons (implemented); the per-group cap with
  loud eviction is designed but not yet built. An unbounded quarantine is a
  disk-exhaustion vector until it lands.
- **Link budgets** (RFC-0012) cap per-transport connections, so a discovery
  storm cannot exhaust the radio.
- **Relay withholding** is the one DoS we cannot prevent, only route around:
  nearby transports still converge without it (RFC-0012 dissemination).

## Non-goals

- **Metadata privacy / traffic analysis resistance.** BLE advertisement
  announces presence; the relay sees who talks to whom, when, and how much.
  Encryption (post-port) hides content, not patterns.
- **Anonymity.** `peerId` IS the public key; authorship is the point, not a
  leak. This is not a mixnet and will not become one.
- **Malicious-authority detection.** The authority is trusted by
  construction; apps needing less trust keep data in member-encrypted
  partitions (OPEN) or don't route it through ops.

## Current state

| Piece | State |
|---|---|
| Verify-before-apply, dedup, byte-identical re-forward | implemented (RFC-0002) |
| Grants, policy AST at every receiver, partition admission, quarantine with typed reasons | implemented (RFC-0008, M4–M7) |
| Relay opaque store-and-forward, verify-on-put blobs | implemented (RFC-0010) |
| Fuzz suite (garbage, bit-flips, grant garbage) | implemented, green |
| BLE encryption | **hole** — donor derives a session key it never uses; plaintext today |
| BLE frame auth | **hole** — `transport.ts:398–401` falls back to decoding unauthenticated bare frames |
| BLE identity | **hole** — `createDeterministicIdentity` mints keypairs from the public peerId (`identity.ts:121–138`), and `peerHintMatchesPublicKey` accepts them — trivially impersonable |
| Revocation | proposed (RFC-0016) |
| Per-partition payload encryption | implemented: sealed kinds, keys in grants, epochs; issuer-side `createPartitionKeys` and `grants.rekey` (D40) |
| Read gate: who is sent which partition | implemented: grant-gated rooms, the peer-link read gate, `ungranted` / `revoked` / `regranted` refusals (D40) |
| Quarantine caps | proposed |

All three BLE holes are slated for deletion in the RFC-0006 port — none of
them survives into `@syncmesh/ble-channel`.

## Weakest links, ranked

1. **BLE plaintext until the RFC-0006 port.** Every nearby payload is
   readable today. The port (encryption on, bare-frame fallback and
   deterministic identity deleted) closes all three radio holes at once.
2. **Offline revocation window.** A stolen device or hacked client keeps its
   powers until revocation propagates or the grant expires; under partition
   that window is bounded only by the validity window (RFC-0016).
3. **Relay availability.** A dropped/withholding relay degrades far peers to
   nearby-only convergence. Correctness holds; latency does not.

## Remaining work

- Execute the RFC-0006 port — kills weakest link #1; acceptance is the
  port's own contract suite plus a sniffer seeing only ciphertext.
- Implement revocation propagation and the stale-grant grace window
  (RFC-0016, RFC-0008 remaining work).
- Quarantine caps + `quarantine-grew` alarm; add a fuzz lane that measures
  quarantine growth under sustained forged-event load.
- ~~Decide per-partition encryption~~ — decided (D40): members and the
  issuer hold keys; the relay holds none.

## Open questions

- ~~Per-partition encryption key distribution~~ — inside grants (grant key
  8), minted by the issuer's `createPartitionKeys` (D40).
- Should a peer whose events repeatedly quarantine get its **frames**
  throttled (per-peer inbound budget), or only alarmed on?
- How long is the stale-grant grace window per partition class, and who
  sets it — the policy doc or defineSync?
- Is traffic-pattern hardening (padding, batched send) permanently out of
  scope, or revisited if a hostile-network deployment appears?

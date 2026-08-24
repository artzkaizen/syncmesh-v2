---
rfc: 0016
title: Identity, Accounts & Revocation
package: syncmesh (src/protocol/identity, src/protocol/grants) · accounts (design)
layer: 2
status: partial
standalone: false
deps: ["0002", "0008"]
---

# RFC-0016 — Identity, Accounts & Revocation

## Purpose

Who is speaking, who they belong to, and how belonging ends — all verifiable
**offline, from signed bytes alone**. SyncMesh models none of your users,
members, or roles (RFC-0008); it models keys and the signed artifacts
connecting them. Three principals, strictly layered.

## The hierarchy

| Principal | Key | Signs | Status |
|---|---|---|---|
| **Device** | Ed25519; hex pubkey IS the `peerId` | every event (RFC-0002) | implemented (M2) |
| **Account** | separate keypair, follows the user | link events binding devices | proposed |
| **Issuer** | authority key, trusted by config | grants | implemented (M5) |

**Device.** `createIdentity()` mints a random Ed25519 key; `peerId =
hex(publicKey)`, so verification needs no key registry — holding a peerId IS
holding the verification key. The engine owns the key (first run mints +
persists; pass one in only to restore/migrate/test). String-seeded keys are
for reproducible fixtures only — knowing the string is impersonation.

**Account.** "Alice's phone AND laptop are both Alice." A bare device key
makes every device its own identity — fine for no-user apps, wrong for
attribution across devices. The account keypair **vouches for device keys
via signed link events in the log** — server-less registration; the only
out-of-band transfer is the account secret when linking a new device (QR /
recovery phrase). Ownership and policy reference an *identity* — device id
or account id — "device == user" is never baked deeper than that.

**Issuer.** Signs grants; peers hold only its public key, by config.

## Grants — belonging as signed bytes (implemented)

A `GrantCore` is `{ v, account, device, role, partitions, issuedAt,
expiresAt }` in canonical CBOR, shipped as `[core, sig]` — **the same wire
shape events use** (RFC-0002) — so grants forward byte-identically over any
transport; the relay stores them opaquely. `verifyGrant` checks the
signature over the *received* core bytes. Failures are typed values:
`MalformedGrant`, `BadGrantSignature`, `GrantExpired`.

`GrantRegistry` rules — all implemented and tested:

| Rule | Effect |
|---|---|
| newest-issued wins per device | replaying a stale admin grant after a demotion is a no-op — downgrade-by-replay impossible |
| expiry reads as absent | `grantFor` returns null past `expiresAt` — staleness, not a tombstone |
| verify-before-hold | tampered / rogue-issuer wires are typed errors, never registry state |
| grants travel FIRST | the handshake ships `allWires()` before events, so a never-met author's events apply instead of quarantining on NoGrant; mid-session registrations fan out live |

Expiry is a **staleness bound**; the security boundary is issuer re-validation.

## The auth ladder — bring your own users

The requirement is narrower than "use JWT": **any claim a peer verifies
offline needs a signed, self-contained artifact.** A session cookie is an
opaque server-side reference — it can gate the server tier, never
phone-to-phone replication in a field with no internet.

| Mode | You bring | P2P wire enforcement | Work |
|---|---|---|---|
| Trusted mesh | nothing | none — policy still gates writes locally (RFC-0008) | zero, start here |
| BYO JWT + JWKS | your provider's token + a JWKS URL | full — peers cache the public key, verify claims offline | token plumbing |
| Device-key only | nothing; the device key is the identity | authorship, no user claims | zero |

Cookie-only deployments fall back to trusted-mesh on the p2p wire; a token
exchange (short-lived signed token minted when online) upgrades them. In
every mode SyncMesh stores **no users, members, roles, or invites** —
membership is your own synced table.

## Device loss & revocation (proposed)

There is no "un-sign." Revoking a lost device = the issuer **issues newer
grants excluding it** (or one for that device with no partitions);
newest-wins makes the demotion stick at every peer the new grant reaches,
and replay of the old grant cannot resurrect it. At the account layer,
`revokeDevice` is a signed revocation event in the log. `GrantRegistry.revoke()`
exists today but is **local removal only**; propagation is this RFC's work.

**The honest window:** a peer that never receives the newer grant honors the
stale one until `expiresAt` — the end-to-end test already shows the shape in
miniature (an author's engine accepts a write against its frozen cached
grant; every receiver with a fresher clock denies). Mitigations:

1. **Short validity + automatic renewal** — the window is bounded by the
   validity length; connected devices renew silently.
2. **Server verdict as settlement** — revocation propagates as an ordinary
   signed event, via anti-entropy like data.
3. **Per-partition grace windows** — strict partitions read grants as
   absent before `expiresAt`; policy-owned (RFC-0008 `_policy` row).

## Key rotation (proposed)

A device key cannot rotate in place — the peerId IS the key. Rotation =
**add new, retire old**: mint a new device key, the account signs a link
event vouching it, the issuer grants it, the old grant expires unrenewed.
Account key rotation needs a signed successor statement (recovery-phrase
re-mint). Issuer rotation is the trust-anchor problem: re-issue live grants
under the new key across a dual-trust window.

## Current state

| Piece | State |
|---|---|
| Device Ed25519 identity, peerId = pubkey, signs every event | implemented (M2) |
| Signed grant envelopes, offline verify, typed errors | implemented (M5) |
| Registry: newest-wins, no-downgrade replay, expiry-as-absent | implemented + tested |
| Grants-first handshake, relay fan-out, store-and-forward wires | implemented (M7) |
| `revoke()` | local-only stub — no propagation |
| Account keypair, signed link/revoke events, `accounts.*` API | proposed |
| Revocation settlement, renewal loop, grace windows | proposed |
| Key rotation (device / account / issuer) | proposed |

## Remaining work

- Account layer: `AccountCore` + link/revoke event kinds; account registry
  feeding attribution and `owner()` policy.
- Revocation propagation replacing local-only `revoke()` — verdicts as
  settlement events over anti-entropy.
- Short-validity issuance + renewal loop on the authority (RFC-0010).
- Grace-window policy wired into `grantFor` per partition.

## Open questions

- Who sets the grace window — the `_policy` row per partition, or engine config?
- Which partition carries revocation settlement events so every affected peer receives them?
- Account key custody for v1: recovery phrase, passkey-wrapped, or both?
- May an account key act as its own issuer in device-key-only meshes, or is the issuer always distinct?
- Issuer rotation: how long is the dual-trust window and how do fully-offline peers learn the successor key?

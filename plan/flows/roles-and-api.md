# Roles and the API — client, issuer, authority, and what can go wrong

Companion to [grant-onboarding](grant-onboarding.md). Three roles a process can play. They are
**orthogonal** — one process can hold any combination:

| role | means | defined by |
|---|---|---|
| **client** | a device: writes its partitions, syncs, verifies everyone | `createMesh({ schema, identity, issuer })` |
| **issuer** | holds the org's signing keypair; the only party that can mint grants | possessing the issuer `Identity` (a server route, or a phone) |
| **authority** | the relay: may write `global`, evaluates `visibility: "authority"` admission | `createMesh({ …, isAuthority: true })` |

Legend: ✅ exists today · 🟡 proposed, to okay · 🔴 gap found writing this doc.

> **2026-08-25:** all four proposals were okayed and are done where code exists: #1 `authority: PeerId` fixed and tested; #2 `issuerKey` + `mesh.grants.issue` built (S3 uses it); #3 Q1 defaults and #4 the frame shape are recorded in the D08 addendum, frame itself lands with E11.

---

## 1 · The client device ✅

```ts
// first launch — the key IS the device identity (D08-A)
const identity = createIdentity(await loadOrMintSeed()).unwrap();   // seed: 32 bytes, stays on device

const mesh = createMesh({
  schema,                      // the one manifest (D06)
  identity,                    // this device
  issuer: ISSUER_PEER_ID,      // the issuer's PUBLIC key — the root of trust, shipped in the app
});

mesh.grants.register(wireBytes).unwrap();   // from HTTPS, BLE, QR code — bytes are bytes
mesh.activate("org:acme").unwrap();         // ambient partition (D07); implied if grant lists one
```

**What the device receives on a link (E11 frame types):**

| frame | payload | device does |
|---|---|---|
| `grant` | `[core, sig]` wire bytes | `verifyGrant` vs issuer public key → registry. Bad sig / expired → typed error, dropped |
| `event` | signed event `[core, sig]` | verify sig → validator ladder (grant → partition → schema → policy) → fold, or quarantine |
| `cursors` | per-author high-water marks | answer with the events the peer lacks |
| `grant-request` 🟡 | `{ peerId, invite? }` | **not** trusted — surfaced to the app to forward or approve (flows A/B) |

A device never receives "permissions" as state — it receives **grants** (who may act) and
**events** (what they did), and computes everything else locally.

---

## 2 · The issuer

**Server-side (flow A)** ✅ — one route on the auth you already run:

```ts
const issuer = createIdentity(ISSUER_SEED).unwrap();          // keep the seed in a KMS/secret store

app.post("/mesh/grant", async (req) => {
  const session = await auth.getSession(req);                 // YOUR auth answers "who is this?"
  if (!session) return new Response(null, { status: 401 });
  const { devicePeerId } = await req.json();
  const wire = issueGrant(issuer, {
    account: session.userId,
    device: parsePeerId(devicePeerId).unwrap(),
    role: session.role,                                       // "member" | "admin" | …
    partitions: session.orgs.map((o) => parsePartitionKey(`org:${o}`).unwrap()),
    claims: { permissions: session.permissions },             // for claim-based policy
    validFor: Temporal.Duration.from({ days: 30 }),
    now: Temporal.Now.instant(),
  });
  return Response.json({ grant: bytesToHex(wire) });
});
```

**On-device issuer (flow B)** 🟡 — proposed sugar so the owner's phone can mint without
importing wire internals:

```ts
const mesh = createMesh({
  schema,
  identity: ownerPhone,
  issuer: ownerPhone.peerId,     // this org's root of trust IS this phone
  issuerKey: ownerPhone,         // ✅ holding the private half unlocks minting
});

// the approval screen's handler (flow B step ②):
const wire = mesh.grants.issue({    // ✅ panics without issuerKey; mismatched key panics at createMesh
  account: "acct_ada",
  device: requestedPeerId,          // from the grant-request frame — attacker-writable, binds only the KEY
  role: "member",
  partitions: ["org:acme"],
  validFor: Temporal.Duration.from({ days: 30 }),
});
// send `wire` back over the same link
```

To okay: `issuerKey` + `mesh.grants.issue`. Without it, flow B still works via bare
`issueGrant` — this is ergonomics, not capability.

---

## 3 · The authority (relay) ✅ / 🔴

```ts
const relay = createMesh({
  schema,
  identity: relayIdentity,
  issuer: ISSUER_PEER_ID,
  isAuthority: true,     // ✅ may write global tables; evaluates visibility:"authority" admission
});
```

🔴 **Gap found writing this doc — the receiver side of `global` is wrong today.**
`checkPartition` gates global writes on the *local* `isAuthority` flag, not on **who authored
the event**. Consequences:

- a normal device (`isAuthority: false`) that *receives* the authority's global events refuses
  them with `ReadOnlyPartition` — global data never replicates to devices, which is its whole
  purpose (the load test in `live-query-load.test.ts` had to set `isAuthority: true` on a
  receiver to work — that was the smell);
- symmetrically, if a device were granted `isAuthority: true` by mistake, it would accept
  global writes from **anyone**.

**Fix to okay:** name the authority the way the issuer is named — config, not flag:

```ts
createMesh({ …, authority: RELAY_PEER_ID })   // 🔴→🟡 who may author global/authority-visibility events
// validator global branch becomes: event.peerId === authority (verified by signature, like everything)
// isAuthority: true stays as "I am that peer" for the relay process itself
```

Until then, `global` tables are only correct relay-side. This goes in E16's lap (server-written
tables) but the config field should land with E11 so the validator stops lying.

---

## 4 · Problems and security issues, honestly

| # | issue | severity | mitigation |
|---|---|---|---|
| 1 | 🔴 `global` receiver check (above) — devices can't verify *who* the authority is | correctness+security, fix before E12 | `authority: PeerId` in config; validator checks event author |
| 2 | **Issuer key compromise = the org.** Whoever holds it mints any grant, any role, any device | highest stakes in the design | KMS / secure enclave; short `validFor` so stolen-key damage ages out; ⚠ no key-rotation story exists yet — grants have a `v` field but no "issuer #2" concept. Open. |
| 3 | **Stolen device stays valid until `expiresAt`** (D08: expiry = staleness bound; no offline revocation) | by-design trade | short grants + cheap renewal (flow Q4); the relay can additionally deny transport instantly — server-side revocation even while p2p honors the grant |
| 4 | **`grant-request` is unauthenticated** — anyone in radio range can ask, and relays amplify to the issuer route | DoS + junk accounts | rate-limit the route; invite tokens (Q1) make requests non-amplifiable; requests are never trusted, only forwarded |
| 5 | **Account binding (Q1)** — the flow proves the *key*, not that the key is Ada | the open decision | invite token / owner approval / device-vouch (Q5); credentials-in-frame is the weakest option — secrets transiting an untrusted courier, even encrypted, invite replay design bugs |
| 6 | **Clock trust** — `verifyGrant` compares `expiresAt` to the local clock; a device with a wrong clock accepts expired grants (or rejects live ones) | medium | HLC drift-clamping exists for events; grant checks could take `now` from the last authenticated peer exchange rather than raw wall clock. Open. |
| 7 | **Metadata over the radio** — grants are capabilities, not secrets: account ids, roles, partitions readable by anyone sniffing the hello | privacy, not integrity | link-layer encryption at pairing (E22's lane); until then assume membership is visible to the room |
| 8 | **Courier denial** — M can drop requests/grants silently | low | any other online peer works (flow A); store & forward (Q3) removes the single-courier dependency |
| 9 | **Grant sprawl** — every peer relays every grant (`allWires`); a large org's session-open grows | perf, later | scope grant exchange to the partitions the link's scope covers (E11's `scope` already exists for stores) |

---

## What needs an okay from you

1. **`authority: PeerId` in `createMesh`** and the validator author-check (fixes 🔴 #1).
2. **`issuerKey` + `mesh.grants.issue(...)`** — the on-device issuer ergonomics (flow B).
3. **Q1 default**: my lean — invite token for relayed onboarding, owner-approval for flow B,
   device-vouch (Q5) for second devices. They compose; none excludes another.
4. `grant-request` frame minimum shape: `{ peerId, invite? }` (Q2).

Say which of 1–4 stand, and they go into D08/E11/E16 and then code.

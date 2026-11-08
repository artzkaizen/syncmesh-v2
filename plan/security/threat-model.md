# Threat model — external security review prep

status: draft — prepared for external review, not a review

Date 2026-11-07. Branch `gap/proof`, base `origin/main` `638eed6`. Every claim below cites
`file:line` at that commit. Where a claim rests on reading rather than on a test, it says so.
Nothing here has been fixed; this document only describes the code.

Conventions:

- **OPEN** — the gap is in the code today. **FIXED** — the code now does what the earlier audit
  said it did not, with the evidence named. **PARTIAL** — part fixed, part open.
- **N-numbers** (N1…N26) are findings made while preparing this document. They come from
  reading the code and have not been confirmed by a test. The one exception is N4, which was
  confirmed by a probe (§7.2).
- **Priorities** (P0–P3) are a guess at where a reviewer should start. They are not severity
  ratings from a review.
- Earlier documents this one builds on: `research/rfcs/0017-threat-model.md` (proposed, describes
  the donor stack), `research/gap-audit.md` (2026-09-11, addendum 2026-09-26).

---

## 1. Scope and system summary

A device is a full replica that signs its own events. Devices sync with each other over radios
and the LAN, and with relays and an authority over WebSocket. The authority is a device with
extra duties (`packages/orpc/src/server.ts:15-19`). It can fold into Postgres and it serves
oRPC procedures over HTTP.

```
                         +-------------------------- authority (server peer) ----------------------+
                         |  createServer  packages/orpc/src/server.ts:80                           |
   HTTP POST /<g>/<leaf> |  oRPC handler  packages/orpc/src/http.ts:172   (no caller identity, N5) |
  -----------------------+> gate bodies (.authority())  http.ts:177-205                            |
                         |  mesh (engine + validator)  packages/client/src/boot.ts:116-127         |
                         |  issuerKey (Identity in config) packages/orpc/src/options.ts:108-109    |
                         |      |                                                                  |
                         |      | fold UPSERTs (capture disarmed) / app SQL (capture armed)       |
                         |      v                                                                  |
                         |  Postgres: app tables + RLS (storage/src/rls.ts:201-229)               |
                         |            capture triggers (storage/src/dialect-postgres.ts:84-117)   |
                         |            syncmesh.events, _syncmesh_changes (outside RLS)             |
                         |  custody (inline relay host)  packages/orpc/src/custody.ts             |
                         +------------------------------+------------------------------------------+
                                                        | ws/wss, relay protocol v3 (D36)
                                                        | sealed link per socket
     +-------------------- relay ---------------------+ |
     | packages/relay (room, connection, catch-up)    |<+
     | adapters/relay-node (ws, Node http)            |
     | adapters/cloudflare-do (Durable Object, SQLite)|
     | room log + blob store + grant cache + presence |
     | room key seed in _relay_meta (host.ts:161)     |
     +----------------------+-------------------------+
                            | ws/wss, protocol v3: hello -> sealed frames
                            |
   +------------------------+--------- device ---------------------------------------------+
   | createMesh/createClient: engine, validator, grant registry, key ring                  |
   | SQLite store (adapters/sqlite-*): log, state, _device{seed,incarnation} PLAINTEXT     |
   |   packages/client/src/identity.ts:40-64                                               |
   | bridge per link  packages/transport/src/bridge.ts:182                                 |
   | upgrader: framing -> secureLink handshake -> admission gate -> bridge                 |
   |   packages/transport/src/upgrade.ts:138-207                                           |
   +----+-------------------------+-----------------------------+--------------------------+
        | BLE GATT (packages/ble) | LAN TCP + UDP multicast     | Wi-Fi Aware/AWDL
        | fragments, 128 KiB max  | (packages/transports/lan,   | (packages/transports/p2p)
        | per message             |  adapters/lan-node)         |
        v                         v                             v
                            other devices (same stack)
```

In scope for the review:

| Component       | Code                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Device mesh     | `packages/client`, `packages/engine`, `packages/kernel`, `packages/policy`                                                                                                                        |
| Device store    | `packages/storage`, `adapters/sqlite-{bun,node,expo,wasm}`, `adapters/browser`                                                                                                                    |
| Wire and crypto | `packages/wire` (CBOR, Ed25519, envelopes, grants, receipts, sealing, feed, checkpoint, accounts)                                                                                                 |
| Session layer   | `packages/transport` (framing, handshake, session, upgrade, gate, bridge, join exchange, presence)                                                                                                |
| Transports      | `packages/ble`, `packages/transports` (LAN, P2P, WebSocket), `adapters/lan-node`, `adapters/react-native`                                                                                          |
| Relay           | `packages/relay`, `adapters/relay-node`, `adapters/cloudflare-do`                                                                                                                                 |
| Authority       | `packages/orpc`, `packages/cdc`, `adapters/postgres`, `packages/storage/src/{rls,capture,dialect-postgres}.ts`                                                                                    |
| Second impl     | `crates/syncmesh-core`, `crates/syncmesh-client`                                                                                                                                                  |
| Vectors         | `conformance/*.json`, `conformance/src/generate-*.ts`                                                                                                                                             |

Out of scope: `apps/`, `examples/`, `bench/`, `chaos/`, `packages/devtools`, `native/` (Swift and
Kotlin glue; covered only where it sits under BLE), and the separate `@syncmesh/rn-ble` repo.

---

## 2. Assets

| Asset                                       | Where it lives                                                                                                                                                                                                                         | Protection today                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device signing key (Ed25519 seed, 32 B)     | Hex text in table `_device`, key `"seed"`, in the device's main SQLite file (`packages/client/src/identity.ts:40-64`, `:78-93`). The seed is also the X25519 secret for unwrapping content keys (`packages/wire/src/identity.ts:47-49`). | **Plaintext at rest.** No SQLCipher, Keychain or Keystore anywhere in `adapters/` or `native/` (searched for `sqlcipher`, `pragma key`, `SecureStore`, `Keychain`, `Keystore`). Anyone who can read the file holds the identity. The audit note "device seed in plaintext SQLite" is **confirmed OPEN**.                     |
| Device incarnation (lineage id)             | Same table, key `"incarnation"` (`identity.ts:114-121`)                                                                                                                                                                                 | Plaintext; it is an id, not a secret.                                                                                                                                                                                                                                                                                      |
| Relay room key (Ed25519 seed)               | `_relay_meta`, key `"identity-seed"`, in the room's SQLite (`packages/relay/src/host.ts:140-150`, `:161-169`); DO: the object's own SQLite (`adapters/cloudflare-do/src/host.ts:144`)                                                    | Plaintext at rest. Fresh on each open when no store is given (D36).                                                                                                                                                                                                                                                        |
| Relay link session secrets (DO)             | WebSocket attachment, resume-script head `[nonce, secret, hello, seal, open, peer]` (D36; `adapters/cloudflare-do/src/resume.ts:82-118`)                                                                                                  | Platform storage. D36 accepts this.                                                                                                                                                                                                                                                                                        |
| Grant issuer key                            | `issuerKey: Identity` passed in config (`packages/client/src/options.ts:117-118`, `packages/orpc/src/options.ts:108-109`)                                                                                                                | The app's responsibility; the library never stores it. Peers pin the matching public key as `issuer`. No issuer rotation and no multi-issuer support (§6.3).                                                                                                                                                               |
| Partition content keys (sealed partitions)  | Wrapped to the device inside its grant (`packages/wire/src/grant.ts:33`, `sealing.ts:123-153`). Unwrapped keys live in the device key ring (`packages/wire/src/keyring.ts`).                                                             | Wrapped with X25519 + HKDF + XChaCha20-Poly1305. The key ring is in memory.                                                                                                                                                                                                                                                |
| Event log integrity                         | Each event is `[core, sig]` and is verified over the received core bytes (`packages/wire/src/envelope.ts:87-100`). Stored with `core` and `sig` and relayed verbatim (`envelope.ts:120-123`).                                         | Ed25519 per event. Feed chains (RFC-0019) exist as a codec only (§5.6).                                                                                                                                                                                                                                                    |
| Row state                                   | Folded state on each device; Postgres tables on the authority.                                                                                                                                                                        | Comes from verified events — **except snapshot installs, which merge unsigned rows** (N1).                                                                                                                                                                                                                                 |
| Row confidentiality per partition           | Rows travel in events and in snapshots.                                                                                                                                                                                                | Sealed partitions only (`sealing.ts`). **No read authorization runs on any send path**: device bridge (N2), relay catch-up (N3), snapshot serve (N2). On Postgres, read rules become RLS (`rls.ts`).                                                                                                                      |
| Blobs                                       | Relay blob store and device blob store, addressed by sha256 (`packages/storage/src/blob.ts:41-50`)                                                                                                                                      | Content hash checked on put and on fetch (`blob.ts:50`, `packages/client/src/blobs.ts:89`). In an open room, any member who knows a hash can fetch it. In a grant-gated room a fetch is served only to a grant naming a partition the bytes were put into, and a put is checked against the putter's grant (D44, `packages/relay/src/ingest.ts` `serveBlob`).                                                                                                                  |
| Custody receipts (D28)                      | `receipt` frame (tag 7) on direct links and through a relay room, which hands it to the author alone (U17); a `vouches` table in the ledger                                                                                                                                                           | Signed by the holder (`packages/wire/src/receipt.ts:94-98`). Devices in a relay room sign for each other through it; the room itself signs nothing (U34). Claims can be forged by third parties (N6).                                                                                                                                                                |
| Operation records / ledger                  | `packages/client/src/operations.ts`, `packages/storage/src/operation-store.ts`                                                                                                                                                          | `unsettled()` is built from cursor acks (`operations.ts:248-292`) and gates `detach` (`packages/storage/src/detach.ts:39-45`).                                                                                                                                                                                              |
| Grants (who may write where)                | `GrantRegistry` (`packages/wire/src/grant-registry.ts:41-89`), persisted by `packages/storage/src/grant-store.ts`                                                                                                                       | Issuer signature; newest `issuedAt` wins; expiry judged on the receiver's clock.                                                                                                                                                                                                                                           |
| Account links (D21)                         | `_links` rows carrying an account-signed core (`packages/wire/src/account.ts:87`, `packages/engine/src/accounts.ts:47-57`)                                                                                                              | The account signs; the device signs through the carrying event.                                                                                                                                                                                                                                                            |
| Checkpoint certificates                     | Sent with snapshot manifests (`packages/transport/src/snap-frame.ts:42`)                                                                                                                                                                | Issuer signature over a state hash (`packages/wire/src/checkpoint.ts:80-140`). Checked only when `trust` is configured (`packages/transport/src/join.ts:196-204`).                                                                                                                                                          |

---

## 3. Actors

| Actor                                         | Starting position                                                     | What the code lets them do (citations in §4, §5, §7)                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Honest device                                 | Holds its own seed and a grant.                                       | Baseline.                                                                                                                                                                                                                                                                                                                                         |
| Malicious device with a valid grant           | Admitted to direct links where its grant shares at least one partition (`packages/transport/src/gate.ts:127-129`). | Writes within its grant (the validator ladder bounds this). It can also: be sent every synced event the peer holds, in all partitions (N2); request a full snapshot (N2); push an unsolicited snapshot with arbitrary rows and coverage (N1); forge other peers' cursors (N6); squat presence sessions (N11); poison the relay grant cache (N8). |
| Revoked device                                | Its key still verifies. A `_revocations` row exists.                   | Backdates its HLC below the revocation instant and is admitted until the grant expires on the receiver's clock (N7). Until a receiver folds the revocation row, that receiver admits it anyway (`packages/engine/src/author.ts:118-121`).                                                                                                           |
| Any key holder (no grant)                     | Generates a keypair locally.                                          | Completes the link handshake (it checks signatures, not membership). The relay accepts its join and pages it the whole room log unless `verifyJoin` is configured (N3). The relay stores its signed events (N15). It reaches the CBOR decoder after the handshake (N4).                                                                           |
| Curious relay operator                        | Holds the room key and the room's SQLite.                             | Reads every unsealed row, grant claims, presence values and blobs. Sees author, sequence, stamp and partition even for sealed events (`packages/wire/src/sealing.ts:23-26`).                                                                                                                                                                        |
| Malicious relay                               | Can send any relay frame.                                             | Drops, delays or reorders traffic. Forges `ack` (false durability). Sends a `scoped` coverage the client adopts (N18). Sends `hello.floor`. Cannot forge events or grants.                                                                                                                                                                         |
| Network attacker (ws, BLE, LAN)               | On path.                                                              | Without TLS and without a pinned relay key, can stand in the middle of the relay link (N17). On direct links the handshake is signed (MITM-resistant), but sealed frames have no sequence numbers, so they can be replayed, reordered or dropped (N12). Can spoof LAN announcements and BLE hints (§4.1). Can break a link with a replayed hello (`packages/transport/src/session.ts:158-169`). |
| App SQL writer on the server (uncaptured)     | Runs SQL outside `captureChanges`.                                    | Writes are not logged and not judged (`dialect-postgres.ts:74`, `:97-106`), so Postgres and the mesh diverge silently. Can `set_config('syncmesh.*')` to assume any principal under RLS (N16).                                                                                                                                                     |
| DB admin / superuser                          | Bypasses RLS by Postgres rules (`rls.ts:196-200`).                    | Everything: events, state, and the issuer key if the app stored it there.                                                                                                                                                                                                                                                                          |
| Physical device access                        | Holds the device's files.                                             | Copies the seed (plaintext), so it can impersonate the device until revoked and expired. Reads every content key the grant wraps, and every row.                                                                                                                                                                                                   |
| Unauthenticated HTTP caller                   | Can reach the authority's fetch.                                      | Calls any procedure. Queries and mutations run on the server's own api (N5).                                                                                                                                                                                                                                                                       |

---

## 4. Trust boundaries

### 4.1 Device ↔ device (BLE, LAN, Wi-Fi Aware/AWDL)

Path: medium → `framed` (byte streams) or fragments (BLE) → `secureLink` → admission gate → bridge
(`packages/transport/src/upgrade.ts:138-207`).

- **Discovery is unauthenticated, as the code says.** A BLE hint is the first 8 hex characters of
  the peer id (`packages/ble/src/advert.ts:25-27`). A LAN announcement is
  `MAGIC‖v1‖peer‖port‖room` with no signature (`packages/transports/src/lan/advert.ts:48-64`).
  Both are used only for dial decisions (`upgrade.ts:38-45`, `gate.ts:19-22`). Spoofing one makes a
  device dial; on a LAN with spoofed UDP source addresses, it makes the device dial an arbitrary
  host:port (reading only).
- **Handshake** (`packages/transport/src/handshake.ts`): each side sends `0x01‖edPub‖x25519Eph‖sig`.
  The signature is over `"syncmesh/link/hello/v1"‖edPub‖eph` (`:53-81`, `:89-98`). The session key
  is `HKDF-SHA256(x25519(secret, peerEph), salt = hello_lo‖hello_hi, info = "syncmesh/link/session/v1")`,
  with one key per direction chosen by peer id order (`:125-146`). Frames are
  `0x02‖nonce24‖XChaCha20-Poly1305` with a random nonce (`:149-156`).
  - A self-reflected hello is refused (`:130-131`).
  - There is no explicit key confirmation and no version or role field. The same context string
    is used on relay sockets (`packages/relay/src/secure.ts:10-14`).
  - There is **no counter or sequence number in a sealed frame**, so the receiver accepts a replay
    of any sealed frame within a session (N12).
  - A re-hello from the proven peer replaces the session (`session.ts:170-210`). There is a replay
    window of the last 64 ephemerals (`:68`, `:92-101`). A replay of an older hello breaks the
    link; the code says so (`:158-169`).
  - Before the session opens, up to 64 frames are held (`session.ts:60`, `:243-249`).
- **Admission** (`packages/transport/src/gate.ts:106-130`): allowed if the peer's grant shares
  **any one** partition with ours, or if the peer sets `requesting`. Nothing sets `requesting` yet
  (`:123-125`). Fails closed on handler error or timeout (`:132-146`). Admission is a topology
  decision only (`:59-62`), and **nothing downstream narrows what is sent** (N2).
- **Bridge** (`packages/transport/src/bridge.ts`):
  - Sends all grants, then cursors, then routes (`:335-337`).
  - Learns the far side's id from the `cursors` frame's `from` field, not from the handshake
    (`:238-240`). The proven peer is passed to `attach` (`upgrade.ts:186`,
    `packages/transport/src/transport.ts:407`) but the bridge never compares it with `from` (N6).
  - Every received event is signature-checked (`bridge.ts:208-213`), then held per author
    (`packages/transport/src/holdback.ts:32-45`), then validated by `engine.receiveBatch` (`bridge.ts:223`).
- **Limits:** framing caps a frame at 8 MiB (`packages/transport/src/framing.ts:43`, `:75-76`).
  BLE caps a message at 128 KiB and 32 concurrent assemblies (`packages/ble/src/fragment.ts:23-26`).
  BLE allows 6 links (`packages/ble/src/transport.ts:89`), P2P 4
  (`packages/transports/src/p2p/transport.ts:66`). **LAN has no link cap**
  (`packages/transports/src/lan/transport.ts:305`).

### 4.2 Device ↔ relay

- **Upgrade gate** runs before a socket exists (`packages/relay/src/host.ts:114-137`). Its order
  is: connection cap (503), origin, announce (404), `verifyJoin` (403).
  - The defaults admit everything: origin unset admits all (`packages/relay/src/posture.ts:51-54`);
    `announce` defaults to true, so any path opens a room (`:55`); `verifyJoin` absent admits
    (`:56`).
  - E24's posture task is still unchecked (`plan/epics/E24.md:21`), and its watch-out still holds
    (`E24.md:39`).
- **Protocol version 3 (D36).** The room speaks first with a signed hello
  (`packages/relay/src/connection.ts:108-113`). Every frame after the client's hello is sealed per
  socket. The join must name the key the hello proved, or it is refused as `impostor`
  (`connection.ts:162-166`). v2 challenge-and-proof stays available only where an operator lists
  it (`packages/relay/src/frames.ts:40-47`, `packages/relay/src/proof.ts:20-48`).
  `RELAY_PROTOCOL_VERSIONS = [3]` (`frames.ts:47`). A version with no overlap is a typed fatal
  refusal (`connection.ts:149-153`).
- **Relay key pinning is optional.** `relayKey` on `relayTransport` and `webSocket()` is unset by
  default (`packages/relay/src/transport.ts:86`, `:281-283`; `packages/transports/src/web-socket.ts:47`).
  Without it, any hello is accepted and TLS is the only defense against a man in the middle (D36
  watch-out; N17).
- **Per-socket ceilings:**
  - frame size: 8 MiB plus 41 B seal overhead (`connection.ts:255-258`; `packages/relay/src/limits.ts:59`);
  - backlog: 1000 frames or 64 MiB, whichever comes first, then the socket is closed
    (`packages/relay/src/sender.ts:38-44`; `limits.ts:61`; `packages/relay/src/room.ts:136`);
  - token buckets: event, blob and fanout (`limits.ts:58-74`, `:114-146`), checked in
    `connection.ts:280-291`;
  - process connection cap: 10 000 (`limits.ts:60`; `host.ts:269-273`) — **not effective on the
    Durable Object host** (N14).
- **What the relay checks on content:**
  - events: signature only (`packages/relay/src/ingest.ts:37`); no grant registry, no policy (N15);
  - grants: forwarded, cached by device and `issuedAt` without verification
    (`packages/relay/src/grant-cache.ts:32-40`; N8);
  - presence: signature only (`connection.ts:224-230`);
  - cursors and grant requests: forwarded as received (`connection.ts:243-244`; N6);
  - blobs: hash only (`ingest.ts:96-117`).
- **Catch-up** (`packages/relay/src/catchup.ts:93-131`): every event since the joiner's cursors,
  narrowed by the joiner's own `interest` only (`:112-115`). There is no entitlement filter (N3,
  E13). The last page may carry a `scoped` coverage that the client adopts
  (`packages/relay/src/session.ts:130-142`; N18).

### 4.3 Device ↔ authority

Two channels.

1. **The sync path.** The authority is a peer and receives events like any other. The validator is
   built in `packages/client/src/boot.ts:116-127`. With no `issuer` configured,
   `grantFor: null` is ungranted mode: grant and policy rungs are skipped
   (`packages/engine/src/validate.ts:80`, `packages/engine/src/author.ts:36-37`; N22).
   - The validator's rungs:
     - clock drift (`validate.ts:157-172`);
     - reserved tables (`:123`);
     - partition and authorship (`:130`, `:178-245`);
     - grant held, grant names this device, revoked, stale (`author.ts:33-63`);
     - policy.
   - Authority-only tables (D24-A) are checked on authorship (`validate.ts:184-208`).
2. **oRPC over HTTP** (`packages/orpc/src/http.ts`).
   - `POST /<group>/<leaf>` is routed by oRPC's `RPCHandler` with `context: {}` (`:260`).
   - Gate bodies get `{input, errors, db, read}` and **no caller identity** (`:189-197`).
   - Query and mutation leaves run against the server's own `api` (`:208-221`), so they act as
     the server's principal (`packages/orpc/src/api.ts:261-265`). See N5.
   - Scope is read from the input (`packages/orpc/src/scope.ts:45-58`). It is documented as a
     claim, not a capability (`:19-21`). That holds on the sync path (every receiver re-checks),
     but not for a query answered over HTTP.
   - The idempotency cache is keyed by `x-syncmesh-request-id` alone (`http.ts:266-290`) and holds
     1024 entries (`packages/orpc/src/idempotency.ts:31-45`). See N23.
3. **Grant issuance.** A grant request is a frame anyone can send. It is passed to `onGrantRequest`,
   which is documented "Untrusted" (`packages/transport/src/bridge.ts:36-40`,
   `packages/transport/src/custody.ts:79-83`, `packages/client/src/options.ts:92`).
   What the app does with it is outside this repo.

### 4.4 Authority ↔ Postgres

- **Capture** (`packages/storage/src/capture.ts:188-234`).
  - `SET LOCAL syncmesh.armed = '1'` (`dialect-postgres.ts:114`). Triggers log
    `OLD`/`NEW` JSON into `_syncmesh_changes` only while armed (`:74`, `:96-106`).
  - At the end, `check(changes)` runs the schema and policy verdict before COMMIT
    (`capture.ts:219-220`). The partition is then stamped with capture disarmed (`:221-222`).
  - **Writes made while not armed are neither logged nor refused. There is no strict mode.**
    SQLite uses the same pattern with a guard row (`packages/storage/src/dialect-sqlite.ts:48-83`).
- **RLS** (`packages/storage/src/rls.ts`).
  - Read rules are compiled to one `FOR SELECT` policy, with `ENABLE` and `FORCE ROW LEVEL SECURITY`
    (`:201-229`).
  - The principal is passed in transaction-local GUCs `syncmesh.account|role|claims|partition`,
    set with `set_config(…, true)` (`:36-41`, `:251-270`).
  - Insert, update and delete policies are `TRUE`; writes are left to capture to judge (`:222-227`).
  - The partition filter is `partition GUC IS NULL OR _partition = GUC` (`:214`). It fails open
    when no partition is set (N16).
  - The tables in the `syncmesh` schema (events, changes) get no policy.
- **Compiler parity.** The read-rule compiler mirrors `evaluate`'s handler table
  (`rls.ts:85-177`; `packages/storage/src/read-filter.ts:54-60`). The device-side compiler is
  "pinned by the driver suite against `can()`" (`read-filter.ts:14-18`). Whether the Postgres
  compiler is pinned the same way is for the reviewer to confirm (§8 item 5).
- **External writers.** These are meant to come in through `packages/cdc` (watermarks,
  `_cdc.apply`) (`packages/cdc/src/capture.ts:19-20`).

### 4.5 App code ↔ engine (capture guard)

The guard is a session setting (Postgres) or a guard row (SQLite) that the library sets around
the app's own callback (`capture.ts:209-227`). App code inside that callback can run anything the
connection's role allows. That includes `SET LOCAL syncmesh.armed = '0'`, which turns off
capture for the rest of the callback, and `set_config('syncmesh.account', …)`, which changes the
RLS principal. Neither is detected. The guard separates captured writes from fold writes. It does
not separate the app from the engine.

---

## 5. Every wire frame

### 5.0 Layers and shared parsers

```
medium  ──▶ length prefix (stream media) │ BLE fragment header (8 B)
        ──▶ link handshake: HELLO 0x01 / SEALED 0x02  (raw bytes, not CBOR)
        ──▶ CBOR frame [tag, …]  session tags 0–8 │ relay tags 8–19
        ──▶ signed envelope [core, sig] inside (event, grant, receipt, presence, link, checkpoint)
```

- **CBOR decoder.** `packages/wire/src/cbor-decode.ts:12-122`; Rust: `crates/syncmesh-core/src/cbor.rs:255-355`.
  - It refuses tags, indefinite lengths, simple values other than false/true/null/f64, integers
    beyond 2^53, invalid UTF-8, and trailing bytes.
  - It does **not** enforce shortest-form heads, sorted map keys or unique map keys (the last
    duplicate wins: `cbor-decode.ts:112`, `cbor.rs:336`).
  - It **has no nesting-depth limit** (N4).
- **Size limits per medium:**
  - 8 MiB per frame on streams (`framing.ts:43`) and on the relay (`limits.ts:59`);
  - 128 KiB per BLE message (`fragment.ts:23`);
  - the WebSocket library's own payload ceiling applies before the relay's check — Node `ws`
    defaults to 100 MiB, Bun to 16 MiB, and neither host sets it
    (`adapters/relay-node/src/index.ts:127`; `packages/relay/src/serve.ts:50-57`). See N13.
- **Frozen vectors.** The 2026-09-26 audit line "vectors cover event cores, receipts, grants and
  accounts only" is **stale**. `conformance/` now holds `account`, `checkpoint`, `feed`, `fragment`,
  `frame` (18), `grant`, `handshake`, `join`, `presence`, `receipt`, `relay` (21), `resume`,
  `sealing` and `wire` vectors (E24.md:30, :33). What is still missing is listed per row below and
  summarized in §5.7.

### 5.1 Link handshake (raw bytes; `packages/transport/src/handshake.ts`)

| Frame                        | Sender → verifier         | Authenticated by                                                        | Forged / replayed / oversized                                                                                                                                                                                                         | Parser, limit                                                                                     | Vector                                         |
| ---------------------------- | ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `HELLO` 0x01 (129 B)         | each end → the other      | Ed25519 over context‖edPub‖eph (`:75-81`, `:108`)                       | Forged: refused. Replayed: refused if the ephemeral is in the 64-entry window (`session.ts:177-178`); otherwise it rekeys to an unusable key, a link-level DoS (`session.ts:158-169`). Oversized: exact length required (`:103`). | `readHello` `:101-113`, exactly 129 B                                                              | `handshake-vectors.json` (positive only)       |
| `SEALED` 0x02                | each end → the other      | XChaCha20-Poly1305 per direction; random 24 B nonce (`:149-166`)        | Forged: fails to open and is dropped (`session.ts:216-217`). **Replayed: accepted; there is no counter (N12).** Oversized: bounded by framing and the relay cap.                                                                   | `unseal` `:159-166`; minimum 41 B                                                                 | `handshake-vectors.json` (one sealed frame)    |

The relay socket runs the same handshake through `packages/relay/src/secure.ts:89-134`. A frame
in the clear after the hellos is refused there as `unsealed` (`:128`).

### 5.2 Medium framing

| Frame                         | Sender → verifier                     | Authenticated              | Attack                                                                                                                                                         | Parser, limit                                                                                                         | Vector                                                         |
| ----------------------------- | ------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 4-byte BE length prefix       | peer → `framed`                       | none (below the handshake) | An announced length over the cap closes the link (`framing.ts:75-76`). Partial frames are re-copied on every chunk, which is quadratic (`:67-70`; N20).        | `framing.ts:65-83`, 8 MiB                                                                                             | `frame-vectors.json` `framing`                                 |
| BLE fragment (8 B header)     | peer → `reassembler`                  | none (below the handshake) | Message cap and assembly cap with eviction (`fragment.ts:113-160`). Up to 65 535 fragments (`:20`, `:61`).                                                     | `packages/ble/src/fragment.ts:113`, 128 KiB × 32                                                                      | `fragment-vectors.json` (4 vectors + 2 refusals)               |
| BLE advertisement / hint      | peer → scanner                        | none                       | Spoofed hint → a wasted dial; the handshake names the real peer.                                                                                               | `packages/ble/src/advert.ts:90-118`, `packages/ble/src/sighting.ts`                                                   | **none**                                                       |
| LAN announcement (UDP)        | peer → multicast listeners            | none                       | Spoofed → a dial to `from.host:port` (`packages/transports/src/lan/transport.ts:256-259`). Room ≤ 64 B (`lan/advert.ts:29`).                                     | `readAnnouncement` `lan/advert.ts:48-64`, exact length                                                                 | **none**                                                       |

### 5.3 Session frames (CBOR `[tag, …]`; `packages/transport/src/frame.ts`, tags in `frame-parts.ts:20-32`)

Every one of these is **inside the sealed link**, so the link key authenticates the sending
device. None carries a link-level sequence number (N12).

| Tag | Frame                         | Sender → verifier                                     | What is signed                                                                                    | Forged / replayed / oversized                                                                                                                                                                                                                                                                                                       | Parser, limit                                                                                                                       | Vector                        |
| --- | ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 0   | `grant`                       | any peer → `GrantRegistry.register`                   | Issuer signature over the grant core (`grant.ts:108-149`)                                         | A forged grant is refused. A replay of an older grant for the same device is ignored (`grant-registry.ts:50-56`). A replay **after a local `revoke()` is accepted again** (`:84-87` deletes the entry). Claims are broadcast to every peer and the relay.                                                                           | `decodeFrame` `frame.ts:119-140`; grant `grant.ts:124-238`. No size cap beyond the frame.                                            | `frame`, `grant`              |
| 1   | `grant-request`               | ungranted peer → `onGrantRequest`                     | nothing                                                                                           | Anyone can send one; a replay re-fires the callback. The invite is free text.                                                                                                                                                                                                                                                       | `frame.ts:174-184`                                                                                                                  | `frame` (2)                   |
| 2   | `cursors`                     | peer → bridge `onCursors` → `engine.acknowledge`      | nothing; `from` is self-declared                                                                   | **A forged `from` writes acks for another peer** (`bridge.ts:238-240`; N6). Large cursor maps cost an `eventsSince` per frame (`:241-259`), which is an amplification lever.                                                                                                                                                         | `frame.ts:213-226`; `frame-parts.ts:82-119`                                                                                         | `frame` (2)                   |
| 3   | `event`                       | author or forwarder → `decodeAndVerify` → holdback → validator | Author Ed25519 over the received core (`envelope.ts:87-100`)                                  | A forgery fails the signature. A replay is deduplicated by id. Many authors → unbounded holdback maps before any grant check (`holdback.ts:35-43`; N9).                                                                                                                                                                              | `event-codec.ts:108-235`, the frame cap                                                                                             | `frame`, `wire`               |
| 4   | `presence`                    | peer → presence store                                 | Author Ed25519 over the presence core (`presence-codec.ts:80-95`)                                 | **A squatted session string blocks a victim's updates** (`packages/transport/src/presence.ts:91-94`). `held` has no count bound and `expires` is author-chosen (`:107-114`; N11).                                                                                                                                                     | `presence-codec.ts:80-139`                                                                                                          | `frame`, `presence`           |
| 5   | `digest`                      | peer → `answerDigest`                                 | nothing                                                                                           | A false digest causes a spurious `onDivergence` and repair work. Hex is parsed with `BigInt` per table (`frame.ts:197-206`).                                                                                                                                                                                                         | `frame.ts:186-211`; `packages/transport/src/divergence.ts`                                                                         | `frame` (2)                   |
| 6.0 | `snap-req`                    | peer → `serve`                                        | nothing                                                                                           | **Any admitted peer gets a whole-state snapshot of whatever interest it names** (`join.ts:110-131`; N2). A replay re-serves it (amplification).                                                                                                                                                                                     | `snap-frame.ts:88-93`                                                                                                               | `frame` (2)                   |
| 6.1 | `snap-manifest`               | peer → `onManifest`                                   | optional checkpoint certificate (issuer)                                                          | **Accepted unsolicited. `chunks: 0` installs immediately and adopts `at` as coverage** (`join.ts:107`, `:133-141`, `:173-189`; N1). `chunks` is limited only to 2^53 (`snap-frame.ts:106-107`) and later spread into an array (`join.ts:153`, `:174`; N10).                                                                         | `snap-frame.ts:100-114`                                                                                                             | `frame` (2)                   |
| 6.2 | `snap-chunk`                  | peer → `onChunk`                                      | nothing (rows are unsigned)                                                                       | Its rows are merged without signature, policy or drift checks (`packages/engine/src/snapshot.ts:85-90`; N1).                                                                                                                                                                                                                        | `snap-frame.ts:116-124`; rows `snapshot-codec.ts:112-280`                                                                           | `frame`                       |
| 6.3 | `snap-ack`                    | peer → `onAck`                                        | nothing                                                                                           | `missing` makes the sender re-send pages (`join.ts:206-218`), an amplification lever.                                                                                                                                                                                                                                               | `snap-frame.ts:126-138`                                                                                                             | `frame` (2)                   |
| 7   | `receipt`                     | holder → `custody.receive`                            | Holder Ed25519 over the receipt core (`receipt.ts:94-98`)                                         | Kept only when `author` is this device (`custody.ts:61-62`). A replay re-records the same vouch.                                                                                                                                                                                                                                     | `receipt.ts:94-144`                                                                                                                 | `frame`, `receipt`            |
| 8   | `routes`                      | peer → route table                                    | nothing. The next hop is the link (`frame.ts:73-78`), and the link is named by the unbound `from` (N6). | A false `hops` or `expiresAtMs` attracts traffic (a black-hole or a traffic-analysis lever). The list length is unbounded up to the frame cap.                                                                                                                                                                                       | `frame.ts:143-156`; `packages/transport/src/routes.ts`                                                                              | `frame`                       |
| —   | unknown tag                   | —                                                     | —                                                                                                 | Ignored (`frame.ts:171`).                                                                                                                                                                                                                                                                                                           | —                                                                                                                                   | —                             |

Tag 8 means `routes` among session frames and `join` among relay frames (`frame-parts.ts:31`
against `packages/relay/src/frames.ts:23`). The relay decoder resolves this by reading relay tags
first (`frames.ts:360-365`). The comment at `frames.ts:353-355` says the two spaces "cannot both
claim one", and that is no longer true (N24). The Rust crate documents the overlap
(`crates/syncmesh-core/src/relay_frames.rs:5-7`).

### 5.4 Relay control frames (tags 8–19; `packages/relay/src/frames.ts:22-35`, decoders `:233-350`)

On protocol v3 all of these travel sealed, so the link key authenticates the sender. Nothing
inside them is signed except the v2 join proof.

| Tag | Frame          | Sender → verifier                       | What is signed / checked                                                                                                     | Forged / replayed / oversized                                                                                                                                                                                                                            | Parser, limit                     | Vector        |
| --- | -------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------- |
| 8   | `join`         | client → room                           | v3: the peer id must equal the hello's key (`connection.ts:162-166`). v2: proof over `"syncmesh/relay/join/v2"‖nonce‖core` (`proof.ts:22-48`) | A new join supersedes the old socket for the same peer (`connection.ts:200-206`); only the key's holder can do this (FIXED, D33/D36). The joiner's cursors are broadcast to every client (`:213`) without a fanout charge. Cursor map size is bounded only by the frame cap. | `frames.ts:251-266`               | `relay` (5), `join` (2) |
| 9   | `hello`        | room → client                           | link key (v3) or TLS (v2)                                                                                                    | Carries `floor`, `cursors` and `epoch`, which the client acts on.                                                                                                                                                                                         | `frames.ts:273-289`               | `relay` (2)   |
| 10  | `error`        | room → client                           | link key                                                                                                                     | `version` and `retention` codes change client behavior. A forged one is possible only on an unpinned or plaintext link.                                                                                                                                     | `frames.ts:291-294`               | `relay` (4)   |
| 11  | `ka`           | room → client                           | link key                                                                                                                     | —                                                                                                                                                                                                                                                        | `frames.ts:341`                   | `relay`       |
| 12  | `ack`          | room → client                           | link key; not signed by the relay                                                                                            | **A malicious relay can ack writes it never stored** (false `synced()`). The relay cannot vouch (D28 watch-out).                                                                                                                                           | `frames.ts:296-299`               | `relay`       |
| 13  | `page`         | room → client                           | the events and grants inside are signed; `scoped` coverage is not                                                            | **A `scoped` coverage is adopted** (`packages/relay/src/session.ts:130-142`; N18).                                                                                                                                                                        | `frames.ts:301-315`               | `relay` (2)   |
| 14  | `relayed`      | room → client                           | the event inside is signed                                                                                                   | `offset` is advisory.                                                                                                                                                                                                                                    | `frames.ts:331-334`               | `relay`       |
| 15  | `blob-put`     | client → room                           | sha256 checked at the store (`packages/storage/src/blob.ts:50`)                                                              | 64-token blob bucket (`limits.ts:64`). A 1 GiB LRU cap by default (`packages/relay/src/retention.ts:70`).                                                                                                                                                  | `frames.ts:318-323`; 8 MiB        | `relay`       |
| 16  | `blob-get`     | client → room                           | nothing                                                                                                                      | Open room: any member can fetch any hash. Gated room: served only to a grant naming one of the blob's homes, else `blob-missing` (D44).                                                                                                                                                                                                      | `frames.ts:326-329`               | `relay`       |
| 17  | `blob`         | room → client                           | the hash is checked by the client (`packages/client/src/blobs.ts:89`)                                                        | —                                                                                                                                                                                                                                                        | `frames.ts:318-323`               | `relay`       |
| 18  | `blob-missing` | room → client                           | nothing                                                                                                                      | A malicious relay can deny blobs.                                                                                                                                                                                                                        | `frames.ts:326-329`               | `relay`       |
| 19  | `challenge`    | room → client (v2 rooms only)           | 32 random bytes (`proof.ts:25`)                                                                                              | Exact length (`frames.ts:268-271`).                                                                                                                                                                                                                      | `frames.ts:268-271`               | `relay`, `join` |
| 0–7 | `session`      | client ↔ room                           | as in §5.3                                                                                                                   | The room acts on event, grant and presence, and forwards grant-request and cursors (`connection.ts:239-245`). Snapshot, digest, receipt and routes from a client are ignored.                                                                              | `frames.ts:369-376`               | —             |

Per-connection decode order (`connection.ts:252-303`): size cap → unseal → **CBOR decode** →
token bucket → fanout debt → join-first. A frame that fails to decode returns `malformed` without
spending a token (`:273-277`). A frame that throws in the decoder escapes (N4).

### 5.5 Signed envelopes carried inside frames or rows

| Envelope                        | Signer → verifier                                       | Signed bytes                                                                                                         | Notes                                                                                                                                                                                                       | Parser                                                                    | Vector                         |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| Event `[core, sig]`             | author → every receiver                                 | the received core bytes                                                                                              | No domain separation prefix on the event core. Verified over the bytes received and relayed verbatim (`envelope.ts:113-123`).                                                                               | `envelope.ts:27-100`, `event-codec.ts:108`                                | `wire`, `frame`                |
| Grant                           | issuer → `GrantRegistry`                                | the core map (keys 0–8, `grant.ts:51-62`)                                                                            | `issuedAt ≤ expiresAt` is checked (`:209`). **`issuedAt` is not bounded against now**, so a future-dated grant wins "newest" until then. Expiry is judged on the receiver's clock (`:139`).                 | `grant.ts:124-238`                                                        | `grant` (3)                    |
| Grant origin (unverified read)  | relay → grant cache                                     | none                                                                                                                 | `readGrantOrigin` reads `device` and `issuedAt` without a signature check (`grant.ts:174-193`). N8.                                                                                                         | `grant.ts:174`                                                            | —                              |
| Custody receipt                 | holder → author                                         | `{holder, author, throughSeq, incarnation, at}`                                                                      | D28 two tiers. Not carried on relay links.                                                                                                                                                                 | `receipt.ts:94`                                                           | `receipt` (3)                  |
| Presence                        | author → hops                                           | `{v, peerId, topic, partition, session, count, value, expires}` (`presence-codec.ts:40-49`)                          | No grant or partition-membership check at the relay.                                                                                                                                                       | `presence-codec.ts:80`                                                    | `presence` (2)                 |
| Account link core (D21)         | account key, plus the device through the carrying event | `{v, op, account, device, partition, …}` (`account.ts:14-47`)                                                        | The partition is inside the core (`account.ts:28-29`).                                                                                                                                                      | `account.ts:87`                                                           | `account` (3)                  |
| Checkpoint certificate          | issuer → snapshot receiver                              | a state hash over rows, JSON-encoded (`checkpoint.ts:77-87`)                                                         | Checked only when `trust` is set (`join.ts:196-204`). With no certificate the install is "provisional" **but still adopts coverage by default** (N1).                                                        | `checkpoint.ts:133`                                                       | `checkpoint` (2)               |
| Join proof (v2)                 | device → room                                           | `"syncmesh/relay/join/v2"‖nonce‖canonical(core)`                                                                      | The room re-encodes the core from the decoded parts (`frames.ts:260-263`), so the proof depends on canonical encoding.                                                                                      | `proof.ts:40-48`                                                          | `join` (2)                     |
| Sealed payload                  | author, under the content key                           | XChaCha20-Poly1305 with AAD = author, seq, partition (`sealing.ts:65-86`)                                            | The epoch is in the clear and outside the AAD (`:80-82`); the core signature covers it.                                                                                                                     | `sealing.ts:95-110`                                                       | `sealing`                      |
| Wrapped content key             | issuer → device, inside the grant                       | X25519(ephemeral, toMontgomery(device edPub)) → HKDF(info = device id) → XChaCha20 (`sealing.ts:113-153`)            | Ed25519 and X25519 share one key (`packages/wire/src/identity.ts:21-30`). The wrap's AEAD has no AAD, so it is not bound to partition or epoch; the grant signature covers those.                          | `sealing.ts:141`                                                          | `sealing.wrap`                 |
| Feed certificate and chunk (RFC-0019) | author → receiver                                 | `sha256(head‖core)` chain; one signature per head (`feed.ts:14-23`, `:46-90`, `:130-148`)                             | **Codec and engine path only** (`packages/engine/src/feed.ts:103-184`). No frame tag carries a chunk, and no transport or relay sends one.                                                                  | `feed.ts:130`                                                             | `feed`                         |
| DO resume script                | room → its own storage                                  | none                                                                                                                 | Holds session keys (D36).                                                                                                                                                                                  | `adapters/cloudflare-do/src/resume.ts:93`                                 | `resume` (4)                   |

### 5.6 Frames that do not exist yet

- **Feed chunks and chains** (RFC-0019): codec and engine only (row above).
- **Relay receipts** (D28): absent on purpose.
- **Accounts**: travel as `_links` rows, not as frames.

### 5.7 Vector gaps

These have no frozen vector:

- BLE advertisement and sighting;
- LAN announcement;
- any **negative** vector (non-shortest CBOR heads, duplicate or unsorted map keys, deep nesting,
  over-cap lengths, wrong-length hello, low-order X25519 points, non-canonical Ed25519 `S` or `R`);
- frame sequences (handshake then supersede; join exchange with missing pages; unsolicited manifest).

The only refusal vectors are the two in `fragment-vectors.json`.

---

## 6. Key handling

### 6.1 Generation

- **Device seed:** 32 bytes from `randomBytes` (`packages/client/src/identity.ts:62`). The
  entropy source is the injected `entropy`, else `crypto.getRandomValues`, else a panic — never
  `Math.random` (`packages/wire/src/entropy.ts:28-66`).
- **Relay seed:** `randomBytes(32)` (`packages/relay/src/host.ts:162`).
- **Link ephemerals:** `x25519.utils.randomSecretKey()` (`handshake.ts:84`). Fresh per session and
  per rekey (`session.ts:102`, `:194-196`).
- **Content keys:** `randomBytes(32)` (`sealing.ts:60`).
- **Signing implementation.** Signing and verification are pluggable process-wide through
  `supplySigner` (`packages/wire/src/signing.ts:35-40`). The default is `@noble/ed25519` 3.1.0
  (`packages/wire/package.json:26`). Rust uses `ed25519-dalek` 2.2 `Verifier::verify`
  (`crates/syncmesh-core/src/identity.rs:48-60`, `Cargo.toml:12`). Whether these three accept
  exactly the same set of signatures is not established (N19).

### 6.2 Storage

See §2. To restate: the device seed, relay seed and DO session keys are plaintext at rest. The
issuer key is wherever the app keeps it.

### 6.3 Rotation

- **Device key: there is no rotation.** Changing the key means a new identity. Events the old
  identity wrote and never handed to anyone become unsendable and are reported as `StrandedWrites`
  (`packages/engine/src/stranded.ts:9-40`, `:118`; surfaced in `packages/client/src/recovery.ts:66`).
  Nothing refuses a rotation over a kept log (`stranded.ts:76-79`).
- **Issuer key: there is no rotation.** One `issuer: PeerId` is pinned per mesh
  (`packages/wire/src/grant-registry.ts:36-39`; `packages/client/src/boot.ts:33`, `:121`).
  Changing it invalidates every grant at once.
- **Relay key:** stable per store. A client that pinned the old key refuses a new one permanently
  (E24.md:20).
- **Content keys:** rotation is by epoch. The grant carries every epoch a device may read
  (`grant.ts:36-48`, `sealing.ts:35-47`). A revoked device keeps every key it already received.

### 6.4 Revocation

- **Propagating form:** a `_revocations` row written by the authority, keyed
  `partition:device` (`packages/engine/src/authority.ts:157-218`). It is checked by
  `checkRevoked` (`packages/engine/src/author.ts:118-138`).
  - The revocation applies only to grants with `issuedAt ≤ at`.
  - It applies only to events whose own HLC is `≥ at` (`author.ts:131-132`). The HLC is the
    author's own claim, and D34 bounds only stamps that run ahead (`validate.ts:157-172`), so **a
    revoked device that backdates its writes is admitted** (N7). The code calls this "residual
    honesty" (`author.ts:66-77`).
- **Local form:** `GrantRegistry.revoke` deletes the entry (`grant-registry.ts:84-87`). A
  re-arriving copy of the same grant is then accepted again (`:50-57`).
- **Topology quarantine:** the admission handler may refuse a suspect peer immediately
  (`gate.ts:53-62`).

### 6.5 Grant validity and expiry

- **Window:** `issuedAt` and `expiresAt` are epoch milliseconds (`grant.ts:94-95`). The registry
  hides an expired grant on the receiver's clock (`grant-registry.ts:62-68`).
- **Grace (RFC-0016):** `checkStale` judges `event.hlc + grace < expiresAt` against the author's
  stamp (`author.ts:78-101`).
- **The authority is exempt** from staleness but not from revocation (`author.ts:57-62`).

### 6.6 Clock skew (D34) — FIXED

- `DEFAULT_MAX_DRIFT` is 5 minutes (`packages/kernel/src/hlc.ts:32`).
- It clamps the clock (`packages/client/src/boot.ts:177`) and arms the validator's `ClockAhead`
  rung (`boot.ts:127`; `validate.ts:115`, `:157-172`).
- It bounds only the future. It does not apply to snapshot rows (N1).

### 6.7 Sealing

See §5.5 for `sealPayload`, `openPayload`, `wrapKey` and `unwrapKey`. Points for the reviewer:

- The AEAD nonce is random 24 bytes (`sealing.ts:76`).
- The epoch is outside the AAD (`:80-82`).
- One key does both Ed25519 and X25519 (`packages/wire/src/identity.ts:47-49`; `sealing.ts:130`).
- `toMontgomery` is applied to a peer id taken off the wire (`sealing.ts:130`).
- Behavior on low-order points has not been checked: noble `x25519` against `x25519-dalek`, whose
  `static_secrets` feature is on (`Cargo.toml:14`).
- Sealing hides content but not metadata (`sealing.ts:23-26`).

### 6.8 A lost or stolen device

The seed can be read from the SQLite file (§2). The thief holds:

- the device's identity until every peer folds a revocation **and** the thief stops backdating
  (N7), or until the grant expires;
- every content key wrapped in its grant, which no revocation can take back (`sealing.ts:38-42`);
- full read of every row the device held.

The topology override can refuse its links immediately (`gate.ts:53-57`). The relay does not
consult grants, so a revoked device keeps joining and pulling the room log until `verifyJoin`
refuses it (N3).

---

## 7. Known open issues

### 7.1 Gap-audit items re-verified

| #               | Item (source)                                                    | Status   | Evidence                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5               | No connection cap (gap-audit:37)                                 | PARTIAL  | **Fixed** on the Node and Bun hosts: `maxConnections` is 10 000 (`limits.ts:48`, `:60`), refused with 503 at the gate (`host.ts:128-137`, `:269-273`). **Open** on the Durable Object host: `live` is counted only in `accept` (`host.ts:274-275`), and the DO host binds through `acquire` and `connect` (`adapters/cloudflare-do/src/host.ts:180-197`, `:220-223`), so `atCapacity()` never trips (N14). No per-IP or per-room cap anywhere. |
| 6               | Backlog bounded in frames, not bytes (gap-audit:40)              | FIXED    | `maxBacklogBytes` is 64 MiB (`limits.ts:54`, `:61`), enforced in `sender.ts:38-44`. The 1000-frame cap remains as well (`room.ts:136`).                                                                                                                                                                                                         |
| 7               | Ingress-only rate limit (gap-audit:43)                           | PARTIAL  | Fan-out is metered for events: `fanout` bucket (`limits.ts:72`), charged after delivery (`ingest.ts:80`), and checked before the next event (`connection.ts:288-291`). Not charged: presence fan-out (`connection.ts:228-229`), grant fan-out (`:235-236`), forwarded cursors and grant requests (`:244`), the joiner's cursors broadcast (`:213`), and catch-up pages sent to a joiner (`catchup.ts:126`). |
| 8               | Retention defaults off (gap-audit:45)                            | PARTIAL  | Blobs default to a 1 GiB cap (`retention.ts:70`). Events: `keepEventsFor` is absent by default (`retention.ts:41`), so the log grows forever. `DURABLE_RETENTION` is opt-in (`:80-81`), and an unbounded room emits `relay.retention.unbounded` (`room.ts:256-259`). Idle-room eviction is off by default (`rooms.ts:110`). With `announce` defaulting to true (`posture.ts:55`), every new path is a new room with its own SQLite file (N25). |
| 9               | BLE never on hardware (gap-audit:48; E22.md:20-24)               | OPEN     | The two donor defects were not ported: the per-fragment ack is gone, and frame size now comes from the MTU (`packages/ble/src/radio.ts:137-155`, `fragment.ts`). The device checklist is still unchecked (E22.md:20). There is one anecdotal hardware observation in a comment (`packages/transport/src/session.ts:148-150`, "three-phone chain"). No recorded hardware test. |
| addendum 2      | Relay link skips the link handshake (D33 option C)               | FIXED    | D36 shipped protocol v3 (`frames.ts:40-50`; `connection.ts:108-113`, `:162-166`; `secure.ts`; `handshake-vectors.json`). Remaining: key pinning is optional (N17).                                                                                                                                                                             |
| 17              | Field-level read rules (E06.md:27)                               | OPEN     | Unchecked in E06. No `fields` node in the policy AST (`packages/policy/src/ast.ts`). The book calls this deliberately absent (gap-audit:126).                                                                                                                                                                                                 |
| 18              | Interest is a request, not a permission (E13.md:52-53)           | OPEN     | The relay's catch-up and live fan-out filter by the joiner's interest only (`catchup.ts:112-115`; `connection.ts:144-145`). No policy or entitlement filter exists for interest to sit behind. The device bridge serves snapshots by the requester's interest (`join.ts:110-111`) and events with no filter at all (`bridge.ts:242`). See N2 and N3. |
| 30              | Strict capture mode (gap-audit:113)                          | OPEN     | The trigger body is `IF armed THEN log END IF` with no `ELSE RAISE` (`dialect-postgres.ts:96-106`). SQLite uses `WHEN armed` (`dialect-sqlite.ts:58`, `:70`).                                                                                                                                                                                  |
| addendum 3      | Device seed in plaintext SQLite                                  | OPEN     | `packages/client/src/identity.ts:40-64`. Same for the relay seed (`host.ts:161-163`).                                                                                                                                                                                                                                                            |
| addendum 1      | Clock-skew bound (D34)                                           | FIXED    | §6.6.                                                                                                                                                                                                                                                                                                                                            |
| addendum 2      | Relay trusted a claimed identity (D33)                           | FIXED    | v2 proof (`proof.ts`), v3 impostor check (`connection.ts:162-166`). Both run before the seat is taken (`:200-206`).                                                                                                                                                                                                                              |
| E24 posture     | "Any socket can join any room and pull the whole log" (E24.md:39) | OPEN     | Defaults at `posture.ts:51-56`. The RFC-0017 posture task is unchecked (E24.md:21).                                                                                                                                                                                                                                                              |
| D24             | Authority visibility = admission                                  | PARTIAL  | Authorship is enforced (`validate.ts:184-208`). D24's watch-outs require the relay to filter an admitted subset and report a scope that names the entitlement. No such filter exists in `catchup.ts`.                                                                                                                                           |
| D28             | Destructive actions licensed by a claim                           | OPEN     | `detach` still gates on `unsettled()`, built from cursor acks (`packages/storage/src/detach.ts:39-45`). `soleCustody` exists but gates nothing (D28 watch-out). Third-party cursor forgery makes this worse (N6).                                                                                                                               |
| audit vectors   | "Vectors cover event cores, receipts, grants, accounts only"     | FIXED (stale) | 15 vector files (§5.0). Remaining gaps in §5.7.                                                                                                                                                                                                                                                                                             |

### 7.2 Findings made while preparing this document (unconfirmed unless stated)

| ID  | Pri | Finding                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                         |
| --- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | P0  | **An unsolicited snapshot rewrites state and retires history.** `onManifest` accepts a manifest nobody asked for. `unvouchedMayAdopt` starts `true`. `chunks: 0` completes at once. The manifest's `at` is adopted as coverage, and its rows go through `mergeRecord` with no signature, grant, policy or `ClockAhead` check. Any admitted peer can write any row in any table with any stamp, and can make the victim stop asking for history it never received. | `packages/transport/src/join.ts:107`, `:133-141`, `:173-189`; `packages/engine/src/snapshot.ts:85-90`; dispatch at `packages/transport/src/dispatch.ts:36-38`                    |
| N2  | P0  | **Direct links have no read authorization on the send path.** `onCursors` sends every synced event since the far side's cursors with no interest or entitlement filter. `snap-req` serves whatever interest the requester names. A link is admitted when the peer's grant overlaps **one** partition. Result: every unsealed partition a device holds leaks to any peer that shares any one partition with it. | `bridge.ts:241-253`; `join.ts:110-131`; `gate.ts:127-129`; no `interest` passed at `packages/transport/src/transport.ts:407-447`                                                |
| N3  | P0  | **The relay has no read authorization.** Any key that completes the hello can join any announced room and be paged the whole log, filtered only by its own interest. Membership is whatever `verifyJoin` says, and by default it admits. | `posture.ts:55-56`; `catchup.ts:105-126`; `connection.ts:147-215`                                                                                                                |
| N4  | P0  | **Unbounded CBOR nesting throws out of the "never throws" decoder.** Probe: a 100 001-byte input of `0x81…0x00` makes `decodeCbor` throw `RangeError: Maximum call stack size exceeded`; 10 000 levels decode. (Probe run with Bun 1.4.4 against `packages/wire/src/cbor-decode.ts`, which `diff -q` showed identical between this worktree and the main checkout; the worktree has no `node_modules`.) On the relay this decode runs inside the socket's message handler before the rate limit and before join-first. On Node `ws` a synchronous throw in a `message` listener is likely to be an uncaught exception (not confirmed). The Rust decoder recurses the same way, and stack overflow in Rust aborts the process. | `cbor-decode.ts:25-51`, `:91-115`; `packages/relay/src/connection.ts:271-283`; `adapters/relay-node/src/index.ts:107-111`; `crates/syncmesh-core/src/cbor.rs:321-339`          |
| N5  | P0  | **HTTP procedures have no caller identity.** oRPC is invoked with `context: {}`. Gate bodies receive no principal. Query and mutation leaves run on the server's own api, as the server. Unless something in front of `server.fetch` authenticates **and** the handlers authorize on input alone, any HTTP caller acts with the server's rights. The intended deployment needs confirming. | `packages/orpc/src/http.ts:189-197`, `:208-221`, `:260`; `packages/orpc/src/api.ts:261-265`                                                                                      |
| N6  | P1  | **Cursor `from` is not bound to the sender.** The relay forwards `cursors` from any member unchanged. Relay clients call `engine.acknowledge(frame.from, …)`. The bridge takes `from` as the far side's identity. A member can claim that any other peer holds everything. That empties `unsettled()`, which is what licenses `detach`. It also lets the member point another peer's route table at itself. | `connection.ts:243-244`; `packages/relay/src/session.ts:215-217`; `bridge.ts:238-240`; `packages/client/src/operations.ts:248-292`; `packages/storage/src/detach.ts:39-45` |
| N7  | P1  | **Revocation and staleness can be bypassed by backdating.** Both rungs judge the author-chosen HLC. The bound is the grant's `expiresAt` on the receiver's clock. Documented as accepted; needs a decision.                                                                                                                                                                                  | `packages/engine/src/author.ts:66-101`, `:131-132`                                                                                                                              |
| N8  | P1  | **The relay grant cache can be poisoned.** An unsigned grant core with the victim's `device` and a far-future `issuedAt` replaces the real grant. Every later joiner then receives the forgery, which every receiver refuses, instead of the real grant.                                                                                                                                       | `packages/relay/src/grant-cache.ts:32-40`; `packages/wire/src/grant.ts:174-193`; served at `catchup.ts:121`                                                                       |
| N9  | P2  | The holdback buffers up to 512 events per author for any number of authors, before the grant check. Self-generated keys can fill memory.                                                                                                                                                                                                                                                   | `packages/transport/src/holdback.ts:32-45`; `bridge.ts:214`                                                                                                                      |
| N10 | P1  | A manifest's `chunks` is limited only to 2^53. `[...Array(chunks).keys()]` throws `RangeError` above 2^32−1 and allocates huge arrays below that. The throw rejects the bridge's promise chain (`queue = queue.then(run)`), and every later `.then` on that bridge is then skipped. Reading only: this would stall the bridge.                                                              | `snap-frame.ts:106-107`; `join.ts:153`, `:174`; `bridge.ts:273`; `dispatch.ts:37`                                                                                                |
| N11 | P2  | Presence: `seen` is keyed by the session string alone, so a member can pre-claim a victim's session id with a high count. `held` has no count bound and keeps `expires` as the author set it. The relay sends every held entry to each joiner.                                                                                                                                                | `packages/transport/src/presence.ts:91-114`; `connection.ts:209-210`, `:224-230`                                                                                                 |
| N12 | P2  | Sealed frames carry no counter. An on-path attacker can replay, reorder or drop them without detection, on direct links and on relay sockets. This matters most on media without TLS (BLE, LAN, plain `ws://`).                                                                                                                                                                              | `handshake.ts:148-166`; `packages/relay/src/secure.ts:128-132`                                                                                                                   |
| N13 | P2  | WebSocket payloads are buffered up to the library ceiling (Node `ws` 100 MiB default, Bun 16 MiB) before the relay's 8 MiB check.                                                                                                                                                                                                                                                          | `adapters/relay-node/src/index.ts:127`; `packages/relay/src/serve.ts:50-57`; `connection.ts:255`                                                                                 |
| N14 | P1  | The Durable Object host never trips the connection cap (see #5 above).                                                                                                                                                                                                                                                                                                                      | `host.ts:274-275`; `adapters/cloudflare-do/src/host.ts:180-197`                                                                                                                  |
| N15 | P1  | The relay stores and fans out events from any signing key, with no grant check. With `keepEventsFor` off by default, strangers can grow a room's log without limit.                                                                                                                                                                                                                         | `ingest.ts:33-55`; `retention.ts:41`                                                                                                                                             |
| N16 | P1  | RLS: the partition filter is open when the GUC is unset. GUCs are settable by any SQL in the session, so RLS does not protect against app SQL (only against code that forgets to scope). The `syncmesh` schema tables (events, changes) have no policies, and events hold every partition's cores.                                                                                            | `rls.ts:214`, `:251-270`; DDL `dialect-postgres.ts:86`, `:129`                                                                                                            |
| N17 | P1  | Relay key pinning is opt-in. Without it, TLS is the only defense against a man in the middle on the relay link.                                                                                                                                                                                                                                                                           | `packages/relay/src/transport.ts:86`, `:281-283`; D36 watch-out                                                                                                                  |
| N18 | P1  | A malicious relay can send a `scoped` coverage on the last page. The client adopts it if the scope text matches its own interest, and then never asks for those events again, from any relay.                                                                                                                                                                                             | `packages/relay/src/session.ts:126-142`; `frames.ts:301-315`                                                                                                                     |
| N19 | P1  | Ed25519 acceptance may differ across implementations: noble 3.1.0 default `verify`, ed25519-dalek 2.2 `Verifier::verify`, and any `supplySigner` native signer. A signature one accepts and another refuses splits verdicts between peers. Not checked.                                                                                                                                     | `packages/wire/src/identity.ts:54-60`; `signing.ts:35`; `crates/syncmesh-core/src/identity.rs:48-60`                                                                              |
| N20 | P3  | Stream framing re-copies the whole held buffer on every chunk, so a slowly trickled 8 MiB frame costs quadratic copying.                                                                                                                                                                                                                                                                    | `framing.ts:65-70`                                                                                                                                                               |
| N21 | P2  | LAN: no link cap; inbound TCP runs a handshake and framing (up to 8 MiB held each) for any connector; announcements are unauthenticated.                                                                                                                                                                                                                                                  | `packages/transports/src/lan/transport.ts:305`; `lan/advert.ts:48-64`                                                                                                             |
| N22 | P2  | No `issuer` means ungranted mode: every grant and policy rung is skipped. A misconfigured mesh is open to every writer.                                                                                                                                                                                                                                                                    | `packages/client/src/boot.ts:116-121`; `author.ts:36-37`; `validate.ts:80`                                                                                                        |
| N23 | P2  | Idempotency answers are keyed by request id alone, not by caller or path. Anyone who knows an id gets the kept response.                                                                                                                                                                                                                                                                    | `http.ts:266-290`                                                                                                                                                                |
| N24 | P3  | Tag 8 is both `routes` and `join`. The comment that claims no collision is false.                                                                                                                                                                                                                                                                                                           | `frame-parts.ts:31`; `relay/src/frames.ts:23`, `:353-355`                                                                                                                         |
| N25 | P2  | Unbounded rooms: any path is a room by default; idle eviction is off by default; each room opens its own store.                                                                                                                                                                                                                                                                             | `posture.ts:55`; `rooms.ts:110`; `adapters/relay-node/src/index.ts:165`                                                                                                           |
| N26 | P1  | Secrets at rest in plaintext: device seed, relay seed, DO session keys.                                                                                                                                                                                                                                                                                                                    | §2                                                                                                                                                                               |

---

## 8. What the external review must cover

The list is in priority order. Each item names its files, the method, and the artifacts it needs.

1. **Authorization on the sync path (P0).** Covers N1, N2, N3, N6, N7, N8, E13, D24.
   - **Files:** `packages/transport/src/{bridge,join,gate,dispatch,custody,outbound}.ts`;
     `packages/engine/src/{validate,author,authority,snapshot,interest,admit}.ts`;
     `packages/relay/src/{connection,catchup,ingest,grant-cache,session}.ts`.
   - **Method:** model each frame's receive-side effect against the sender's grant. Write attacker
     scenarios as tests in the existing bridge and relay fixtures:
     - unsolicited manifest with `chunks: 0` and high `at`;
     - snapshot rows with future stamps;
     - a `snap-req` from a peer sharing one partition;
     - spoofed `cursors.from`;
     - a backdated write after revocation;
     - a future-dated unsigned grant core sent to the relay.
   - **Decide:** where entitlement filtering lives on the device send path and at the relay;
     whether snapshot rows must be checkpoint-verified before they can adopt coverage.

2. **CBOR canonical decoder: fuzzing and parity (P0).** Covers N4, N19 (encoding half), N24.
   - **Files:** `packages/wire/src/{cbor,cbor-decode,cbor-guards,event-codec,grant,receipt,presence-codec,account,checkpoint,snapshot-codec,record-codec}.ts`;
     `packages/transport/src/{frame,frame-parts,snap-frame}.ts`; `packages/relay/src/frames.ts`;
     `crates/syncmesh-core/src/{cbor,frames,relay_frames,event_codec,record_codec,grant,receipt,account,checkpoint}.rs`.
   - **Method:**
     - add a depth limit, then fuzz:
       - **TS:** `fast-check` property tests already exist (`packages/wire/src/__tests__/cbor.test.ts`);
         extend them to arbitrary byte input with an assertion that nothing throws;
       - **Rust:** `cargo-fuzz` targets for `cbor::decode`, `frames::decode_frame` and
         `relay_frames::decode_relay_frame` (none exist today);
     - run a differential fuzz of TS against Rust over the same inputs: same accept/reject, same
       re-encoding;
     - decide whether non-canonical input (non-shortest heads, unsorted or duplicate keys) must be
       refused. Today both decoders accept it, while signatures cover received bytes and the join
       proof covers a re-encode.
   - **Vectors needed:** negative vectors for each refusal class (§5.7).

3. **Relay DoS (P0/P1).** Covers N4, N9, N13, N14, N15, N25 and gap #5, #7, #8.
   - **Files:** `packages/relay/src/{connection,host,limits,sender,room,rooms,retention,blob-cap,serve}.ts`;
     `adapters/relay-node/src/index.ts`; `adapters/cloudflare-do/src/{host,resume}.ts`.
   - **Method:** run a load rig against each host with:
     - many keys;
     - many rooms;
     - deep-nesting frames;
     - 100 MiB WebSocket messages;
     - presence floods with far-future `expires`;
     - catch-up requests from cursor 0 by many joiners;
     - DO connection counts above `maxConnections`.
   - **Check:** the memory and disk ceiling under each.

4. **Crypto use review (P1).**
   - **Files:** `packages/transport/src/{handshake,session}.ts`; `packages/relay/src/{secure,proof}.ts`;
     `packages/wire/src/{identity,signing,entropy,sealing,keyring,feed,checkpoint,receipt,grant,account}.ts`;
     `crates/syncmesh-core/src/{handshake,identity,join_proof,signed}.rs`.
   - **Topics:**
     - signed-ephemeral handshake with no key confirmation and no counters (N12);
     - rekey on a re-hello and the 64-entry replay window;
     - the same context string for relay and device links;
     - Ed25519 and X25519 sharing one key, and `toMontgomery` on a wire-supplied key;
     - HKDF salt and info choices;
     - AAD coverage (epoch);
     - low-order points;
     - Ed25519 strictness across noble, dalek and host signers (N19);
     - the feed chain (`sha256(head‖core)`) as a substitute for per-event signatures;
     - the checkpoint state hash built from JSON (`checkpoint.ts:77-87`);
     - entropy injection (`supplyEntropy` is process-wide; `entropy.ts:37-39`).
   - **Vectors needed:** low-order X25519 and non-canonical Ed25519 cases run against both
     implementations.

5. **RLS correctness (P1).** Covers N16.
   - **Files:** `packages/storage/src/{rls,read-filter,dialect-postgres}.ts`; `packages/policy/src/evaluate.ts`;
     `adapters/postgres/src/index.ts`.
   - **Method:**
     - property test: for random policy ASTs, rows and principals, `evaluate(read)` must equal
       Postgres `SELECT` visibility (a PGlite harness exists);
     - review the threat of GUC spoofing and the unset-partition fail-open;
     - review the `syncmesh` schema's exposure (events, changes) to the app role;
     - check `FORCE RLS` together with the role the authority actually connects as.

6. **Capture bypass (P1).** Covers strict mode, §4.5.
   - **Files:** `packages/storage/src/{capture,dialect-postgres,dialect-sqlite}.ts`; `packages/cdc/src/*`.
   - **Method:** enumerate the write paths that skip capture:
     - unarmed transactions;
     - `SET LOCAL syncmesh.armed='0'` inside the callback;
     - `TRUNCATE`, which fires no row triggers;
     - `COPY`;
     - writes that bypass triggers (`session_replication_role = replica`);
     - DDL.
   - **Decide:** a strict mode that raises on unarmed writes (gap-audit №30).

7. **Grant forgery, replay and lifecycle (P1).** Covers N7, N8, N22.
   - **Files:** `packages/wire/src/{grant,grant-registry}.ts`; `packages/storage/src/grant-store.ts`;
     `packages/client/src/{grants,auth}.ts`; `packages/engine/src/{author,authority}.ts`.
   - **Topics:**
     - future-dated `issuedAt`;
     - a replay after a local revoke;
     - expiry judged on the receiver's clock;
     - backdating against revocation;
     - claims broadcast to every peer and the relay;
     - no issuer rotation;
     - ungranted mode as a default footgun.
   - **Vectors needed:** grant edge cases (`issuedAt > now`; `issuedAt == expiresAt`;
     duplicate keys in the core map).

8. **HTTP procedure surface (P0 if N5 holds).**
   - **Files:** `packages/orpc/src/{http,server,api,scope,idempotency,custody,client}.ts`.
   - **Method:** confirm where caller authentication is expected. Test whether a query or mutation
     sent over HTTP runs as the server principal. Review idempotency-key scoping and the request
     body limits of oRPC's `RPCHandler`.

9. **Rust implementation parity (P1).** `crates/syncmesh-core` and `crates/syncmesh-client` exist
   (E24.md:31-32, D35, D37).
   - **Method:**
     - differential tests against TS for every decoder, the handshake, join-proof verification,
       grant verification, and presence admission (`crates/syncmesh-client/src/presence.rs`);
     - confirm the Rust client implements the same relay-trust choices (scoped coverage
       adoption, own-position adoption);
     - stack depth on decode (N4).
   - **Existing tests:** `crates/syncmesh-core/tests/{vectors,signed_vectors,frame_vectors,handshake_vectors}.rs`
     and `crates/syncmesh-client/tests/interop.rs`.

10. **Transports below the handshake (P2).** Covers BLE, LAN, P2P.
    - **Files:** `packages/ble/src/{fragment,link,transport,advert,sighting,radio}.ts`;
      `packages/transports/src/lan/*`, `packages/transports/src/p2p/*`; `adapters/lan-node/src/index.ts`.
    - **Method:**
      - fuzz the fragment reassembler;
      - LAN inbound connection flood (N21);
      - announcement spoofing toward arbitrary host:port;
      - BLE on real hardware (E22 checklist).

11. **Secrets at rest (P1).** Covers N26.
    - **Files:** `packages/client/src/identity.ts`; `packages/relay/src/host.ts:140-169`;
      `adapters/cloudflare-do/src/resume.ts`; the `adapters/sqlite-*` bindings.
    - **Decide:** platform keystores for the device seed, or an encrypted database, and what a
      backup of the SQLite file is allowed to restore.

12. **Dependency audit (P2).**
    - **Crypto:** `@noble/ed25519` 3.1.0 (pinned), `@noble/curves`, `@noble/ciphers`,
      `@noble/hashes` (caret ranges, `packages/wire/package.json:24-27`,
      `packages/transport/package.json:29-31`).
    - **Server:** `ws` ^8.18 (`adapters/relay-node/package.json:22`), oRPC.
    - **Rust:** `ed25519-dalek` 2.2, `x25519-dalek` 2.0, `chacha20poly1305` 0.10, `hkdf` 0.12,
      `rusqlite` 0.37 bundled (`Cargo.toml:12-16`; `crates/syncmesh-client/Cargo.toml:19`).
    - **Lockfiles:** `bun.lock`, `Cargo.lock`.
    - **Method:** `cargo audit`, an npm advisory scan of `bun.lock`, and a review of caret ranges
      on the crypto packages.

---

## Appendix: what this document is unsure of

- **N4.** Whether a `RangeError` thrown out of a `ws` `message` listener crashes the Node relay
  process, and how a Durable Object treats a rejected `webSocketMessage`. Not tested.
- **N5.** Whether apps are expected to put an authenticating proxy in front of `server.fetch` and
  authorize inside handlers. Nothing in `packages/orpc` passes request identity through.
- **N10.** The bridge-stall effect of a rejected queue link was reasoned from
  `queue = queue.then(run)`, not observed.
- **N19.** The exact default verification mode of `@noble/ed25519` 3.1.0 (ZIP-215 or strict) was
  not confirmed from its source. The worktree has no `node_modules`.
- **BLE hardware.** The comment at `session.ts:148` suggests a three-phone run happened. No test,
  log or checklist records it.
- **Tests.** None were run for this document; `vp install` was not run in this worktree. The only
  executed check is the N4 probe.

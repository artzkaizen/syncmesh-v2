---
rfc: 0024
title: Accounts, server-issued grants, and working offline
package: "(design) wire (scoped roles) · relay (grant-gated rooms) · syncmesh-client (validator slice, grant store) · @syncmesh/better-auth (issuer plugin) · licnep crates/sync + a Better Auth service on Cloudflare"
layer: 2
status: proposed
standalone: false
deps: ["0002", "0008", "0010", "0016", "0017", "0019"]
---

# RFC-0024 — Accounts, server-issued grants, and working offline

> **Revision 2 (2026-09-29, owner feedback).**
> 1. The account service is built on **Better Auth**. Sign-in, sessions, social providers,
>    passkeys and workspaces (organizations) are Better Auth's. syncmesh adds one Better Auth
>    plugin that binds device keys and mints signed grants.
> 2. **An account is needed only to share.** Local files never need one; the app asks you to
>    sign in the first time you share, open a link, publish to others, or join a workspace.
>
> §2, §3, §4.4, §4.7, §4.9, §5, §6, §7 and §9 changed. §1 and the wire and room design (§4.3,
> §4.6) are unchanged.

## Purpose

The owner's requirement (2026-09-29): people should use licnep **like a normal application with a
server**. They sign in, they **keep working when the server is off**, and the server **issues the
grants** that say who may open, edit or view a shared file.

licnep is the first consumer. Its Share dialog needs:

- invite by email;
- roles (can edit / can view / owner);
- link access;
- a workspace Home (Paper boards G1, G2, F15, F16).

Publishing goes to Cloudflare Workers + R2. **None of this may get in the way of local work.** A
person who never shares never sees a sign-in screen.

syncmesh already has most of the offline half: grants are signed bytes that every peer verifies
without a network (D08). What it does not have:

- the online half, an account system that authenticates a person and decides which grant to mint;
- a relay that enforces grants;
- a Rust device that validates anything.

This RFC designs those three, plus the licnep integration. It implements nothing. Wire changes are
listed with the frozen vectors they need (README rule 3).

**One sentence.** A **Better Auth** server on Cloudflare Workers + D1 signs people in. A
syncmesh Better Auth plugin binds each install's Ed25519 device key to the Better Auth session that
enrolled it, then mints short-lived, per-partition **syncmesh grants** from the person's Better
Auth identity and organization memberships. Rooms verify those grants on join and on every event.

Offline, **only signed syncmesh bytes are verified**: grants against the issuer key shipped in the
app, and events against their authors. A Better Auth session is an online credential and is never
checked offline. Revocation goes out three ways at once:

- a newer grant;
- a `_revocations` row;
- a room deny list.

The convergence rules for offline writes are the ones `engine/src/author.ts` already implements.

---

## 1 · What exists today

### 1.1 Primitives (TypeScript is complete; Rust has the bytes but not the judgment)

| Piece | TypeScript | Rust | Notes |
|---|---|---|---|
| Device identity (Ed25519, `peerId = hex(pubkey)`) | `packages/wire/src/identity.ts`; seed minted into the `_device` table of the device's own database (`packages/client/src/identity.ts:8-21, :40-42`) | `crates/syncmesh-core/src/identity.rs` (`Identity::from_seed`) | TS keeps the key **in the database on purpose**, so the key and the log die together (`client/src/identity.ts:17-21`). |
| Grant core + envelope | `packages/wire/src/grant.ts`: keys `v`0 `account`1 `device`2 `role`3 `partitions`4 `issuedAt`5 `expiresAt`6 `claims`7 `keys`8 (:55-66); `issueGrant` / `verifyGrant` / `readGrantOrigin` | `crates/syncmesh-core/src/grant.rs`: `issue_grant` :209, `verify_grant` :226, `read_grant_origin` :260; vectors in `conformance/grant-vectors.json` | **One `role` per grant**; `verifyGrant` checks expiry only (no not-before). |
| Grant registry | `packages/wire/src/grant-registry.ts`: newest-issued wins **per device**, expired reads as absent (`grantFor`), `revoke` is local only | `crates/syncmesh-client/src/grants.rs:17-110`: same rules | Keyed by device alone, so **a device holds exactly one grant from one issuer**. |
| Grant persistence | `GrantStore` + `rememberGrants` (`packages/client/src/grants.ts:118-143`); re-verified on boot | **none**: `sqlite.rs` has no grant table | A Rust device forgets every grant on restart. |
| Minting and renewal | `mesh.grants.issue`, `expiring`, `renew` (refuses revoked devices, `DeviceRevoked`) (`client/src/grants.ts:36-252`) | only the free function `issue_grant` | |
| Validator ladder: author rungs | `packages/engine/src/author.ts`: `NoGrant`, `GrantDeviceMismatch`, `GrantRevoked` (vs `_revocations`, judged on the **event's stamp** and the grant's `issuedAt`), `GrantStale` (grace from `_policy`) | **none**: "No validator yet" (`crates/syncmesh-client/src/engine.rs:10-13`, D37) | A Rust device folds whatever verifies. |
| Partition admission | `PartitionNotGranted` (`packages/engine/src/validate.ts:232-247`), an exact string match on `grant.partitions` | none | Nesting was dropped (`packages/schema/src/partition.ts:14-29`). |
| Roles | `role(...)` via `roleAtLeast` on a per-kind ladder (`packages/policy/src/evaluate.ts:50, :101-105`); `claimHas` / `claimEquals` / `claimIncludes` (`policy/src/ast.ts:8-15`) | none | |
| Revocations, grace | `_revocations` rows written by the authority (E21); `grace` column on `_policy` (`engine/src/rules.ts:36-42`) | none | |
| Account links (D21) | `packages/wire/src/account.ts` (`AccountCore` link/unlink, signed by the account key), `engine/src/accounts.ts`, `client/src/accounts.ts` | `crates/syncmesh-core/src/account.rs` (`sign_link` :126, `verify_link` :131) | **Read only in an ungranted mesh** (D21, `author.ts:26-41`). |
| Session vs grant | `packages/client/src/auth.ts`: `SessionProvider`, `signOut` order (stop sync, then purge, then drop credential) | none | The TS client already separates "who the user is" (session) from "whose events peers admit" (grant). This RFC keeps that split. |
| Custody receipts | `packages/wire/src/receipt.ts` (D27/D28) | `crates/syncmesh-core/src/receipt.rs` | Not auth, but used for "only this device holds it" warnings (§3.6). |
| Checkpoint certificates | `packages/wire/src/checkpoint.ts` (issuer-signed state hash) | `crates/syncmesh-core/src/checkpoint.rs` | Already an issuer-signed artifact besides grants. |
| Sealed partitions | `packages/wire/src/sealing.ts`, `keyring.ts`; content keys wrapped to the device **inside the grant** (key 8) | the core decodes key 8; the engine writes `sealed: false` (`engine.rs:251`) | |
| `grant-request` frame `{peerId, invite?}` | `packages/transport/src/frame.ts:26, :80`; `bridge.requestGrant` | `MeshEvent::GrantRequest` (`crates/syncmesh-client/src/mesh.rs`) | Unauthenticated by definition (D08 addendum). |
| Clock bound | D34: `DEFAULT_MAX_DRIFT` = 5 min on stamps (`kernel/src/hlc.ts`) | the D34 clamp in `syncmesh-core/src/hlc.rs` | |

### 1.2 The relay: identity is proven, membership is not

- **D33** (`packages/relay/src/proof.ts`, `crates/syncmesh-core/src/join_proof.rs`) makes a join
  prove the key it names. **D36** (protocol v3, `crates/syncmesh-core/src/handshake.rs`) makes the
  socket a sealed link. On a v3 link, a join naming a key other than the one the hello proved is
  refused as `impostor`. The client can pin the room's key (`RelayOptions.relay_key`,
  `crates/syncmesh-client/src/relay.rs:112, :488-493`). Pinning is not decided for TypeScript
  (D36, "Watch out").
- **The room holds no issuer key and verifies no grant.** `GrantCache` reads `readGrantOrigin`
  without a signature check. It only decides which bytes to forward (`packages/relay/src/grant-cache.ts`,
  Rust `room.rs:102-103, :665-680`). D33 says it plainly: *"A proof binds a join to a socket, not
  a person to a room. Who may be in the room at all is still the posture (`verifyJoin`) and …
  the grant."*
- The only access control is `RelayPosture.verifyJoin(request, room)`, asked at HTTP upgrade
  (`packages/relay/src/posture.ts:27-33`). The Durable Object host asks it in `gate` before a
  socket exists (`adapters/cloudflare-do/src/host.ts:60-72`).
- The Rust driver dials with `tokio_tungstenite::connect_async(&url)`
  (`crates/syncmesh-client/src/driver.rs:168`). It sends **no headers**.

### 1.3 licnep today (pinned at syncmesh `429cd6d`, `licnep/crates/sync/Cargo.toml:21-22`)

- **One mesh per project.** Partition `project:<sync_id>`, room = URL path chosen by the user
  (`crates/sync/src/model.rs:41, :106-125`).
- **`issuer: None`** (`crates/sync/src/device.rs:658`), which means *"this device's own key"*
  (`syncmesh-client/src/mesh.rs:38-39, :110-112`). licnep never issues, requests, registers or
  checks a grant. `MeshEvent::GrantRequest` is ignored (`device.rs:443`). `docs/sync.md:215-216`
  says: *"every device in a room is trusted. Use `--sync-key` and a private relay."*
- **Device seed.** A plaintext file, `~/Library/Application Support/licnep/device.seed`, one per
  machine, shared by every project (`crates/sync/src/relay.rs:21-33`,
  `crates/app/src/bin/shell.rs:66-70`). The relay seed is `<dir>/relay.seed`, also plaintext.
- **Identity is only a name.** Display name = git `user.name` / `$USER` (`shell.rs:72-83`).
  `Person { name }` has no id, email or role (`crates/app/src/ui/state.rs:210-212`). The Share
  dialog's "Owner" / "Can edit" labels are hard-coded (`crates/app/src/ui/share.rs:289-299`).
- **MCP agents.** A Unix socket in a 0700 directory (`crates/mcp/src/link.rs:123-145, :494-497`).
  The hello carries a free-text `owner` that the editor believes (`crates/app/src/agent_link.rs:330-360`).
  There is **no token**, although `docs/ui-spec.md:273-276` specifies "the account that issued the
  MCP token". Per-agent `write_allowed` / `DeletePolicy` already exist
  (`agent_link/control.rs:46-53, :205-219`).
- **Publishing** writes a static site to `<project>/publish/` (`crates/app/src/publish.rs`). The
  owner decided the host is Cloudflare Workers + R2 behind his domain
  (`licnep/docs/research/premium-phase3-decisions.md:17`). F15/F16 (workspace Home) wait "until
  sync has accounts" (`licnep/docs/premium-build/files.md:14-16`).

### 1.4 Gaps this RFC closes (numbered; referenced below)

| # | Gap | Where it bites |
|---|---|---|
| G1 | There is no issuer, account service or sign-in. | Everything shared. |
| G2 | **One `role` per grant**, and a registry that holds **one grant per device**. A person who owns file A and views file B cannot be described. | Share roles per file. |
| G3 | `grant.partitions` is exact-match only, so workspace membership means listing every file in the grant. | Grant size; reissue churn. |
| G4 | Rooms are membership-blind. A viewer, a removed member or a stranger holding the URL can join, read the whole log and append. Honest receivers quarantine bad writes, but the relay stores and fans them out. | Read access control; link access; spam. |
| G5 | The Rust device has no validator, no grant persistence, no `_revocations` / `_policy` reading and no renewal. | licnep cannot enforce anything. |
| G6 | There are no primitives for invites or link access. | G1/G2 boards. |
| G7 | Device keys sit in plaintext files, and **one machine key signs every project log**. The Rust engine takes its next sequence from its **local** log (`engine.rs:238-241`) and skips its own events on receive (`engine.rs:268-270`). Delete a project's `.licnep-sync.sqlite` and rejoin, and the device reuses `(author, seq)` pairs the room already holds, so new writes are dropped as duplicates. That is the silent failure `client/src/identity.ts` warns about. | Must be fixed before keys move to the keychain (§5.2). |
| G8 | The validator judges grant expiry by the **receiver's** clock (`grantFor` → `live(now)`). A backlog written offline and delivered after the author's grant lapsed quarantines as `NoGrant` until a renewal arrives. That is refusal without loss, but the UI has to explain it. | Offline UX. |
| G9 | There is no issuer key rotation: `verifyGrant` takes one issuer key and the grant names none. | Operating the service. |

---

## 2 · Principals, credentials and what each one proves

The design has **two credentials and never confuses them**. `packages/client/src/auth.ts` already
draws the same line ("`auth` says who the *user* is; a grant says whose *events* peers admit").

| Credential | Issued by | Proves | Checked | Offline? |
|---|---|---|---|---|
| **Better Auth session token** | Better Auth (`session` table, D1) | "this request comes from signed-in user U" | by the Worker on every HTTP call | **No.** It is an opaque database reference, meaningless without the server. |
| **syncmesh grant** `[core, sig]` | the syncmesh issuer key, via the plugin (§3.4) | "device K acts for account A with role R in these scopes until T" | by every peer and every room, against the issuer public key | **Yes.** That is its whole purpose (D08). |

**Principals:**

| Principal | Key or identifier | Held where | Signs | Trusted by |
|---|---|---|---|---|
| **Device** (one install × one account) | Ed25519 device key | macOS keychain (§5.2) | events, joins, hellos, API proof-of-possession (§3.5) | everyone, via the grant that names it |
| **Account** | Better Auth `user.id`, written as `acct_<user.id>` in grants | D1 `user` table | nothing | only through grants |
| **Workspace** | Better Auth organization `organization.id` → partition `ws:w_<id>` | D1 `organization` / `member` | nothing | only through grant scopes |
| **Issuer** | Ed25519 issuer key set | a Signer Worker behind a service binding (§3.2) | grants, checkpoint certificates | **shipped config**: compiled into licnep, and `issuers` in room config |
| **Authority** | Ed25519 authority key | the Authority Durable Object | `_revocations`, `_policy`, projection rows (§4.8) | shipped config `authority: PeerId` (D08 addendum) |
| **Room** | Ed25519 room key (D36) | each room DO's storage | hellos | pinned by clients (`relay_key`) |
| **Agent** (headless MCP) | its own Ed25519 device key | keychain, scoped to `licnep-mcp` | events, API proof-of-possession | through an **agent grant** (§4.9) |

**Why account links (D21) are not used.** D21's `AccountCore` links are read only when
`grantFor === null`; in a granted mesh they are *never read* (`author.ts:26-41`). Every shared
licnep file is a granted mesh, so the issuer already makes `owner()` cross-device by minting each
of a person's grants with the same `account`. The **Better Auth user id is that account**, and the
**device↔account binding is the grant itself**. An account keypair would add custody and recovery
problems and buy nothing. D21 stays available for issuer-less meshes. The `acct_` prefix keeps
Better Auth ids out of the 64-hex namespace D21 reserves for account public keys (D21 "Watch
out").

**Why one device key per (install, account).** Grants are newest-wins **per device**, and
attribution reads the grant keyed by device (`client/src/accounts.ts:118-136`). If Jace signs out
and Mara signs in on the same Mac with the same key, Mara's grant supersedes Jace's, and every
event that key ever authored is attributed to Mara. Signing in as a different account therefore
**mints a new device key**. The old key is revoked server-side and kept locally only while its
unsynced writes drain (§5.4).

---

## 3 · Accounts, on Better Auth

### 3.1 When an account is needed at all

**Only to share.** Local files never need an account, and never contact a server. licnep asks you
to sign in only when you:

| Action | Where | Why it needs an account |
|---|---|---|
| Invite someone (by email) | Share → Invite (G1/G2) | someone else must be granted into the file's room |
| Turn on link access / copy a share link | Share → link row (G1/G2) | a room and a link secret must exist on the server |
| Open a licnep link someone sent you | `https://<d>/f/…` → app | the server must grant this device into that room |
| Publish **to others** (hosted site) | Publish (G3) | uploads to R2 under your site; "Publish to folder" stays local |
| Create or join a workspace; see "Shared with me" | Home workspace switcher (F15/F16) | workspaces are Better Auth organizations |
| Connect a **remote** agent | Settings → Agents & MCP | its grant is minted by the issuer (local agents on the live link need nothing, §4.9) |

The first time you share a local project, the app does three things:

1. It creates the file on the server (`POST /api/licnep/files`, which returns a partition id).
2. It mints this device's grant for that file.
3. It opens the project's mesh against the new room, then pushes the project's current state as
   the first events.

Until then the project has no mesh, no room and no grant. Its Loro history
(`history/<id>.loro`) is the only log.

### 3.2 The service

| Component | Cloudflare primitive | Holds |
|---|---|---|
| **`auth` Worker running Better Auth** | Workers. Better Auth 1.5+ takes the D1 binding directly (`database: env.DB`, "auto-detected"). D1 has no interactive transactions, so Better Auth uses `batch()` for atomicity. [blog/1-5], [adapters/sqlite] | Better Auth's core tables (`user`, `session`, `account`, `verification` [concepts/database]), plugin tables, and licnep's tables (below) in **the same D1** |
| `licnep` API routes | the same Worker (Hono or plain `fetch` routing), beside `auth.handler(request)` | files, file shares, link access, publish |
| **`Signer` Worker**, reachable only by **service binding** | Worker + secret | the syncmesh issuer private key(s). One RPC: `sign(core) → sig`, which re-decodes the CBOR `GrantCore` / `CheckpointCertificate` and range-checks it before signing. The internet cannot reach anything that holds the key. |
| `Authority` DO | one Durable Object, SQLite-backed (`adapters/cloudflare-do`) | the authority key and its own log. It writes `_revocations`, `_policy` and projection rows into rooms by RPC (§4.8). **One object = one key = one sequence**, avoiding the corruption `client/src/identity.ts` describes. |
| Room DOs | existing relay host (`adapters/cloudflare-do/src/host.ts`) | one per partition; gains grant verification (§4.6) |
| Queue | Cloudflare Queues | "kick device" and "grant changed" fan-out to room DOs, with retries |
| KV | Workers KV | Better Auth `secondaryStorage` for rate-limit counters [concepts/rate-limit]. **Not** for single-use tokens, which stay in D1 (atomic updates). |

This replaces rev 1's hand-written account service. It also departs from
`licnep/docs/research/sync-engines.md` §4 ("plain Postgres behind our own HTTP API").

**Better Auth configuration (sketch; option names from the cited docs):**

```ts
betterAuth({
  database: env.DB,                                    // D1, native dialect  [blog/1-5]
  secondaryStorage: createKvStorage(env.KV),                 // rate limits  [concepts/rate-limit]
  session: { expiresIn: 60 * DAY, updateAge: DAY },    // O7: default is 7 d / 1 d  [concepts/session-management]
  advanced: { database: { generateId: createPrefixedUlid } }, // [concepts/database]
  socialProviders: { google: {...}, github: {...} },   // [authentication/google], [authentication/github]
  plugins: [
    magicLink({ sendMagicLink, storeToken: "hashed" }),                    // [plugins/magic-link]
    emailOTP({ sendVerificationOTP, storeOTP: "hashed", allowedAttempts: 3 }), // [plugins/email-otp]
    passkey({ rpID: "<accounts domain>", rpName: "licnep", origin }),      // @better-auth/passkey [plugins/passkey]
    organization({ ac, roles: { owner, editor, commenter, viewer },
                   invitationExpiresIn: 14 * DAY,
                   requireEmailVerificationOnInvitation: true,
                   sendInvitationEmail, organizationHooks }),              // [plugins/organization]
    deviceAuthorization({ expiresIn: "10m", interval: "5s",
                          validateClient: (id) => id === "licnep-desktop" || id === "licnep-mcp" }), // [plugins/device-authorization]
    bearer(),                                                              // [plugins/bearer]
    createGrantIssuer({ signer: env.SIGNER, authority: env.AUTHORITY, ... }), // §3.4, this RFC
  ],
});
```

Email goes through Cloudflare Email Service (the Workers `send_email` binding) from
`sendMagicLink`, `sendVerificationOTP` and `sendInvitationEmail`.

**licnep's own tables** (same D1, beside Better Auth's):

```sql
syncmesh_device(peer_id PK, user_id, session_id UNIQUE, name, platform,
                created_at, last_seen_at, revoked_at, revoke_reason,                      -- plugin schema (generic)
                kind, parent_device)                                                      -- licnep's additionalFields
files(id PK /* f_… */, organization_id NULL /* NULL = personal */, name, created_by,
      trashed_at, link_access /* restricted|workspace|anyone */, link_role, link_secret_hash)
file_members(file_id, user_id, role, source /* invite|link */, PK(file_id, user_id))
file_invites(id PK, file_id, email_norm, role, inviter, token_hash, expires_at, accepted_at, revoked_at)
grants_issued(id PK, device, issued_at, expires_at, scopes_json, digest)                     -- audit
request_nonces(device, nonce, at, PK(device, nonce))                                        -- replay window
```

**What is generic and what is licnep's.** The plugin defines only the generic columns. Apps
extend the table the way Better Auth's own plugins allow (the organization plugin's `schema`
option [plugins/organization]):
- `modelName` renames the table;
- `fields` maps column names;
- `additionalFields` adds columns. With `input: true`, a field is accepted on the enrol request and
  stored on the row.

The plugin's types infer the extra fields, and a client helper, `inferDeviceFields<typeof auth>()` (like Better Auth's `inferOrgAdditionalFields`),
gives the client the same types. licnep's configuration:

```ts
createGrantIssuer({
  context: "licnep",
  schema: {
    syncmeshDevice: {
      additionalFields: {
        kind: { type: "string", input: true, required: false, defaultValue: "app" },   // app | agent | web
        parentDevice: { type: "string", input: true, required: false,
                        references: { model: "syncmeshDevice", field: "peerId", onDelete: "cascade" } },
      },
    },
  },
  resolveScopes: resolveLicnepScopes,   // (user, device row incl. kind/parentDevice, ctx) → Result<Scope[]>; caps agents
  ...
})
```

`onDelete: "cascade"` removes an agent's row with its parent. Revocation (`revoked_at`) is
propagated by licnep's `resolveScopes`/revoke hook, because revoking is an update, not a delete.

### 3.3 Sign-in methods (all Better Auth)

| Method | Better Auth piece | Notes |
|---|---|---|
| Email magic link | `magicLink` plugin: `POST /sign-in/magic-link`, `GET /magic-link/verify`, default `expiresIn` 5 min, `storeToken: "hashed"` [plugins/magic-link] | for the same machine |
| Email code | `emailOTP` plugin: `POST /email-otp/send-verification-otp`, `POST /sign-in/email-otp`, 6 digits, 300 s, `allowedAttempts` 3 [plugins/email-otp] | for when the email opens on a phone; sent in the same email as the link |
| Google, GitHub | `socialProviders` [authentication/google], [authentication/github] | provider tokens stay on the server |
| Passkeys | `@better-auth/passkey` (SimpleWebAuthn), `POST /passkey/add-passkey`, `POST /sign-in/passkey`, conditional UI via `autoFill` [plugins/passkey] | the ceremony runs **in the browser** on the accounts domain, so the native app needs no Associated Domains entitlement |

All of them happen on one web page, `https://accounts.<d>/signin`. The native app never renders a
login form.

### 3.4 The native app: device authorization, then device-key enrolment

**Step 1. Get a Better Auth session: RFC 8628 device flow**, via Better Auth's
`deviceAuthorization` plugin [plugins/device-authorization].

```
app   → POST /api/auth/device/code {client_id: "licnep-desktop"}
      ← {device_code, user_code, verification_uri, verification_uri_complete, interval}
app   : opens verification_uri_complete in the default browser and shows the user_code
        in the sign-in sheet ("Confirm this code in your browser: KDFJ-QWPX")
user  : signs in by any §3.3 method; the page shows the code, "licnep on Jace's MacBook Pro",
        and Approve / Deny  (GET /device, POST /device/approve | /device/deny)
app   → POST /api/auth/device/token {device_code, client_id}  every `interval`
      ← {access_token: <Better Auth session token>, …}
```

The plugin returns "a Better Auth session token" in `access_token`
[plugins/device-authorization]. From here on the app sends it as `Authorization: Bearer`, via the
`bearer` plugin [plugins/bearer].

**Why the device flow** rather than a loopback redirect:

- The app needs no local HTTP listener and no custom URL scheme.
- The user code is a built-in "does this match?" check between the two screens.
- The same flow serves `licnep-mcp` (no GUI) and a future CLI.

The OAuth 2.1 provider plugin (`@better-auth/oauth-provider`: authorization code + S256 PKCE,
loopback redirects `http://127.0.0.1` with any port) is the alternative [plugins/oauth-provider].
It is kept for remote agents (§4.9) and is **O2**.

**Step 2. Bind the device key to that session.** This is the syncmesh plugin's first endpoint:

```
app → POST /api/auth/syncmesh/enrol  {device: K, name, platform, …app fields}   (licnep adds kind, parent)
      Authorization: Bearer <session>   +  device proof-of-possession by K (§3.5)
```

The plugin, built with `createAuthEndpoint` + `sessionMiddleware` [concepts/plugins]:

- checks the proof by K;
- refuses if this session already has a device, or if K is enrolled to a different user;
- inserts `syncmesh_device {peer_id: K, user_id, session_id}`;
- mints K's first grant (step 3).

**One device per session and one session per device.** A stolen bearer token alone therefore
cannot enrol an attacker's key (the session already has one) and cannot fetch grants (every grant
request must be signed by K).

**Step 3. Mint grants from Better Auth identity and organizations.**

```
app → POST /api/auth/syncmesh/grant  {}   Bearer + proof by K
    ← {grant: <[core, sig] hex>, profile, server_time, issuer_keys}
```

The plugin computes the scopes from D1, reading Better Auth's tables through its adapter:

| Source (D1) | Scope in the grant (§4.3) |
|---|---|
| Better Auth `member` rows (organization plugin) with role `r` in org `o` | `ws:w_<o>` exact, role `r`; and `project:w_<o>.` **prefix**, role `r` (every file in the workspace) |
| `file_members` rows | `project:<file partition>` exact, with that role (overrides the workspace role; the most specific scope wins) |
| the user's own id | `user:acct_<user.id>` exact, `owner` |

It then builds the `GrantCore`:

- `account = "acct_" + user.id`;
- `device = K`;
- `role` = the least role present (the one-way rollout rule, §4.3);
- claims `{n: user.name, c: colour}`, with **no email** (§4.10);
- 24-hour validity.

It asks the Signer to sign, writes `grants_issued`, and returns the wire.

### 3.5 Requests: bearer session **and** device proof-of-possession

Every call to `/api/auth/syncmesh/*` and `/api/licnep/*` carries the Better Auth bearer token and:

```
Syncmesh-Device:    <peer id K>
Syncmesh-Timestamp: <ms since epoch>
Syncmesh-Nonce:     <16 random bytes, hex>
Syncmesh-Signature: Ed25519(K, "<app context>/api/v1\n" ‖ method ‖ "\n" ‖ path ‖ "\n"
                             ‖ sha256(body) ‖ "\n" ‖ timestamp ‖ "\n" ‖ nonce)
```

A request is accepted only when **both** of these hold:

- Better Auth resolves the session;
- K is that session's enrolled device, not revoked, the timestamp is within ±5 min (the D34 bound)
  and the nonce is fresh.

The app sets `<app context>` in the plugin's options; licnep uses `"licnep"`. The context string separates this signature from events, joins and hellos (the same construction
as D33's `proof.ts`). Better Auth's own endpoints (`/device/*`, `/sign-in/*`) need only what
Better Auth asks for.

### 3.6 Multi-device, sign-out, recovery, revocation

- **Second device:** it signs in independently (§3.4) and gets its own key, session, enrolment and
  grant. **Devices list** (Settings → Account): Better Auth `listSessions` joined with
  `syncmesh_device` [concepts/session-management].
- **Sign out this Mac:** `revokeSession`. A **`databaseHooks.session.delete.after`** hook
  [concepts/database] marks the enrolled device revoked and starts the revocation fan-out below.
  "Sign out everywhere" is `revokeSessions`. Local files stay; the local session token and the
  device key are deleted after unsynced writes drain or the user confirms losing them. The D28
  `soleCustody()` warning ("3 changes exist only on this Mac") applies here, and the Rust port
  needs it.
- **Recovery** is Better Auth's: sign in again by email, a provider or a passkey. There is no key
  escrow, because accounts have no keys; device keys are disposable.
- **Revoking a device** (from another device, or "Lost device"):
  1. `syncmesh_device.revoked_at` and `revoke_reason`, plus `revokeSession` on its session.
  2. The Queue sends a kick to every room DO whose partition its last grant covered. The DO
     closes its sockets and adds it to the **deny list** (§4.6).
  3. The Authority writes `_revocations` rows in those partitions (`author.ts:103-141`).
  4. The issuer never renews it.
- **Session expiry without revocation** (60 days idle, O7) does **not** revoke the device key. On
  the next online moment the app runs §3.4 again and **re-enrols the same K** under the new
  session (allowed because K is enrolled to the same user). The grant history and the log stay
  continuous.
- **Account deletion:** Better Auth `user.delete` hooks revoke every device, remove memberships,
  and transfer or trash files (F16's "Mara and Theo lose access too" confirmation).

---

## 4 · Grants issued by the server

### 4.1 Scopes = partitions

| Kind | Id | Room | Holds |
|---|---|---|---|
| `project` | `w_<org>.f_<file>`, or `u_<user>.f_<file>` for a personal (non-workspace) shared file | one room DO | the file: today's `project.metadata` and `doc_updates` rows (`licnep/crates/sync/src/model.rs:3-22`), comments, versions |
| `ws` | `w_<org>` | one room DO | workspace rows: the file list, member cards and libraries, as **authority projections** (§4.8) |
| `user` | `acct_<id>` (reserved kind, `validate.ts:215` admits only `user:${author.account}`) | one room DO | the person's own synced rows: "Shared with me", drafts list, grant-changed pings |

Putting the workspace id inside the file's partition id is what makes a **prefix scope** (§4.3)
possible. A file moved between workspaces keeps its partition, and its members fall back to exact
scopes.

### 4.2 Roles

- **One ordered ladder per kind**: `owner > editor > commenter > viewer`, declared with
  `ladder(...)` (`policy/src/evaluate.ts:101-105`). The **same four names** are the organization
  plugin's custom roles, made with `createAccessControl` [plugins/organization]. They replace
  Better Auth's default `owner/admin/member`, so a workspace role maps to a grant role 1:1 with no
  translation table. Workspace-management permissions (invite, remove, rename, delete) are the
  access-control statement's; only `owner` holds them.
- Mesh policy per table (licnep's manifest):
  - `project.*`: write ≥ `editor`;
  - `comments` / `comment_messages`: write ≥ `commenter`, plus `patchOnly(["resolved"])` on other
    people's threads;
  - `versions`: ≥ `editor`;
  - nothing is writable by `viewer`.
- `owner`'s extra powers are all **server-side**: sharing, link settings, transfer, trash and
  publish. They are online by nature, checked by the Worker, never in the mesh.

### 4.3 Wire change W1: scoped roles (grant core key 9) — fixes G2 and G3

```
key 9  scopes: [[kind: text, id: text, match: 0 = exact | 1 = prefix, role: text], …]
```

- **Admission.** An event in partition `k:i` is admitted if a scope matches. Exact means
  `kind = k ∧ id = i`. Prefix means `kind = k ∧ i` starts with `id`, and `id` must end in `.`
  (so `w_1.` cannot match `w_10.f_x`).
- **Role.** That scope's role, taking the **most specific** match (exact beats prefix, longer
  prefix beats shorter). Policy evaluation reads `roleFor(partition)` instead of `grant.role`.
- **Why a new key, not `partitions`.** `PARTITION_KEY` already allows `*` and `.` in ids
  (`kernel/src/partition.ts:13`), so a pattern in `partitions` would be ambiguous with a literal id.
- **One-way rollout (the D21 shape).** The issuer keeps `role` (key 3) at the **least** role in
  the grant and lists in `partitions` only exact partitions. An old peer that ignores key 9
  therefore *refuses more, never admits more*.
- **Size.** Scopes are O(workspaces + individually shared files), not O(files).
- **Vectors.** Exact, prefix, the specificity tie-break, and a key-9 grant read by a build that
  does not know key 9.

**Alternatives rejected:**

- *Claims-based roles.* These change the synced policy AST (`_policy` rows old peers cannot
  parse), and admission stays exact-match.
- *Many grants per device.* This breaks newest-wins downgrade protection and the room's
  grant-cache semantics.

### 4.4 Invites: two kinds, one experience

| Invite to | Mechanism | Email must match? |
|---|---|---|
| a **workspace** | Better Auth organization invitations: `sendInvitationEmail`, `acceptInvitation` [plugins/organization] | yes: `acceptInvitation` requires the session email, and a *verified* one with `requireEmailVerificationOnInvitation: true` |
| a **file** (guest, not a workspace member) | the plugin's `file_invites` (same email template, 256-bit token stored hashed, 14 days) | yes, the same rule, enforced by the plugin |

1. The Share dialog (G1) sends `POST /api/licnep/files/:id/invites {emails, role}`. For a file in a
   workspace, the dialog offers "Add to workspace" as a choice.
2. The server checks the inviter's role (≥ `owner` for the file, or `owner` in the organization's
   access control) and caps the invited role at the inviter's own.
3. **Known, verified email:** membership is created at once (`file_members` or a Better Auth
   `member` row) and a grant-changed ping goes to the invitee (§4.7). The email is a
   notification.
4. **Unknown email:** a pending invitation. The link opens the web sign-in (§3.3), and the account
   is created by whichever method the invitee picks.

   **Accepting** happens in whichever licnep the link opens:
   - the web viewer, if they have no app;
   - the app via a `licnep://` handoff, if they do. The app runs §3.4 when it has no session yet.
5. Pending invites show in G2 as "Invite sent · waiting to join", with Resend and Revoke.

Organization hooks (`afterAddMember`, `afterRemoveMember`, `afterUpdateMemberRole`
[plugins/organization]) and the plugin's own file-share handlers call **one** function,
`pushGrantChange(userIds)`, which runs §4.7.

### 4.5 Link access

`files.link_access ∈ {restricted, workspace, anyone}` × `link_role ∈ {viewer, commenter, editor}`.
This is G2's menu: "Only people invited / Anyone at <org> / Anyone with the link", with a role cap.

- The link is `https://<d>/f/<file>#<secret>`. The secret sits in the **fragment**, out of server
  logs and `Referer`. The page posts it to `POST /api/licnep/links/open`. "Reset link" rotates
  `link_secret_hash`.
- **Signed-in opener:** a `file_members` row with `source = link`, so the file appears in their
  Recents. The role follows the link setting, and tightening the link tightens every link-derived
  member (via `pushGrantChange`).
- **`workspace`** requires a Better Auth `member` row in the file's organization.
- **`anyone` + an anonymous browser:** a **web device** (§6.3) with a 1-hour `viewer` grant.
  Editing by link always requires sign-in (O11).
- **Agents never join through a link** (G1's "Agents join only by invite").

### 4.6 Grant-gated rooms: verification on join and per write (wire change W2) — fixes G4

The room gains **public** trust config. It still holds no private key:

```ts
RelayRoomOptions.trust?: { issuers: PeerId[]; partitions: PartitionKey[]; relayGraceMs: number }
```

**On join.** After the D36 hello proves key K, the room requires a grant for K that:

- verifies against `issuers` (the full `verifyGrant`, not `readGrantOrigin`);
- has a scope covering the room's partition;
- has not expired by more than `relayGraceMs` (§5.5);
- has an `issuedAt` later than any deny-list entry for K.

The first catch-up page is held until such a grant arrives (flow C already sends it straight after
the join), or for 5 s. Failing that, the room refuses the join as **`ungranted`**: a typed
refusal, **not fatal** (the client renews and retries), and counted.

**Per event.** Before append and fan-out, the room checks the **author's** grant, not the socket's
(clients forward others' events):

- *R1* a qualifying grant for `event.peerId`;
- *R2* the partition is in scope;
- *R3* the scope's role ≥ the kind's minimum writer (`commenter` for `project`);
- *R4* no deny cut applies (§5.4).

A failure is not appended, and the author gets a **quarantine report** (D32, still *draft*; this
RFC asks to decide it). Row-level rules (`owner()`, `patchOnly`, per-table roles) stay with
receivers.

**Deny list.** Per room, `device → {at, cut}` in DO storage. It is filled by the Authority's kick
RPC and by `_revocations` rows passing through the room. It is lifted only by a grant whose
`issuedAt` is later, the same readmission rule as `author.ts`.

**HTTP gate.** `verifyJoin` only rate-limits, because the grant is the ticket. The Rust driver
gains `connect_async(request)` with headers (`driver.rs:168`), so a ticket can be added later.

**Better Auth is not in this path.** Rooms never call Better Auth. A room judges signed syncmesh
bytes only, so a room keeps working during an auth outage (§5.5).

**W2 scope:**

- the `ungranted` / `denied` refusal codes and the D32 report frame, with frozen vectors in
  `relay_frames`;
- `packages/relay` (the Durable Object host and the Bun host);
- `crates/syncmesh-client/src/room.rs`, so `licnep relay` and the Rust tests enforce the same way.

### 4.7 Expiry, renewal and push

| Grant | Validity | Renewal |
|---|---|---|
| App device | 24 h | `POST /syncmesh/grant` at 50 % of life when online, and on every app start online |
| Agent device | 8 h, never past the parent device's grant | by the parent app, only while it is signed in |
| Web viewer (anonymous) | 1 h | by the page while open |

- **`pushGrantChange(userIds)`**, called by the organization hooks and the file-share handlers
  (§4.4), puts a `grant-changed` row into each affected user's `user:` room through the
  Authority. Online apps renew at once. Offline apps get the row, and the new grant, next time.
- **Push is an optimisation.** Correctness comes from short validity plus the room deny list.
- **Removing someone** is three steps:
  1. a newer grant without the scope (newest-wins, `grant-registry.ts:45-58`);
  2. a room kick for that user's devices in that partition;
  3. `_revocations` rows for them.

### 4.8 The Authority and projections

Some rows every device needs offline come from D1, not from any device: the workspace file list,
member cards (name, avatar, role), "Shared with me", and trash state. The Authority DO writes
them as **projection rows**, ordinary signed events from `authority`, into `ws:` and `user:` rooms
via RPC.

- Home (F15/F16) is a **local query**, so it works offline and shows the last-known state.
- Mutations are HTTP calls, and their results come back as projections.
- The Authority's grant is `owner` on the prefixes it serves. It is exempt from grace
  (`author.ts:51-56`), not from revocation.

### 4.9 Agents (MCP)

1. **Local agent on the live link (editor open).** This needs **no account and no grant**, even on
   a shared file: the editor's device key signs the agent's writes. Changes:
   - the hello's `owner` is **ignored** (`agent_link.rs:330-360` believes it today). The owner is
     the signed-in account, or the local profile name when signed out;
   - on a shared file, `write_allowed` is capped by the account's role (G1: "Can view means
     read-only").

   First connection shows G13's approval ("It acts as you, Jace, with your access to Checkout
   flow"). It is remembered per client in the keychain and revocable in Settings → Agents & MCP
   (F11).
2. **Headless `licnep-mcp` on a shared file** (editor closed). `licnep-mcp` runs the device flow
   (§3.4) with `client_id: "licnep-mcp"`, and the user approves it in the browser. It enrols its
   own key, sending `kind: "agent"` and `parentDevice` (the approving user's app device, if one
   is enrolled). These are licnep's `additionalFields` on the plugin's table (§3.2). licnep's
   `resolveScopes` reads them and caps the grant, so the plugin itself knows nothing about agents.
   The agent grant has:
   - `account` = the owner's;
   - `claims.agent = {client}`;
   - scopes limited to the files the user ticked on the approval page;
   - role ≤ min(owner's role, `editor`);
   - 8-hour validity.
3. **Remote agents** (cloud MCP clients) use the **OAuth 2.1 provider plugin**: authorization
   code + PKCE, MCP support, `consentPage` [plugins/oauth-provider]. They then receive the same
   agent grant. This is P9.

**Agents are never `owner`.** The Worker refuses sharing, link, transfer, trash and publish calls
from devices whose `kind` (licnep's additional field) is `agent`. Revoking the parent device revokes its agents,
through licnep's revocation hook, which calls the plugin's revoke for each child device.

### 4.10 What peers learn from grants (privacy)

Grants are forwarded to everyone in a room (`grant-cache.ts`), **including anonymous link
viewers**. So:

- **Grants carry no email**, only `n` (name) and `c` (colour). Emails reach co-members only through
  the Share dialog's HTTP call, which requires ≥ `viewer`.
- **Scopes reveal the ids of a person's other workspaces and files.** Ids are opaque and grant
  nothing. This is accepted for v1 (O12); room-scoped grant views are the later fix.

### 4.11 Why the Better Auth JWT plugin is **not** the grant issuer

Better Auth's JWT plugin signs EdDSA/Ed25519 JWTs by default, serves a JWKS (`/jwks`, configurable
via `jwksPath`), rotates keys (`rotationInterval`, `gracePeriod`) and keeps them AES-256-GCM
encrypted in a `jwks` table [plugins/jwt]. It is tempting to reuse. It is kept separate because:

- **Format and verifier.** Every syncmesh peer, including the Rust device and the rooms, verifies
  CBOR `[core, sig]` against a raw Ed25519 key (D03, `grant.ts`). A JWT would be a second grant
  format on the wire, and D08 option B (JWT + JWKS) was rejected because a JWT does not bind the
  device key.
- **Key isolation.** The JWT plugin's private keys live in D1, encrypted by the app secret. The
  issuer key should live only in the Signer.
- **Domain separation.** One Ed25519 key signing both JWTs and CBOR cores invites cross-protocol
  confusion.

The JWT plugin (15-minute default expiry) **is** useful where a Cloudflare service needs a
stateless "who is this user" check without a D1 round trip: the publish Worker serving a
workspace-only site, and the room HTTP gate if a ticket is ever added. That use is optional (O15).

---

## 5 · Offline

### 5.1 What is verified offline, and what is not

| Offline, the app… | Based on | Verified how |
|---|---|---|
| opens and edits **local files** | nothing; there is no account involved | — |
| shows "Signed in as Jace · Offline" | keychain: Better Auth session token + cached profile | **not verified.** It is a local label. The session is only checked when online. |
| knows its role in a shared file (edit / comment / view) | its own cached grant | Ed25519 signature against the **issuer key set shipped in the app**; scope and role read from the verified core |
| accepts or refuses **other people's** changes it already holds or receives over any path | their cached grants + `_revocations` / `_policy` rows | the full validator ladder (Rust slice, §7 P1), exactly as online |
| shows Home, members and "Shared with me" | projection rows (§4.8) | ordinary signed events from `authority` |

**Nothing in the Better Auth session is trusted offline**, and nothing offline depends on it. That
is why a session expiring while a laptop is in a drawer changes nothing until it comes back
online.

### 5.2 Key storage (fixes G7)

- Keychain items:
  - **device seed**: service `app.licnep.device`, account `acct_<id>`,
    `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, **not synchronizable**. A key roaming to
    another Mac is two devices as one author;
  - **Better Auth session token**: service `app.licnep.session`, same attributes.
- Signed-out users have **no keychain items at all**. Local files need no key.
- The login-keychain ACL follows the app's code signature. Unsigned dev builds use files (mode
  0600) behind `LICNEP_DEV_KEYS=file`.
- **Precondition (G7).** One device key signs many per-project logs. Before the key outlives a
  log, the Rust engine must:
  - store its own events received from the room (`engine.rs:268-270` skips them);
  - take `next seq = max(local last, highest own seq the room reported)`;
  - **refuse to write** in a partition until the first catch-up of a fresh log (known by the D28
    incarnation) completes.

### 5.3 The offline edit window

- **Local files:** no window, no limit, ever.
- **Shared files, inside the window** (default **30 days** since the last successful
  `/syncmesh/grant`; O8): the device keeps writing **even after its own grant expired**, as long as
  its **latest grant's role** for that partition allows the write. The own-write rung checks role
  and scope and **ignores expiry**. A viewer stays read-only offline.
- **Past the window:** shared files open read-only with "Sign in to keep editing".
- **The window is UX, not security.** Rolling the clock back stretches it and gains nothing,
  because rooms and receivers judge every write on arrival.

### 5.4 Reconnecting, and revocation while offline

**The order on reconnect is the contract:**

1. `POST /syncmesh/grant`. If the Better Auth session is gone (expired or revoked), run §3.4
   (device flow, then re-enrol the same K) and continue.
2. Join rooms. The grant goes first, and the room checks it (§4.6).
3. Push the backlog.

| Case | Room verdict | Receivers | UI |
|---|---|---|---|
| Grant only lapsed while offline | renewed grant qualifies; all admitted | `grantFor` returns the renewed grant; quarantined copies retry (G8) | "Syncing 214 changes" |
| Better Auth session expired (idle > 60 d) | nothing sent until step 1 re-signs-in | — | "Sign in to sync your changes" (local editing continues within the window) |
| **Removed from the file** while offline | **stamp rule**: events stamped before the revocation are admitted, later ones refused | same (`checkRevoked`, `author.ts:124-141`) | "You no longer have access to Checkout flow. 12 changes made after 14:02 were not shared." **Save as a copy** (a new local file) · **Discard** |
| **Device reported lost** | **cursor rule**: the deny cut is the room's coverage of that author at the kick; later sequence numbers are refused whatever their stamp | never see them | the thief's copy: "This Mac was signed out"; synced projects wiped on next run (O10) |
| Role lowered to viewer while offline | events after the newer grant's `issuedAt` fail R3 | same, policy rung | as for removal |

**Why two cut rules.** The stamp rule keeps honest offline work, but a stamp is the author's word
and a stolen device can backdate it (D34 bounds only future drift). The room knows how far it held
the author's run at the kick, so it can cut there. That rule applies only when someone presses
"Lost device" (O9).

**Surfacing rejections.** The room's D32 reports and local quarantine (`NoGrant`, `GrantRevoked`,
`GrantStale`, `PartitionNotGranted`, policy) feed one **Sync issues** list per file. Each entry
has a count, the reason in words, and Retry after sign-in / Save as a copy / Discard. The sync pill
turns amber, and nothing is dropped silently.

### 5.5 Outages

- **Better Auth Worker or D1 down, rooms up.** Nobody can sign in or renew. Rooms accept grants up
  to `relayGraceMs` = **7 days** past expiry (O7). The deny list does not depend on expiry.
  Editing continues everywhere.
- **Rooms down.** Devices edit within the window and converge on return.
- **Everything down.** Same. Local files are untouched either way.

### 5.6 Clocks (D34)

- **Stamps:** the 5-minute future bound is unchanged.
- **Own grant expiry and the offline window:** judged on `local + offset`, where
  `offset = server_time − local` from every `/syncmesh/grant` response. Used only for the device's
  own UX decisions, never for HLC stamps or for judging peers.
- **Rooms** use Cloudflare's clock. A device hours fast gets D34-parked events and a banner: "Your
  Mac's clock is 3 h ahead; changes will sync when it is corrected."
- **Not-before:** `verifyGrant` checks only expiry. That is harmless and left as is.

---

## 6 · licnep integration

### 6.1 `crates/sync` (GPUI-free, per licnep's rule 3)

| Change | Detail |
|---|---|
| Sync only for shared projects | A project gets a mesh **only once it is shared** (§3.1). `project.sync_id` stays the partition id's source. Local projects open no room and hold no grant. |
| `SyncConfig` | Replace `identity_seed` and `relay_key` with `Session { account, device: Identity, issuer_keys, grant_wire }`. Add the issuer key **set** (W3) to `MeshOptions` instead of `issuer: None` (`device.rs:658`). |
| Grants | Register the own grant plus the cached ones at open, and keep a `GrantStore`. `MeshEvent::GrantRequest` stays ignored: grants come over HTTP. |
| Validator | The Rust validator slice (§7 P1); verdicts become `SyncEvent::Rejected { partition, reason, count }`. |
| Rooms | Per shared project, as today. Plus, when signed in, `user:acct_<id>` (Home, Shared with me, grant-changed) and one per open workspace `ws:w_<id>`. Room URL = `wss://sync.<d>/r/<partition>`; the room name **is** the partition. |
| Account client | New `account.rs`, GPUI-free: the device flow (§3.4), enrolment, grant renewal, and the §3.5 signed requests (bearer + proof-of-possession) for files, invites, link, devices, agents and publish. A blocking HTTP client on the device thread. |
| Presence | Rows gain `account`; the name and colour come from the account when signed in, otherwise from Settings → Account (not git `user.name`, `shell.rs:72-83`). |
| Self-host / dev | `licnep relay --issuer <peer>` enforces grants with the same Rust room code. `licnep issuer` mints grants from a local key for tests. The dev `--sync --sync-key` flow stays as an **ungranted** mesh, labelled as such. |

### 6.2 The app: where sign-in appears, and nowhere else

**The sign-in sheet** (one sheet, reused) opens only from the §3.1 triggers. It shows:

- "Sign in to share <file>";
- **Continue in browser** (opens `verification_uri_complete`) with the user code under it;
- "Waiting for your browser…" while it polls.

Its states: waiting, approved, denied, expired (the code timed out), offline ("Connect to the
internet to share; your work stays on this Mac").

| Surface | Board | Signed out | Signed in |
|---|---|---|---|
| Share · Invite (email chips, role menu: Can edit / Can view / Transfer ownership / Remove access; pending invites) | G1, G2 | the dialog shows "Only you can open this file" (G2 empty state) and an **Invite** field; typing an email and pressing Invite opens the sign-in sheet, then completes the invite | full dialog |
| Share · link access (Only people invited / Anyone at <org> / Anyone with the link × role cap; Copy link; Reset) | G1, G2 | **Copy link** on a local file offers "Share with a link…", which opens the sign-in sheet | full |
| Publish (G3) | G3 | "Publish to folder" works; "Publish to the web" opens the sign-in sheet | hosted publish |
| Home workspace switcher, Shared with me, Drafts, Trash, Projects | F15, F16 | Home is today's local Home (F1–F14); the switcher shows "Local files on this Mac" and **Sign in to see shared files** | workspaces from projections |
| Settings → Account (email, photo, **Sign out**, Devices) | F11 | local name and colour only; **Sign in** button | Better Auth profile, Devices = `listSessions` + enrolments |
| Settings → Agents & MCP (connected agents, **Revoke**) | F11 | local agents only | plus headless / remote agent devices |
| Read-only (viewer) and commenter modes | G7 | n/a (local files are always yours) | from the own grant's scopes |
| **Sync issues** list, amber pill, "Save as a copy" | (new; add to Paper) | n/a | §5.4 |
| Clock banner; "Sign in to keep editing"; "Sign in to sync your changes" | (new) | n/a | §5.3–§5.6 |

### 6.3 Web (licnep-web, the wasm viewer)

- **Signed-in browsers** use Better Auth's cookie session on the accounts domain. The page makes a
  WebCrypto Ed25519 key (`extractable: false`, IndexedDB) and enrols it with `kind: "web"`.
- **Anonymous link viewers** get a 1-hour `viewer` grant (§4.5).
- Both need the browser WebSocket relay driver that licnep lists as the next web step.

### 6.4 Publishing's auth

- "Publish to the web" needs sign-in (§3.1). `POST /api/licnep/publish/:file` is a §3.5 request
  from the file's `owner` or `editor` (O11). The Worker returns an upload session; the app PUTs
  the static site (`crates/app/src/publish.rs` output) to R2 at `sites/<site>/<version>/…`, then
  `commit` flips the current version. The Worker serves `<site>.<publish-domain>`.
- **Visibility:**
  - public;
  - **workspace-only**: the reader signs in with Better Auth on the web and must be a `member` of
    the organization. The site Worker checks the Better Auth session, or a JWT-plugin token
    against JWKS (§4.11);
  - password: hash in D1, a cookie per site.
- Site metadata is a projection row in the file's room, so G3's states work offline.
- **Comments on published sites** come from Better Auth web sessions over HTTP. The Worker turns
  them into Authority-written `comments` rows (RFC-0010's "one write path"). Browsers need no
  grant to comment.

---

## 7 · Build plan

Sizes are for one engineer.

| Phase | Repo | What | Size | Depends |
|---|---|---|---|---|
| **P0 Decide + freeze** | syncmesh | Decision files: **W1** scoped roles (key 9: vectors, TS `roleFor` + admission); **W2** grant-gated rooms (`ungranted` / `denied`, D32 decided); **W3** issuer key *set* (`issuers: PeerId[]`: verification tries each; no wire change). | 4–5 d | — |
| **P1 Rust device slice** | syncmesh | `GrantStore` in `sqlite.rs`; validator author rungs, partition admission, **scoped role ≥ minimum writer**; `_revocations` / `_policy`; own-write rung with "ignore expiry"; the G7 sequence fix; `connect_async(request)`; D28 `soleCustody`; while in the registry, rename `grantFor` → `grants.get(device)` (TS) and `grant_for` → `GrantRegistry::get` (Rust), per the naming skill. Interop verdict test vs TS. | 2–2.5 wk | P0 |
| **P2 Grant-gated rooms** | syncmesh | `packages/relay` + DO host + Rust `room.rs`: join and per-event checks, deny list, kick RPC, stamp / cursor cuts, `relayGraceMs`. | 1.5 wk | P0 |
| **P3 `@syncmesh/better-auth`** | syncmesh | A Better Auth server plugin, generic (no licnep nouns): `syncmesh_device` schema; `/syncmesh/enrol`, `/syncmesh/grant`, `/syncmesh/devices`; proof-of-possession verification; the scope builder as an **app-supplied function** (`resolveScopes(user, device, ctx) → Result<Scope[]>`, with a ready-made `resolveOrganizationScopes` mapping organization members to `ws:` + prefix scopes); `pushGrantChange`; the session-delete hook → revocation; a Signer interface; an Authority-DO helper for projections. Tests with Better Auth's in-memory adapter. | 1.5 wk | P0 |
| **P4 licnep auth Worker** | licnep-cloud (new repo; O14) | Better Auth on Workers + D1 + KV: magic link + email OTP, Google, GitHub, passkey, organization (custom roles, invitations), device authorization, bearer, `@syncmesh/better-auth`; licnep routes for files, file invites, link access; the Signer Worker; the Authority DO; Queue; the Email binding. | 1.5–2 wk | P3 |
| **P5 licnep: sign-in on share + offline** | licnep | Keychain; the sign-in sheet and device flow; "share turns on sync" (§3.1); `Session` in `crates/sync`; grant store; offline window; clock offset; Sync issues; viewer mode; `user:` / `ws:` rooms; Home F15/F16. | 2–3 wk | P1, P4 (P2 for room enforcement) |
| **P6 Sharing** | both | File invites + workspace invitations, members, link access, `pushGrantChange`, removal (grant + kick + `_revocations`); Share G1/G2. | 1.5 wk | P2, P5 |
| **P7 Agents** | licnep (+ Worker) | Ignore the hello `owner`; role-capped live agents; approval memory; headless `licnep-mcp` via device flow + agent grants; Settings Revoke. | 1 wk | P5 |
| **P8 Publishing auth** | licnep + Worker | Upload sessions, R2 layout, visibility (workspace-only via Better Auth session / JWT), site projections, web comments. | 1–1.5 wk | P4 (+ the publish feature) |
| **P9 Hardening** | both | Remote agents via `@better-auth/oauth-provider`; issuer rotation with a signed successor statement; audit view; rate-limit tuning; a security review of the Worker and the plugin; fuzzing the new refusals; optional sealed partitions (O5). | 2 wk | P6 |

**Total ≈ 13–16 weeks.** Better Auth removes about a week of hand-written auth (rev 1's P4 was
2 wk plus passkeys in P9). The generic plugin adds that week back to syncmesh (P3), where every
syncmesh app can reuse it.

- **First usable milestone:** P0 + P1 + P3 + P4 + P5. Sign in when you first share, work offline,
  see Home.
- **Second:** P2 + P6, which adds sharing with room enforcement.

**Tests that define done** (README rule 1):

- Rust validator verdicts equal the TS verdicts on a shared corpus.
- **`offline-removal.test`**: removed at t0 while offline; on reconnect, events stamped before t0
  land and later ones are reported, identically at the room and at B.
- **`lost-device.test`**: a backdated post-kick event is refused by the room.
- **`viewer-cannot-append.test`**: R3 refuses a viewer's event, and the log and fan-out are
  unchanged.
- **`stolen-bearer.test`** (plugin): a valid session token without K can neither enrol another key
  nor fetch a grant.
- **`session-delete-revokes.test`** (plugin): `revokeSession` marks the device revoked and
  enqueues the kick.
- **licnep GPUI tests:**
  - a fresh install never shows sign-in until Invite is pressed;
  - viewer mode disables tools;
  - Sync issues shows a removal;
  - Save as a copy creates a local project.

---

## 8 · Security review

| Threat | Mitigation | Residual |
|---|---|---|
| **Device-code phishing** (an attacker sends you *their* user code to approve) | the approval page names the client and device ("licnep-desktop on Mara's-MacBook, Berlin") and warns "Only approve a code shown by licnep on *your* computer"; 10-minute codes; `validateClient` allowlist; the app opens `verification_uri_complete` itself, so users normally never type codes | A user approving a stranger's code grants that stranger a session. The loopback + PKCE alternative (O2) removes this class. |
| **Stolen Better Auth session token** (bearer) | useless for grants without K: enrolment is one per session, and every syncmesh request needs K's signature (§3.5); `revokeSession` | It can read HTTP APIs as the user (file lists, member emails) until revoked. |
| **Email account takeover** | passkeys; a new-device email notice from the session-create hook; the Devices list | Email-only accounts are as strong as the mailbox. |
| **Stolen device, unlocked** | "Lost device": kick + cursor cut + `_revocations` + `revokeSession`; 24 h grants | A thief offline with P2P peers (none in licnep today) is trusted ≤ 24 h. |
| **Stolen device, locked / disk image** | keychain `ThisDeviceOnly`; FileVault | licnep does not encrypt project files. |
| **Malware as the same user** | keychain ACL bound to the code signature; socket directory 0700 | Out of scope, as for any desktop app. |
| **Replay: requests / grants / joins / links / invites** | nonce + ±5 min + context string; newest-issued wins; D33/D36 per-socket freshness; Better Auth hashed single-use tokens (`storeToken: "hashed"`, `storeOTP: "hashed"`, `allowedAttempts`); invites bound to the verified email | Link-access secrets are reusable by design; Reset rotates them. |
| **Malicious peer with a valid grant** | receivers' full ladder; room R1–R4; quarantine caps (RFC-0017) | Garbage within its scope, recovered by revocation plus version restore. |
| **Viewer or removed member reading new content** | grant-gated join + deny list | They keep what they already synced. Cryptographic read revocation needs sealed partitions (O5). |
| **Compromised room DO / Cloudflare operator** | end-to-end signatures | It reads unsealed content (O5). |
| **Compromised auth Worker / D1** | the issuer key is **not** in the Better Auth Worker or D1, only in the Signer, which signs only well-formed grant cores; `grants_issued` audit with digests | A compromised auth Worker can ask the Signer for any grant. That is the trust anchor; the audit log and alerts detect it. |
| **Issuer key theft** | Signer isolation; key set + rotation (W3, P9) | Valid until rotated out; offline apps learn at next contact. |
| **Agents** | no user session is ever handed to an agent; live agents capped by the owner's role; headless agents have their own key, an 8 h grant and ticked files, and are never `owner` | A prompt-injected agent can do what its scope allows; `DeletePolicy::AskFirst` and version history are the backstop. |
| **Account enumeration** | invite responses identical for known and unknown emails; autocomplete only from existing workspace members; Better Auth rate limits | — |
| **Metadata in grants** | no emails; opaque ids | Co-members learn how many files and workspaces a person can access (O12). |

---

## 9 · Owner decisions (each with a recommendation)

| # | Decision | Recommendation |
|---|---|---|
| O1 | Better Auth plugins for sign-in | **Magic link + email OTP (in one email), Google, GitHub, passkey** (`@better-auth/passkey`). All run on the web page, so passkeys cost nothing extra natively. |
| O2 | How the native app gets a session | **Device authorization plugin (RFC 8628)** for the app and `licnep-mcp`. The OAuth 2.1 provider plugin (loopback + PKCE) is kept for remote agents in P9. Switch the app to loopback + PKCE only if device-code phishing becomes a concern. |
| O3 | Roles | **owner > editor > commenter > viewer**, used both as the organization plugin's custom roles (`createAccessControl`) and as the grant ladder: one vocabulary. Agents are a grant claim, not a role. |
| O4 | Per-file roles in a grant | **W1: grant core key 9 `scopes`** (exact + prefix). |
| O5 | End-to-end encryption for licnep files | **No for v1** (publishing, thumbnails and server rendering read content). Per-file "sealed" option later. |
| O6 | Workspaces vs file shares | **Workspace = Better Auth organization** (members, invitations, roles). **File guests = the plugin's `file_members` / `file_invites`**. Teams (organization plugin `teams`) are not used in v1. |
| O7 | Lifetimes | **Better Auth session 60 days rolling (`updateAge` 1 day); device grants 24 h, agent 8 h, anonymous 1 h; renew at 50 %; rooms accept expired grants for 7 days; the deny list is authoritative.** |
| O8 | Offline edit window for shared files | **30 days** since the last grant renewal, then read-only. Local files: never limited. |
| O9 | Revocation cut | **Stamp rule for "removed"; cursor rule for "lost device".** |
| O10 | Remote wipe on "Lost device" | **Synced projects only**, on next run. Local-only files never. |
| O11 | Who may publish; edit-by-link | **Owner and editor publish** (visibility owner-only). **Link access for anonymous viewers is view/comment only; editing by link requires sign-in.** |
| O12 | Grant metadata leak (ids of a person's other files) | **Accept for v1** with opaque ids and no emails; revisit if guest sharing grows. |
| O13 | **When an account is required** | **Only to share.** Local files never need an account and never contact a server. Sign-in is prompted **only** by Invite, link access, opening a shared link, publishing to the web, workspaces and remote agents (§3.1, §6.2). Sharing a local project is what turns its sync on. The dev `--sync --sync-key` ungranted mesh stays for testing. |
| O14 | Where the code lives | **`@syncmesh/better-auth` (generic plugin + scope builder) in syncmesh; the licnep auth Worker, Signer, Authority and licnep routes in a new `licnep-cloud` repo.** |
| O15 | Better Auth JWT plugin | **Not the grant issuer** (§4.11). Use it only where a Cloudflare service needs a stateless user check (workspace-only published sites); otherwise leave it off. |
| O16 | D32 (quarantine report on the wire, draft) | **Decide it with W2**: room refusals need a way back to the author's UI. |

## Open questions (not blocking P0)

- Does "workspace owner" need to override a file owner who left, to recover files? The organization
  plugin's `owner` could imply `owner` on every `project:w_<o>.` file. The prefix scope already
  gives that when the workspace role is `owner`.
- Better Auth's `session` rows grow one per device plus one per web login. Is `listSessions` enough
  for the Devices list, or should enrolled devices be listed from `syncmesh_device` alone?
- Should the Authority's projections use a dedicated partition kind rather than `ws:` / `user:`?
- Garbage-collecting room deny lists after the denied grant's expiry + grace.
- Pinning room keys (D36 left it open): pin one **room-host key** per deployment rather than per
  room?

## References (Better Auth docs, read 2026-09-29)

- [blog/1-5]: https://better-auth.com/blog/1-5 (native D1: `database: env.DB`, `batch()` instead of transactions; `@better-auth/oauth-provider`; adapter package split)
- [adapters/sqlite]: https://better-auth.com/docs/adapters/sqlite (SQLite / D1 dialect)
- [concepts/database]: https://www.better-auth.com/docs/concepts/database (core tables, `additionalFields`, `databaseHooks` incl. `session.delete`, `advanced.database.generateId`)
- [concepts/session-management]: https://www.better-auth.com/docs/concepts/session-management (`expiresIn` 7 d, `updateAge` 1 d, `freshAge`, `cookieCache`, `revokeSession(s)`, `listSessions`)
- [concepts/plugins]: https://www.better-auth.com/docs/concepts/plugins (`createAuthEndpoint`, `schema`, `hooks`, `sessionMiddleware`, `rateLimit`)
- [concepts/rate-limit]: https://www.better-auth.com/docs/concepts/rate-limit
- [plugins/device-authorization]: https://www.better-auth.com/docs/plugins/device-authorization (RFC 8628; `/device/code`, `/device/token`, `/device`, `/device/approve`, `/device/deny`; `expiresIn` 30 m, `interval` 5 s, `validateClient`; returns a Better Auth session token)
- [plugins/bearer]: https://www.better-auth.com/docs/plugins/bearer (`set-auth-token`, `Authorization: Bearer`)
- [plugins/magic-link]: https://www.better-auth.com/docs/plugins/magic-link (`sendMagicLink`, `expiresIn` 5 min, `storeToken`)
- [plugins/email-otp]: https://www.better-auth.com/docs/plugins/email-otp (`sendVerificationOTP`, `otpLength` 6, `expiresIn` 300 s, `allowedAttempts` 3, `storeOTP`)
- [plugins/passkey]: https://www.better-auth.com/docs/plugins/passkey (`@better-auth/passkey`, SimpleWebAuthn, `rpID`, `rpName`, `origin`)
- [plugins/organization]: https://www.better-auth.com/docs/plugins/organization (default roles, `createAccessControl`, teams, `sendInvitationEmail`, `invitationExpiresIn` 48 h, `requireEmailVerificationOnInvitation`, member hooks)
- [plugins/jwt]: https://www.better-auth.com/docs/plugins/jwt (EdDSA/Ed25519 default, `/jwks` + `jwksPath`, `rotationInterval`, `gracePeriod`, `definePayload`, 15 min expiry, encrypted `jwks` table)
- [plugins/oauth-provider]: https://www.better-auth.com/docs/plugins/oauth-provider (OAuth 2.1 + OIDC, PKCE, loopback redirects for native, `device_code`, dynamic registration, MCP)
- [authentication/google]: https://www.better-auth.com/docs/authentication/google · [authentication/github]: https://www.better-auth.com/docs/authentication/github

Details to re-check against the pinned Better Auth version at build time:

- whether `databaseHooks` on `session.delete` fire for `revokeSessions` as well as `revokeSession`;
- that custom organization roles fully replace `owner/admin/member`, including the creator's role
  (`creatorRole`).

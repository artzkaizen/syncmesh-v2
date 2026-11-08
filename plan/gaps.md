# Gaps to the graduation bar

> Swept 2026-11-07 on `gap/sweep` (base `638eed6`). Sources: every epic's open and `[~]` boxes,
> the "still open" clauses inside ticked ones, every decision still `draft`,
> `research/gap-audit.md` (P0–P4 + addendum), `plan/api-gaps.md` §3, and the **code** (stubs,
> unimplemented interfaces, `test.todo`, "not started" / "follow-on" comments). Where the plan
> and the code disagreed, the code won and the row says so.
>
> **Owner** is who closes it. `S1`–`S7` are the sibling threads in this sweep: S1 scale · S2
> Postgres CDC source · S3 gated/authority visibility (E08/E12) · S4 read permissions, room
> tickets, E06 `fields:`, confidentiality posture · S5 windowed row path (E24 row patches + E27) ·
> S6 Loro + doc branch merge · S7 proof (10M test, chaos in CI, durability, threat model). **This**
> is this thread. **Unowned** is nobody in the sweep. **Hardware** needs devices in hand.
>
> **Status**: `open` · `decision` (needs the owner; a decision file exists or is named) ·
> `built` (with its test; the PR that landed it on main is named) · `partly built` (the PR named
> landed part of the row; the rest is still open) · `done` (was already built; the plan said
> otherwise) · `hardware`.
>
> **Updated 2026-11-08** after the sweep's PRs merged into main: #2 and #3 (document columns,
> RFC-0023), #5 (scale), #6 (windowed sync, D43), #7 (authority visibility, D24), #8 (Postgres
> logical replication), #9 (this sweep), #10 (proof), #11 (loro adapter), #12 (read permissions,
> D40). A row's status says only what those PRs' descriptions and the tree show.
>
> **Decisions, 2026-11-08.** Jace delegated the remaining calls. Every row in the Decisions table
> now names a decided record; a decided row that is not built yet reads `open`.

## Decisions

| # | Gap | Where | Owner | Status |
|---|---|---|---|---|
| D1 | **D31** schema evolution across a mixed-version fleet: `retired` state, `schemaVersion` stamp, additive lint; also gap-audit №20 (correction mismatch across versions) and E16 | **D31 decided C** (2026-11-08): expand → wait for the fleet → retire → contract; the additive lint, the `unknown-table` / retired split, `schemaVersion` on event key 9 and the cursors frame as a reading, never a gate. `engine/src/quarantine.ts`, `engine/src/validate.ts`, `schema/src` | Unowned | open |
| D2 | **D38** a CRDT inside a cell | **D38 decided D** (2026-11-08): RFC-0023's document columns are the answer, not a lattice the kernel folds; Loro first under **D41, decided A**. Built so far: #2, #3, #11; the rest is E30's open boxes (P4–P7) | S6 | open |
| D3 | **D32** quarantine report on the wire | `plan/decisions/D32.md` — **decided C by the owner 2026-11-07** in this thread | This | built (#9; see B9) |
| D4 | Relay durability `ack` as a mesh-level `synced()` — needs a way to name the relay in `engine.acknowledge` (gap-audit P0 №4) | `plan/epics/E12.md:37`; **D42 decided A** (2026-11-08): a `durable` transport capability, not an acknowledgement | Unowned | open |
| D5 | A returning device does not rejoin from state on its own — needs a compaction floor on the wire (D31's "pin D15's floor for every peer") | **D46 decided A** (2026-11-08): the sender's floor goes at index 4 of the cursors frame (with `ahead` always present at 3); a device whose cursor is strictly below the floor requests state once per floor per session. Unvouched, it adopts nothing when `trust` is set, and with no `trust` only up to the claimed floor for the authors below it (a peer-triggered unvouched install, open for Jace). A manifest nobody asked for installs nothing, which closes U20. After any install, authors still below the floor raise a `$recovery` issue; an install that brings every author up to the floor raises none. `transport/src/__tests__/resurrection.test.ts` (`test.todo`), `transport/src/outbound.ts` `cursorsAfter`, `api-gaps.md` §3.6 | Unowned | open |
| D6 | One constructor: `createMesh` and `createClient` both exist with callers | **D47 decided B** (2026-11-08): `createClient` is the one public constructor, as the book's cut list agreed; `createMesh` moves to `@syncmesh/client/internal` for harnesses and adapters, and `flatten` goes. `client/src/index.ts`, `orpc/src/client.ts`, `orpc/src/options.ts`, `api-gaps.md` §3.1 | Unowned | open |
| D7 | Confidentiality posture written into RFC-0017 ("a room name is a bearer secret" or `verifyJoin` + per-partition encryption) — gap-audit P0 №2 | **D40 decided C** (grant-gated rooms plus sealed kinds); RFC-0017 carries the posture and the hosted presets refuse to start without `trust` or `open: true` | S4 | built (#12) |
| D8 | E27 thin client: supported shape or demo — gap-audit P0 №3 | **D43 decided B**: a supported shape, served by the peer that holds the rows | S5 | built (#6) |
| D9 | D17: may relay telemetry variants carry peer identity | **D48 decided A** (2026-11-08): no — `relay.*` variants carry no peer id, room name or event id; not yet built: the doc comments still call it open, and the test that pins it is still to write. `engine/src/telemetry.ts`, `relay/src/telemetry.ts`, `plan/epics/E24.md` | Unowned | open |
| D10 | **D39** a damaged log is refused, not read around: a torn page in the log reads back a silent subset (29 of 40 tears in #10's test, pinned as `test.failing`) | **D39 decided C** (2026-11-08): contiguity check on read, `quick_check` on demand and after an unclean shutdown | Unowned | open |

## Built by the sweep (merged in #9)

| # | Gap | Where | Status |
|---|---|---|---|
| B1 | Relay fan-out metered **per room**, not only per socket (gap-audit №7) | `relay/src/limits.ts`, `ingest.ts`; `__tests__/limits.test.ts` | built (`b41e230`) |
| B2 | Per-room socket cap and open-room cap, refused with 503 before upgrade (gap-audit №5 — the process-wide cap already existed) | `relay/src/host.ts`, `rooms.ts`, `adapters/cloudflare-do/src/host.ts`; `relay/src/__tests__/host.test.ts` | built (`b41e230`) |
| B3 | Production eviction default: durable hosts evict an idle room after 15 min; the log stays unbounded unless `DURABLE_RETENTION` is opted into (owner's call, 2026-11-07; gap-audit №8) | `DEFAULT_IDLE_AFTER` in `relay/src/rooms.ts`, applied by `hostTuning`; `__tests__/serve.test.ts` | built (`b41e230`) |
| B4 | E24 `mesh.start()` symmetric with `stop()`: `createMesh({ start: false })`, idempotent `start()`, typed `Err` after `stop()` (owner's call, 2026-11-07) | `client/src/lifecycle.ts`, `transports.ts`, `options.ts` | built (`702bf88`) |
| B5 | E15 blob sweep + per-partition quotas refused at the put as a typed value (gap-audit №22) | `relay/src/blob-keeper.ts`, `blob-cap.ts`, `client/src/blobs.ts`; relay tags 20–21 + vectors; `__tests__/blob-keeper.test.ts` | built (`d37adf7`) |
| B6 | E19 60 Hz presence burst as a load test, and a BLE-shaped drop test (gap-audit №21) | `ble/src/__tests__/presence.test.ts` — writing it found BLE queueing every stale cursor; fixed with `FrameLink.sendLatest` | built (`e8dc1e2`) |
| B7 | E25 embedded example had no test — and **did not work**: its Drizzle opened the log file, not the state file the rows live in | `examples/src/embedded/backend.ts`, `__tests__/embedded.test.ts` | built (`afafea2`) |
| B8 | E25 Rivet actor | `adapters/rivet` (`@syncmesh/rivet`) | built (`68602c5`) |
| B9 | D32 refusal receipt: wire core + vectors, frame kind 9, ledger table, reader on `$operations` | `wire/src/receipt.ts`, `transport/src/custody.ts`, `storage/src/operation-refusals.ts`, `conformance/refusal-vectors.json`, `crates/syncmesh-core` | built (`695bf98`, `6926d8d`) |

## Owned by a sibling

| # | Gap | Where | Owner | Status |
|---|---|---|---|---|
| O1 | Scale: whole replica in memory, table map copied per write, tombstones never collected (gap-audit addendum №3) | `engine/`, `kernel/` | S1 | partly built (#5): the table map is no longer copied per write (`applyChange`, `mergeRecord`, memory `lastSeq` and `encodeCbor` are flat in `bench scale`, which now gates `ci`); the whole replica is still in memory and tombstones are still never collected |
| O2 | **E20 is ticked done but Postgres logical replication is not built** — `manualChangeSource` is the only source | `cdc/src/source.ts:19-20` ("deliberately not started"), `cdc/src/manual.ts:41`, `plan/epics/E20.md:20` | S2 | built (#8): `postgresChangeSource` in `@syncmesh/postgres`, tested against a real Postgres 17 in CI |
| O3 | External-writer story (table classes, staged-changes sweeper) wants an RFC (gap-audit №31) | `research/gap-audit.md` | S2 | open |
| O4 | E08 `visibility: "authority"` tier (blocked on D24's reframing) | `plan/epics/E08.md:25` | S3 | built (#7) |
| O5 | E09 `mesh.visibility` | `plan/epics/E09.md:35` | S3 | built (#7) |
| O6 | E12 `token()` / `visibleAt()` / `VisibilityLost`, and the `Relay` transport class declaring `visibility` + `blobs` | `plan/epics/E12.md:31-32` | S3 | built (#7) |
| O7 | A withheld event stalls its author's whole stream; the gated tier needs its own sequence (gap-audit №16) | `engine/src/admit.ts`, `transport/src/holdback.ts` | S3 | built (#7): a withheld event is followed by a scoped pass-over page, with no separate sequence (D24); peer links name what they hold back in the `withheld` frame (#12, session tag 10) |
| O8 | E06 `fields: { column: rule }` read restriction at the relay (gap-audit №17) | `plan/epics/E06.md:27` | S4 | built (#12): holds only where an authority serves rows (D40); on a device it is cosmetic |
| O9 | Interest is a request, not a permission — the relay must filter by policy first (gap-audit №18) | `plan/epics/E13.md:50`, `relay/src/catchup.ts` | S4 | built (#12): a gated room narrows catch-up and live fan-out to what the grant entitles |
| O10 | Room tickets / read permissions on the relay | `relay/src/posture.ts`, RFC-0024 | S4 | built (#12): the grant is the ticket, checked in band after the D36 hello (D40) |
| O11 | E24 versioned row patches (`epoch` + monotone id, resnapshot-on-gap) | `plan/epics/E24.md:24` | S5 | built (#6) |
| O12 | E27 `ClientView`, `desire / undesire / rows` frames, engine-less patch client | `plan/epics/E27.md:31-37` | S5 | built (#6): `createServerWindows` (was `ClientView`), relay tags 32–34, a store-less patch client (D43) |
| O13 | E14 snapshot window is not a field of `Interest` (gap-audit №19); E13 an interest change leaves a permanent gap | `plan/epics/E14.md:43`, `plan/epics/E13.md:53` | S5 | open |
| O14 | Collaborative text / doc branch merge (D04's open door, D38) | `research/crdt-cells.md` | S6 | partly built: document columns (#2, #3) and the loro@1 adapter under TipTap (#11); D41 decided A and D38 decided D (both 2026-11-08); E30's open boxes remain |
| O15 | Chaos in CI on a small seed; grant propagation under fault; blobs and retention-floor refusals in the schedule (gap-audit №10–12) | `chaos/`, `.github/workflows/ci.yml` | S7 | built (#10): an invariant check after every run, and new `--grants fault`, `--blobs` and `--retention` switches (`--retention` and a soak loop nightly only, in `nightly.yml`); the bugs it found are `test.todo` replays |
| O16 | Crash safety and format migration: `kill -9` mid-fold / mid-append, torn writes, `_syncmesh_meta` upgrades (gap-audit №13) | `storage/` | S7 | partly built (#10): kill -9 mid-append and mid-fold on `bun:sqlite`, `node:sqlite` and PGlite, and the migration ladder now commits per step; a torn log page is D39 (D10 above), and the Durable Object, OPFS and expo drivers are not covered |
| O17 | 10M-event test; threat model (RFC-0017) | — | S7 | partly built (#10): the 10M ladder runs nightly and **does not hold** (SQLite abandoned at 795k rows after 30 min); the threat model is `plan/security/threat-model.md`, with findings N1–N26 |

## Unowned — not hardware

| # | Gap | Where | Status |
|---|---|---|---|
| U1 | Dedup below the compaction floor: `receiveBatch` re-admits a compacted event below the floor (state stays right only because the merge is a max-join) | `engine/src/admit.ts` (`store.has(event.id)`), `api-gaps.md` §3.7 | open |
| U2 | Telemetry has no consumer: no inspector, no storage taps; a policy verdict is a bare boolean with no "why" (gap-audit №24) | `plan/epics/E24.md:22`, `engine/src/telemetry.ts` | open |
| U3 | Rust client (D37) has no policy ladder, no local scope, no radios | `crates/syncmesh-client`, `plan/epics/E24.md:32` | open |
| U4 | Device seed stored in plaintext SQLite; no platform keystore seam (gap-audit addendum №3) | `client/src/identity.ts:82` | open |
| U5 | Strict capture mode: an unarmed write to a synced table should raise, not diverge silently (gap-audit №30) | `storage/src/capture.ts` | open |
| U6 | rounds-web's only test is a manual Playwright smoke script no runner picks up (gap-audit №25) | `apps/rounds-web/package.json:10` | open |
| U7 | `verify-node-consumer` never imports `@syncmesh/sqlite-bun`; sqlite-node's durable path only indirectly covered (gap-audit №26) | `tooling/verify-node-consumer/bin/` | open |
| U8 | Effect anti-slop oxlint variant not enabled; one benchmark total (`bench/storage`) (gap-audit №27) | `vite.config.ts`, `bench/` | open |
| U9 | E06: ungranted mode does not enforce `deny` — documented, pinned by no test | `plan/epics/E06.md:34`, `engine/src/validate.ts` | built (#12): pinned by a test |
| U10 | E06: named rules by convention (`const isOwner = owner("createdBy")`) — a doc, no feature | `plan/epics/E06.md:28` | open |
| U11 | Browser: two tabs cannot share one database; a second tab is refused `OpfsPoolHeld` | `plan/epics/E04.md:41`, `adapters/sqlite-wasm` | open |
| U12 | `@syncmesh/docs` is a scaffold whose only test is the template's `test.todo` | `packages/docs/src/__tests__/index.test.ts:4` | open |
| U13 | `describeRoom` reports the host's key, not the room's when a `RoomStore` supplies its own identity (the Durable Object host does, and mounts no describe yet); the Rivet host sidesteps it by opening its host over the stored key | `relay/src/describe.ts` (`host.peerId`), `relay/src/host.ts` (`RoomStore.identity`) | open (latent) |
| U14 | D31's two "now" fixes: split `unknown-table` from the retired-table case sharing its 128-slot bucket; pin D15's compaction floor for every peer | `engine/src/quarantine.ts` | open (D31 decided C, 2026-11-08; the floor half is D46 A) |
| U16 | **main's CI had failed on every push since 2026-09-28.** #9 fixed the formatting, the undeclared `@syncmesh/transport` in `adapters/browser` and the private `@syncmesh/ble` (`3bfa67a`); #2 fixed the `apps/issues-native` bulk; #15 cleared the last ten file-size, complexity and type errors, so `vp check` reports none | `vp lint`; `.github/workflows/ci.yml` | built (#15) |
| U17 | Refusals and receipts are not carried by the relay (D32 limit: direct links only); React `refused-by` rendering (`plan/react-api.md` G12) unbuilt | `relay/src/session.ts` | open |
| U18 | Blob sweep limits: a reference is kept for the life of the instance (log trims do not release it, since a trimmed insert is still a live row), so deleting a row never frees its blob and only uploads no row ever named are swept; a room that has seen a sealed event stops sweeping; only blobs put since the room opened are swept or billed; no telemetry on a sweep; the Rust client ignores the put answer | `relay/src/blob-keeper.ts` | open |
| U19 | A stalled relay WebSocket still buffers presence inside the socket; conflation stops at the link (`FrameLink.sendLatest` covers BLE, not the relay) | `relay/src/sender.ts`, `relay/src/transport.ts` | open |
| U20 | **The join exchange accepts a snapshot manifest nobody asked for.** `onManifest` stores any manifest, `unvouchedMayAdopt` starts `true` per session, and `complete` adopts its `at`; so any connected peer, with or without `trust`, can send a manifest with no pages and a huge `at` and the device stops fetching that author's events. Reproduced on `014abc5` with a throwaway test. D46's policy queue closes it (an unasked manifest is dropped) | `transport/src/join.ts` (`onManifest`, `complete`), `transport/src/bridge.ts` (`joinFor`), D46 | open |
| U15 | The fleet `compose.yaml` is never run by CI (the shape is proved in-process by `fleet.test.ts`) | `examples/src/fleet/compose.yaml` | open |

## Hardware — listed, not built here

| # | Gap | Where | Status |
|---|---|---|---|
| H1 | BLE has never touched a radio: the manual device checklist is every box unchecked; the donor's per-fragment ack and 140-byte frame sizing were replaced in `packages/ble`, but nothing has proved the replacement on air (gap-audit №9) | `plan/epics/E22.md:20` | hardware |
| H2 | Wi-Fi Aware (E23): `class WifiAware extends FrameTransport`, route preference for bulk, `maxLinks`, `costly` / `dormant` declared | `plan/epics/E23.md:19-29` | hardware |
| H3 | iOS Wi-Fi Aware engine: accept and browse loops deliberately not started until `pair()` produces a paired device | `native/rn-nearby/ios/WifiAwareEngine.swift:78` | hardware |
| H4 | No Android radio module in `native/rn-nearby` (no `android/`) | `native/rn-nearby/` | hardware |

## Plan said open, code says done

| Gap | Evidence |
|---|---|
| gap-audit №5 process-wide connection cap | `RelayLimits.maxConnections`, 503 at `createGate` (`relay/src/host.ts`) |
| gap-audit №6 backlog bounded in bytes | `RelayLimits.maxBacklogBytes`, `relay/src/sender.ts:42` |
| gap-audit №7 per-socket fan-out | `fanout` traffic class, `relay/src/ingest.ts:80`, `connection.ts:288` (per-room is B1) |
| gap-audit №8 blob half | `DEFAULT_MAX_BLOB_BYTES`, `relay.retention.unbounded`, `__tests__/retention-defaults.test.ts` |
| gap-audit №14 stale-link detection | `client/src/stale.ts`, opt-in `mesh.stale` (E28.md:42) |
| gap-audit №15 E17 loose ends | every E17 box ticked with its test; no "still open" clause left |
| gap-audit №23 `mesh.transports.add/remove` | `client/src/transports.ts:481-500`, `api-gaps.md` §4 |
| E25 docker compose | `examples/src/fleet/compose.yaml` (Postgres `LISTEN/NOTIFY` replaced Redis, `df56207`) |
| E25 "async driver port" blocker for Rivet | D05 decided B; `SqlDriver` and `StateStore` are async |
| gap-audit №28 doc rot in E24 | retention and eviction exist (`retention.ts`, `rooms.ts`) |

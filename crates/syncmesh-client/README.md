# syncmesh-client

A syncmesh device in Rust (D37), sans-IO: the engine that numbers, signs, appends and folds; its
memory and SQLite stores; the D36 relay link as a state machine; a peer link to another device
with no relay between them, over any byte duplex (gap U3's radios); the join exchange and D46's
rejoin from state; the ephemeral tier (D16); blobs (D18); the grant registry; document columns
over any adapter (RFC-0023); and, behind the `tokio` feature, the drivers and `Mesh`. Measured
against the TypeScript: the wire through `syncmesh-core` and `conformance/*.json`, live through
`tests/interop.rs` (a relay) and `tests/peer_interop.rs` (a TypeScript device, directly).

## The validator

With `EngineOptions.validator` the engine runs the TypeScript's shared ladder (gap U3) on every
event: a peer's as it arrives, and this device's own as a probe before it is numbered. Its
verdicts are the TypeScript's, tag for tag, and so are the buckets it parks in.

The ladder runs on the manifest as data. Write it from the TypeScript schema and hand it over:

```ts
import { portableSchema } from "@syncmesh/schema";
await Bun.write("schema.portable.json", `${JSON.stringify(portableSchema(schema), null, 2)}\n`);
```

```rust
use syncmesh_client::{Engine, EngineOptions, GrantRegistry, Manifest, ValidatorOptions};

let manifest = Manifest::parse(&std::fs::read_to_string("schema.portable.json")?)?;
let engine = Engine::open(identity, store, state_store, EngineOptions {
    validator: Some(ValidatorOptions {
        grants: Some(Box::new(GrantRegistry::new(issuer))), // None: ungranted mode
        authority: Some(authority),
        ..ValidatorOptions::new(manifest)
    }),
    ..EngineOptions::default()
})?;
```

`docs` and `merge` default to the manifest's own; `docs` given is what the ladder judges documents
by too. Under `Mesh`, a validator with no `grants` of its own is granted, over the mesh's registry,
when `MeshOptions.issuer` is set; the mesh's link registers every grant that arrives before the
events beside it fold. A host driving `RelayLink` itself gets the same with
`RelayLink::with_grants(registry)`, given the registry its validator reads.

The rungs, first failure wins: clock (`ClockAhead`), grant (`NoGrant`, `GrantDeviceMismatch`,
`GrantRevoked`, `GrantStale`), the manifest's own tables (`_policy`, `_corrections`,
`_revocations` by the authority; `_links` signed by its account, `LinkRefused`), the table
(`UnknownTable`, `TableDropped`, `RetiredWrite`), the partition (`ReadOnlyPartition`,
`LocalOnly`, `WrongPartition`, `PartitionNotGranted`), cells and documents (`UnknownChangeKind`,
`SchemaViolation`, `DocColumnWrite`, `DocChangeRefused`), and the table's `allow` block, or the
instance's synced `_policy` rules, last (`PolicyDenied`). A `replace()` is judged by
`allow.replace`, and by `update` when the block has none (RFC-0023 §16.2).

A column's `check()` runs as the JSON Schema the manifest carries for it (`checkSchema`, written
by `portableSchema` from the Standard JSON Schema extension zod 4 implements). JSON Schema says
less than a function can: a `.refine()` is dropped from it, and a `z.custom` has none, so such a
column's check is weaker here or not run (`Manifest::unported_checks` lists the second kind).
It is never stricter: `portableSchema` leaves out whatever zod's converter would say stricter
than zod runs (a `/…/i` regex, a `.catch()`, a coerce, a trimmed string, a UTF-16 `.min(n)`, a
regex without `u` whose `.` or negated class would count UTF-16 units, a `\b`, a lookbehind or a
backreference), and a check from a vendor other than zod travels as the flag alone. A pattern's
`.`, `\d`, `\w`, `\s` and their negations travel spelled as the sets JavaScript means, because
the `jsonschema` crate runs a pattern with a lookahead untranslated, where they are Unicode's. A
match the regex engine stops at its backtrack limit is no refusal: `CheckSchema::accepts` takes
it, as JavaScript would have finished. A schema this
build cannot compile leaves its column flagged with no schema, as `unported_checks` lists, and the
manifest still reads. JSON Schema `format` is an annotation here, never asserted, so a check zod
runs in code beside a format alone (`z.url()`, `z.jwt()`) is looser here. Register the rest
yourself; a host check replaces the column's schema:

```rust
let mut checks = ColumnChecks::new();
checks.insert(
    ("tasks".into(), "title".into()),
    Box::new(|v: &CellValue| matches!(v, CellValue::Text(t) if t.trim() == t)),
);
let options = ValidatorOptions { checks, ..ValidatorOptions::new(manifest) };
```

`Engine::can("notes.update", Some(&row), Some("org:acme"))` is the UI's question (`mesh.can`),
answered by the same rules the ladder enforces: the instance's synced `_policy` row when the
device holds one, the manifest's block otherwise. With no instance named, an accounts mesh asks as
the account every one of the device's `_links` rows agrees on. `Validator::can` asks it for any
principal; `Mesh::can` and `Mesh::mutate_local` reach the same through a mesh.

A `local` table takes this device's own local-only writes, `Engine::mutate_local`: numbered in
their own run (`peer-L1`), folded and kept, never signed and never offered to a peer. A write to
one through `Engine::mutate` is `LocalOnly`, as a peer's is.

`conformance/policy-vectors.json` holds the verdicts both runtimes reach; `tests/policy_vectors.rs`
replays it here.

## The join exchange

State instead of history (RFC-0019), and D46's answer to a peer's compaction floor, as the
TypeScript's `transport/src/join.ts` and `rejoin.ts` run them, byte for byte
(`conformance/snapshot-vectors.json`, `tests/snapshot_vectors.rs`). It runs on a peer link: the
relay carries no join exchange. `PeerLink` (below) runs it for you —
`PeerLink::request_snapshot`, the floor on every cursors frame, `PeerLink::accept_floor` — over
the `Rejoins` its `SessionOptions` names. A host with a link of its own drives it directly. One
`PeerJoin` per link, one `Rejoins` per device:

```rust
use syncmesh_client::{JoinExchange, JoinOptions, PeerJoin, Rejoins};
use syncmesh_core::frames::{Frame, decode_frame};

let mut rejoins = Rejoins::new();
let mut options = JoinOptions::new(&engine.peer_id().as_str()[..8]);
options.trust = Some(issuer.clone()); // None: nothing vouches, and nothing below a floor is asked
let mut link = PeerJoin::open(&mut rejoins, JoinExchange::new(options), None);

// every frame the peer sends:
match decode_frame(&bytes)? {
    Frame::Cursors { from, cursors, floor, .. } => {
        let floor = floor.map(|f| f.into_iter().collect());
        for frame in link.on_cursors(&mut rejoins, &engine, &from, &cursors.into_iter().collect(), floor.as_ref()) {
            send(frame);
        }
    }
    Frame::Snapshot(frame) => {
        let step = link.on_snapshot(&mut rejoins, &mut engine, frame)?;
        step.send.into_iter().for_each(send);
    }
    _ => {}
}

// when the link ends — required: a dropped PeerJoin leaves its requests in `rejoins` for good
// link.close(&mut rejoins);

// after a fold, so an issue whose authors caught up some other way goes
rejoins.sweep(&engine.coverage().synced);
// the app's call, in a mesh with no trust: take the state, up to the floor the peer claimed
if rejoins.accept(&peer, &engine.coverage().synced) == Accepted::Requested {
    link.flush(&mut rejoins).into_iter().for_each(send);
}
```

`JoinExchange::request(None, false)` is a cold join (rows merge, coverage stays this device's
own); `request(None, true)` is a rebuild. A manifest nobody asked for installs nothing. A vouched
install (a certificate from `trust` over exactly the rows) adopts what the certificate signs and
never more than the manifest claims; what an install adopts beyond the log is `Engine::floor`.

An install the store refuses, or one whose state or doc store returns an error, sends no ack: the
request stays unanswered and the next session asks again, and the holder keeps that exchange's
pages until its link closes. Rows and coverage commit before the doc log is relabelled; an install
stopped between the two leaves document heads naming the old winner, and the next `Engine::open`
relabels them.

A record's cells go out in column order in both runtimes (gaps U34), so a Rust holder and a
TypeScript holder of one row serve the same bytes, and a certificate either runtime's authority
mints vouches for either holder's pages. Certificates are version 2; a version 1 (minted before
U34, over cells in first-written order) is refused as `CheckpointError::UnknownVersion` and vouches
for nothing. A table the validator's manifest puts in the `local` kind never travels in a snapshot
(gaps U36).

An install records its floor in the log as well as in the state's coverage
(`EventStore::installed_below`, gaps U37), once a state store has committed the rows. An open that
finds an empty state store over that floor (the state file deleted or replaced) is refused as
`StateCorrupt` instead of rebuilt from a log that never held the installed rows.

A relay link refused with `retention` (gaps U37) says `Action::BelowFloor { floor }` and does not
redial; the host raises the issue with `Rejoins::relay_refused(link.name(), floor)`, which lists
it beside the peers' (`BelowFloorReason::Retention`). The link dials again once
`RelayLink::on_remote_fold` (called after any fold or install from another source) finds the
floor held, or on `wake`, and says `Action::FloorCleared` when the issue is over. `Mesh` does this
itself: `Mesh::below_floor` lists the issues, `MeshEvent::Recovery` says they changed, and
`Mesh::folded_elsewhere` tells the link a host's own peer link moved the device.

## Peer links

A link to one other device with nothing between them (gap U3's radios), as the TypeScript's
upgrader and bridge run it (`transport/src/upgrade.ts`, `session.ts`, `bridge.ts`), byte for byte:
both ends send a signed hello unprompted, the session keys come from the pair, and every frame
after is sealed. Then the session: every grant held, then the cursors; the events the far side
lacks (less what it holds above its cursor), a digest of the rows over the session's slice, and
our cursors when it is ahead; the gap rule on arrival, with a fold announced by our cursors;
custody receipts with an `incarnation`, signed refusals of what parked; presence slotted by
`(topic, instance, author)`; and the join exchange with D46's floor.

`Framing` says what the medium is: `Framing::STREAM` (TCP, a Wi-Fi Aware or AWDL data path: a
four-byte length before each frame), `Framing::Messages` (a WebSocket), or
`Framing::fragments(write_limit)` (a BLE characteristic: eight-byte headers, reassembled in any
order, `syncmesh_core::fragment` against `conformance/fragment-vectors.json`). The machine is
sans-IO; the host moves bytes:

```rust
use syncmesh_client::{Framing, PeerAction, PeerLink, PeerOptions};

let (mut link, hello) = PeerLink::open(identity, PeerOptions {
    framing: Framing::STREAM,
    peer_key: Some(expected),                // optional: refuse any other key
    ..PeerOptions::default()
}, now_ms);
send_all(hello);
// every read:            link.on_bytes(&mut engine, &bytes, now_ms)
// every local write:     link.on_local_write(&mutated.entry)
// a fold from elsewhere: link.on_remote_fold(&engine)
// at next_deadline_ms(): link.on_tick(&engine, now_ms)   (5s keepalive, hung up on at 2.5x)
// once the medium is closed: link.on_closed(reason)
```

`PeerAction::Send` is bytes for the medium, in order; `SendLatest { slot, units }` is a presence
value a medium that backs up may replace by slot (`FrameLink.sendLatest`); `Close` asks the host to
hang up. The rest are facts: `Established`, `Superseded` (the peer restarted on the same link and
its new session replaced the old one; a replayed hello is dropped), `Refused` (another key than
`peer_key`, or the `admits` door said no), `Folded`, `Presence`, `Grant`, `GrantRequest`,
`Receipt` and `Refusal` (about this device's own writes), `Divergence` (RFC-0014: the same
position, other rows), `Snapshot` (a join that settled), `Recovery` (the session raised or cleared
a floor issue in its `Rejoins`, D46), `Dropped`, `Ended`. `PeerSession` is the
session alone, over plaintext frames, for a medium that is already sealed and framed.

Behind `tokio`, `driver::run_peer` runs one over any `PeerMedium` — `StreamMedium` for
`AsyncRead + AsyncWrite`, `MessageMedium` for a `Stream + Sink` of messages, or your own, which
splits into a `PeerRead` and a `PeerWrite` half. The write half drains a queue while the link
keeps reading, so two devices that each owe the other more than the medium buffers both get
through, and a presence value still waiting replaces the one before it under its slot. And
`Mesh::attach_peer` runs one beside the relay link, handing it every write, presence value and
fold, and the relay and the other links what it folds. It returns a `PeerHandle`: its `id()` is
what that link's `MeshEvent::Peer` facts carry (unique even when two links share a name), and
`send`/`try_send` hand the link any `PeerCommand` — `AcceptFloor` (D46), `RequestSnapshot`,
`RequestGrant`, `Grants` (the answer to a `GrantRequest` that link raised), `Resync`, `Close`.
A link that finds this device below its peer's floor says `MeshEvent::Recovery`, and
`Mesh::below_floor` then names that peer; `AcceptFloor` down that link is the consent:

```rust
let socket = tokio::net::TcpStream::connect(addr).await?;
let link = mesh.attach_peer(StreamMedium::new(socket), PeerOptions::default(), &handle);
link.try_send(PeerCommand::AcceptFloor)?;
```

Grants cross a peer link when it opens and when sent through its handle; the mesh forwards none
between links (the TypeScript sends every newly registered grant to every link). A command the
mesh hands a link whose queue is full is lost and said as `MeshEvent::Dropped`; the link's next
cursor exchange carries what it would have. `Mesh::stop` drops the events nobody read and waits
for each link to take its close, so it ends even while the host holds a handle and reads nothing.

What it does not do, as a TypeScript bridge with neither does not: no read gate (D40), so it
carries everything to every peer, and no route table, so a `routes` frame is ignored. Frames
offered in one call leave in tag order, the TypeScript outbox's order within one turn.
`conformance/peer-link-vectors.json` freezes the session's frames (`tests/peer_vectors.rs`), and
`tests/peer_interop.rs` links a Rust device to the TypeScript LAN transport and to the TypeScript
BLE link, both directions, rows, presence and the join exchange.

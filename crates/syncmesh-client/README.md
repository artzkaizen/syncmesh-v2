# syncmesh-client

A syncmesh device in Rust (D37), sans-IO: the engine that numbers, signs, appends and folds; its
memory and SQLite stores; the D36 relay link as a state machine; the join exchange and D46's
rejoin from state; the ephemeral tier (D16); blobs (D18); the grant registry; document columns
over any adapter (RFC-0023); and, behind the `tokio` feature, a WebSocket driver and `Mesh`. Measured against the TypeScript: the wire through
`syncmesh-core` and `conformance/*.json`, live through `tests/interop.rs`.

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
backreference), and a check from a vendor other than zod travels as the flag alone. A schema this
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
relay carries no join exchange, and this crate has no peer link of its own yet (D37, U3's radios),
so a host with one drives it. One `PeerJoin` per link, one `Rejoins` per device:

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

A Rust holder serves a row's cells in column order, not the order they were first written (gaps
U34): a certificate it relays from a TypeScript authority vouches for its page only when each
row's cells were first written in column order. A certificate a Rust issuer mints over its own
rows always does.

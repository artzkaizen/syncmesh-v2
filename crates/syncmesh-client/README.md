# syncmesh-client

A syncmesh device in Rust (D37), sans-IO: the engine that numbers, signs, appends and folds; its
memory and SQLite stores; the D36 relay link as a state machine; the ephemeral tier (D16); blobs
(D18); the grant registry; document columns over any adapter (RFC-0023); and, behind the `tokio`
feature, a WebSocket driver and `Mesh`. Measured against the TypeScript: the wire through
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
        manifest,
        grants: Some(Box::new(GrantRegistry::new(issuer))), // None: ungranted mode
        authority: Some(authority),
        accounts: false,
    }),
    ..EngineOptions::default()
})?;
```

`docs` and `merge` default to the manifest's own. Under `Mesh`, the validator is granted, over the
mesh's registry, exactly when `MeshOptions.issuer` is set.

The rungs, first failure wins: clock (`ClockAhead`), grant (`NoGrant`, `GrantDeviceMismatch`,
`GrantRevoked`, `GrantStale`), the manifest's own tables (`_policy`, `_corrections`,
`_revocations` by the authority; `_links` signed by its account, `LinkRefused`), the table
(`UnknownTable`, `TableDropped`, `RetiredWrite`), the partition (`ReadOnlyPartition`,
`LocalOnly`, `WrongPartition`, `PartitionNotGranted`), cells and documents (`UnknownChangeKind`,
`SchemaViolation`, `DocColumnWrite`, `DocChangeRefused`), and the table's `allow` block, or the
instance's synced `_policy` rules, last (`PolicyDenied`). A `replace()` is judged by
`allow.replace`, and by `update` when the block has none (RFC-0023 §16.2).

What it does not do, because the TypeScript has it only as a function: run a column's `check()`
schema. The manifest marks those columns, and `Manifest::checked_columns` lists them; a write only
a check refuses folds here. This crate writes no local events, so a write to a `local` table is
always `LocalOnly`.

`conformance/policy-vectors.json` holds the verdicts both runtimes reach; `tests/policy_vectors.rs`
replays it here.

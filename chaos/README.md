# @syncmesh/chaos

A mesh of devices under deliberate fault, and a replay log of what happened to every event.

```sh
bun run --cwd chaos run -- --seed 3 --devices 6 --ticks 25
```

Exits non-zero when a device is missing a write, when the durability invariant fails, when two
devices' digests disagree, or when a blob does not read back. The run is written to
`.chaos/run-<seed>[-<switch>…]/`: `ledger.jsonl` (every fact, in order) and `report.txt` (the
divergence, with each row's history, then the invariant's verdict).

## The invariant

After heal, every run checks **no acknowledged event is ever absent from a converged replica**
(`src/invariant.ts`). Acknowledged is an `authored` line — `mutate` returned ok, with the event's
id, author and sequence. Each device must hold each such event: in its log
(`engine.eventsSince` from nothing), or below a floor its own state stands in for — a
`compacted` floor or `covered` adopted state, with `engine.cursors()` past the event. A device
that recorded a typed refusal (`refused`, e.g. the relay's `retention`) is reported as refused
for the events it lacks rather than as a violation — it was told. Everything else is a
`violation` line in the ledger and the report. Per-table `engine.digest()` must agree across
every device that is not refused.

## Switches

All off by default; the original run is unchanged by any of this.

| flag             | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--grants fault` | Device `a` holds the issuer key. Some other devices start with no grant anywhere and are granted mid-run (by half-time, under fault) through `mesh.grants.issue` on `a`; the device is handed its wire directly, every other peer learns it through sync — `a`'s links send it on registration, the relay's grant cache forwards it, each receiver's links pass it on. A device writing before its own grant is refused locally (`rejected`); one writing before its peers hold it is quarantined there and must be re-offered — though grants travel ahead of events on every path (a session opens with grants, the relay hands its grant cache over first), and no run has reached that quarantine yet. The oracle still demands convergence. |
| `--blobs`        | A write sometimes `mesh.blobs.put`s seeded bytes first and references the hash in its title. After heal every device `fetch`es every referenced blob; the bytes must be identical and hash (sha-256, computed here) to the reference. A device with no blob-carrying medium — Bluetooth carries none — answers `NoSuchCapability`, which is recorded, not counted.                                                                                                                                                                                                                                                                                                                                                                               |
| `--retention`    | The relay keeps events for 400 ms (`retention.keepEventsFor`), awake devices `engine.compact` at random mid-run with `forgetPeersAfter` 200 ms and once more before heal, and one device (the _sleeper_) is dark from tick 0 until heal. The relay's `retention` refusal is read off the socket's close reason into a `refused` line.                                                                                                                                                                                                                                                                                                                                                                                                            |

Any switch also makes every radio re-advertise once a tick, as a real one does continuously: the
virtual air only announces when asked, and a link a door refused, or one that failed, is only
ever rebuilt by a later advertisement.

## Many runs

```sh
bun run --cwd chaos soak -- --seeds 1..20 --switches none,grants,blobs,retention --devices 6 --ticks 25
```

One process per run (`src/soak.ts`), so a hang is one red row (`--timeout` seconds, default
300). `--jobs N` runs N at once; timing-sensitive faults shift under load, so a failure found in
parallel is replayed alone. Prints a table, writes it to `.chaos/soak.txt`, and exits non-zero if
any run did. Switch sets: `none`, `grants`, `blobs`, `retention`, `all`.

## What is real and what is faked

Real: the relay, over a real socket. The relay transport, with its own reconnect. The BLE
transport — dial rule, fragmenting, session handshake — over the same virtual air the
`@syncmesh/ble` unit tests run against. The engine, the policies, the grants.

Faked: the radio hardware, and the network's willingness to carry a packet. Those are the two
things a test has to be able to take away.

## What it does to them

Per tick, at random and while writes are in flight: a device's relay link flips; a device's radio
range changes to hear some subset of its neighbours; a device goes dark on every link at once and
keeps writing; packets vanish in the air. Then everything is healed and given time to settle.
What is missing after that is missing.

Device `a` is relay-only, `b` is on both, `c` is Bluetooth-only, and the rest are drawn from the
seed — `connected()` refuses a wiring with no path between every device, because an oracle asking
for convergence across a partitioned mesh reports losses that were never possible.

## Reading a failure

The oracle is derived from the authored writes, never declared: per cell the highest stamp wins,
and a row deleted after its last write is gone. A divergence prints with that row's history, so
the question "why is `a` missing `n8`" is answered by the lines under it rather than by guessing.

Without `--grants fault`, grants are handed out at boot rather than propagated. Grant distribution
is its own failure, and a run that loses one loses everything after it — so it is its own switch,
not a confound in this one.

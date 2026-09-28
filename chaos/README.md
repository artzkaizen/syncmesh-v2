# @syncmesh/chaos

A mesh of devices under deliberate fault, and a replay log of what happened to every event.

```sh
bun run --cwd chaos run -- --seed 3 --devices 6 --ticks 25
```

Exits non-zero when a device is missing a write. The run is written to `.chaos/run-<seed>/`:
`ledger.jsonl` (every fact, in order) and `report.txt` (the divergence, with each row's history).

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

Grants are handed out at boot rather than propagated. Grant distribution is its own failure, and
a run that loses one loses everything after it — worth its own switch, not worth confounding this.

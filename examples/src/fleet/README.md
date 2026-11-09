# B · A fleet — several relays, one room

The shape for when the relay is your own process and you run more than one of it (D09-B,
API.md §13.5, §14-B). Phones arrive through a load balancer and land on whichever instance it
picked; Postgres carries frames between the instances so a write on one reaches sockets on another.

```sh
docker compose -f examples/src/fleet/compose.yaml up --build
# the holder of the issuer key, against the fleet rather than a relay of its own
RELAY_URL=ws://localhost:5198/acme bun run --cwd examples server
RELAY_URL=ws://localhost:5198/acme bun run --cwd examples device alice "from the fleet"
RELAY_URL=ws://localhost:5198/acme bun run --cwd examples device bob   "and back"
```

nginx round-robins, so `alice` and `bob` land on different instances — which is the only
interesting case, and why there are no sticky sessions here. The compose file runs relays and
nothing else: a relay holds no keys, so the peer that answers `requestGrant` is the same
[`../embedded`](../embedded) server process, pointed at the load balancer with `RELAY_URL`
instead of starting a relay of its own.

## What it demonstrates

**Postgres is a transport between relays, never the relay.** Each container has its own volume and
its own room log; nothing shares storage. An instance **ingests** what it hears rather than only
forwarding it, so each log is the set of frames that reached that instance and any one of them
can serve the next joiner alone.

**Best-effort, and what that actually costs.** `postgres-server --save "" --appendonly no` keeps no
persistence, because a relay never reads back from Postgres — it only publishes and subscribes. But
a frame Postgres drops is **not** re-requested: neither instance knows it existed, so nothing asks
for it. What puts it back is an ordinary cursor exchange — a device that holds the event landing
on the starved instance and pushing everything above the cursors its `hello` advertised, which is
what round-robin without sticky sessions makes happen on the next reconnect. Until then the two
instances hold different logs. [`../__tests__/fleet.test.ts`](../__tests__/fleet.test.ts) drops a
frame and shows exactly that: nobody notices, nobody asks, and the phone that roams is the repair.

**The fan-out is a port, and Bun's Postgres client is a dozen lines against it.**
[`postgres.ts`](postgres.ts) is the whole adapter: `sql.listen`, which keeps a dedicated
connection that actually reads notifications, and `sql.notify`. Frames travel base64, because a
relay frame is signed bytes and a UTF-8 round trip would mangle most of them. `@syncmesh/relay`
imports no driver: `PostgresListener` is structural, so postgres.js, node-postgres or anything
else with `LISTEN`/`NOTIFY` fits the same shape.

**CI runs this file as written** (`.github/workflows/ci.yml`, job `fleet`): the image builds, the
three relays come up, and [`check.ts`](check.ts) sends the server peer and three phones through
nginx. Round robin spreads four peers over three instances, so most grants and notes cross
between them; one pair shares an instance, and the check does not assert which. `RELAY_URL` may also list instances,
comma-separated, which spreads the peers the same way without nginx. Running it found three
faults that `fleet.test.ts`, which uses an in-process fan-out, could not: the relays could not
boot (no keystore for the device key, now `createPlaintextVault()` with its boot notice), the
adapter issued a bare `LISTEN` whose notifications nothing read, so no frame ever crossed, and
a grant request was never fanned out, so a phone on another instance than the server peer was
never granted.

**It is the same room.** `fleet.test.ts` runs the same two-phone scenario against a single relay
and against two fanned-out instances, and compares `tableDigests` across the two hosts — not row
counts, and not an engine against itself. It also checks the two things that made the instances
distinguishable before: that the receiving instance's own log holds the write, and that a device
which narrowed its `interest` is filtered the same way whichever box it landed on.

## What this shape still cannot promise

A phone cannot tell the instances apart **while the fan-out is delivering**. It can when one
drops a frame, and no cursor exchange happens by itself to close the gap. A deployment that needs
the stronger promise gives the instances a shared log — Postgres Streams or the Postgres event store
— rather than a shared bus, which is D09's other half and is not what this example is.

**An instance catches up on a room when it opens it, not before.** It subscribes to a room's
channel when a device first connects to it there, so what was fanned out before then never reached
it. Once its `LISTEN` is acknowledged it greets the fleet — a `hello` on the fan-out carrying its
cursors — and every instance already holding the room answers with the grants it holds and the
events above those cursors (gaps U41). The answer is best-effort like everything else here: an
instance that had the room evicted for idleness answers nothing, and a fleet where no instance
holds the room open has nobody to answer, which is the same as a room nobody has written to since.
Each answering instance sends the whole difference, unpaced, so a room with a long history pays for
it in fan-out traffic once per instance that opens it. A greeting naming more authors than one
notification holds (about 150) names the ones furthest along, and the rest are sent from their
first event.

**A note can arrive before its author's grant**, because the two travel separately between
instances. It is parked, and the grant registering re-offers it (gaps U42), so `check.ts` writes as
soon as each phone is granted rather than waiting for every grant to spread.

## What it deliberately leaves out

- **Anything an operator must decide**: TLS at the edge, a `posture` for who may open a socket,
  authentication in front of nginx, Postgres credentials, health checks past `postgres-cli ping`,
  resource limits, and how many instances is the right number.
- **The server peer in a container.** It is one process with the issuer key in it, unchanged from
  shape A; running it on the host against `RELAY_URL` is the whole difference, so it lives in
  [`../embedded`](../embedded) rather than being written twice.
- **Any Postgres in the actor shape.** D09's watch-out: a Durable Object or Rivet actor has every
  socket for a room routed to it, so there is no second instance to gossip with. Adding this there
  buys a dependency and nothing else.

# B · A fleet — several relays, one room

The shape for when the relay is your own process and you run more than one of it (D09-B,
API.md §13.5, §14-B). Phones arrive through a load balancer and land on whichever instance it
picked; Redis carries frames between the instances so a write on one reaches sockets on another.

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

**Redis is a transport between relays, never the relay.** Each container has its own volume and
its own room log; nothing shares storage. An instance **ingests** what it hears rather than only
forwarding it, so each log is the set of frames that reached that instance and any one of them
can serve the next joiner alone.

**Best-effort, and what that actually costs.** `redis-server --save "" --appendonly no` keeps no
persistence, because a relay never reads back from Redis — it only publishes and subscribes. But
a frame Redis drops is **not** re-requested: neither instance knows it existed, so nothing asks
for it. What puts it back is an ordinary cursor exchange — a device that holds the event landing
on the starved instance and pushing everything above the cursors its `hello` advertised, which is
what round-robin without sticky sessions makes happen on the next reconnect. Until then the two
instances hold different logs. [`../__tests__/fleet.test.ts`](../__tests__/fleet.test.ts) drops a
frame and shows exactly that: nobody notices, nobody asks, and the phone that roams is the repair.

**The fan-out is a port, and node-redis is 20 lines against it.** [`redis.ts`](redis.ts) is the
whole adapter — two connections, because Redis will not take a `PUBLISH` on a connection in
subscriber mode, and `bufferMode: true`, because a relay frame is signed bytes and a UTF-8 round
trip would mangle most of them. `@syncmesh/relay` imports neither package: `RedisPublisher` and
`RedisSubscriber` are structural, so ioredis, NATS, or Postgres `LISTEN/NOTIFY` fit the same shape.

**It is the same room.** `fleet.test.ts` runs the same two-phone scenario against a single relay
and against two fanned-out instances, and compares `tableDigests` across the two hosts — not row
counts, and not an engine against itself. It also checks the two things that made the instances
distinguishable before: that the receiving instance's own log holds the write, and that a device
which narrowed its `interest` is filtered the same way whichever box it landed on.

## What this shape still cannot promise

A phone cannot tell the instances apart **while the fan-out is delivering**. It can when one
drops a frame, and no cursor exchange happens by itself to close the gap. A deployment that needs
the stronger promise gives the instances a shared log — Redis Streams or the Postgres event store
— rather than a shared bus, which is D09's other half and is not what this example is.

## What it deliberately leaves out

- **Anything an operator must decide**: TLS at the edge, a `posture` for who may open a socket,
  authentication in front of nginx, Redis credentials, health checks past `redis-cli ping`,
  resource limits, and how many instances is the right number.
- **The server peer in a container.** It is one process with the issuer key in it, unchanged from
  shape A; running it on the host against `RELAY_URL` is the whole difference, so it lives in
  [`../embedded`](../embedded) rather than being written twice.
- **Any Redis in the actor shape.** D09's watch-out: a Durable Object or Rivet actor has every
  socket for a room routed to it, so there is no second instance to gossip with. Adding this there
  buys a dependency and nothing else.

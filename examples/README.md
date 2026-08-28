# Deployment shapes you can run

D09 says the room logic is one core against two ports, and the hosts are three. Two of them are
yours to deploy; this directory is what running them actually looks like.

| Shape                                                             | Where                          | Runnable here                                                              |
| ----------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| **A · embedded** — `startRelay()` in the backend you already have | [`src/embedded`](src/embedded) | `bun run --cwd examples server`, then `device`                             |
| **B · a fleet** — several relays, Redis between them              | [`src/fleet`](src/fleet)       | `docker compose … up --build`, then `server` and `device` with `RELAY_URL` |
| **C · one actor per room** — a Durable Object                     | `adapters/cloudflare-do`       | its own test suite; there is nothing to deploy from here                   |

Shape C is a library, not a deployment: `relayDurableHost(ctx)` plus the four lines of `fetch` in
the `@example` on it. `adapters/cloudflare-do/src/__tests__/host.test.ts` already runs the same
client against an embedded relay and a Durable Object and compares state digests, which is E25's
done-when for A against C. [`src/__tests__/fleet.test.ts`](src/__tests__/fleet.test.ts) is the same
question for A against B: two phones behind two instances, digests compared across the two hosts.

Both shapes sync one table, [`src/notes.ts`](src/notes.ts) — defined once in Drizzle, synced
through the mesh, and materialised back into that same table on the server.

## Running them

The scripts pass `--conditions=@syncmesh/source`, so the workspace's TypeScript runs directly and
no `vp run -r build` is needed first.

```sh
bun run --cwd examples server              # relay on :5198, your API on :5199
bun run --cwd examples device alice "hi"   # a phone: joins, asks for a grant, writes
curl localhost:5199                        # the notes table, straight out of SQLite
```

`server` reads `RELAY_URL`, `RELAY_PORT`, `API_PORT` and `DATA_DIR` from the environment. Given a
`RELAY_URL` it starts no relay of its own and joins the one already running — which is how the
same process becomes the fleet's issuer, since the containers in shape B hold no keys.

State lands under `examples/.syncmesh/` — delete it to start clean.

## The demo keys are demo keys

[`src/identity.ts`](src/identity.ts) derives every keypair from a name, so a restarted process is
the same peer and its grants still name it. A real device generates a seed once and keeps it in
the platform's keystore; a real issuer's seed comes from a secret manager. A seed anyone can
recompute from a string is a signing key everybody holds.

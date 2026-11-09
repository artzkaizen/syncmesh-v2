import { Temporal } from "@syncmesh/temporal";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Phone } from "../phone.js";

import { openBackend } from "../embedded/backend.js";
import { identityNamed } from "../identity.js";
import { INSTANCE, INVITE, ROOM, notes } from "../notes.js";
import { admitted, phone, until } from "../phone.js";

/**
 * The fleet, checked from outside: `docker compose -f examples/src/fleet/compose.yaml up` and
 * then `bun run --cwd examples fleet:check`. CI runs exactly that (gaps U15).
 *
 * `fleet.test.ts` proves the shape in one process; this proves the containers: the image builds,
 * three relays fan out over a real Postgres, and nginx's round robin spreads the server peer and
 * three phones over the three instances. Four peers on three instances means one pair shares an
 * instance, so most exchanges below cross between instances, the grant requests included, and a
 * fleet whose fan-out is broken fails at the first wait that does.
 */

/**
 * The fleet's address — the load balancer — or several instances' addresses, comma-separated,
 * which the server peer and the phones take in turn: the same spread without nginx.
 */
const URLS = (Bun.env.RELAY_URL ?? `ws://localhost:5198/${ROOM}`).split(",");
const dialing = (n: number): string => URLS[n % URLS.length] ?? `ws://localhost:5198/${ROOM}`;
const WAIT = 30_000;
/**
 * How long a peer's `ready()` and `settled()` wait for its relay's hello: long enough that they
 * mean the room is open on that peer's instance, rather than the transport's one-second default.
 */
const JOINED = Temporal.Duration.from({ seconds: 30 });
const dir = mkdtempSync(join(tmpdir(), "syncmesh-fleet-check-"));

const check = (held: boolean, what: string): void => {
  console.log(`${held ? "ok  " : "FAIL"}  ${what}`);
  if (!held) process.exitCode = 1;
};

// `openBackend` awaits the server peer's own hello before it returns
const backend = await openBackend({ dataDir: dir, relayUrl: dialing(0), readyWithin: JOINED });
// empty until the phones open, so the element type has nothing to be inferred from
const phones: Phone[] = [];
try {
  // one phone at a time, each granted before the next opens: an instance a phone is the first
  // on opens the room then, and asks the fleet for what it missed — the grants fanned out before
  // it was listening included (gaps U41)
  const names = ["alice", "bob", "carol"];
  for (const [n, name] of names.entries()) {
    const mesh = await phone(name, dialing(n + 1), backend.issuer, dir, JOINED);
    phones.push(mesh);
    check(await admitted(mesh, WAIT), `${name} is granted by the server peer through the fleet`);
  }
  const [alice, bob, carol] = phones;
  if (alice === undefined || bob === undefined || carol === undefined)
    throw new Error("three phones were opened");
  // a phone with no grant cannot write: there is nothing further to check
  if (process.exitCode === 1) throw new Error("the fleet granted nobody; its logs say why");

  // written without waiting for alice's grant to reach every phone: a note that lands ahead of
  // its author's grant is parked, and the grant arriving re-offers it (gaps U42)
  await alice
    .on(INSTANCE)
    .unwrap()
    .db.insert(notes)
    .values({ id: "a1", body: "from alice", author: "alice" });
  await alice.flush();
  // the fan-out is best-effort (README): a grant one instance did not hear is asked for again,
  // which mints a newer one and fans it out afresh. Each ask is said, so a run that needed one
  // shows it
  const peers = names.map((name) => identityNamed(`device:${name}`).peerId);
  const lacks = (peer: (typeof peers)[number]) =>
    phones.some((mesh) => mesh.grants.grantFor(peer) === undefined);
  const spread = await until(async () => {
    if (!(await until(() => peers.every((peer) => !lacks(peer)), 5_000))) {
      for (const [n, peer] of peers.entries())
        if (lacks(peer)) {
          console.log(`      ${names[n]}'s grant did not reach every phone; asking again`);
          phones[n]?.requestGrant(INVITE);
        }
      return false;
    }
    return true;
  }, WAIT);
  check(spread, "every phone holds every other phone's grant");
  for (const [n, mesh] of phones.entries()) {
    const missing = names.filter((name) => {
      const peer = identityNamed(`device:${name}`).peerId;
      return mesh.grants.grantFor(peer) === undefined;
    });
    if (missing.length > 0)
      console.log(`      ${names[n]} holds no grant for ${missing.join(", ")}`);
  }
  const count = (mesh: typeof alice) => async () =>
    (await mesh.on(INSTANCE).unwrap().db.select().from(notes)).length;
  for (const [name, mesh] of [
    ["bob", bob],
    ["carol", carol],
  ] as const)
    check(await until(async () => (await count(mesh)()) === 1, WAIT), `${name} sees alice's note`);

  await bob
    .on(INSTANCE)
    .unwrap()
    .db.insert(notes)
    .values({ id: "b1", body: "from bob", author: "bob" });
  await bob.flush();
  check(await until(async () => (await count(alice)()) === 2, WAIT), "alice sees bob's note");
  check(
    await until(async () => (await backend.db.select().from(notes)).length === 2, WAIT),
    "both notes land in the server peer's own table",
  );
} finally {
  for (const mesh of phones) await mesh.stop();
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
}
console.log(process.exitCode === 1 ? "\nthe fleet did not converge." : "\nthe fleet converges.");

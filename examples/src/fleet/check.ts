import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openBackend } from "../embedded/backend.js";
import { INSTANCE, ROOM, notes } from "../notes.js";
import { admitted, phone, until } from "../phone.js";

/**
 * The fleet, checked from outside: `docker compose -f examples/src/fleet/compose.yaml up` and
 * then `bun run --cwd examples fleet:check`. CI runs exactly that (gaps U15).
 *
 * `fleet.test.ts` proves the shape in one process; this proves the containers: the image builds,
 * three relays fan out over a real Postgres, and nginx's round robin puts the server peer and
 * three phones on different instances. Every exchange below crosses between instances, the grant
 * requests included, so a fleet whose fan-out is broken fails at the first wait.
 */

/**
 * The fleet's address — the load balancer — or several instances' addresses, comma-separated,
 * which the server peer and the phones take in turn: the same spread without nginx.
 */
const URLS = (Bun.env.RELAY_URL ?? `ws://localhost:5198/${ROOM}`).split(",");
const dialing = (n: number): string => URLS[n % URLS.length] ?? `ws://localhost:5198/${ROOM}`;
const WAIT = 30_000;
const dir = mkdtempSync(join(tmpdir(), "syncmesh-fleet-check-"));

const check = (held: boolean, what: string): void => {
  console.log(`${held ? "ok  " : "FAIL"}  ${what}`);
  if (!held) process.exitCode = 1;
};

const backend = await openBackend({ dataDir: dir, relayUrl: dialing(0) });
const phones = [];
try {
  // every phone on before any asks: an instance opens a room at its first socket, and a grant
  // fanned out before that is a frame it never hears and nobody sends again (README, "What this
  // shape still cannot promise")
  const names = ["alice", "bob", "carol"];
  for (const [n, name] of names.entries())
    phones.push(await phone(name, dialing(n + 1), backend.issuer, dir));
  for (const [n, mesh] of phones.entries())
    check(
      await admitted(mesh, WAIT),
      `${names[n]} is granted by the server peer through the fleet`,
    );
  const [alice, bob, carol] = phones;
  if (alice === undefined || bob === undefined || carol === undefined)
    throw new Error("three phones were opened");
  // a phone with no grant cannot write: there is nothing further to check
  if (process.exitCode === 1) throw new Error("the fleet granted nobody; its logs say why");

  await alice
    .on(INSTANCE)
    .unwrap()
    .db.insert(notes)
    .values({ id: "a1", body: "from alice", author: "alice" });
  await alice.flush();
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

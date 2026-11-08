import { createClient, sqlite } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { mkdirSync } from "node:fs";

import { identityNamed, serverIdentity } from "../identity.js";
import { INSTANCE, INVITE, ROOM, notes, notesSchema } from "../notes.js";

const DATA_DIR = ".syncmesh/example";
const RELAY_URL = Bun.env.RELAY_URL ?? `ws://localhost:5198/${ROOM}`;
const name = Bun.argv[2] ?? "alice";
const body = Bun.argv[3] ?? `hello from ${name}`;

/** Polls until `check` holds or the window runs out; a phone has no other way to await a peer. */
const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await Bun.sleep(20);
  return check();
};

mkdirSync(DATA_DIR, { recursive: true });

// A phone: its own SQLite, its own keypair, and the issuer's peer id — shipped config, the same
// on every device. `driver` is the whole storage story here; the mesh opens the log, the sidecar
// and the `notes` table on it. No procedures: this phone writes through the mesh's own handle.
const client = createClient({
  schema: notesSchema(),
  identity: identityNamed(`device:${name}`),
  storage: sqlite({ driver: bunSqliteDriver(`${DATA_DIR}/device-${name}.db`) }),
  trust: { issuer: serverIdentity().peerId },
  transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
});
await client.$ready; // `$mesh` throws until the mesh has opened
const mesh = client.$mesh;

await mesh.ready();
await mesh.settled(); // every source has finished its first pass: what to await before drawing

if (!mesh.can("notes.insert", undefined, INSTANCE)) {
  mesh.requestGrant(INVITE);
  const granted = await until(() => mesh.can("notes.insert", undefined, INSTANCE));
  if (!granted)
    throw new Error("no grant arrived: is the server running, and is the invite right?");
  console.log("granted");
}

const handle = mesh.on(INSTANCE).unwrap();
await handle.db.insert(notes).values({ id: `${name}-${Date.now()}`, body, author: name });
await mesh.flush(); // the transport's queue has drained; the relay has the event

console.table(await handle.db.select().from(notes));
await client.$close();

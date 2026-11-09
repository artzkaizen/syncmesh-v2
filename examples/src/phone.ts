import type { PeerId } from "@syncmesh/kernel";

import { createClient, sqlite } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { join } from "node:path";

import { identityNamed } from "./identity.js";
import { INSTANCE, INVITE, notesSchema } from "./notes.js";

/** Polls until `check` holds or `ms` runs out; answers whether it ever did. A phone has no other way to await a peer. */
export const until = async (
  check: () => boolean | Promise<boolean>,
  ms = 8000,
): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return check();
};

/** A phone as `device.ts` builds one: its own SQLite file, its own key, the issuer's id as config. */
export const phone = async (name: string, dialing: string, issuer: PeerId, dir: string) => {
  const client = createClient({
    schema: notesSchema(),
    identity: identityNamed(`device:${name}`),
    storage: sqlite({ driver: bunSqliteDriver(join(dir, `device-${name}.db`)) }),
    trust: { issuer },
    transports: [relayTransport({ dial: webSocketDial(dialing), reconnectMs: 20 })],
  });
  await client.$ready; // `$mesh` throws until the mesh has opened
  return client.$mesh;
};

/** Asks for a grant with the invite and waits until the phone may write. */
export const admitted = async (
  mesh: Awaited<ReturnType<typeof phone>>,
  ms?: number,
): Promise<boolean> => {
  await mesh.ready();
  mesh.requestGrant(INVITE);
  return until(() => mesh.can("notes.insert", undefined, INSTANCE), ms);
};

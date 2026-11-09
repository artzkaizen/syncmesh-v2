import type { PeerId } from "@syncmesh/kernel";

import { createClient, sqlite } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { type Temporal, durationMs } from "@syncmesh/temporal";
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

/**
 * A phone as `device.ts` builds one: its own SQLite file, its own key, the issuer's id as config.
 * `readyWithin` is how long its `ready()` and `settled()` wait for the relay's hello and catch-up
 * before carrying on without them; the relay transport's default when absent.
 */
export const phone = async (
  name: string,
  dialing: string,
  issuer: PeerId,
  dir: string,
  readyWithin?: Temporal.Duration,
) => {
  const client = createClient({
    schema: notesSchema(),
    identity: identityNamed(`device:${name}`),
    storage: sqlite({ driver: bunSqliteDriver(join(dir, `device-${name}.db`)) }),
    trust: { issuer },
    transports: [
      relayTransport({
        dial: webSocketDial(dialing),
        reconnectMs: 20,
        ...(readyWithin && { forceReadyAfter: durationMs(readyWithin) }),
      }),
    ],
  });
  await client.$ready; // `$mesh` throws until the mesh has opened
  return client.$mesh;
};

/** One phone's mesh, as {@link phone} opens it. */
export type Phone = Awaited<ReturnType<typeof phone>>;

/** Asks for a grant with the invite and waits until the phone may write. */
export const admitted = async (mesh: Phone, ms?: number): Promise<boolean> => {
  await mesh.ready();
  mesh.requestGrant(INVITE);
  return until(() => mesh.can("notes.insert", undefined, INSTANCE), ms);
};

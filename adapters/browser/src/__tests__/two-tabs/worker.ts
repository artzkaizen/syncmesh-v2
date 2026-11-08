import { deviceIdentity } from "@syncmesh/client";
import { createClient, sqlite } from "@syncmesh/orpc";
import { syncedTables } from "@syncmesh/schema";
import { wasmSqliteDriver } from "@syncmesh/sqlite-wasm";
import { schemaName } from "@syncmesh/storage";

import type { MeshHost, WirePort } from "../../index.js";

import { hostWorker } from "../../host-worker.js";
import { serveMesh } from "../../host.js";
import { createTabPhases } from "../../phases.js";
import { schema } from "./schema.js";

/**
 * A tab's dedicated worker, hosting a real mesh over OPFS if it wins the election.
 *
 * What `two-tabs.test.ts` drives in a browser: the database is opened here and only here, so the
 * second tab of the origin is served by this worker rather than refused `OpfsPoolHeld` (U11), and
 * the mesh hears every tab's phase through the knock the host reports into (U32).
 */
const open = async (): Promise<MeshHost> => {
  const driver = (
    await wasmSqliteDriver({
      name: "two-tabs",
      schema: schemaName(syncedTables(schema)),
      whenHeld: "wait",
    })
  ).unwrap();
  const identity = (await deviceIdentity(driver)).unwrap();
  const phases = createTabPhases();
  const app = createClient({
    schema,
    identity,
    storage: sqlite({ driver }),
    // the device is its own authority, so it writes the global table with no grant to fetch
    trust: { authority: identity.peerId },
    knocks: [phases.knock],
  });
  await app.$ready;
  return serveMesh(app.$mesh, { phases });
};

let host: Promise<MeshHost> | undefined;

hostWorker((port: WirePort) => {
  host ??= open();
  void host.then((served) => served.accept(port));
});

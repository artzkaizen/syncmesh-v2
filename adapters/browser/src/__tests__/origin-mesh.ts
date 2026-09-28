import type { Router } from "@syncmesh/orpc";

import { createMesh } from "@syncmesh/client";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { FollowerClient, FollowerMesh } from "../client.js";
import type { ServeOptions } from "../host.js";

import { connectMesh } from "../client.js";
import { serveMesh } from "../host.js";
import { linkOver } from "../link.js";

/**
 * One origin with a real mesh in it, and as many tabs as a test wants.
 *
 * Distinct from `origin.ts` beside it, which builds an origin's *election* over a fake lock room
 * and an echo host; this one builds the thing being elected. The two halves meet in `MeshLink`,
 * and each is testable without the other, which is the point of the seam.
 */
export const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

const org = partition("org", { roles: ladder("owner", "member", "viewer") });
export const schema = syncSchema({
  tables: {
    book: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member"), read: role("viewer") }),
    },
  },
});

export const ORG = "acme";
export const ACME = `org:${ORG}`;
const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
export const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 70 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** A fold crosses a port and then a task queue; one turn of the loop is not enough to see it. */
export const settled = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

export interface Tab<R extends Router> {
  /** What a window actually holds: the app's procedures, and the port under `$mesh`. */
  readonly client: FollowerClient<R>;
  readonly mesh: FollowerMesh;
  readonly link: ReturnType<typeof linkOver>;
  /** Drops this tab's port the way its window closing would, without stopping the origin. */
  readonly close: () => void;
}

export interface MeshOrigin {
  readonly mesh: Awaited<ReturnType<typeof openMesh>>;
  readonly host: ReturnType<typeof serveMesh>;
  readonly tab: <R extends Router>(role?: "leader" | "follower", procedures?: R) => Tab<R>;
  readonly stop: () => Promise<void>;
}

const openMesh = async () => {
  const mesh = (
    await createMesh({
      schema,
      identity: device,
      issuer: issuer.peerId,
      driver: bunSqliteDriver(":memory:"),
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_one",
        device: device.peerId,
        role: "member",
        // SAFETY: a test fixture instance in the documented kind:id form
        partitions: [ACME] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();
  return mesh;
};

export async function meshOrigin(options: ServeOptions = {}): Promise<MeshOrigin> {
  const mesh = await openMesh();
  const host = serveMesh(mesh, options);
  return {
    mesh,
    host,
    // a tab is a client: procedures at the top level, the mesh under `$mesh` for the tests that
    // want the port itself
    // SAFETY: the default stands in for a caller that named no procedures, so `R` is inferred as
    // the empty router and the empty object is exactly a value of it — there is nothing to call
    tab: <R extends Router>(role: "leader" | "follower" = "follower", procedures = {} as R) => {
      const channel = new MessageChannel();
      host.accept(channel.port2);
      const link = linkOver(channel.port1, role);
      const client = connectMesh({ link, schema, procedures });
      return { client, mesh: client.$mesh, link, close: () => void client.$close() };
    },
    stop: async () => {
      host.stop();
      await mesh.stop();
    },
  };
}

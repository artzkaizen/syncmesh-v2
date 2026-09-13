import type { Mesh } from "@syncmesh/client";
import type { App } from "@syncmesh/orpc";
import type { Identity } from "@syncmesh/wire";

import { createLink } from "@syncmesh/engine";
import { createApp, createServer, httpLink } from "@syncmesh/orpc";
import { panic } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";

import { authorityHandlers } from "../authority.js";
import { WORKSPACE } from "../domain.js";
import { procedures } from "../procedures.js";
import { issuesSchema, type IssuesPresence } from "../schema.js";

/**
 * A workspace of devices, over real engines and real SQLite.
 *
 * Nothing is mocked. Every test in this folder opens an actual mesh per device, writes through
 * the actual procedures, and carries events between them with the engine's own link — because
 * the questions being asked (does a concurrent reorder converge, does a counter sum, does a rule
 * refuse) are questions about the fold, and a double would answer them by construction.
 */

/** One fixed instant, so a timestamp in an assertion is a timestamp and not a race. */
export const T0 = Temporal.Instant.from("2026-09-01T09:00:00Z");

const bytes = (n: number) => Uint8Array.from({ length: 32 }, (_, index) => (n + index) % 256);

/** The root of trust. In a real deployment this is the org's key, held by the authority. */
export const issuer = createIdentity(bytes(1)).unwrap();

/** Who is in this workspace, and what they may do. The role is the whole of the difference. */
export const CAST = [
  { who: "ada", seed: 40, account: "acct_ada", role: "admin" },
  { who: "bo", seed: 80, account: "acct_bo", role: "member" },
  { who: "chidi", seed: 120, account: "acct_chidi", role: "member" },
  { who: "dalia", seed: 160, account: "acct_dalia", role: "guest" },
  { who: "authority", seed: 200, account: "acct_authority", role: "admin" },
] as const;

export type Who = (typeof CAST)[number]["who"];

export const accountOf = (who: Who): string =>
  CAST.find((one) => one.who === who)?.account ?? panic(`no such person: ${who}`);

const identities = new Map<Who, Identity>();
const identityOf = (who: Who): Identity => {
  const held = identities.get(who);
  if (held !== undefined) return held;
  const seed = CAST.find((one) => one.who === who)?.seed ?? panic(`no such person: ${who}`);
  const made = createIdentity(bytes(seed)).unwrap();
  identities.set(who, made);
  return made;
};

/**
 * Everyone's grant, on every device. A receiver admits an author it can vouch for, so a device
 * that has never heard of the person at the next desk quarantines their writes — which is the
 * point of the ladder, and what `mesh.requestGrant` carries over a link in a real onboarding.
 */
const grants = CAST.map(({ who, account, role }) =>
  issueGrant(issuer, {
    account,
    device: identityOf(who).peerId,
    role,
    // SAFETY: the workspace this fixture runs under, in the documented kind:id form
    partitions: [WORKSPACE] as never,
    validFor: Temporal.Duration.from({ hours: 8 }),
    now: T0,
  }),
);

/** The mesh this app opens: SQLite, and the one presence topic the manifest declares. */
type WorkspaceMesh = Mesh<"sqlite", IssuesPresence>;

const register = (mesh: WorkspaceMesh): void => {
  for (const grant of grants) mesh.grants.register(grant).unwrap();
};

const base = (who: Who) => ({
  schema: issuesSchema(),
  procedures,
  identity: identityOf(who),
  issuer: issuer.peerId,
  driver: bunSqliteDriver(":memory:"),
  now: () => T0,
});

/** One person's device: their identity, their grant, their own SQLite file, the whole API. */
export const openDevice = async (who: Who) => {
  const app = await createApp(base(who));
  register(app.mesh);
  return app;
};

/**
 * The authority: the same node with two extra duties — it runs the `.authority()` bodies and it
 * answers HTTP. A real port rather than a direct call, so the test exercises the wire the device
 * would actually use, error tags and all.
 */
export const openAuthority = async () => {
  const server = await createServer({ ...base("authority"), handlers: authorityHandlers });
  register(server.mesh);
  const listening = Bun.serve({ port: 0, fetch: server.fetch });
  return {
    server,
    url: `http://localhost:${String(listening.port)}/`,
    stop: async () => {
      await listening.stop(true);
      await server.stop();
    },
  };
};

/** A device that can reach an authority — the same app, plus the one link the gate needs. */
export const openDeviceWithAuthority = async (who: Who, url: string) => {
  const app = await createApp({ ...base(who), link: httpLink(url) });
  register(app.mesh);
  return app;
};

/**
 * Puts devices back in range: one exchange each way, then the radio goes away again. Calling it
 * is the test's way of saying "and then they met".
 */
export const settle = async (
  ...meshes: readonly { readonly mesh: WorkspaceMesh }[]
): Promise<void> => {
  for (const left of meshes) {
    for (const right of meshes) {
      if (left === right) continue;
      const link = createLink(left.mesh.engine, right.mesh.engine, { now: () => T0 });
      (await link.catchUp()).unwrap();
      link.close();
    }
  }
};

/** What `openDevice` hands back, for a helper that takes one. */
export type Device = App<typeof procedures, IssuesPresence>;

import { createServer, postgres, sqlite } from "@syncmesh/orpc";
import { postgresDriver } from "@syncmesh/postgres";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { mkdirSync } from "node:fs";

import { authorityHandlers } from "../authority.js";
import { WORKSPACE } from "../domain.js";
import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";
import { certificates } from "./checkpoint.js";

/**
 * The one thing in this tracker that a device cannot do for itself — `bun run --cwd apps/issues authority`.
 *
 * **A server is a node with extra duties, not a different world** (book ch. 19). This process
 * folds events and holds the workspace exactly like a phone does; what it has on top is a body
 * for the router's one `.authority()` leaf and an HTTP door to reach it through. That is the
 * whole difference, and it is why this file is thirty lines rather than a backend.
 *
 * The duty is `issues.claimNumber`, and it earns the round trip twice over: the sequence is
 * `max + 1` over rows **it** holds and no device does, and asking twice gives back the same
 * number rather than burning one. Everything else in the app — filing the issue, editing it,
 * commenting, dragging it across the board — happens on the device with this process switched
 * off, which is what the empty `ENG-•` in the list has been saying all along.
 *
 * **It joins the same relay as every other device**, because it is one. Without that it would
 * hold a workspace nobody had written to, and `claimNumber` would answer `NO_SUCH_ISSUE` for
 * every issue in it — an authority that cannot see what it is deciding about.
 */

const ROOM = "issues";
const RELAY = Bun.env["VITE_RELAY_URL"] ?? `ws://localhost:5241/${ROOM}`;
const PORT = Number(Bun.env["AUTHORITY_PORT"] ?? 5252);

/** The demo issuer, as `identity.ts` mints it: the same bytes on every install of this build. */
const bytes = (seed: number) => Uint8Array.from({ length: 32 }, (_, index) => seed + index);
const issuer = createIdentity(bytes(1)).unwrap();

/**
 * The authority's own key, fixed rather than per-install.
 *
 * Every device ships `trust: { authority }` in its config and compares events against it, so this
 * is one of the two names a build agrees on before it meets anybody — the same reasoning that
 * keeps the issuer fixed. A device that generated it would be a device that could not tell the
 * authority's writes from anyone else's.
 */
export const authority = createIdentity(bytes(200)).unwrap();

/**
 * Where this node folds to — a file by default, the app's own Postgres when it has one.
 *
 * Both are the same store to the engine: a log, the rows it folds to, and the capture that turns
 * a write into an event. What differs is who else is reading. `.syncmesh/issues-authority.db` is
 * this process's own and nobody else's, which is exactly right for `bun run authority` with
 * nothing provisioned; a `DATABASE_URL` says the rows belong in a database an existing backend
 * already queries, and the fold puts them there — `SELECT * FROM issue` from a report or a cron
 * job sees what the mesh agreed on without asking the mesh anything (book ch. 18).
 *
 * `rls` goes with it and only with it: the schema's `read` rules become the database's own row
 * policies, so a hand-written `SELECT` on that connection cannot see past them. It is belt to the
 * fold's braces — every receiver already checks `allow` — and it is Postgres-only because row
 * policies are.
 */
const DATABASE_URL = Bun.env["DATABASE_URL"];

const storage = async () => {
  if (DATABASE_URL === undefined) {
    mkdirSync(".syncmesh", { recursive: true }); // the driver opens a file; it makes no directory
    return sqlite({ driver: bunSqliteDriver(".syncmesh/issues-authority.db") });
  }
  /**
   * `pglite://<dir>` — a real Postgres with nothing to provision, kept in a directory here.
   *
   * The same engine as a server, compiled to wasm and given PGlite's Node filesystem, so the
   * statements this node emits are the statements a server would run and the data outlives the
   * process. What it is for is the gap between the two other answers: a file is not Postgres and
   * proves nothing about this path, and standing up a server is more than anyone will do to try
   * a demo. (It is the test runner PGlite's filesystem cannot abide, not Bun — see the
   * `dumpDataDir` note in `packages/orpc`'s postgres test.)
   */
  if (DATABASE_URL.startsWith("pglite://")) {
    const dir = DATABASE_URL.slice("pglite://".length) || ".syncmesh/pg";
    mkdirSync(dir, { recursive: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const { pgliteDriver } = await import("@syncmesh/postgres");
    return postgres({ driver: pgliteDriver(new PGlite(dir)), rls: true });
  }
  const { default: connect } = await import("postgres");
  return postgres({ driver: postgresDriver(connect(DATABASE_URL)), rls: true });
};

/**
 * Bound after the server exists, because the thing it hashes is the server's own state.
 *
 * The option is read per call rather than held, so handing it a closure that is empty for the
 * first instant is sound: nothing asks for a certificate until a peer requests state, which is
 * necessarily after this process is up.
 */
let taking: (() => Uint8Array) | undefined;

const server = await createServer({
  certificate: () => taking?.(),
  schema: issuesSchema(),
  procedures,
  handlers: authorityHandlers,
  identity: authority,
  trust: { issuer: issuer.peerId, authority: authority.peerId },
  storage: await storage(),
  transports: [relayTransport({ dial: webSocketDial(RELAY) })],
});

// an authority acts as an admin: `patchOnly` is the rule that makes it the only writer of
// `number`, and admin is the one role that rule does not narrow
taking = certificates(server.mesh.engine, issuer);

server.mesh.grants
  .register(
    issueGrant(issuer, {
      account: "acct_authority",
      device: authority.peerId,
      role: "admin",
      // SAFETY: the workspace this build runs under, in the documented kind:id form
      partitions: [WORKSPACE] as never,
      validFor: Temporal.Duration.from({ days: 30 }),
      now: Temporal.Now.instant(),
    }),
  )
  .unwrap();

/**
 * The browser's preflight, answered here rather than by a proxy.
 *
 * The app is served from the dev server's origin and the authority listens on its own, so every
 * `claimNumber` is a cross-origin POST with a JSON content type — which is exactly the pair that
 * makes a browser ask permission first. Without this the call never leaves the tab, and the
 * symptom is indistinguishable from an authority that is switched off: the bullet stays.
 *
 * Wide open because this is a demo binary on a laptop. A deployment puts the authority behind the
 * same origin as the app, or names the origins it serves.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
} as const;

const listening = Bun.serve({
  port: PORT,
  fetch: async (request) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const answered = await server.fetch(request);
    for (const [name, value] of Object.entries(CORS)) answered.headers.set(name, value);
    return answered;
  },
});
console.log(
  `authority on http://localhost:${listening.port} — relays through ${RELAY}; the app dials it unless VITE_AUTHORITY_URL says otherwise`,
);

const stop = async (): Promise<void> => {
  await listening.stop(true);
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

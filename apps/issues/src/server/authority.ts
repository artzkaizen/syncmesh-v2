import { createServer, sqlite } from "@syncmesh/orpc";
import { relayTransport, webSocketDial } from "@syncmesh/relay";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { mkdirSync } from "node:fs";

import { authorityHandlers } from "../authority.js";
import { WORKSPACE } from "../domain.js";
import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";

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

mkdirSync(".syncmesh", { recursive: true });

const server = await createServer({
  schema: issuesSchema(),
  procedures,
  handlers: authorityHandlers,
  identity: authority,
  trust: { issuer: issuer.peerId, authority: authority.peerId },
  storage: sqlite({ driver: bunSqliteDriver(".syncmesh/issues-authority.db") }),
  transports: [relayTransport({ dial: webSocketDial(RELAY) })],
});

// an authority acts as an admin: `patchOnly` is the rule that makes it the only writer of
// `number`, and admin is the one role that rule does not narrow
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
  `authority on http://localhost:${String(listening.port)} — relays through ${RELAY}; the app dials it unless VITE_AUTHORITY_URL says otherwise`,
);

const stop = async (): Promise<void> => {
  await listening.stop(true);
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

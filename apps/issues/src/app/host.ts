import type { MeshHost, WirePort } from "@syncmesh/browser";
import type { EngineError } from "@syncmesh/engine";
import type { Client } from "@syncmesh/orpc";
import type { SqlDriver } from "@syncmesh/storage";

import { MeshCallFailed, serveMesh } from "@syncmesh/browser";
import { deviceIdentity } from "@syncmesh/client";
import { createInspectorHost } from "@syncmesh/devtools";
import { createClient, httpLink, sqlite } from "@syncmesh/orpc";
import { Result, serializeTagged } from "@syncmesh/result";
import { syncedTables } from "@syncmesh/schema";
import { wasmSqliteDriver } from "@syncmesh/sqlite-wasm";
import { schemaNameFor } from "@syncmesh/storage";

import type { Procedures } from "../procedures.js";
import type { IssuesPresence } from "../schema.js";

import { WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";
import { seedWorkspace } from "../seed.js";
import { AUTHORITY_PEER, AUTHORITY_URL, issuer } from "./identity.js";
import { serveInstall } from "./install.js";
import { dialRelay } from "./relay.js";

/**
 * The tracker's one engine, in the one thread that may hold it.
 *
 * **This module is loaded by the worker that won and by no other**, which is the whole reason it
 * is a module rather than the body of `mesh-worker.ts`. That file documented the property — *"a
 * worker that loses the election holds a queued lock request and nothing else"* — and was only
 * ever true of runtime work: it named seventeen static imports, so every tab of this origin pulled
 * Drizzle, Zod, the schema, the seed data, SQLite's wasm binding and the inspector through Vite
 * before it could contend for a lock it was probably going to lose. Measured at 250 modules
 * against the 2 the election needs. Now the loser loads those two and stops.
 *
 * Everything the app used to do in the page is here: the database, the log, the device's key, its
 * grant and the seed. A tab holds a thin client of it and no database of its own, so two tabs are
 * one device with two windows — one identity, one log, one allocation of `(author, seq)` — rather
 * than two engines writing under one name, which is the silent corruption
 * `research/browser-durability.md` §4 exists to prevent.
 *
 * **Two browser profiles are two devices, and that is now a thing this file has to earn.** The
 * same corruption §4 describes across two tabs is available across two installs the moment a relay
 * joins them: one author, two divergent sequence streams, and the loser's writes dropped as stale
 * rather than refused. So the key is read out of this origin's own database before an engine is
 * opened over it — see `identity.ts` — and every install signs under a name only it holds.
 */

/** One OPFS file for this app. A second mesh in this origin would name a second one (D07). */
const DATABASE = "issues";

/**
 * The account a refusal carries, which is not always on the error itself.
 *
 * **A `cause` is appended rather than discarded**, because the sentence that identifies a failure
 * is routinely one hop under the one that reports it: `OpfsUnavailable` wraps whatever the browser
 * refused with, and reading only `.message` threw the browser's own words away. That is not
 * hypothetical — it is how a Gecko browser refusing this origin an OPFS reached the screen as
 * `this origin's database would not open:` and nothing after the colon.
 *
 * The tag stands in where a message is empty, so an error can be silent in its sentence but never
 * silent on screen.
 */
const reasonOf = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  const said = cause.message === "" ? cause.name : cause.message;
  return cause.cause === undefined ? said : `${said} — ${reasonOf(cause.cause)}`;
};

/**
 * A refusal shaped so it survives the port.
 *
 * `MeshCallFailed` is in the wire's catalog, so the tab revives it as itself and shows the
 * sentence rather than a spinner. A worker that could not build a mesh has no other way to say
 * so: the page is waiting on a port, not on a promise in its own thread.
 */
const refused = (what: string) => (cause: unknown) =>
  new MeshCallFailed({ path: "open", message: `${what}: ${reasonOf(cause)}` });

/**
 * Fills the workspace on the first run and never again — **once per origin, not once per tab.**
 *
 * Idempotent against the *data*, not against a flag in local storage: a flag can outlive the
 * database it describes — clear the OPFS file and it still says "seeded" — whereas a count of
 * issues is read from the thing it is a fact about. `summary` is already the read the header
 * wants, so this costs nothing extra.
 *
 * Two tabs racing at boot cannot double-seed, and the reason is upstream of this check: only the
 * elected worker is ever handed a port, so only one thread of the origin ever reaches here.
 *
 * **Two installs racing at boot cannot double-seed either, and the wait for that is paid only by
 * the boot that could double-seed.** A second profile joining a room somebody has already seeded
 * must read the workspace off the relay rather than author a second copy of it: the copies would
 * converge, because the seed is deterministic down to the ids and the instants, but a log with two
 * authors for every row is a log nobody can read, and reading an event list is what this app is
 * for. So the sources are waited on — `settled()`, nearest first (RFC-0019).
 *
 * **The local count is asked first, and that is the whole of the boot cost.** A device that
 * already holds the workspace has settled the question out of its own database, for one query and
 * no network at all; only a device that counts zero has anything to wait for. Gating the wait on
 * the answer rather than the other way round is what keeps a warm boot independent of whether a
 * relay is running — which is what `replica.ts` promises when it says pulling the cable changes
 * nothing on screen.
 */
const seedOnce = (app: Client<Procedures, IssuesPresence>) => {
  /** The one read the boot makes: awaited as a `Result`, so a refused count is this gen's `Err`. */
  const counted = async () =>
    (await app.issues.summary({ workspaceId: WORKSPACE_ID })).mapError(
      refused("the workspace could not be counted"),
    );
  return Result.gen(async function* () {
    const [before] = (yield* await counted()).data;
    if (before !== undefined && before.total > 0) return Result.ok(undefined);
    await app.$mesh.settled();
    // asked again, because that is what the wait was for: a relay that had the room has filled it
    const [after] = (yield* await counted()).data;
    if (after !== undefined && after.total > 0) return Result.ok(undefined);
    const handle = yield* app.$mesh
      .on(WORKSPACE)
      .mapError(refused(`this build names a workspace the manifest rejects: ${WORKSPACE}`));
    yield* await Result.tryPromise({
      // no `now`: the seed's own default instant is what makes two installs byte-identical, which
      // is what an event list and a screenshot diff both need
      try: () => seedWorkspace(handle.db, {}),
      catch: refused("the workspace could not be seeded"),
    });
    return Result.ok(undefined);
  });
};

/**
 * The pool the tab that just closed was holding is not always back yet, so this waits to be handed it.
 *
 * The mesh lock and the OPFS access handles are both released by the browser when the leader's
 * context dies, and nothing orders the two — so a worker promoted in that instant can win the
 * election and still be refused the files for a moment. This used to be a five-attempt, 150ms poll:
 * a 750ms budget, spent in a tab where an earlier measurement found `setInterval` clamped to a
 * second, and when it ran out the app drew "The replica would not open" over a database that was
 * about to be fine.
 *
 * `whenHeld: "wait"` is the same waiting done by the primitive that is good at it. A queued Web
 * Lock resolves the instant the previous holder is released — including when the holder was a
 * context the browser reaped — with no polling and no budget to run out of. **Only a caller that
 * has won the election may ask for it**, which this one has: `openHost` runs on the port, and a
 * port is only ever handed to the winner.
 */
const openDriver = () =>
  wasmSqliteDriver({
    name: DATABASE,
    // the log keeps `DATABASE`; the folded half is named after the schema, so a deploy that adds
    // a column opens an empty file and refolds into it rather than migrating a tab's rows
    schema: schemaNameFor(syncedTables(issuesSchema())),
    whenHeld: "wait",
  });

/**
 * The OPFS root this origin's databases live under, named here because removing it is the one
 * thing the adapter that created it does not offer.
 *
 * `/syncmesh` is `@syncmesh/sqlite-wasm`'s own default (`adapters/sqlite-wasm/src/driver.ts`), and
 * a second copy of a constant is normally the thing this codebase refuses to write. It is written
 * anyway because the alternative is worse: the adapter's pool holds a slot file per database *and*
 * per journal under opaque names it chose, so there is nothing an app could remove one file at a
 * time, and a reset that deleted the wrong subtree would be a reset that corrupted the rest.
 */
const ROOT = "syncmesh";

/**
 * Throws this install away: the mesh, the connection, and then the files underneath both.
 *
 * **The order is the whole of it.** The access-handle pool takes exclusive handles for every slot
 * in {@link ROOT} the moment it installs, and a directory whose files are held open cannot be
 * removed by anybody — this worker included. `$close` stops the transports and the engine but
 * deliberately leaves the connection open, because a driver you passed stays yours to close
 * (`client/src/boot.ts`); closing it is what takes the pool to zero, and at zero the pool pauses
 * and hands the handles back. Only then is there anything to delete.
 *
 * It does not reload anything. The windows are told (`install.ts`), and each of them decides — a
 * worker has no page to navigate, and a reset performed for a person who then sees the last frame
 * of a database that no longer exists is the failure this is meant to end rather than cause.
 */
const wipe = async (close: () => Promise<void>, driver: SqlDriver): Promise<void> => {
  await close();
  await driver.close?.();
  const gone = await Result.tryPromise({
    try: async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(ROOT, { recursive: true });
    },
    catch: reasonOf,
  });
  // a reset that silently did nothing is the worst outcome here: the app comes back looking
  // identical, and the person who asked for a cold join has no way to tell they did not get one
  console.log(`[syncmesh] reset: ${gone.isOk() ? "database deleted" : `refused — ${gone.error}`}`);
};

/**
 * What the engine reports, in the one thread that can hear it.
 *
 * This is a console line rather than a design, because a worker has no screen — the surface that
 * matters is the devtools Writes panel, which reads the same audit back through the inspector.
 * What the line buys is the report nobody went looking for: `openEngine` audits the log for
 * writes this install can never sign *while it opens*, which is the one moment a device that
 * rotated its key over a kept log can be told so, and it happens before `createApp` has returned
 * anything a caller could have subscribed to. Without this the audit would run and speak to
 * nobody, which is the silence it was written to end.
 */
const report = (error: EngineError) => console.warn(`[syncmesh] ${error._tag}: ${error.message}`);

/**
 * The mesh, over the best database this thread can have.
 *
 * `wasmSqliteDriver` opens in place here rather than starting a worker of its own, because this
 * thread already is one — which is the whole reason the engine moved: both OPFS backends are
 * built on `createSyncAccessHandle`, and the File System API exposes that method in dedicated
 * workers and nowhere else. `"auto"` therefore resolves to the access-handle pool, and to memory
 * only in a browser where no thread could have been durable; a thread that *could* have had the
 * pool and was refused gets an error, which is refused to the tab rather than served quietly.
 */
const buildHost = (): Promise<Result<MeshHost, MeshCallFailed>> =>
  Result.gen(async function* () {
    const driver = yield* (await openDriver()).mapError(
      refused("this origin's database would not open"),
    );
    // asked before the client rather than left to it, because this app's transports want the peer
    // id at construction — `createClient` would mint the same key out of the same table
    const device = yield* (await deviceIdentity(driver)).mapError(
      refused("this install's device key would not open"),
    );
    const app = yield* await Result.tryPromise({
      try: async () => {
        const opened = createClient({
          schema: issuesSchema(),
          procedures,
          identity: device,
          // grouped because they are one decision each, not seven fields that happen to be here
          trust: { issuer: issuer.peerId, authority: AUTHORITY_PEER },
          storage: sqlite({ driver }),
          transports: dialRelay(device.peerId),
          link: httpLink(AUTHORITY_URL),
          onError: report,
        });
        await opened.$ready;
        return opened;
      },
      catch: refused("the mesh could not open over the database"),
    });
    // who this install is, read out of the same database the device key came from, and the grant
    // that says so — every window of this origin is told, and told again whenever it moves
    yield* (
      await serveInstall({
        driver,
        issuer,
        device: device.peerId,
        grants: app.$grants,
        wipe: () => wipe(app.$close, driver),
      })
    ).mapError((failure) => refused("this install could not say who it is")(failure.message));
    yield* await seedOnce(app);
    // the inspector is an argument and not a flag: a build that dropped this line serves an origin
    // whose windows can read their own data and learn nothing about the device carrying it, and
    // nothing here subscribes to anything until some tab actually opens the panel
    return Result.ok(serveMesh(app.$mesh, { inspector: createInspectorHost(app.$mesh) }));
  });

/** Answers every call on this port with the reason there is no mesh behind it, and nothing else. */
const sorry = (port: WirePort, failure: MeshCallFailed): void => {
  port.onmessage = (event) => {
    // SAFETY: the only sender is this origin's own `connectMesh`, whose every ask carries an id
    const { id } = event.data as { readonly id?: number };
    if (id !== undefined) port.postMessage({ id, ok: false, error: serializeTagged(failure) });
  };
};

/**
 * The mesh behind every port this worker is handed, or the reason there is none.
 *
 * One promise for the whole worker: `serve` is synchronous and building a mesh is not, so a port
 * waits on the promise every other port waits on and they are accepted in arrival order. A
 * `MessagePort` buffers what the tab says until someone reads it, so nothing said during the wait
 * is lost.
 */
export async function openHost(): Promise<(port: WirePort) => void> {
  const ready = await buildHost();
  return ready.match({
    ok: (host) => (port: WirePort) => void host.accept(port),
    err: (failure) => (port: WirePort) => sorry(port, failure),
  });
}

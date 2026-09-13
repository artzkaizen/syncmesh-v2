import type { FollowerMesh, MeshLink, MeshLinkFailure } from "@syncmesh/browser";
import type { Api } from "@syncmesh/orpc";

import { connectMesh, openMeshLink, rendezvousAvailable } from "@syncmesh/browser";
import { meshApi } from "@syncmesh/orpc";
import { Result, TaggedError } from "@syncmesh/result";

import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";
import { ACTOR } from "./identity.js";

/**
 * The tracker's replica, opened **for the tab** and held for the origin.
 *
 * This is the whole claim the app is making, so it is worth stating precisely: there is no server
 * in this file, and there is no database either. One dedicated worker per origin — `mesh-worker.ts`,
 * elected by `navigator.locks` — opens a real SQLite database over the origin private file system
 * and holds the only engine; this page opens a port to whichever tab won and reads and writes
 * across it. Every read the UI performs is still a local query against that database. Pull the
 * network cable and nothing on screen changes, which is a different sentence from "the cache still
 * has some of it".
 *
 * **Two tabs are one device with two windows.** They share an identity, a log and one allocation
 * of `(author, seq)`, because there is one engine and the second tab is a client of it. That is
 * what makes a write in one tab appear in the other without a reload, and it is also the only
 * shape that is *sound*: two engines over one log stamp events below ones peers have already seen
 * and lose them silently (`research/browser-durability.md` §4). Which tab holds the engine is in
 * the header, along with the case where an origin has no rendezvous and only one tab can be live.
 *
 * **There is a transport now, and the claim this file used to make about adding one was two
 * thirds right.** It said adding a relay was a line in `mesh-worker.ts` and that nothing in the
 * app would move. The line is one line — `transports: dialRelay(device.peerId)` — and nothing
 * *above this file* moved: no component, no query, no route, because nothing up there knows a
 * transport exists. What it got wrong is that a second device is not a transport feature. Every
 * install of this build presented the same `peerId`, because the device key came out of the
 * bundle; joining two of them to one relay would have made one author with two divergent sequence
 * streams, and the loser's writes would have been dropped as already-seen rather than refused. So
 * two files moved that this comment did not predict: `identity.ts`, where the key is now generated
 * per install and read back out of the database, and `reach.ts`, because a relay that is not
 * running must not look like one that is.
 *
 * The claim underneath is unchanged and is still the harder one. Pull the network cable and
 * nothing on screen changes: the relay is a *source*, priority 1, sitting behind this device's own
 * storage at priority 0, and every read the UI performs is still a local query.
 */

/**
 * The replica could not be opened, with the reason in a sentence a person can act on.
 *
 * One tagged error rather than the union of everything underneath, because the screen that
 * renders it has exactly one thing to say and no branch to take: the app cannot start, here is
 * why. The original travels as `cause` for the console.
 */
export class ReplicaUnavailable extends TaggedError("ReplicaUnavailable")<{
  message: string;
  cause?: unknown;
}> {}

/** Everything a screen needs from the mesh, and nothing it does not. */
export interface Replica {
  /** The only surface a component touches: `api.issues.list(…)`, never Drizzle and never a handle. */
  readonly api: Api<typeof procedures>;
  /**
   * The window's own view of the origin's mesh — a thin client over a port, never an engine.
   *
   * A `FollowerMesh` and not a `Mesh`, in the leader's tab as much as in any other, because both
   * hold exactly the same thing: a port to the worker that owns the engine. Typing the leader's
   * as more would be claiming a surface this page does not have, and would put a branch in every
   * component that reads it.
   */
  readonly mesh: FollowerMesh;
  /**
   * Whether the origin's one database has a file underneath it.
   *
   * Carried up to the UI rather than logged, because a memory database is a different product —
   * see `StorageBadge`, which is the one part of the chrome that exists solely to keep this app
   * from telling the user something untrue.
   */
  readonly durable: boolean;
  /** Whether this tab's own worker holds the engine, or it is reading another tab's. */
  readonly role: MeshLink["role"];
  /**
   * Whether tabs of this origin can share the engine at all.
   *
   * False is single-tab mode: there is no `SharedWorker` here — Chrome on Android — so one tab of
   * this origin is live and every other one is told so rather than quietly opening a second
   * database. The header says which mode it is in before anything has failed.
   */
  readonly shared: boolean;
  /** Who this tab is acting as. Every write takes it, because a handler cannot ask the mesh. */
  readonly actor: string;
}

const unavailable = (message: string) => (cause: unknown) =>
  new ReplicaUnavailable({ message, cause });

const NO_WORKER =
  "this tab could not start the dedicated worker that holds the mesh; a Content-Security-Policy " +
  "without worker-src is the usual cause";

/** `HostWorkerUnavailable` carries only its cause, because the sentence is the same every time. */
const sentenceOf = (failure: MeshLinkFailure) =>
  failure._tag === "HostWorkerUnavailable" ? NO_WORKER : failure.message;

const startWorker = () =>
  new Worker(new URL("./mesh-worker.js", import.meta.url), { type: "module" });

/**
 * Whether the origin's database has a file, asked of the database rather than assumed.
 *
 * The tier is decided in the worker and a window cannot see the decision — a follower's engine is
 * in another tab entirely — so the page asks the one question whose answer is a consequence of it.
 * SQLite forces an in-memory database's journal to `memory` and will not be talked out of it; a
 * database with a file gets `delete`, because both OPFS backends refuse WAL. One round trip at
 * boot, on a port the app is holding anyway — and it doubles as the proof that there is a mesh at
 * the other end, since a worker that could not build one answers this with the reason.
 */
const durabilityOf = (mesh: FollowerMesh) =>
  Result.tryPromise({
    try: async () => {
      const [journal] = (await mesh.query?.("PRAGMA journal_mode")) ?? [];
      const mode = journal?.[0];
      // no answer is not an answer: only a mode that is there and is not `memory` is a file
      return mode !== undefined && mode !== "memory";
    },
    catch: unavailable("the mesh this tab reached could not answer for the database behind it"),
  });

const openOnce = (): Promise<Result<Replica, ReplicaUnavailable>> =>
  Result.gen(async function* () {
    const link = yield* (
      await openMeshLink({ worker: startWorker, onPromoted: () => void reopen() })
    ).mapError(
      (failure) => new ReplicaUnavailable({ message: sentenceOf(failure), cause: failure }),
    );
    const mesh = connectMesh({ link, schema: issuesSchema() });
    // registered before the first call, so a host that dies mid-boot is a reconnect and not a
    // failure screen over a link nobody is watching any more
    link.onLost(() => void reopen());
    const durable = yield* await durabilityOf(mesh);
    // awaited once: a window builds `syncOf` SQL correlated on this origin's author id, and the
    // port cannot answer that synchronously
    const self = await mesh.selfId();
    return Result.ok({
      api: meshApi({ ...mesh, self }, procedures),
      mesh,
      durable,
      role: link.role,
      shared: rendezvousAvailable(),
      actor: ACTOR,
    });
  });

type Opened = Result<Replica, ReplicaUnavailable>;

let opening: Promise<Opened> | undefined;
let held: Replica | undefined;
let reopening = false;
let again = false;
const watchers = new Set<(opened: Opened) => void>();

const remember = (opened: Opened): Opened => {
  if (opened.isOk()) held = opened.value;
  return opened;
};

/**
 * The leader's tab went, or this tab was promoted into its place.
 *
 * A handover is a reconnect: the worker, the election and the rendezvous are all still running,
 * so what has to be rebuilt is the link and the client over it — not a database, and not a boot.
 *
 * **A reconnect asked for while one is in flight starts another one, and dropping it is not the
 * same thing.** A promoted tab is told twice — once as a link that died and once as a role that
 * changed — and the second telling arrives *after* the first has already drawn a new link, which
 * it then takes down with the rest. Measured: a survivor that ignored the second notice sat on a
 * link that had been killed a millisecond after it was made, and showed "the mesh this tab
 * reached could not answer" over a mesh that was fine. So the notice is remembered and the build
 * runs again, which settles the moment nothing has died underneath it.
 */
const reopen = async (): Promise<void> => {
  if (reopening) {
    again = true;
    return;
  }
  reopening = true;
  const gone = held;
  let opened: Opened;
  do {
    again = false;
    opening = openOnce().then(remember);
    opened = await opening;
  } while (again);
  reopening = false;
  // the old client is talking to a worker that is no longer the host; its port is already closed
  void gone?.mesh.stop();
  for (const watch of watchers) watch(opened);
};

/**
 * The replica, opened once per tab however many times this is called.
 *
 * Memoised at module scope rather than in a hook, because opening twice is not slow — it is
 * wrong. The election is the *tab's*, and a second worker under one tab would be a second
 * contender wearing the same face; React's development double-effect would produce exactly that
 * on every reload.
 */
export function openReplica(): Promise<Opened> {
  opening ??= openOnce().then(remember);
  return opening;
}

/**
 * The replica changed underneath the screen, which happens when the tab holding the engine goes.
 *
 * A callback rather than a promise because there is no last answer: a tab may be a follower, then
 * the leader, then a follower again, and each of those is a new client over a new port. It also
 * carries the one recovery worth having — a tab told there was no rendezvous can be promoted
 * later, and the app it could not draw arrives here.
 */
export function onReplica(listener: (opened: Opened) => void): () => void {
  watchers.add(listener);
  return () => void watchers.delete(listener);
}

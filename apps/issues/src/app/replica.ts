import type { FollowerClient, FollowerMesh, MeshLink, MeshLinkFailure } from "@syncmesh/browser";

import { connectMesh, openMeshLink, rendezvousAvailable } from "@syncmesh/browser";
import { Result, TaggedError, panic } from "@syncmesh/result";

import { procedures } from "../procedures.js";
import { issuesSchema } from "../schema.js";

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

/**
 * Everything a screen needs from the mesh, and nothing it does not.
 *
 * **Who this tab is acting as is deliberately not here.** It used to be — one field, a constant
 * read out of `identity.ts` — and that was honest only while the answer could never change. It can
 * now: the actor is a row in the origin's database, chosen by a person, and a second window that
 * kept its own copy would go on attributing comments to whoever it was told at boot. So it is a
 * fact about the *install* rather than about this object, it is held by the worker that holds the
 * database, and it reaches the screens through `install.ts` and `useActor` instead.
 */
export interface Replica {
  /**
   * The client over this link: the procedures, and the window's `$` surfaces beside them.
   *
   * A `FollowerClient` and not a `Client`, in the leader's tab as much as in any other, because
   * both hold exactly the same thing: a port to the worker that owns the engine. Typing the
   * leader's as more would be claiming a surface this page does not have, and would put a branch
   * in every component that reads it. `api.$mesh` is the port half, for the few callers that
   * want it by that name.
   */
  readonly api: FollowerClient<typeof procedures>;
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
    const client = connectMesh({ link, schema: issuesSchema(), procedures });
    // registered before the first call, so a host that dies mid-boot is a reconnect and not a
    // failure screen over a link nobody is watching any more
    link.onLost(() => void reopen());
    const durable = yield* await durabilityOf(client.$mesh);
    // awaited once: a window builds `syncOf` SQL correlated on this origin's author id, and the
    // port cannot answer that synchronously. `connectMesh` is already asking; this is the wait
    await client.$ready;
    return Result.ok({
      api: client,
      durable,
      role: link.role,
      shared: rendezvousAvailable(),
    });
  });

type Opened = Result<Replica, ReplicaUnavailable>;

/** The replica this tab holds and which one it is, because the second has to **replace** the first. */
export interface Held {
  readonly replica: Replica;
  /**
   * Counts the links this tab has held; keys the tree.
   *
   * Every live query in the tree is subscribed to the mesh it was built against, and the hooks
   * key a subscription on the *question* rather than on the mesh — `useLiveQuery`'s own contract,
   * and the right one for an app whose mesh outlives its screens. A handover breaks that
   * assumption once: the old subscriptions are on a port that is closed, and a tree that merely
   * re-rendered would go on showing the last rows it was given over a database that has moved
   * on. So the epoch keys the tree and the whole of it is rebuilt — and what the rebuild no
   * longer costs is the screen, because the filters and the open issue are in the address bar and
   * the router is built once, outside the key.
   */
  readonly epoch: number;
}

/** What this tab holds and the last reason it could not: one snapshot, for `useSyncExternalStore`. */
export interface ReplicaState {
  /** `undefined` until the first open succeeds. */
  readonly held: Held | undefined;
  /** The last open or reopen that failed, cleared by the next that succeeds. */
  readonly failure: ReplicaUnavailable | undefined;
}

let state: ReplicaState = { held: undefined, failure: undefined };
let opening: Promise<Opened> | undefined;
let reopening = false;
let again = false;
const watchers = new Set<() => void>();
const heldOnce = Promise.withResolvers<void>();

const remember = (opened: Opened): Opened => {
  if (opened.isErr()) {
    // the screen renders the reason as prose; this is the live error, whose fields — which VFS
    // was refused, which directory is held — are the ones a bug report is actually written from
    // eslint-disable-next-line no-console -- there may be no screen yet to put it on
    console.error("[syncmesh] the replica would not open", opened.error);
    state = { held: state.held, failure: opened.error };
    return opened;
  }
  state = {
    held: { replica: opened.value, epoch: (state.held?.epoch ?? 0) + 1 },
    failure: undefined,
  };
  heldOnce.resolve();
  return opened;
};

const announce = (): void => {
  for (const watch of watchers) watch();
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
 * runs again, which settles the moment nothing has died underneath it — and only the settled
 * outcome is announced, so the tree is not rebuilt over a link about to die.
 */
const reopen = async (): Promise<void> => {
  if (reopening) {
    again = true;
    return;
  }
  reopening = true;
  const gone = state.held?.replica;
  do {
    again = false;
    opening = openOnce().then(remember);
    await opening;
  } while (again);
  reopening = false;
  // the old client is talking to a worker that is no longer the host; its port is already closed
  void gone?.api.$close();
  announce();
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
  opening ??= openOnce()
    .then(remember)
    .then((opened) => {
      announce();
      return opened;
    });
  return opening;
}

/**
 * The replica changed underneath the screen, which happens when the tab holding the engine goes.
 *
 * A callback rather than a promise because there is no last answer: a tab may be a follower, then
 * the leader, then a follower again, and each of those is a new client over a new port. It also
 * carries the one recovery worth having — a tab told there was no rendezvous can be promoted
 * later, and the app it could not draw arrives here. The listener reads {@link replicaState}.
 */
export function onReplica(listener: () => void): () => void {
  watchers.add(listener);
  return () => void watchers.delete(listener);
}

/** The current snapshot; the same object until something changes, as `useSyncExternalStore` needs. */
export const replicaState = (): ReplicaState => state;

/** This app's procedures, bound over whichever link the tab holds. */
type Client = FollowerClient<typeof procedures>;

const current = (): Client =>
  state.held?.replica.api ?? panic("no link is held yet — read the client under <mesh.Provider>");

/**
 * The client, as one object for the life of the tab.
 *
 * A leader handover is a new link and a new `FollowerClient` over it, and `syncmeshReact` binds
 * one client once — so this is the façade the handover happens behind: every property read
 * resolves against the client of the link currently held, and nothing above this file learns that
 * the port moved. What does still move is the tree: `main.tsx` keys it on {@link Held.epoch},
 * because a subscription taken on the old port is dead however this reads.
 */
export const client: Client = new Proxy(
  // SAFETY: every read resolves against a `Client`; the empty target is never read itself
  {} as Client,
  {
    // SAFETY: a name that is not a `Client` member reads `undefined` off the held client, which is
    // exactly what the target would have answered
    get: (_, key) => current()[key as keyof Client],
  },
);

/**
 * Starts the open and resolves with {@link client} the first time a link is held — however many
 * attempts that takes, which is why it never rejects: a tab told there is no rendezvous can be
 * promoted a minute later, and the failure in between is drawn from {@link replicaState}.
 */
export function openClient(): Promise<Client> {
  void openReplica();
  return heldOnce.promise.then(() => client);
}

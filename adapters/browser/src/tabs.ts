import { Result } from "@syncmesh/result";

import type { Control, Standing } from "./election.js";
import type { MeshLinkFailure } from "./errors.js";
import type { DirectLink, MeshLink } from "./link.js";
import type { CarrierPort, Rendezvous } from "./rendezvous.js";

import { HostWorkerUnavailable, NoElection, NoRendezvous } from "./errors.js";
import { linkOver } from "./link.js";
import { rendezvousOver } from "./rendezvous.js";

/** The OPFS root `wasmSqliteDriver` defaults to; one election per tree of databases. */
const SCOPE = "/syncmesh";

/** Named so a human reading `chrome://inspect` or `navigator.locks.query()` can tell them apart. */
const RENDEZVOUS = "syncmesh-rendezvous";

/**
 * The lock the election runs on, and it is deliberately **not** the pool's.
 *
 * `adapters/sqlite-wasm` takes `syncmesh-opfs:<directory>` with `ifAvailable` immediately before
 * it installs the access-handle pool, to turn "another tab has the files" into a plain yes/no.
 * This one elects the owner of the *engine*, and the two must stay separate for a mechanical
 * reason: the elected worker goes on to open a database, which asks for the pool lock on the same
 * thread — and a worker queued on the pool lock would be asking itself for a lock it already
 * holds, and be refused by its own success. They release together anyway, because they are held
 * by one context and that context is a tab.
 */
const lockFor = (scope: string) => `syncmesh-mesh:${scope}`;

const NO_SHARED_WORKER =
  "this browser has no SharedWorker, so an origin has no singleton to introduce tabs through " +
  "and a follower has no way to address the tab holding the mesh; one tab of this origin is " +
  "live and the rest are not. Chrome on Android is the case this covers";

const REFUSED =
  "the SharedWorker that would introduce this tab to the one holding the mesh could not be " +
  "started; a Content-Security-Policy without worker-src is the usual cause";

const DECLINED =
  "single-tab mode was asked for, so this tab has no way to reach another tab's mesh";

const NO_LOCKS =
  "this context has no navigator.locks, so no tab of this origin can be elected and none may " +
  "host: two tabs that both assumed they were leader would be two engines over one log. Web " +
  "Locks needs a secure context, which is also what the origin private file system needs";

/**
 * The two members of a page's global scope this module reads off it, both of which may be absent.
 *
 * `lib.dom.d.ts` declares `SharedWorker` unconditionally because it describes a browser that has
 * one; asking through a shape that admits its absence is what lets the same build run where there
 * is none, and Chrome on Android is exactly that place.
 */
interface BrowserScope {
  readonly SharedWorker?: unknown;
  readonly addEventListener?: (type: string, listener: () => void) => void;
  readonly removeEventListener?: (type: string, listener: () => void) => void;
}

// SAFETY: narrowing `globalThis` to the two properties this module reads off it — one that a
// browser may genuinely not have, and one that a test runner does not
const browser = globalThis as BrowserScope;

export interface MeshLinkOptions {
  /**
   * This tab's own dedicated worker, which is where the mesh lives if this tab wins.
   *
   * Called once per page, not once per link: the election is the tab's, and a second worker would
   * be a second contender under one tab's identity. A tab that loses holds a queued lock request
   * and nothing else, which is what makes a handover a reconnect rather than a cold start.
   *
   * @example
   * worker: () => new Worker(new URL("./mesh-worker.js", import.meta.url), { type: "module" })
   */
  readonly worker: () => CarrierPort;
  /**
   * Where the origin's rendezvous comes from, for a bundler that will not follow
   * `new SharedWorker(new URL(…), { type: "module" })`.
   *
   * `false` asks for single-tab mode outright: this tab hosts if it wins the election and reports
   * {@link NoRendezvous} if it does not.
   */
  readonly rendezvous?: (() => CarrierPort) | false;
  /** The tree the election covers; change it only to run two independent meshes in one origin. */
  readonly scope?: string;
  /**
   * This tab has just become the host, having started as a follower.
   *
   * Only ever called on a *later* promotion — an opening call already reports the role in its
   * link. It exists for the one case that has no link to lose: a tab told {@link NoRendezvous},
   * which is showing single-tab mode on screen and now can host after all.
   */
  readonly onPromoted?: () => void;
}

/** One per page: the worker, the rendezvous, the standing, and every link made from them. */
interface Tab {
  readonly control: CarrierPort;
  readonly bus: Result<Rendezvous, NoRendezvous>;
  readonly links: Set<DirectLink>;
  leader: boolean;
}

const packagedRendezvous = (): CarrierPort =>
  new SharedWorker(new URL("./rendezvous-worker.js", import.meta.url), {
    type: "module",
    name: RENDEZVOUS,
  }).port;

const busFor = (make: MeshLinkOptions["rendezvous"]): Result<Rendezvous, NoRendezvous> => {
  if (make === false)
    return Result.err(new NoRendezvous({ reason: "declined", message: DECLINED }));
  const start = make ?? (browser.SharedWorker === undefined ? undefined : packagedRendezvous);
  if (start === undefined)
    return Result.err(new NoRendezvous({ reason: "unsupported", message: NO_SHARED_WORKER }));
  return Result.try({
    try: start,
    catch: (cause) => new NoRendezvous({ reason: "refused", message: REFUSED, cause }),
  }).map(rendezvousOver);
};

/**
 * A promotion that may land before anything is ready to hear it.
 *
 * The gap is real and it is one turn wide: a leader that quits between this tab's `ifAvailable`
 * answer and the page building its `Tab` delivers `elected` to nobody. Remembering that it fired
 * is the whole fix.
 */
const promotion = () => {
  let fired = false;
  let notify: (() => void) | undefined;
  return {
    fire: () => {
      fired = true;
      notify?.();
    },
    when: (listen: () => void) => {
      notify = listen;
      if (fired) listen();
    },
  };
};

const contend = (control: CarrierPort, lock: string, promoted: () => void) =>
  new Promise<Result<boolean, NoElection>>((settle) => {
    control.onmessage = (event) => {
      // SAFETY: the only sender is this page's own `hostWorker`, whose every post is a `Standing`
      const standing = event.data as Standing;
      if (standing.kind === "elected") promoted();
      else
        settle(
          standing.kind === "unelectable"
            ? Result.err(new NoElection({ message: NO_LOCKS }))
            : Result.ok(standing.leader),
        );
    };
    control.postMessage({ kind: "contend", lock } satisfies Control);
  });

/** Every link made before this moment is talking to a worker that is no longer the host. */
const turnoverOf = (tab: Tab) => () => {
  for (const link of tab.links) link.lost();
  tab.links.clear();
};

const attach = (tab: Tab, bus: Rendezvous, turnover: () => void) => {
  bus.onServe((port) => tab.control.postMessage({ kind: "serve" } satisfies Control, [port]));
  bus.onTurnover(turnover);
  browser.addEventListener?.("pagehide", () => bus.leave());
};

/**
 * Takes the host role: tells the rendezvous first, then drops the links this tab held as a
 * follower. In that order, so a seeker queued during the handover is served before anything
 * asks again, and in single-tab mode the first half is simply not there to do.
 */
const claim = async (tab: Tab, turnover: () => void) => {
  if (tab.bus.isOk()) await tab.bus.value.announce();
  turnover();
};

const startTab = async (options: MeshLinkOptions): Promise<Result<Tab, MeshLinkFailure>> => {
  const started = Result.try({
    try: options.worker,
    catch: (cause) => new HostWorkerUnavailable({ cause }),
  });
  if (started.isErr()) return started;
  const pending = promotion();
  const standing = await contend(started.value, lockFor(options.scope ?? SCOPE), pending.fire);
  if (standing.isErr()) return standing;
  const tab = {
    control: started.value,
    bus: busFor(options.rendezvous),
    links: new Set<DirectLink>(),
    leader: standing.value,
  };
  const turnover = turnoverOf(tab);
  if (tab.bus.isOk()) attach(tab, tab.bus.value, turnover);
  if (tab.leader) await claim(tab, turnover);
  else
    pending.when(() => {
      tab.leader = true;
      void claim(tab, turnover).then(options.onPromoted);
    });
  return Result.ok(tab);
};

const hold = (tab: Tab, port: MessagePort, role: MeshLink["role"]): MeshLink => {
  const link = linkOver(port, role);
  tab.links.add(link);
  link.onLost(() => port.close());

  /**
   * Goodbye to the host, on the way out — the same best-effort notice the rendezvous already gets.
   *
   * A reload is the common way a tab stops existing, and it is the one where the host is told
   * nothing: `pagehide` reaches {@link attach} and tells the *rendezvous*, while the host is left
   * holding a client that will never speak again. That matters because a client is what the turn
   * on a handle is taken *for* — so a tab reloaded mid-statement leaves the origin's one handle
   * held by nobody, and every tab that opens afterwards waits behind it for ever. `bye` is what
   * runs `disconnect`, which rolls back whatever the tab left open and hands the handle on.
   *
   * Best effort, exactly like the broker's: nothing fires on a crash, and a lost goodbye costs
   * the wait it was meant to save rather than correctness.
   */
  const farewell = () => {
    try {
      port.postMessage({ kind: "bye" });
    } catch {
      // a port already closed by the other end; there is nobody left to tell
    }
  };
  browser.addEventListener?.("pagehide", farewell);

  return {
    port,
    role,
    onLost: (listener) => link.onLost(listener),
    lost: () => link.lost(),
    close: () => {
      browser.removeEventListener?.("pagehide", farewell);
      tab.links.delete(link);
      link.close();
      port.close();
    },
  };
};

const followerLink = (tab: Tab): Result<MeshLink, NoRendezvous> => {
  if (tab.bus.isErr()) return Result.err(tab.bus.error);
  const channel = new MessageChannel();
  tab.bus.value.seek(channel.port1);
  return Result.ok(hold(tab, channel.port2, "follower"));
};

const leaderLink = (tab: Tab): Result<MeshLink, NoRendezvous> => {
  const channel = new MessageChannel();
  tab.control.postMessage({ kind: "serve" } satisfies Control, [channel.port1]);
  return Result.ok(hold(tab, channel.port2, "leader"));
};

/**
 * This page's standing place in the origin's election, from which links are drawn.
 *
 * One per page, because the election is the *tab's*: a second one under one tab would be a second
 * contender wearing the same face, and the tab that beat itself would hold a lock its other half
 * is queued behind. {@link openMeshLink} keeps the one; this is for a harness that needs several
 * tabs in one process, and for a page deliberately running two meshes under different scopes.
 */
export interface MeshTab {
  /** A fresh link to whoever holds the mesh now. Ask again whenever `onLost` fires. */
  readonly open: () => Result<MeshLink, NoRendezvous>;
  /** Drop every link and leave the rendezvous. The election is the worker's and outlives this. */
  readonly leave: () => void;
}

/** Joins the origin's election and rendezvous; see {@link openMeshLink} for how it is used. */
export async function joinMesh(
  options: MeshLinkOptions,
): Promise<Result<MeshTab, MeshLinkFailure>> {
  const started = await startTab(options);
  return started.map((tab) => ({
    open: () => (tab.leader ? leaderLink(tab) : followerLink(tab)),
    leave: () => {
      if (tab.bus.isOk()) tab.bus.value.leave();
      turnoverOf(tab)();
    },
  }));
}

/** One election, one rendezvous, one worker per page — however many links are asked of it. */
let joined: Promise<Result<MeshTab, MeshLinkFailure>> | undefined;

/**
 * Opens a port to this origin's one mesh host, whichever tab is holding it.
 *
 * **The leader is elected by `navigator.locks` and nothing else.** Every tab's dedicated worker
 * contends for one exclusive lock; the winner is the host and holds it for the life of its tab.
 * The browser releases it when that context dies — close, crash, or kill — so there is no
 * heartbeat to tune, no lease to expire, and no moment at which two workers both believe they are
 * leader, because the lock manager grants it to exactly one waiter.
 *
 * **A follower reaches the leader through a `SharedWorker` and nothing else.** A tab cannot
 * address another tab's dedicated worker; the `SharedWorker` is the origin's only singleton, so
 * it is where "the host" becomes an address. It brokers a `MessagePort` and touches no file — it
 * could not touch one if it tried, since `createSyncAccessHandle` is as absent there as it is on
 * a page.
 *
 * **Handover.** When the leader's tab goes, the lock passes to one queued worker, whose tab
 * announces itself to the rendezvous; every other tab's link fires `onLost` and it asks again. A
 * port that arrives mid-handover waits in the rendezvous rather than failing, so "ask again" is
 * one call and not a retry loop. Nothing here reads from a dead port: a lost link closes its
 * `MessagePort` as it dies.
 *
 * **Where there is no `SharedWorker`** — Chrome on Android — the elected tab still works and
 * every other tab gets {@link NoRendezvous}, which names the mode rather than degrading into a
 * tab that looks live and is not. {@link rendezvousAvailable} is how a header says which mode it
 * is in before anything has failed.
 *
 * Call it again whenever `onLost` fires. The worker, the election and the rendezvous are the
 * page's and are made once; only the link is new.
 *
 * @example
 * const link = (await openMeshLink({ worker: () => new Worker(url, { type: "module" }) })).unwrap();
 * link.onLost(() => void reconnect());
 * const mesh = connectMesh(link.port);
 */
export async function openMeshLink(
  options: MeshLinkOptions,
): Promise<Result<MeshLink, MeshLinkFailure>> {
  joined ??= joinMesh(options);
  const ready = await joined;
  if (ready.isErr()) {
    joined = undefined;
    return ready;
  }
  return ready.value.open();
}

/**
 * Whether tabs of this origin can share a mesh at all, asked before anything has failed.
 *
 * For a header that names the mode it is in. False means single-tab mode: one tab of this origin
 * is live and the others will be told so.
 */
export const rendezvousAvailable = (): boolean => browser.SharedWorker !== undefined;

/**
 * Drops this page's links and its place in the rendezvous; the next {@link openMeshLink} starts over.
 *
 * It does **not** hand the mesh to another tab. The election is held by a worker and released by
 * the browser when that worker's context ends, which is what a reload or a close does — so this
 * is for a page tearing its own links down, not a way to resign.
 */
export function leaveMesh(): void {
  const leaving = joined;
  joined = undefined;
  void leaving?.then((ready) => {
    if (ready.isOk()) ready.value.leave();
  });
}

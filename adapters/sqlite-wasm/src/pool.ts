import type { SAHPoolUtil } from "@sqlite.org/sqlite-wasm";

import { Result, TaggedError } from "@syncmesh/result";

import type { OptionalVfs, VfsOptions, WasmStorage } from "./vfs.js";

interface SyncAccessHandleHost {
  readonly FileSystemFileHandle?: {
    readonly prototype: { readonly createSyncAccessHandle?: unknown };
  };
  readonly navigator?: {
    readonly storage?: { readonly getDirectory?: unknown };
    readonly locks?: LockManager;
  };
}

// SAFETY: narrowing `globalThis` to the one property this module reads off it. The assertion is
// unavoidable rather than convenient: the property being asked about is declared in
// `lib.webworker.d.ts` and this package compiles against `lib.dom.d.ts`, which is the same fact
// the check exists to discover.
const host = globalThis as SyncAccessHandleHost;
export { host };

/**
 * Pool-lease management for the OPFS access-handle pool: one browsing context at a
 * time holds it, and this module is the only place that asks, tracks and gives back.
 * Split out of vfs.ts so the openers (databases.ts) and the installer (vfs.ts) share
 * it without importing each other — a cycle caught, not introduced.
 */
/**
 * A durable VFS was asked for by name and this thread will not give one out.
 *
 * Never returned for `"auto"`, which resolves to `"memory"` where no durable VFS is reachable —
 * but it *is* returned when a thread that could have had one is refused, because a device with
 * storage that will not open is a fact the app has to see rather than quietly lose writes over.
 *
 * Several causes, none of which clears on its own — which is exactly what separates this tag from
 * {@link OpfsPoolHeld}, where waiting is the remedy.
 *
 * 1. **This thread is not a dedicated worker.** `createSyncAccessHandle` is
 *    `[Exposed=DedicatedWorker]`, so no window has it and no window ever will. Opening the
 *    database in a worker is the entire remedy, and {@link wasmSqliteDriver} does that by default.
 * 2. The browser is too old for synchronous access handles (Safari before 17, Chrome before 108).
 * 3. The browser has them and is refusing this origin an OPFS anyway — a private window, or a
 *    cookie policy strict enough to deny site storage. `cause` is the only account of that one.
 *
 * **`message` is required, and that is the point.** It used to be optional, and the two sites that
 * had a `cause` to hand left it unset — so an origin refused by its browser reported itself to the
 * app as an error with an empty sentence, and the tab drew `this origin's database would not
 * open:` with nothing after the colon. The reason was in `cause` the whole time. A tagged error
 * with no message is one that every screen printing `.message` renders as silence.
 */
export class OpfsUnavailable extends TaggedError("OpfsUnavailable")<{
  readonly requested: Exclude<WasmStorage, "memory">;
  message: string;
  cause?: unknown;
}> {}

/**
 * The access-handle pool exists and another browsing context of this origin is holding it.
 *
 * A different fact from {@link OpfsUnavailable} and a different remedy, which is why it is a
 * different tag: nothing is wrong with the browser, the thread or the build. One pool per origin
 * *directory* is the VFS's rule, and it is not per database — the pool takes exclusive access
 * handles for every slot in the directory the moment it installs, so a second tab asking for a
 * database nobody has ever opened is refused just as firmly as one asking for the first tab's.
 *
 * An app that reports this as "this browser cannot save" has told the user something false, and an
 * app that reports it as "another tab owns the database" has told them something they can act on.
 *
 * It clears by itself: closing every driver in the holding context hands the access handles back
 * (`pauseVfs`), and so does closing that tab. Nothing here polls on the waiter's behalf.
 */
export class OpfsPoolHeld extends TaggedError("OpfsPoolHeld")<{
  /** The pool directory that is taken, which is the granularity of the exclusion. */
  readonly directory: string;
  message: string;
  cause?: unknown;
}> {}

/**
 * The browser will not give this origin an origin private file system at all.
 *
 * A third fact and a third remedy, which is why it is a third tag. Nothing is wrong with the
 * build, the thread or another tab: the storage is there and this browsing context is not allowed
 * it. **A private window is the one every developer meets** — Firefox provides no OPFS in one and
 * refuses `navigator.storage.getDirectory()` with a `SecurityError`, where Chrome's incognito
 * hands over an ephemeral one. The same refusal comes from a cookie policy that denies site
 * storage, and from a build with the File System API switched off.
 *
 * It does not clear by waiting and there is nothing the app can do about it, which is what makes
 * it different from {@link OpfsPoolHeld} — and why `"auto"` treats it as an answer rather than a
 * failure: see {@link openDatabase}.
 */
export class OpfsDenied extends TaggedError("OpfsDenied")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * The `DOMException` names the File System API uses for a file whose access handle is already
 * out. `NoModificationAllowedError` is what the specification says; `InvalidStateError` is what
 * some builds have shipped. Anything else is a pool that failed for a reason of its own.
 */
const CONTENDED = new Set(["NoModificationAllowedError", "InvalidStateError"]);

/**
 * The names a browser refuses an origin its file system under. `sqlite-wasm` calls
 * `navigator.storage.getDirectory()` without wrapping what it throws, so the `DOMException`
 * arrives here as the browser raised it and its name is the whole classification.
 */
const DENIED = new Set(["SecurityError", "NotAllowedError"]);

const NO_FILE_SYSTEM =
  "this browser will not give the origin private file system to this origin. A private window is " +
  "the usual cause — Firefox provides no OPFS in one, where Chrome's incognito provides an " +
  "ephemeral one — and so is a cookie policy that denies site storage, or a build with the File " +
  "System API switched off";

/** What a window is told, spelled out, because the rule is not guessable from the symptom. */
export const NOT_A_WORKER =
  "a durable VFS needs FileSystemFileHandle.createSyncAccessHandle, which the File System API " +
  "exposes only in a dedicated worker; this thread is not one, so the only VFS it can open is " +
  "memory. Open the database in a worker — wasmSqliteDriver does that for you.";

/** A pool and how many databases opened on it are still open; at zero the access handles go back. */
export interface HeldPool {
  readonly util: SAHPoolUtil;
  open: number;
}

/**
 * The origin-wide right to the pool, held for as long as the access handles are.
 *
 * The pool's exclusivity is a fact about the origin, and SQLite only ever reports it as a
 * `DOMException` from halfway through an install — by which point handles have been taken and
 * given back and the caller has a sentence about writable streams to interpret. A Web Lock asks
 * the same question first, gets a plain yes or no, and costs nothing when the answer is yes.
 *
 * `navigator.locks` is the one coordination primitive every browser that has OPFS also has,
 * including Chrome on Android; where it is absent — a test runner, an old build — the lease is a
 * no-op and the `DOMException` classification below is still the backstop.
 */
interface PoolLease {
  readonly release: () => void;
}

/**
 * What to do when another browsing context of this origin holds the pool.
 *
 * Two callers, two right answers, and collapsing them is what made a handover look like a broken
 * browser. A tab deciding *whether it may be durable at all* wants `"refuse"`: an immediate no is
 * the answer it draws a badge from, and a tab that queued would sit there claiming to be opening a
 * database it is not entitled to. A worker that has **already won the mesh election** wants
 * `"wait"`: it is the one context of this origin that may hold the pool, the context that had it
 * is gone or going, and the only thing between them is the browser reaping what the dead one held.
 *
 * `"wait"` is a queued Web Lock, which is the primitive that already does this properly — it
 * resolves the instant the previous holder is released, including when that holder was a context
 * the browser reaped, with no polling and no budget to run out of. The 750ms retry loop this
 * replaced was approximating it, and on a loaded machine it approximated it badly.
 *
 * **`"wait"` therefore never answers {@link OpfsPoolHeld}.** Waiting *is* the answer; a caller that
 * asked to wait and got "held" back would have to invent the loop again.
 */
export type WhenPoolHeld = "refuse" | "wait";

/** One lease per directory, and per *thread*: a second database here must not ask for it twice. */
const leases = new Map<string, PoolLease>();

const HELD_ELSEWHERE =
  "another browsing context of this origin holds the OPFS access-handle pool; one context at a " +
  "time may have it, and it is released when that one closes its stores or its tab";

const leaseOn = (
  directory: string,
  when: WhenPoolHeld,
): Promise<Result<PoolLease, OpfsPoolHeld>> => {
  const locks = host.navigator?.locks;
  if (locks === undefined) return Promise.resolve(Result.ok({ release: () => {} }));
  // a queued request has no `ifAvailable`, so its callback runs only once the lock is granted and
  // the `lock === null` arm below is unreachable — which is the whole difference between the modes
  const options = when === "wait" ? {} : { ifAvailable: true };
  return new Promise((settle) => {
    void locks.request(`syncmesh-opfs:${directory}`, options, (lock) => {
      if (lock === null) {
        settle(Result.err(new OpfsPoolHeld({ directory, message: HELD_ELSEWHERE })));
        return undefined;
      }
      // the lock is held for exactly as long as this promise is pending, which is what `release`
      // is: the manager hands it to the next waiter the moment we settle it
      return new Promise<void>((release) => settle(Result.ok({ release })));
    });
  });
};

/** Idempotent within a thread, because two scoped stores (D07) share one pool and one lease. */
const takeLease = async (
  directory: string,
  when: WhenPoolHeld,
): Promise<Result<undefined, OpfsPoolHeld>> => {
  if (leases.has(directory)) return Result.ok(undefined);
  const lease = await leaseOn(directory, when);
  if (lease.isErr()) return lease;
  leases.set(directory, lease.value);
  return Result.ok(undefined);
};

export const dropLease = (directory: string) => {
  leases.get(directory)?.release();
  leases.delete(directory);
};

/** One pool per OPFS directory, because the VFS itself allows exactly one and rejects the second. */
const pools = new Map<string, Promise<Result<HeldPool, PoolFailure>>>();

/**
 * Every reason a pool will not install, kept apart because the remedies have nothing in common:
 * another tab is holding it and will let go, this browser is refusing the origin outright, or the
 * thread and build simply cannot.
 */
export type PoolFailure = OpfsUnavailable | OpfsPoolHeld | OpfsDenied;

/**
 * Which of the two a refused install was. The classification happens here, where the original
 * `DOMException` still is: `serializeTagged` flattens a cause to its message on the way across a
 * port, so a page that classified after the hop would be reading prose.
 */
const poolFailure =
  (directory: string) =>
  (cause: unknown): PoolFailure => {
    const name = cause instanceof Error ? cause.name : "";
    if (CONTENDED.has(name))
      return new OpfsPoolHeld({
        directory,
        message:
          "another browsing context of this origin holds the OPFS access-handle pool; " +
          "one context at a time may have it, and it is released when that one closes its stores",
        cause,
      });
    if (DENIED.has(name)) return new OpfsDenied({ message: NO_FILE_SYSTEM, cause });
    return new OpfsUnavailable({
      requested: "opfs-sahpool",
      message: "the access-handle pool would not install on this thread",
      cause,
    });
  };

function poolIn(
  install: NonNullable<OptionalVfs["installOpfsSAHPoolVfs"]>,
  directory: string,
  capacity: number,
): Promise<Result<HeldPool, PoolFailure>> {
  const current = pools.get(directory);
  if (current !== undefined) return current;
  // a refused install is not remembered: the tab holding it may let go a second later
  const installing = Result.tryPromise({
    try: () => install({ directory, initialCapacity: capacity }),
    catch: poolFailure(directory),
  }).then((result) => {
    if (result.isErr()) pools.delete(directory);
    return result.map((util) => ({ util, open: 0 }));
  });
  pools.set(directory, installing);
  return installing;
}

/** Long enough to be past a reap, short enough that nobody watches a spinner for it. */
const REAP_PAUSE = 100;

/**
 * The lease is ours and the handles are not — yet.
 *
 * Holding the lock and still being refused the files is a real window and not a contradiction: the
 * browser releases a dead context's Web Locks and its file handles independently, and nothing
 * orders the two. So a caller that asked to wait waits here too, rather than being handed the one
 * failure it said it did not want an answer to. It is the only loop left, it is entered only under
 * `"wait"`, and it ends when the browser finishes reaping — which it always does.
 */
const installPool = async (
  install: NonNullable<OptionalVfs["installOpfsSAHPoolVfs"]>,
  directory: string,
  capacity: number,
  when: WhenPoolHeld,
): Promise<Result<HeldPool, PoolFailure>> => {
  const held = await poolIn(install, directory, capacity);
  if (held.isOk() || when === "refuse" || held.error._tag !== "OpfsPoolHeld") return held;
  await new Promise((wake) => setTimeout(wake, REAP_PAUSE));
  return installPool(install, directory, capacity, when);
};

/**
 * Takes a reference on the pool, waking it if the last driver on it went away. `pauseVfs` drops
 * the access handles without touching the files, so a worker that has closed its stores stops
 * blocking every other browsing context of the origin; `unpauseVfs` takes them back, which is why
 * an open is async on a path that looks synchronous.
 *
 * **`initialCapacity` is initial**, and a pool that exists already keeps the slot count it was
 * created with — so raising the default does nothing for an origin that has ever run the app, and
 * the symptom would be an open refused for want of a slot long after the number was changed.
 * `reserveMinimumCapacity` is the call that means "at least this many": it grows a pool that is
 * short and returns without side effects on one that is not.
 */
export async function holdPool(
  install: NonNullable<OptionalVfs["installOpfsSAHPoolVfs"]>,
  directory: string,
  options: VfsOptions,
): Promise<Result<HeldPool, PoolFailure>> {
  const when = options.whenHeld ?? "refuse";
  const leased = await takeLease(directory, when);
  if (leased.isErr()) return leased;
  const held = await installPool(install, directory, options.capacity, when);
  if (held.isErr()) {
    dropLease(directory);
    return held;
  }
  const pool = held.value;
  const reserved = await Result.tryPromise({
    try: () => pool.util.reserveMinimumCapacity(options.capacity),
    catch: poolFailure(directory),
  });
  if (reserved.isErr()) {
    dropLease(directory);
    return reserved;
  }
  if (pool.util.isPaused()) {
    const woken = await Result.tryPromise({
      try: () => pool.util.unpauseVfs(),
      catch: poolFailure(directory),
    });
    if (woken.isErr()) {
      dropLease(directory);
      return woken;
    }
  }
  pool.open += 1;
  return held;
}

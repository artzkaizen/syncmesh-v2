import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { Result } from "@syncmesh/result";

import type { PoolFailure, WhenPoolHeld } from "./pool.js";

import { NOT_A_WORKER, OpfsUnavailable, host } from "./pool.js";

export type { PoolFailure, WhenPoolHeld } from "./pool.js";

/**
 * Where a browser database's bytes actually end up. The tag travels on the driver because the
 * three are not interchangeable and only one of them is a promise the app can repeat to a user:
 * `"memory"` is gone at the next reload, and a local-first app that says otherwise is lying.
 *
 * **Both durable VFSes are dedicated-worker-only, and that is the platform's rule rather than
 * SQLite's.** Both are built on `FileSystemFileHandle.createSyncAccessHandle`, and the File
 * System API declares that method `[Exposed=DedicatedWorker]`. TypeScript's own libraries are the
 * shortest proof: it is declared in `lib.webworker.d.ts` and appears nowhere in `lib.dom.d.ts`.
 * Read it off the prototype in a page and it is `undefined` — in every browser, cross-origin
 * isolated or not. So a database opened on *this* thread is durable only when this thread is a
 * dedicated worker, and in a window `"auto"` can only resolve to `"memory"`. Putting the database
 * somewhere it can be durable is {@link WasmSqliteOptions.worker}'s job, not this function's.
 *
 * - `"opfs-sahpool"` — SQLite's synchronous access-handle pool over the origin private file
 *   system. It wants a dedicated worker and nothing else: no `SharedArrayBuffer`, no
 *   cross-origin isolation, no COOP/COEP headers. That is why it is what `"auto"` reaches for
 *   wherever it can be had at all. The pool takes exclusive access handles for a whole directory,
 *   so **one browsing context at a time** holds it; see {@link OpfsUnavailable}.
 * - `"opfs"` — SQLite's original OPFS VFS. Several connections may hold one database, so two tabs
 *   can share it, but it wants strictly more than the pool does: a dedicated worker *and* a page
 *   served with `Cross-Origin-Opener-Policy: same-origin` and
 *   `Cross-Origin-Embedder-Policy: require-corp`, because it coordinates its synchronous and
 *   asynchronous halves through a `SharedArrayBuffer` and `Atomics.wait`. Paying for the headers
 *   alone does not buy it: its own feature check reads `createSyncAccessHandle` before it will
 *   spawn the proxy, so a page with `crossOriginIsolated === true` still gets
 *   `Missing required OPFS APIs.` Ask for it by name once you have both.
 * - `"memory"` — SQLite's `memdb` VFS. Durable for the life of the thread, including across
 *   `close` and a reopen of the same name, and not one byte past a reload.
 */
export type WasmStorage = "opfs-sahpool" | "opfs" | "memory";

/**
 * Whether a durable VFS is even possible on this thread — true in a dedicated worker, false in a
 * window, a shared worker, a service worker and Node.
 *
 * This is the exact check SQLite's own `installOpfsSAHPoolVfs` makes before it will install, so
 * asking it first turns a rejected promise reading `Missing required OPFS APIs.` into a decision
 * made before anything is attempted. It is a fact about the *thread*, not about the browser: the
 * same probe on the same page answers `function` inside a worker it spawned.
 */
export const threadHasSyncAccessHandles = (): boolean =>
  host.FileSystemFileHandle?.prototype.createSyncAccessHandle !== undefined;

/**
 * Whether this *origin* has an origin private file system at all, which is a different question
 * from whether this thread can reach one synchronously.
 *
 * A window answers yes and still cannot open a durable database; that gap is exactly the case a
 * dedicated worker closes, and this is how {@link wasmSqliteDriver} tells "a browser, on the wrong
 * thread" from "a test runner, where there is no OPFS for any thread to reach".
 */
export const originHasOpfs = (): boolean => host.navigator?.storage?.getDirectory !== undefined;

/**
 * The two VFS entry points the browser build installs and the Node build does not. The published
 * types declare both unconditionally because they describe the browser build; asking through a
 * shape that admits their absence is what lets one driver run under both, and is the whole reason
 * this package's conformance suite can run off a browser at all.
 *
 * Note what their presence does **not** tell you: `installOpfsSAHPoolVfs` is a function in a
 * window too. It is defined by the build, not by the thread, and only rejects once called.
 */
export interface OptionalVfs {
  readonly installOpfsSAHPoolVfs?: Sqlite3Static["installOpfsSAHPoolVfs"];
  readonly oo1: { readonly OpfsDb?: Sqlite3Static["oo1"]["OpfsDb"] };
}

const sahPoolInstaller = (sqlite3: OptionalVfs) => sqlite3.installOpfsSAHPoolVfs;
const opfsDbClass = (sqlite3: OptionalVfs) => sqlite3.oo1.OpfsDb;

/** A database and what it cost to get one; `release` is what the driver's `close` owes the pool. */
export interface OpenedDatabase {
  readonly db: Database;
  readonly storage: WasmStorage;
  readonly release: () => void;
}

export interface VfsOptions {
  readonly name: string;
  /**
   * Names the derived half of the pair — `schemaNameFor(tables)`, so that changing a column opens
   * an empty file to refold into rather than the previous shape's rows (RFC-0022). The log keeps
   * the store's own name, because it is what everything else is named after.
   */
  readonly schema: string;
  /**
   * The OPFS directory this origin's syncmesh data lives under. The pool's slots and the plain
   * VFS's files go in separate children of it, because the pool deletes anything in its own
   * directory it did not put there — an app that switches VFS would otherwise lose the database
   * it switched away from.
   */
  readonly directory: string;
  /**
   * Pool slots. The pool opens and holds a file per slot, and a slot is consumed by every
   * database *and* its journal, so the default covers three scoped stores (D07) with room over.
   */
  readonly capacity: number;
  /** What to do when another context holds the pool; see {@link WhenPoolHeld}. Default `"refuse"`. */
  readonly whenHeld?: WhenPoolHeld;
}

/** Names go in a path and come from partition ids, which hold characters a path does not. */
const refuse = (requested: Exclude<WasmStorage, "memory">) =>
  Promise.resolve(Result.err(new OpfsUnavailable({ requested, message: NOT_A_WORKER })));

/**
 * Opens one database **on this thread**, on the VFS that was asked for or on the best one this
 * thread can actually have.
 *
 * `"auto"` asks {@link threadHasSyncAccessHandles} first and resolves to `"memory"` when the
 * answer is no, which in a window it always is. That is not a fallback taken after a failure: a
 * window has no durable VFS to fail at, and trying the pool there only produces a rejected promise
 * reading `Missing required OPFS APIs.` a second later. Where the thread *can* have one, `"auto"`
 * prefers the access-handle pool over the older OPFS VFS because the pool needs only the worker
 * while the older VFS also needs COOP/COEP — and a thread that has both and still cannot open the
 * pool gets an error, not a silent memory database.
 *
 * **{@link OpfsDenied} is the one exception, and it is the same rule rather than a hole in it.**
 * `"auto"` means "the best this context can have", and a browser refusing the origin a file system
 * has answered that question as completely as a window lacking sync handles does: there is nothing
 * to wait for and nothing the app can do. So it resolves to memory — and the driver reports
 * `storage: "memory"`, which is what stops this from being a silent downgrade. An app that draws
 * that tier tells the truth without having to know why. **Asking for a durable VFS by name still
 * errors**, because a caller who named one was not asking what was available.
 *
 * A private window is the case every developer meets: Firefox provides no OPFS in one at all,
 * where Chrome's incognito provides an ephemeral one. Before this, the app simply would not start
 * in Firefox private browsing, and the reason it gave was empty.
 */
import { memoryDatabase, opfsDatabaseIn, sahPoolDatabase } from "./databases.js";

export async function openDatabase(
  sqlite3: Sqlite3Static,
  storage: WasmStorage | "auto",
  options: VfsOptions,
): Promise<Result<OpenedDatabase, PoolFailure>> {
  const install = sahPoolInstaller(sqlite3);
  const OpfsDb = opfsDbClass(sqlite3);
  const durable = threadHasSyncAccessHandles();
  const best = !durable
    ? "memory"
    : install !== undefined
      ? "opfs-sahpool"
      : OpfsDb !== undefined
        ? "opfs"
        : "memory";
  const chosen = storage === "auto" ? best : storage;
  if (chosen === "memory") return Result.ok(memoryDatabase(sqlite3, options));
  if (!durable) return refuse(chosen);
  if (chosen === "opfs")
    return OpfsDb === undefined
      ? Result.err(
          new OpfsUnavailable({
            requested: "opfs",
            message: "this build of sqlite-wasm has no OPFS VFS",
          }),
        )
      : opfsDatabaseIn(OpfsDb, options);
  if (install === undefined)
    return Result.err(
      new OpfsUnavailable({
        requested: "opfs-sahpool",
        message: "this build of sqlite-wasm has no access-handle pool VFS to install",
      }),
    );
  const opened = await sahPoolDatabase(install, options);
  return opened.isErr() && storage === "auto" && opened.error._tag === "OpfsDenied"
    ? Result.ok(memoryDatabase(sqlite3, options))
    : opened;
}
